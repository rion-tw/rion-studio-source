import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type { Cookie, CookiesSetDetails } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionPort,
  type ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";
import {
  ChromiumSessionMigrationImporter,
  type ChromiumSessionMigrationCorePort
} from "../src/electron/main/chromiumSessionMigrationImporter";
import {
  parseChromiumSessionMigrationEnvelope
} from "../src/electron/main/chromiumSessionMigrationCodec";
import {
  ChromiumSessionMigrationLocalStorageCodec,
  type ChromiumMigrationWebContentsPort
} from "../src/electron/main/chromiumSessionMigrationLocalStorage";
import {
  chromiumSessionMigrationFreshHelperResponseMetadata,
  parseChromiumSessionMigrationFreshHelperRequest
} from "../src/electron/main/chromiumSessionMigrationFreshHelperContract";
import type {
  RolePathsRecord,
  RoleSessionMigrationPlatform,
  RoleSessionMigrationRecord
} from "../src/shared/generated";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const TRANSFER_ID = "22222222-2222-4222-8222-222222222222";

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

function rolePaths(platform: "darwin" | "win32"): RolePathsRecord {
  const paths = platform === "win32" ? win32 : posix;
  const root = platform === "win32" ? "C:\\RionData" : "/RionData";
  const browser = paths.join(root, "roles", ROLE_ID, "browser");
  return {
    browserUserDataDir: browser,
    systemBrowserDataDir: paths.join(browser, "system-webview"),
    webview2UserDataDir: paths.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: paths.join(browser, "chromium"),
    webkitDataStoreKey: `role:${ROLE_ID}:wkwebview`,
    webkitDataStoreIdentifier: ROLE_ID
  };
}

interface EnvelopeOptions {
  readonly platform: RoleSessionMigrationPlatform;
  readonly cookie?: Readonly<{
    domain?: string;
    invalidUtf8?: boolean;
    partition?: "unpartitioned" | "partitioned" | "unknown";
    value?: string;
  }>;
  readonly localStorage?: boolean;
}

function migrationFixture(options: EnvelopeOptions): {
  envelope: Buffer;
  journal: RoleSessionMigrationRecord;
} {
  const cookies = options.cookie === undefined ? [] : [{
    name: encoded("session"),
    value: options.cookie.invalidUtf8
      ? { encoding: "base64", data: "/w==" }
      : encoded(options.cookie.value ?? "secret-value"),
    domain: options.cookie.domain ?? "game.example.com",
    path: "/play",
    hostOnly: true,
    secure: true,
    httpOnly: true,
    expiry: { kind: "absolute", unixMs: 1_800_000_000_125 },
    sameSite: "lax",
    partition: options.cookie.partition === "partitioned"
      ? {
        kind: "partitioned",
        partitionKey: encoded("https://top.example.com"),
        hasCrossSiteAncestor: false
      }
      : { kind: options.cookie.partition ?? "unpartitioned" }
  }];
  const localStorage = options.localStorage ? [{
    origin: "https://game.example.com",
    entries: [{
      key: encoded("\ud800-key", "base64Utf16Le"),
      value: encoded("value-\udfff", "base64Utf16Le")
    }]
  }] : [];
  const inventory = { cookies, localStorage };
  const metadata = {
    format: "rion-role-session-transfer",
    version: 1,
    transferId: TRANSFER_ID,
    roleId: ROLE_ID,
    platform: options.platform,
    sourceEngine: options.platform === "macos" ? "wkwebview" : "webview2",
    targetEngine: "chromium",
    sourceRevision: 12,
    ...(options.platform === "windows" ? {
      sourceEvidence: {
        kind: "webview2StorageGetCookies",
        runtimeVersion: "143.0.3650.75",
        protocolVersion: "1.3",
        partitionCapability: "networkCookiePartitionKeyAndOpaque"
      }
    } : {})
  };
  const envelope = Buffer.from(JSON.stringify({ metadata, inventory }));
  const journal: RoleSessionMigrationRecord = {
    roleId: ROLE_ID,
    transferId: TRANSFER_ID,
    phase: "importing",
    journalRevision: 4,
    platform: options.platform,
    sourceEngine: options.platform === "macos" ? "wkwebview" : "webview2",
    targetEngine: "chromium",
    sourceRevision: 12,
    targetRevision: 9,
    envelopeSha256: sha256(envelope),
    inventorySha256: sha256(Buffer.from(JSON.stringify(inventory))),
    cookieCount: cookies.length,
    localStorageOriginCount: localStorage.length,
    localStorageEntryCount: localStorage.reduce(
      (total, origin) => total + origin.entries.length,
      0
    ),
    startedAt: "2026-08-30T00:00:00.000Z",
    phaseChangedAt: "2026-08-30T00:00:01.000Z",
    updatedAt: "2026-08-30T00:00:01.000Z"
  };
  return { envelope, journal };
}

function indeterminateJournal(
  journal: RoleSessionMigrationRecord,
  cleanFlushReceiptId?: string
): RoleSessionMigrationRecord {
  return {
    ...journal,
    phase: "indeterminate",
    journalRevision: journal.journalRevision + 2,
    stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RETRY_REQUIRED",
    outcome: "indeterminate",
    outcomeAt: journal.phaseChangedAt,
    ...(cleanFlushReceiptId ? { cleanFlushReceiptId } : {})
  };
}

function createCore(
  journal: RoleSessionMigrationRecord,
  paths: RolePathsRecord,
  envelope: Buffer
): {
  core: ChromiumSessionMigrationCorePort;
  invoke: ReturnType<typeof vi.fn>;
  readVault: ReturnType<typeof vi.fn>;
  launchHelper: ReturnType<typeof vi.fn>;
  vaultBuffers: Buffer[];
} {
  const invoke = vi.fn(async (command: { type: string }) => {
    if (command.type === "roleSessionMigrationGet") return journal;
    if (command.type === "rolePathsResolve") return paths;
    throw new Error("unexpected command");
  });
  const vaultBuffers: Buffer[] = [];
  const readVault = vi.fn(async () => {
    const bytes = Buffer.from(envelope);
    vaultBuffers.push(bytes);
    return bytes;
  });
  const launchHelper = vi.fn(async () => {
    throw new Error("fresh helper was not configured for this fixture");
  });
  return {
    core: {
      invoke: invoke as unknown as ChromiumSessionMigrationCorePort["invoke"],
      readRoleSessionTransferVaultInternal: readVault,
      launchChromeProfileImportHelperInternal: launchHelper
    },
    invoke,
    readVault,
    launchHelper,
    vaultBuffers
  };
}

function createSession(options: {
  setFailure?: boolean;
  rollbackFailure?: boolean;
  readbackExtra?: boolean;
} = {}) {
  let cookies: Cookie[] = [];
  let clearCount = 0;
  const flushStore = vi.fn<() => Promise<void>>(async () => undefined);
  const get = vi.fn(async () => options.readbackExtra && cookies.length > 0
    ? [...cookies, {
      name: "extra",
      value: "extra",
      domain: "extra.example.com",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      session: true,
      sameSite: "lax"
    } satisfies Cookie]
    : [...cookies]);
  const set = vi.fn(async (details: CookiesSetDetails) => {
    if (options.setFailure) throw new Error("native detail must not escape");
    const url = new URL(details.url);
    cookies = [{
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
    }];
  });
  const clearStorageData = vi.fn(async () => {
    clearCount += 1;
    if (options.rollbackFailure && clearCount > 1) {
      throw new Error("native detail must not escape");
    }
    cookies = [];
  });
  const session = {
    on: vi.fn(),
    cookies: { flushStore, get, set },
    clearStorageData,
    flushStorageData: vi.fn(),
    protocol: {
      handle: vi.fn(),
      unhandle: vi.fn()
    },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn()
  } as unknown as ChromiumRoleSessionPort;
  return { session, clearStorageData, flushStore, get, set };
}

function createRegistry(
  platform: "darwin" | "win32",
  session: ChromiumRoleSessionPort
): {
  registry: ChromiumRoleSessionRegistry;
  fromPath: ReturnType<typeof vi.fn>;
} {
  const fromPath = vi.fn((path: string) => {
    if (!("storagePath" in session)) {
      Object.defineProperty(session, "storagePath", { value: path });
    }
    return session;
  });
  const registry = new ChromiumRoleSessionRegistry(
    { fromPath } as ChromiumSessionFactoryPort,
    platform
  );
  return { registry, fromPath };
}

function importInput() {
  return {
    roleId: ROLE_ID,
    transferId: TRANSFER_ID,
    expectedJournalRevision: 4,
    targetRevision: 9
  };
}

describe("Chromium session migration importer", () => {
  it("rejects a pre-aborted startup before journal, vault, Session, or helper work", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const startupAbort = new AbortController();
    startupAbort.abort("application-before-quit");
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin",
      startupAbort.signal
    );

    expect(() => importer.importRole(importInput())).toThrowError(
      expect.objectContaining({
        code: "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED"
      })
    );
    expect(core.invoke).not.toHaveBeenCalled();
    expect(core.readVault).not.toHaveBeenCalled();
    expect(core.launchHelper).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("retains exact privileged Windows source capability evidence", () => {
    const fixture = migrationFixture({ platform: "windows" });

    expect(parseChromiumSessionMigrationEnvelope(fixture.envelope, {
      journal: fixture.journal,
      platform: "windows"
    }).sourceEvidence).toEqual({
      kind: "webview2StorageGetCookies",
      runtimeVersion: "143.0.3650.75",
      protocolVersion: "1.3",
      partitionCapability: "networkCookiePartitionKeyAndOpaque"
    });
  });

  it("requires exact Windows source capability evidence before acquisition", async () => {
    const fixture = migrationFixture({ platform: "windows", cookie: {} });
    const decoded = JSON.parse(fixture.envelope.toString("utf8")) as {
      metadata: Record<string, unknown>;
    };
    delete decoded.metadata.sourceEvidence;
    const envelope = Buffer.from(JSON.stringify(decoded));
    const journal = { ...fixture.journal, envelopeSha256: sha256(envelope) };
    const paths = rolePaths("win32");
    const core = createCore(journal, paths, envelope);
    const native = createSession();
    const sessions = createRegistry("win32", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "win32"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_SOURCE_EVIDENCE_INVALID"
    });
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin" as const, "macos" as const],
    ["win32" as const, "windows" as const]
  ])("imports and exactly reads back a cookie-only %s inventory", async (
    runtimePlatform,
    migrationPlatform
  ) => {
    const fixture = migrationFixture({
      platform: migrationPlatform,
      cookie: {}
    });
    const paths = rolePaths(runtimePlatform);
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry(runtimePlatform, native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      runtimePlatform
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "applied",
      receipt: {
        roleId: ROLE_ID,
        transferId: TRANSFER_ID,
        targetRevision: 9,
        inventorySha256: fixture.journal.inventorySha256,
        cookieCount: 1,
        localStorageOriginCount: 0,
        localStorageEntryCount: 0,
        cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`
      }
    });
    expect(core.readVault).toHaveBeenCalledWith(ROLE_ID, TRANSFER_ID);
    expect(native.clearStorageData).toHaveBeenCalledOnce();
    expect(native.set).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://game.example.com/play",
      name: "session",
      value: "secret-value",
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1_800_000_000.125
    }));
    expect(native.flushStore).toHaveBeenCalledTimes(3);
    expect(sessions.registry.activeCount).toBe(0);
    expect(sessions.registry.activeMigrationCount).toBe(0);
    expect(sessions.fromPath).toHaveBeenCalledWith(
      paths.chromiumUserDataDir,
      { cache: true }
    );
    expect(core.vaultBuffers[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("waits for an admitted cookie mutation and exact Session release before observing abort", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const applyCookie = native.set.getMockImplementation();
    let resolveSet!: () => void;
    native.set.mockImplementation(async (details) => {
      await new Promise<void>((resolve) => {
        resolveSet = resolve;
      });
      await applyCookie?.(details);
    });
    const sessions = createRegistry("darwin", native.session);
    const startupAbort = new AbortController();
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin",
      startupAbort.signal
    );

    const importing = importer.importRole(importInput());
    const observed = vi.fn();
    void importing.then(observed, observed);
    await vi.waitFor(() => expect(native.set).toHaveBeenCalledOnce());
    startupAbort.abort("application-before-quit");
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    expect(sessions.registry.activeMigrationCount).toBe(1);

    resolveSet();
    await expect(importing).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED"
    });
    expect(sessions.registry.activeMigrationCount).toBe(0);
    expect(native.flushStore).toHaveBeenCalledTimes(3);
  });

  it("does not accept a late applied cookie result until its release fence drains after abort", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    let flushCallCount = 0;
    let resolveRelease!: () => void;
    native.flushStore.mockImplementation(() => {
      flushCallCount += 1;
      return flushCallCount === 3
        ? new Promise<void>((resolve) => { resolveRelease = resolve; })
        : Promise.resolve();
    });
    const sessions = createRegistry("darwin", native.session);
    const startupAbort = new AbortController();
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin",
      startupAbort.signal
    );

    const importing = importer.importRole(importInput());
    const observed = vi.fn();
    void importing.then(observed, observed);
    await vi.waitFor(() => expect(native.flushStore).toHaveBeenCalledTimes(3));
    startupAbort.abort("application-before-quit");
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    expect(sessions.registry.activeMigrationCount).toBe(1);

    resolveRelease();
    await expect(importing).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED"
    });
    expect(sessions.registry.activeMigrationCount).toBe(0);
    expect(native.set).toHaveBeenCalledOnce();
  });

  it("imports a canonical host-only IPv6 cookie without double brackets", async () => {
    const fixture = migrationFixture({
      platform: "macos",
      cookie: { domain: "[::1]" }
    });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toMatchObject({
      status: "applied"
    });
    expect(native.set).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://[::1]/play"
    }));
  });

  it("imports LocalStorage only after an apply helper exits and a fresh helper reads it back", async () => {
    const fixture = migrationFixture({ platform: "macos", localStorage: true });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const exits = ["a".repeat(64), "b".repeat(64)];
    const helperRequests: ReturnType<
      typeof parseChromiumSessionMigrationFreshHelperRequest
    >[] = [];
    core.launchHelper.mockImplementation(async (
      metadataBytes: Buffer,
      secretBytes: Buffer
    ) => {
      const request = parseChromiumSessionMigrationFreshHelperRequest(
        metadataBytes
      );
      helperRequests.push(request);
      expect(secretBytes.equals(fixture.envelope)).toBe(true);
      secretBytes.fill(0);
      const exitEvidenceSha256 = exits.shift()!;
      return {
        outcome: "applied" as const,
        metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
          request,
          {
            readbackCookieCount: 0,
            checkedLocalStorageOriginCount: 1,
            readbackLocalStorageEntryCount: 1,
            surfaceDrainEvidenceSha256: "c".repeat(64),
            ...(request.kind === "verify"
              ? {
                verifierInstanceId:
                  "33333333-3333-4333-8333-333333333333",
                parentExitEvidenceSha256:
                  request.parentExitEvidenceSha256
              }
              : {})
          }
        ),
        secretBytes: Buffer.alloc(0),
        exitEvidenceSha256
      };
    });
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    const result = await importer.importRole(importInput());
    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        roleId: ROLE_ID,
        transferId: TRANSFER_ID,
        targetRevision: 9,
        inventorySha256: fixture.journal.inventorySha256,
        cookieCount: 0,
        localStorageOriginCount: 1,
        localStorageEntryCount: 1
      }
    });
    expect(result.status === "applied" && result.receipt.cleanFlushReceiptId)
      .toMatch(/^chromium-session-fresh:[0-9a-f]{64}$/u);
    expect(core.launchHelper).toHaveBeenCalledTimes(2);
    expect(helperRequests.map(({ kind }) => kind)).toEqual(["apply", "verify"]);
    expect(helperRequests[1]?.parentExitEvidenceSha256).toBe("a".repeat(64));
    expect(native.clearStorageData).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
    expect(core.vaultBuffers[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("cancels and joins the exact startup helper before returning an indeterminate migration", async () => {
    const fixture = migrationFixture({ platform: "macos", localStorage: true });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const startupAbort = new AbortController();
    let announceLaunch!: () => void;
    const launched = new Promise<void>((resolve) => {
      announceLaunch = resolve;
    });
    let helperReaped = false;
    core.launchHelper.mockImplementation((
      _metadataBytes: Buffer,
      _secretBytes: Buffer,
      signal?: AbortSignal
    ) => {
      announceLaunch();
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          queueMicrotask(() => {
            helperReaped = true;
            reject(new Error("native helper exited and its pipes reached EOF"));
          });
        }, { once: true });
      });
    });
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin",
      startupAbort.signal
    );

    const importing = importer.importRole(importInput());
    await launched;
    startupAbort.abort("application-before-quit");

    await expect(importing).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED",
      rollback: "unknown"
    });
    expect(helperReaped).toBe(true);
    expect(core.launchHelper).toHaveBeenCalledOnce();
    expect(core.vaultBuffers[0]?.every((byte) => byte === 0)).toBe(true);
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it("fails closed when LocalStorage fresh helpers cannot establish rollback", async () => {
    const fixture = migrationFixture({ platform: "macos", localStorage: true });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_ROLLBACK_INDETERMINATE",
      rollback: "unknown"
    });
    expect(core.launchHelper).toHaveBeenCalledTimes(2);
  });

  it("uses a read-only fresh verifier when a LocalStorage receipt was already committed", async () => {
    const fixture = migrationFixture({ platform: "macos", localStorage: true });
    const receiptId = `chromium-session-fresh:${"d".repeat(64)}`;
    const journal = {
      ...fixture.journal,
      phase: "verifying" as const,
      cleanFlushReceiptId: receiptId
    };
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, fixture.envelope);
    const helperKinds: string[] = [];
    core.launchHelper.mockImplementation(async (
      metadataBytes: Buffer,
      secretBytes: Buffer
    ) => {
      const request = parseChromiumSessionMigrationFreshHelperRequest(
        metadataBytes
      );
      helperKinds.push(request.kind);
      secretBytes.fill(0);
      return {
        outcome: "applied" as const,
        metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
          request,
          {
            readbackCookieCount: 0,
            checkedLocalStorageOriginCount: 1,
            readbackLocalStorageEntryCount: 1,
            surfaceDrainEvidenceSha256: "e".repeat(64),
            verifierInstanceId:
              "33333333-3333-4333-8333-333333333333",
            committedReceiptId: receiptId
          }
        ),
        secretBytes: Buffer.alloc(0),
        exitEvidenceSha256: "f".repeat(64)
      };
    });
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toMatchObject({
      status: "applied",
      receipt: {
        cleanFlushReceiptId: receiptId,
        localStorageOriginCount: 1,
        localStorageEntryCount: 1
      }
    });
    expect(helperKinds).toEqual(["resumeVerify"]);
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it("freshly verifies an exact empty rollback after LocalStorage verification fails", async () => {
    const fixture = migrationFixture({ platform: "macos", localStorage: true });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const helperKinds: string[] = [];
    const exits = ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)];
    core.launchHelper.mockImplementation(async (
      metadataBytes: Buffer,
      secretBytes: Buffer
    ) => {
      const request = parseChromiumSessionMigrationFreshHelperRequest(
        metadataBytes
      );
      helperKinds.push(request.kind);
      secretBytes.fill(0);
      const exitEvidenceSha256 = exits.shift()!;
      if (request.kind === "verify") {
        return {
          outcome: "failed" as const,
          metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
            request,
            {
              stableErrorCode:
                "CHROMIUM_SESSION_MIGRATION_FRESH_LOCAL_STORAGE_READBACK_MISMATCH"
            }
          ),
          secretBytes: Buffer.alloc(0),
          exitEvidenceSha256
        };
      }
      const imported = request.kind === "apply";
      return {
        outcome: "applied" as const,
        metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
          request,
          {
            readbackCookieCount: 0,
            checkedLocalStorageOriginCount: 1,
            readbackLocalStorageEntryCount: imported ? 1 : 0,
            surfaceDrainEvidenceSha256: "5".repeat(64),
            ...(request.kind === "rollbackVerify"
              ? {
                verifierInstanceId:
                  "33333333-3333-4333-8333-333333333333",
                parentExitEvidenceSha256:
                  request.parentExitEvidenceSha256
              }
              : {})
          }
        ),
        secretBytes: Buffer.alloc(0),
        exitEvidenceSha256
      };
    });
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "failed",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_FRESH_LOCAL_STORAGE_READBACK_MISMATCH",
      rollback: "applied"
    });
    expect(helperKinds).toEqual([
      "apply", "verify", "rollback", "rollbackVerify"
    ]);
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it.each(["partitioned", "unknown"] as const)(
    "rejects %s partition evidence before acquiring or mutating a target session",
    async (partition) => {
    const fixture = migrationFixture({
      platform: "macos",
      cookie: { partition }
    });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED"
    });
    expect(native.clearStorageData).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
    }
  );

  it("rejects cookie bytes that Electron cannot round-trip as UTF-8 strings", async () => {
    const fixture = migrationFixture({
      platform: "macos",
      cookie: { invalidUtf8: true }
    });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED"
    });
    expect(native.set).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical envelope even when its raw digest is committed", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const indentedEnvelope = Buffer.from(JSON.stringify(
      JSON.parse(fixture.envelope.toString("utf8")),
      null,
      2
    ));
    const journal = {
      ...fixture.journal,
      envelopeSha256: sha256(indentedEnvelope)
    };
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, indentedEnvelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_ENVELOPE_INVALID"
    });
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it("rolls a failed cookie apply back to a flushed exact empty target", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession({ setFailure: true });
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "failed",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_APPLY_FAILED",
      rollback: "applied"
    });
    expect(native.clearStorageData).toHaveBeenCalledTimes(2);
    expect(native.flushStore).toHaveBeenCalledTimes(3);
    expect(sessions.registry.activeMigrationCount).toBe(0);
    expect(sessions.registry.ensure(ROLE_ID, paths).session).toBe(native.session);
  });

  it("releases the lease when cookie rollback cannot prove the target state", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession({ setFailure: true, rollbackFailure: true });
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_COOKIE_ROLLBACK_INDETERMINATE",
      rollback: "unknown"
    });
    expect(sessions.registry.activeMigrationCount).toBe(0);
    expect(sessions.registry.ensure(ROLE_ID, paths).session).toBe(native.session);
  });

  it("quarantines an exact target when native release cannot acknowledge completion", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    native.flushStore
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("native detail must not escape"));
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RELEASE_INDETERMINATE",
      rollback: "unknown"
    });
    expect(sessions.registry.activeMigrationCount).toBe(1);
    expect(() => sessions.registry.ensure(ROLE_ID, paths)).toThrowError(
      expect.objectContaining({ code: "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE" })
    );
  });

  it("treats a non-true migration release acknowledgement as indeterminate", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    vi.spyOn(sessions.registry, "releaseMigrationSession")
      .mockResolvedValueOnce(false);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RELEASE_INDETERMINATE",
      rollback: "unknown"
    });
  });

  it("rolls back when Chromium returns any changed or extra cookie", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession({ readbackExtra: true });
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "failed",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_APPLY_FAILED",
      rollback: "applied"
    });
    expect(native.clearStorageData).toHaveBeenCalledTimes(2);
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("rolls back an applied target when the Core revision fence changes", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    let journalReadCount = 0;
    const core = createCore(fixture.journal, paths, fixture.envelope);
    core.invoke.mockImplementation(async (command: { type: string }) => {
      if (command.type === "rolePathsResolve") return paths;
      journalReadCount += 1;
      return journalReadCount < 3
        ? fixture.journal
        : { ...fixture.journal, journalRevision: 5 };
    });
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).resolves.toEqual({
      status: "failed",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_REVISION_FENCE_FAILED",
      rollback: "applied"
    });
    expect(native.clearStorageData).toHaveBeenCalledTimes(2);
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("rejects a changed Core revision before acquiring or mutating Chromium", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    let journalReadCount = 0;
    const core = createCore(fixture.journal, paths, fixture.envelope);
    core.invoke.mockImplementation(async (command: { type: string }) => {
      if (command.type === "rolePathsResolve") return paths;
      journalReadCount += 1;
      return journalReadCount === 1
        ? fixture.journal
        : { ...fixture.journal, journalRevision: 5 };
    });
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_REVISION_STALE"
    });
    expect(native.clearStorageData).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
    expect(core.vaultBuffers[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("maps a native profile-path mismatch to a generic migration error", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    Object.defineProperty(native.session, "storagePath", {
      value: "/RionData/roles/other/browser/chromium"
    });
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_SESSION_ACQUIRE_FAILED",
      message: "The exact Chromium role session could not be leased for migration."
    });
    expect(native.clearStorageData).not.toHaveBeenCalled();
  });

  it("rejects stale journal revisions before reading secrets or opening Chromium", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole({
      ...importInput(),
      expectedJournalRevision: 3
    })).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_REVISION_STALE"
    });
    expect(core.readVault).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });

  it("deduplicates the same in-flight identity and rejects a competing revision", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const paths = rolePaths("darwin");
    const core = createCore(fixture.journal, paths, fixture.envelope);
    const native = createSession();
    let releaseFlush!: () => void;
    native.flushStore.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFlush = resolve;
    }));
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    const first = importer.importRole(importInput());
    const duplicate = importer.importRole(importInput());
    expect(duplicate).toBe(first);
    await expect(importer.importRole({ ...importInput(), targetRevision: 10 }))
      .rejects.toMatchObject({
        code: "CHROMIUM_SESSION_MIGRATION_OPERATION_CONFLICT"
      });
    releaseFlush();
    await expect(first).resolves.toMatchObject({ status: "applied" });
    expect(core.readVault).toHaveBeenCalledOnce();
  });

  it("readback-verifies a pinned cookie receipt without reapplying the target", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const journal = {
      ...fixture.journal,
      phase: "verifying" as const,
      cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`
    };
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, fixture.envelope);
    const native = createSession();
    await native.set({
      url: "https://game.example.com/play",
      name: "session",
      value: "secret-value",
      path: "/play",
      secure: true,
      httpOnly: true,
      expirationDate: 1_800_000_000.125,
      sameSite: "lax"
    });
    native.set.mockClear();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    const first = await importer.importRole(importInput());
    const retry = await importer.importRole(importInput());
    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      status: "applied",
      receipt: { cleanFlushReceiptId: journal.cleanFlushReceiptId }
    });
    expect(native.clearStorageData).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
    expect(core.readVault).toHaveBeenCalledTimes(2);
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("reapplies and verifies an indeterminate cookie transfer without a receipt", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const journal = indeterminateJournal(fixture.journal);
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole({
      ...importInput(),
      expectedJournalRevision: journal.journalRevision
    })).resolves.toMatchObject({
      status: "applied",
      receipt: {
        cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`
      }
    });
    expect(native.clearStorageData).toHaveBeenCalledOnce();
    expect(native.set).toHaveBeenCalledOnce();
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("uses only exact readback for a pinned indeterminate cookie receipt", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const receiptId = `chromium-cookie-flush:${TRANSFER_ID}:9`;
    const journal = indeterminateJournal(fixture.journal, receiptId);
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, fixture.envelope);
    const native = createSession();
    await native.set({
      url: "https://game.example.com/play",
      name: "session",
      value: "secret-value",
      path: "/play",
      secure: true,
      httpOnly: true,
      expirationDate: 1_800_000_000.125,
      sameSite: "lax"
    });
    native.set.mockClear();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole({
      ...importInput(),
      expectedJournalRevision: journal.journalRevision
    })).resolves.toMatchObject({
      status: "applied",
      receipt: { cleanFlushReceiptId: receiptId }
    });
    expect(native.clearStorageData).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("keeps a failed pinned indeterminate verify non-mutating and indeterminate", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const receiptId = `chromium-cookie-flush:${TRANSFER_ID}:9`;
    const journal = indeterminateJournal(fixture.journal, receiptId);
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole({
      ...importInput(),
      expectedJournalRevision: journal.journalRevision
    })).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_COOKIE_VERIFY_INDETERMINATE",
      rollback: "unknown"
    });
    expect(native.clearStorageData).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
    expect(sessions.registry.activeMigrationCount).toBe(0);
  });

  it("rejects a verifying journal with a different Chromium flush receipt", async () => {
    const fixture = migrationFixture({ platform: "macos", cookie: {} });
    const journal = {
      ...fixture.journal,
      phase: "verifying" as const,
      cleanFlushReceiptId: "different-receipt"
    };
    const paths = rolePaths("darwin");
    const core = createCore(journal, paths, fixture.envelope);
    const native = createSession();
    const sessions = createRegistry("darwin", native.session);
    const importer = new ChromiumSessionMigrationImporter(
      core.core,
      sessions.registry,
      "darwin"
    );

    await expect(importer.importRole(importInput())).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_RECEIPT_MISMATCH"
    });
    expect(core.readVault).not.toHaveBeenCalled();
    expect(sessions.fromPath).not.toHaveBeenCalled();
  });
});

describe("Chromium session migration LocalStorage codec", () => {
  it("uses a session-scoped controlled origin and exact destroyed event without claiming flush", async () => {
    const native = createSession();
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    const handle = vi.fn((_scheme: string, nextHandler: typeof handler) => {
      handler = nextHandler;
    });
    const unhandle = vi.fn();
    (native.session.protocol.handle as unknown) = handle;
    (native.session.protocol.unhandle as unknown) = unhandle;
    let currentUrl = "";
    let destroyedListener: (() => void) | undefined;
    const executeJavaScript = vi.fn(async () => [["\ud800-key", "value-\udfff"]]);
    const contents: ChromiumMigrationWebContentsPort = {
      session: native.session,
      close: vi.fn(() => destroyedListener?.()),
      executeJavaScript,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      loadURL: vi.fn(async (url) => {
        currentUrl = url;
        const response = await handler?.(new Request(url));
        expect(response?.status).toBe(200);
      }),
      once: vi.fn((_event, listener) => {
        destroyedListener = listener;
      }),
      setWindowOpenHandler: vi.fn()
    };
    const create = vi.fn(() => ({ webContents: contents }));
    const codec = new ChromiumSessionMigrationLocalStorageCodec({ create });

    await expect(codec.replaceAndReadback(
      native.session,
      "https://game.example.com",
      [{ key: "\ud800-key", value: "value-\udfff" }]
    )).resolves.toEqual([{ key: "\ud800-key", value: "value-\udfff" }]);
    expect(handle).toHaveBeenCalledWith("https", expect.any(Function));
    expect(create).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: native.session,
        webSecurity: true
      })
    });
    const denied = await handler?.(new Request("https://other.example.com/"));
    expect(denied?.status).toBe(403);
    expect(unhandle).toHaveBeenCalledWith("https");
    expect(native.session.flushStorageData).not.toHaveBeenCalled();
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("localStorage.setItem"),
      false
    );
  });

  it("rejects any changed LocalStorage readback", async () => {
    const native = createSession();
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    (native.session.protocol.handle as unknown) = vi.fn(
      (_scheme: string, nextHandler: typeof handler) => { handler = nextHandler; }
    );
    let destroyedListener: (() => void) | undefined;
    const contents: ChromiumMigrationWebContentsPort = {
      session: native.session,
      close: vi.fn(() => destroyedListener?.()),
      executeJavaScript: vi.fn(async () => [["key", "changed"]]),
      getURL: () => "https://game.example.com/.__rion_session_migration__",
      isDestroyed: () => false,
      loadURL: vi.fn(async (url) => {
        await handler?.(new Request(url));
      }),
      once: vi.fn((_event, listener) => { destroyedListener = listener; }),
      setWindowOpenHandler: vi.fn()
    };
    const codec = new ChromiumSessionMigrationLocalStorageCodec({
      create: () => ({ webContents: contents })
    });

    await expect(codec.replaceAndReadback(
      native.session,
      "https://game.example.com",
      [{ key: "key", value: "expected" }]
    )).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_READBACK_FAILED"
    });
  });
});
