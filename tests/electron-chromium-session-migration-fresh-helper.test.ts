import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ChromiumSessionMigrationFreshHelper } from
  "../src/electron/main/chromiumSessionMigrationFreshHelper";
import type { ChromiumSessionMigrationFreshHelperRequest } from
  "../src/electron/main/chromiumSessionMigrationFreshHelperContract";
import type {
  ChromiumMigrationWebContentsPort,
  ChromiumMigrationWebContentsViewFactoryPort
} from "../src/electron/main/chromiumSessionMigrationLocalStorage";
import type {
  ChromiumRoleSessionPort,
  ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const TRANSFER_ID = "22222222-2222-4222-8222-222222222222";
const CHROMIUM_PATH = `/data/roles/${ROLE_ID}/browser/chromium`;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encoded(value: string, encoding = "base64") {
  return {
    encoding,
    data: Buffer.from(value, encoding === "base64" ? "utf8" : "utf16le")
      .toString("base64")
  };
}

function fixture() {
  const inventory = {
    cookies: [{
      name: encoded("session"),
      value: encoded("secret"),
      domain: "game.example.com",
      path: "/play",
      hostOnly: true,
      secure: true,
      httpOnly: true,
      expiry: { kind: "absolute", unixMs: 1_800_000_000_125 },
      sameSite: "lax",
      partition: { kind: "unpartitioned" }
    }],
    localStorage: [{
      origin: "https://game.example.com",
      entries: [{
        key: encoded("character", "base64Utf16Le"),
        value: encoded("Aron", "base64Utf16Le")
      }]
    }]
  };
  const envelope = Buffer.from(JSON.stringify({
    metadata: {
      format: "rion-role-session-transfer",
      version: 1,
      transferId: TRANSFER_ID,
      roleId: ROLE_ID,
      platform: "macos",
      sourceEngine: "wkwebview",
      targetEngine: "chromium",
      sourceRevision: 12
    },
    inventory
  }));
  const request: ChromiumSessionMigrationFreshHelperRequest = {
    version: 1,
    family: "roleSessionMigration",
    kind: "apply",
    platform: "macos",
    roleId: ROLE_ID,
    transferId: TRANSFER_ID,
    expectedJournalRevision: 4,
    targetRevision: 9,
    sourceRevision: 12,
    phase: "importing",
    rolePaths: {
      browserUserDataDir: `/data/roles/${ROLE_ID}/browser`,
      systemBrowserDataDir:
        `/data/roles/${ROLE_ID}/browser/system-webview`,
      webview2UserDataDir:
        `/data/roles/${ROLE_ID}/browser/system-webview/webview2`,
      chromiumUserDataDir: CHROMIUM_PATH,
      webkitDataStoreKey: `role:${ROLE_ID}:wkwebview`,
      webkitDataStoreIdentifier: ROLE_ID
    },
    envelopeSha256: sha256(envelope),
    inventorySha256: sha256(Buffer.from(JSON.stringify(inventory))),
    cookieCount: 1,
    cookiePolicy: "exact",
    localStorageOriginCount: 1,
    localStorageEntryCount: 1,
    envelopeBytes: envelope.byteLength
  };
  return { envelope, request };
}

interface PersistentStorage {
  cookies: Cookie[];
  localStorage: Map<string, Map<string, string>>;
}

function localStorageFor(
  persistent: PersistentStorage,
  origin: string
): Storage {
  let entries = persistent.localStorage.get(origin);
  if (!entries) {
    entries = new Map();
    persistent.localStorage.set(origin, entries);
  }
  return {
    get length() {
      return entries!.size;
    },
    clear: () => entries!.clear(),
    getItem: (key) => entries!.get(key) ?? null,
    key: (index) => [...entries!.keys()][index] ?? null,
    removeItem: (key) => entries!.delete(key),
    setItem: (key, value) => entries!.set(String(key), String(value))
  } as Storage;
}

function nativePorts(
  persistent: PersistentStorage,
  rejectedCookieName?: string
): {
  sessions: ChromiumSessionFactoryPort;
  views: ChromiumMigrationWebContentsViewFactoryPort;
  fromPath: ReturnType<typeof vi.fn>;
} {
  const fromPath = vi.fn((path: string) => {
    const handlers = new Map<string, (request: Request) => Response>();
    const session = {
      storagePath: path,
      on: vi.fn(),
      cookies: {
        flushStore: vi.fn(async () => undefined),
        get: vi.fn(async () => persistent.cookies.map((cookie) => ({ ...cookie }))),
        set: vi.fn(async (details: CookiesSetDetails) => {
          if (details.name === rejectedCookieName) {
            throw new Error("synthetic cookie rejection");
          }
          const url = new URL(details.url);
          const cookie: Cookie = {
            name: details.name ?? "",
            value: details.value ?? "",
            domain: details.domain ? `.${details.domain}` : url.hostname,
            hostOnly: details.domain === undefined,
            path: details.path ?? "/",
            secure: details.secure ?? false,
            httpOnly: details.httpOnly ?? false,
            session: details.expirationDate === undefined,
            ...(details.expirationDate === undefined
              ? {}
              : { expirationDate: details.expirationDate }),
            sameSite: details.sameSite ?? "lax"
          };
          persistent.cookies = [
            ...persistent.cookies.filter((existing) => !(
              existing.name === cookie.name &&
              (existing.domain ?? "").replace(/^\./u, "") ===
                (cookie.domain ?? "").replace(/^\./u, "") &&
              existing.path === cookie.path
            )),
            cookie
          ];
        })
      },
      clearStorageData: vi.fn(async () => {
        persistent.cookies = [];
        persistent.localStorage.clear();
      }),
      flushStorageData: vi.fn(),
      protocol: {
        handle: vi.fn((scheme: string, handler: (request: Request) => Response) => {
          handlers.set(scheme, handler);
        }),
        unhandle: vi.fn((scheme: string) => {
          handlers.delete(scheme);
        })
      },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn(),
      __handlers: handlers
    } as unknown as ChromiumRoleSessionPort & {
      __handlers: typeof handlers;
    };
    return session;
  });
  const sessions = { fromPath } as ChromiumSessionFactoryPort;
  const views: ChromiumMigrationWebContentsViewFactoryPort = {
    create: vi.fn((options) => {
      const session = options.webPreferences.session as
        ChromiumRoleSessionPort & {
          __handlers: Map<string, (request: Request) => Response>;
        };
      let currentUrl = "";
      let destroyed = false;
      let onDestroyed: (() => void) | undefined;
      const contents: ChromiumMigrationWebContentsPort = {
        session,
        close: vi.fn(() => {
          destroyed = true;
          onDestroyed?.();
        }),
        executeJavaScript: vi.fn(async (expression) => {
          const origin = new URL(currentUrl).origin;
          return runInNewContext(expression, {
            location: { origin },
            localStorage: localStorageFor(persistent, origin)
          }) as unknown;
        }),
        getURL: () => currentUrl,
        isDestroyed: () => destroyed,
        loadURL: vi.fn(async (url) => {
          const parsed = new URL(url);
          const response = await session.__handlers.get(
            parsed.protocol.slice(0, -1)
          )?.(new Request(url));
          if (response?.status !== 200) throw new Error("controlled load failed");
          currentUrl = url;
        }),
        once: vi.fn((_event, listener) => {
          onDestroyed = listener;
        }),
        setWindowOpenHandler: vi.fn()
      };
      return { webContents: contents };
    })
  };
  return { sessions, views, fromPath };
}

describe("Chromium session migration fresh helper", () => {
  it("admits Windows profile-snapshot evidence only for best-effort cookie import", async () => {
    const initial = fixture();
    const document = JSON.parse(initial.envelope.toString("utf8")) as {
      metadata: Record<string, unknown>;
    };
    document.metadata.platform = "windows";
    document.metadata.sourceEngine = "webview2";
    document.metadata.sourceEvidence = {
      kind: "webview2ProfileSnapshot",
      runtimeVersion: "legacy-webview2-profile",
      protocolVersion: "1.0",
      partitionCapability: "profileDatabaseBestEffort"
    };
    const envelope = Buffer.from(JSON.stringify(document));
    const request: ChromiumSessionMigrationFreshHelperRequest = {
      ...initial.request,
      platform: "windows",
      cookiePolicy: "bestEffort",
      envelopeSha256: sha256(envelope),
      envelopeBytes: envelope.byteLength,
      rolePaths: {
        browserUserDataDir: `C:\\RionData\\roles\\${ROLE_ID}\\browser`,
        systemBrowserDataDir: `C:\\RionData\\roles\\${ROLE_ID}\\browser\\system`,
        webview2UserDataDir: `C:\\RionData\\roles\\${ROLE_ID}\\browser\\webview2`,
        chromiumUserDataDir: `C:\\RionData\\roles\\${ROLE_ID}\\browser\\chromium`,
        webkitDataStoreKey: `role:${ROLE_ID}:wkwebview`,
        webkitDataStoreIdentifier: ROLE_ID
      }
    };
    const persistent: PersistentStorage = {
      cookies: [],
      localStorage: new Map()
    };
    const ports = nativePorts(persistent);
    const result = await new ChromiumSessionMigrationFreshHelper({
      platform: "win32",
      sessions: ports.sessions,
      views: ports.views
    }).run(request, Buffer.from(envelope));

    expect({
      outcome: result.outcome,
      metadata: JSON.parse(result.metadataBytes.toString("utf8"))
    }).toMatchObject({ outcome: "applied" });
    const exact = await new ChromiumSessionMigrationFreshHelper({
      platform: "win32",
      sessions: ports.sessions,
      views: ports.views
    }).run({ ...request, cookiePolicy: "exact" }, Buffer.from(envelope));
    expect(exact.outcome).toBe("failed");
    expect(JSON.parse(exact.metadataBytes.toString("utf8"))).toMatchObject({
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_SOURCE_EVIDENCE_INVALID"
    });
  });

  it("persists in one helper and verifies from a distinct fresh native Session", async () => {
    const { envelope, request } = fixture();
    const persistent: PersistentStorage = {
      cookies: [],
      localStorage: new Map()
    };
    const ports = nativePorts(persistent);
    const applySecret = Buffer.from(envelope);
    const apply = await new ChromiumSessionMigrationFreshHelper({
      platform: "darwin",
      sessions: ports.sessions,
      views: ports.views
    }).run(request, applySecret);

    expect(apply.outcome).toBe("applied");
    expect(applySecret.every((byte) => byte === 0)).toBe(true);
    expect(persistent.cookies).toHaveLength(1);
    expect(persistent.localStorage.get("https://game.example.com")?.get("character"))
      .toBe("Aron");

    const verifySecret = Buffer.from(envelope);
    const verify = await new ChromiumSessionMigrationFreshHelper({
      platform: "darwin",
      sessions: ports.sessions,
      views: ports.views
    }).run({
      ...request,
      kind: "verify",
      parentExitEvidenceSha256: "a".repeat(64)
    }, verifySecret);

    expect(verify.outcome).toBe("applied");
    expect(verifySecret.every((byte) => byte === 0)).toBe(true);
    expect(ports.fromPath).toHaveBeenCalledTimes(2);
    expect(ports.fromPath.mock.results[0]?.value)
      .not.toBe(ports.fromPath.mock.results[1]?.value);
    expect(JSON.parse(verify.metadataBytes.toString("utf8"))).toMatchObject({
      kind: "verify",
      readbackCookieCount: 1,
      checkedLocalStorageOriginCount: 1,
      readbackLocalStorageEntryCount: 1,
      parentExitEvidenceSha256: "a".repeat(64),
      verifierInstanceId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/u
      )
    });
  });

  it("clears and then freshly proves every migrated origin is empty", async () => {
    const { envelope, request } = fixture();
    const persistent: PersistentStorage = {
      cookies: [{
        name: "session",
        value: "secret",
        domain: "game.example.com",
        hostOnly: true,
        path: "/play",
        secure: true,
        httpOnly: true,
        session: false,
        expirationDate: 1_800_000_000.125,
        sameSite: "lax"
      }],
      localStorage: new Map([
        ["https://game.example.com", new Map([["character", "Aron"]])]
      ])
    };
    const ports = nativePorts(persistent);
    const rollback = await new ChromiumSessionMigrationFreshHelper({
      platform: "darwin",
      sessions: ports.sessions,
      views: ports.views
    }).run({ ...request, kind: "rollback" }, Buffer.from(envelope));
    const verify = await new ChromiumSessionMigrationFreshHelper({
      platform: "darwin",
      sessions: ports.sessions,
      views: ports.views
    }).run({
      ...request,
      kind: "rollbackVerify",
      parentExitEvidenceSha256: "b".repeat(64)
    }, Buffer.from(envelope));

    expect([rollback.outcome, verify.outcome]).toEqual(["applied", "applied"]);
    expect(persistent.cookies).toEqual([]);
    expect(persistent.localStorage.get("https://game.example.com")?.size ?? 0)
      .toBe(0);
  });

  it("binds and freshly verifies the Chromium-accepted best-effort cookie subset", async () => {
    const initial = fixture();
    const document = JSON.parse(initial.envelope.toString("utf8")) as {
      inventory: { cookies: Array<Record<string, unknown>> };
    };
    document.inventory.cookies.push({
      ...document.inventory.cookies[0],
      name: encoded("rejected"),
      value: encoded("not-imported")
    });
    const envelope = Buffer.from(JSON.stringify(document));
    const request: ChromiumSessionMigrationFreshHelperRequest = {
      ...initial.request,
      cookieCount: 2,
      cookiePolicy: "bestEffort",
      envelopeBytes: envelope.byteLength,
      envelopeSha256: sha256(envelope),
      inventorySha256: sha256(
        Buffer.from(JSON.stringify(document.inventory))
      )
    };
    const persistent: PersistentStorage = {
      cookies: [],
      localStorage: new Map()
    };
    const ports = nativePorts(persistent, "rejected");
    const apply = await new ChromiumSessionMigrationFreshHelper({
      platform: "darwin",
      sessions: ports.sessions,
      views: ports.views
    }).run(request, Buffer.from(envelope));
    expect(apply.outcome).toBe("applied");
    const evidence = JSON.parse(apply.metadataBytes.toString("utf8")) as {
      acceptedCookieInventorySha256: string;
      readbackCookieCount: number;
      cookieSkippedCount: number;
    };
    expect(evidence).toMatchObject({
      readbackCookieCount: 1,
      cookieSkippedCount: 1,
      acceptedCookieInventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    const verify = await new ChromiumSessionMigrationFreshHelper({
      platform: "darwin",
      sessions: ports.sessions,
      views: ports.views
    }).run({
      ...request,
      kind: "verify",
      parentExitEvidenceSha256: "c".repeat(64),
      expectedCookieInventorySha256:
        evidence.acceptedCookieInventorySha256,
      expectedCookieCount: evidence.readbackCookieCount,
      expectedCookieSkippedCount: evidence.cookieSkippedCount
    }, Buffer.from(envelope));
    expect(verify.outcome).toBe("applied");
  });
});
