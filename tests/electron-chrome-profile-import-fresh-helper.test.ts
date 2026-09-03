import { createHash } from "node:crypto";

import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";

import type {
  ChromeProfileImportTransactionDescriptorInternal
} from "../src/electron/core/coreAddonClient";
import {
  ChromeProfileImportFreshHelper,
  encodeChromeProfileImportFreshHelperRequest,
  parseChromeProfileImportFreshHelperRequest,
  type ChromeProfileImportFreshHelperRequest
} from "../src/electron/main/chromeProfileImportFreshHelper";
import type {
  ChromiumRoleSessionPort,
  ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";

const roleId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const chromiumPath = `/RionData/roles/${roleId}/browser/chromium`;

function descriptor(
  phase: ChromeProfileImportTransactionDescriptorInternal["journalPhase"],
  revision: number,
  replaceExisting = false
): ChromeProfileImportTransactionDescriptorInternal {
  return {
    contractVersion: 1,
    leaseId,
    operationId: `chrome-profile-import-${transactionId}`,
    transactionId,
    roleId,
    journalPhase: phase,
    journalRevision: revision,
    launchUrl: "https://game.example/play",
    launchOrigin: "https://game.example",
    replaceExisting,
    createdRole: !replaceExisting,
    rolePaths: {
      browserUserDataDir: `/RionData/roles/${roleId}/browser`,
      systemBrowserDataDir: `/RionData/roles/${roleId}/browser/system-webview`,
      webview2UserDataDir: `/RionData/roles/${roleId}/browser/system-webview/webview2`,
      chromiumUserDataDir: chromiumPath,
      webkitDataStoreKey: `role:${roleId}:wkwebview`,
      webkitDataStoreIdentifier: roleId
    },
    chromiumPathSha256: createHash("sha256").update(chromiumPath).digest("hex"),
    stagingSha256: "a".repeat(64),
    stagingBytes: 100,
    cookieCount: 1,
    localStorageCount: 1,
    unsupported: {
      partitionedCookieCount: 0,
      appBoundCookieCount: 0,
      decryptFailureCount: 0,
      storageReadFailureCount: 0
    },
    warnings: []
  };
}

function request(
  kind: ChromeProfileImportFreshHelperRequest["kind"],
  phase: ChromeProfileImportTransactionDescriptorInternal["journalPhase"],
  revision: number,
  payloadBytes: number,
  extra: Partial<ChromeProfileImportFreshHelperRequest> = {}
): ChromeProfileImportFreshHelperRequest {
  return {
    version: 1,
    kind,
    descriptor: descriptor(phase, revision),
    payloadBytes,
    ...extra
  };
}

function createNativeSessionStore() {
  const cookies: Cookie[] = [];
  const localStorage = new Map<string, string>();
  const flushStore = vi.fn(async () => undefined);
  const flushStorageData = vi.fn();
  const session = {
    on: vi.fn(),
    cookies: {
      get: vi.fn(async () => cookies.map((cookie) => ({ ...cookie }))),
      set: vi.fn(async (details: CookiesSetDetails) => {
        const url = new URL(details.url);
        cookies.push({
          name: details.name ?? "",
          value: details.value ?? "",
          domain: details.domain === undefined
            ? url.hostname
            : details.domain.startsWith(".") ? details.domain : `.${details.domain}`,
          path: details.path ?? "/",
          secure: details.secure ?? false,
          httpOnly: details.httpOnly ?? false,
          sameSite: details.sameSite ?? "lax",
          hostOnly: details.domain === undefined,
          session: details.expirationDate === undefined,
          ...(details.expirationDate === undefined
            ? {}
            : { expirationDate: details.expirationDate })
        });
      }),
      remove: vi.fn(async (_url: string, name: string) => {
        for (let index = cookies.length - 1; index >= 0; index -= 1) {
          if (cookies[index]?.name === name) cookies.splice(index, 1);
        }
      }),
      flushStore
    },
    flushStorageData,
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn()
  } as unknown as ChromiumRoleSessionPort;
  Object.defineProperty(session, "storagePath", { value: chromiumPath });
  const factory = {
    fromPath: vi.fn(() => session)
  } as ChromiumSessionFactoryPort;
  return { cookies, factory, flushStorageData, localStorage, session };
}

function helper(store: ReturnType<typeof createNativeSessionStore>) {
  return new ChromeProfileImportFreshHelper({
    platform: "darwin",
    sessions: store.factory,
    localStorage: {
      readback: vi.fn(async () => [...store.localStorage.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value }))),
      replaceAndReadback: vi.fn(async (_session, _origin, entries) => {
        store.localStorage.clear();
        for (const entry of entries) store.localStorage.set(entry.key, entry.value);
        return [...entries];
      })
    },
    auth: {
      verify: vi.fn(async (): Promise<"authenticated"> => "authenticated")
    }
  });
}

const payload = Buffer.from(JSON.stringify({
  cookies: [{
    name: "sid",
    value: "secret-cookie",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax"
  }],
  localStorage: [{ key: "session", value: "secret-local-storage" }]
}));

describe("fresh-process Chrome profile import helper", () => {
  it("round-trips strict non-secret request metadata", () => {
    const input = request("apply", "applying", 3, payload.byteLength);
    expect(parseChromeProfileImportFreshHelperRequest(
      encodeChromeProfileImportFreshHelperRequest(input)
    )).toEqual(input);
  });

  it("rejects descriptor extensions and cross-origin authentication probes", () => {
    const input = request("verify", "awaitingFreshVerification", 5, payload.byteLength, {
      parentExitEvidenceSha256: "b".repeat(64),
      authProbe: {
        verificationUrl: "https://other.example/account",
        authenticatedPath: "/account",
        loginPath: "/login"
      }
    });
    expect(() => parseChromeProfileImportFreshHelperRequest(
      encodeChromeProfileImportFreshHelperRequest(input)
    )).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID"
    }));

    const extended = JSON.parse(
      encodeChromeProfileImportFreshHelperRequest({
        ...input,
        authProbe: undefined
      }).toString("utf8")
    );
    extended.descriptor.unfencedPath = "/tmp/other";
    expect(() => parseChromeProfileImportFreshHelperRequest(
      Buffer.from(JSON.stringify(extended))
    )).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID"
    }));
  });

  it("rejects a non-canonical plaintext inventory before opening Session", async () => {
    const store = createNativeSessionStore();
    const noncanonical = Buffer.from(` ${payload.toString("utf8")}`);
    const result = await helper(store).run(
      request("apply", "applying", 3, noncanonical.byteLength),
      noncanonical
    );
    expect(result.outcome).toBe("failed");
    expect(JSON.parse(result.metadataBytes.toString()).stableErrorCode)
      .toBe("CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID");
    expect(store.factory.fromPath).not.toHaveBeenCalled();
    expect([...noncanonical]).toEqual(new Array(noncanonical.byteLength).fill(0));
  });

  it("applies cookies and LocalStorage, then verifies from a second fresh helper", async () => {
    const store = createNativeSessionStore();
    const applySecret = Buffer.from(payload);
    const apply = await helper(store).run(
      request("apply", "applying", 3, payload.byteLength),
      applySecret
    );
    expect(apply.outcome).toBe("applied");
    expect([...applySecret]).toEqual(new Array(applySecret.byteLength).fill(0));
    expect(store.localStorage.get("session")).toBe("secret-local-storage");
    expect(store.cookies).toHaveLength(1);
    expect(store.flushStorageData).toHaveBeenCalled();

    const verifierSecret = Buffer.concat([Buffer.alloc(32, 7), payload]);
    const verify = await helper(store).run(request(
      "verify",
      "awaitingFreshVerification",
      5,
      payload.byteLength,
      { parentExitEvidenceSha256: "b".repeat(64) }
    ), verifierSecret);
    expect(verify.outcome).toBe("applied");
    expect([...verifierSecret]).toEqual(new Array(verifierSecret.byteLength).fill(0));
    const receipt = JSON.parse(verify.metadataBytes.toString());
    expect(receipt).toMatchObject({
      kind: "verify",
      parentExitEvidenceSha256: "b".repeat(64),
      chromiumPathSha256: descriptor("awaitingFreshVerification", 5).chromiumPathSha256,
      inventorySha256: createHash("sha256").update(payload).digest("hex"),
      cookieCount: 1,
      localStorageCount: 1,
      authState: "notApplicable"
    });
    expect(receipt.verifierInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(store.factory.fromPath).toHaveBeenCalledTimes(2);
  });

  it("snapshots both an empty role and an exact existing role inventory", async () => {
    const store = createNativeSessionStore();
    const snapshot = await helper(store).run(
      request("snapshot", "prepared", 1, 0),
      Buffer.alloc(0)
    );
    expect(snapshot.outcome).toBe("applied");
    expect(snapshot.secretBytes.toString()).toBe('{"cookies":[],"localStorage":[]}');

    store.cookies.push({
      name: "sid",
      value: "secret-cookie",
      domain: "game.example",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      hostOnly: true,
      session: true
    });
    store.localStorage.set("session", "secret-local-storage");

    const replaceRequest = request("snapshot", "prepared", 1, 0);
    const replaced = await helper(store).run({
      ...replaceRequest,
      descriptor: descriptor("prepared", 1, true)
    }, Buffer.alloc(0));
    expect(replaced.outcome).toBe("applied");
    expect(replaced.secretBytes).toEqual(payload);
    expect(JSON.parse(replaced.metadataBytes.toString())).toMatchObject({
      kind: "snapshot",
      inventorySha256: createHash("sha256").update(payload).digest("hex"),
      cookieCount: 1,
      localStorageCount: 1
    });
    expect(store.factory.fromPath).toHaveBeenCalledTimes(2);
  });

  it("returns indeterminate after any mutation whose exact readback fails", async () => {
    const store = createNativeSessionStore();
    const testHelper = new ChromeProfileImportFreshHelper({
      platform: "darwin",
      sessions: store.factory,
      localStorage: {
        readback: vi.fn(async () => []),
        replaceAndReadback: vi.fn(async () => [])
      },
      auth: { verify: vi.fn(async (): Promise<"indeterminate"> => "indeterminate") }
    });
    const secret = Buffer.from(payload);
    const result = await testHelper.run(
      request("apply", "applying", 3, payload.byteLength),
      secret
    );
    expect(result.outcome).toBe("indeterminate");
    expect(JSON.parse(result.metadataBytes.toString()).stableErrorCode)
      .toBe("CHROMIUM_PROFILE_IMPORT_FRESH_READBACK_MISMATCH");
  });
});
