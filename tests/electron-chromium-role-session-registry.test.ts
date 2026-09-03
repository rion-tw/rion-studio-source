import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type { RolePathsRecord } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  ChromiumRoleSessionRegistry,
  type AcquireChromiumRoleSessionChromeImportInput,
  type ChromiumRoleSessionPort,
  type ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";
import {
  ChromiumSessionOwnershipLedger
} from "../src/electron/main/chromiumSessionOwnershipLedger";

type PermissionRequest = Parameters<
  ChromiumRoleSessionPort["setPermissionRequestHandler"]
>[0];
type DisplayMediaRequest = Parameters<
  ChromiumRoleSessionPort["setDisplayMediaRequestHandler"]
>[0];
type BluetoothPairingRequest = Parameters<
  ChromiumRoleSessionPort["setBluetoothPairingHandler"]
>[0];

function rolePaths(
  platform: "darwin" | "win32",
  roleId: string,
  root?: string
): RolePathsRecord {
  const paths = platform === "win32" ? win32 : posix;
  const userData = root ?? (platform === "win32" ? "C:\\RionData" : "/RionData");
  const browser = paths.join(userData, "roles", roleId, "browser");
  return {
    browserUserDataDir: browser,
    systemBrowserDataDir: paths.join(browser, "system-webview"),
    webview2UserDataDir: paths.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: paths.join(browser, "chromium"),
    webkitDataStoreKey: `role:${roleId}:wkwebview`,
    webkitDataStoreIdentifier: roleId
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSession(
  cookieFlush = vi.fn<() => Promise<void>>(async () => undefined)
) {
  let permissionCheck: Parameters<
    ChromiumRoleSessionPort["setPermissionCheckHandler"]
  >[0];
  let permissionRequest: PermissionRequest;
  let devicePermission: Parameters<
    ChromiumRoleSessionPort["setDevicePermissionHandler"]
  >[0];
  let displayMediaRequest: DisplayMediaRequest;
  let bluetoothPairingRequest: BluetoothPairingRequest;
  const unsafeConfiguration = {
    clearCache: vi.fn(),
    clearStorageData: vi.fn(),
    setCertificateVerifyProc: vi.fn(),
    setPreloads: vi.fn(),
    setProxy: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() }
  };
  const flushStorageData = vi.fn();
  const session = {
    ...unsafeConfiguration,
    on: vi.fn(),
    cookies: { flushStore: cookieFlush },
    flushStorageData,
    setPermissionCheckHandler: vi.fn((handler) => { permissionCheck = handler; }),
    setPermissionRequestHandler: vi.fn((handler) => { permissionRequest = handler; }),
    setDevicePermissionHandler: vi.fn((handler) => { devicePermission = handler; }),
    setDisplayMediaRequestHandler: vi.fn((handler) => {
      displayMediaRequest = handler;
    }),
    setBluetoothPairingHandler: vi.fn((handler) => {
      bluetoothPairingRequest = handler;
    })
  } as unknown as ChromiumRoleSessionPort;
  return {
    cookieFlush,
    flushStorageData,
    session,
    unsafeConfiguration,
    handlers: {
      permissionCheck: () => permissionCheck,
      permissionRequest: () => permissionRequest,
      devicePermission: () => devicePermission,
      displayMediaRequest: () => displayMediaRequest,
      bluetoothPairingRequest: () => bluetoothPairingRequest
    }
  };
}

function createFactory(session: ChromiumRoleSessionPort) {
  const fromPath = vi.fn((path: string) => {
    if (!("storagePath" in session)) {
      Object.defineProperty(session, "storagePath", { value: path });
    }
    return session;
  });
  return {
    factory: { fromPath } as ChromiumSessionFactoryPort,
    fromPath
  };
}

function chromeImportInput(
  platform: "darwin" | "win32",
  roleId: string,
  overrides: Partial<AcquireChromiumRoleSessionChromeImportInput> = {}
): AcquireChromiumRoleSessionChromeImportInput {
  const chromiumUserDataDir = rolePaths(platform, roleId).chromiumUserDataDir;
  return {
    roleId,
    coreLeaseId: "22222222-2222-4222-8222-222222222222",
    operationId: "chrome-profile-import:33333333-3333-4333-8333-333333333333",
    transactionId: "33333333-3333-4333-8333-333333333333",
    journalPhase: "verified",
    journalRevision: 4,
    launchOrigin: "https://game.example",
    replaceExisting: true,
    chromiumUserDataDir,
    chromiumPathSha256: createHash("sha256")
      .update(chromiumUserDataDir, "utf8")
      .digest("hex"),
    stagingSha256: "a".repeat(64),
    ...overrides
  };
}

describe("Electron Chromium role-session registry", () => {
  it("leases the exact Core Chrome-import destination until cookie flush", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const flush = deferred();
    const native = createSession(vi.fn(() => flush.promise));
    const { factory, fromPath } = createFactory(native.session);
    const ownership = new ChromiumSessionOwnershipLedger("darwin");
    const registry = new ChromiumRoleSessionRegistry(
      factory,
      "darwin",
      ownership
    );
    const input = chromeImportInput("darwin", roleId);

    const lease = registry.acquireChromeImportSession(input);
    expect(registry.acquireChromeImportSession(input)).toBe(lease);
    expect(lease).toMatchObject({
      roleId,
      coreLeaseId: input.coreLeaseId,
      operationId: input.operationId,
      transactionId: input.transactionId,
      journalPhase: "verified",
      journalRevision: 4,
      launchOrigin: input.launchOrigin,
      replaceExisting: true,
      chromiumUserDataDir: input.chromiumUserDataDir,
      chromiumPathSha256: input.chromiumPathSha256,
      stagingSha256: input.stagingSha256,
      session: native.session
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(fromPath).toHaveBeenCalledOnce();
    expect(ownership.activeCount).toBe(1);
    expect(registry.activeChromeImportCount).toBe(1);
    expect(() => registry.ensure(roleId, rolePaths("darwin", roleId)))
      .toThrowError(expect.objectContaining({
        code: "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE"
      }));
    expect(registry.acquireRoleBrowserDataMaintenance({
      roleId,
      operationId: "clear-while-importing",
      rolePaths: rolePaths("darwin", roleId)
    })).toEqual({ status: "rejected", reason: "active-import" });
    expect(() => registry.acquireMigrationSession({
      roleId,
      rolePaths: rolePaths("darwin", roleId),
      transferId: "44444444-4444-4444-8444-444444444444",
      targetRevision: 1
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE"
    }));
    await expect(registry.releaseRole(roleId, input.chromiumUserDataDir))
      .rejects.toMatchObject({ code: "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE" });
    await expect(registry.dispose()).rejects.toMatchObject({
      code: "CHROMIUM_PROFILE_IMPORT_LEASE_ACTIVE"
    });

    const release = registry.releaseChromeImportSession(lease);
    expect(native.flushStorageData).toHaveBeenCalledOnce();
    expect(native.cookieFlush).toHaveBeenCalledOnce();
    expect(ownership.activeCount).toBe(1);
    expect(registry.activeChromeImportCount).toBe(1);
    expect(() => registry.acquireChromeImportSession(input)).toThrowError(
      expect.objectContaining({ code: "CHROMIUM_PROFILE_IMPORT_LEASE_RELEASING" })
    );
    flush.resolve();
    await expect(release).resolves.toBe(true);
    expect(ownership.activeCount).toBe(0);
    expect(registry.activeChromeImportCount).toBe(0);
    expect(registry.activeCount).toBe(0);
  });

  it("advances only the exact Chrome-import journal fence on one native Session", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const input = chromeImportInput("darwin", roleId);
    const first = registry.acquireChromeImportSession(input);

    expect(() => registry.advanceChromeImportSession(first, {
      ...input,
      journalPhase: "awaitingFreshVerification",
      journalRevision: 6
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_REVISION_INVALID"
    }));
    expect(() => registry.advanceChromeImportSession(first, {
      ...input,
      journalPhase: "committing",
      journalRevision: 5
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_PHASE_TRANSITION_INVALID"
    }));
    expect(() => registry.advanceChromeImportSession(first, {
      ...input,
      journalPhase: "awaitingFreshVerification",
      journalRevision: 5,
      stagingSha256: "b".repeat(64)
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_LEASE_CONFLICT"
    }));
    const second = registry.advanceChromeImportSession(first, {
      ...input,
      journalPhase: "awaitingFreshVerification",
      journalRevision: 5
    });
    expect(second).not.toBe(first);
    expect(second).toMatchObject({
      journalPhase: "awaitingFreshVerification",
      journalRevision: 5,
      session: native.session
    });
    expect(Object.isFrozen(second)).toBe(true);
    expect(fromPath).toHaveBeenCalledOnce();
    expect(registry.acquireChromeImportSession({
      ...input,
      journalPhase: "awaitingFreshVerification",
      journalRevision: 5
    })).toBe(second);
    expect(() => registry.acquireChromeImportSession({
      ...input,
      journalPhase: "awaitingFreshVerification",
      journalRevision: 5,
      stagingSha256: "b".repeat(64)
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_LEASE_CONFLICT"
    }));
    expect(() => registry.acquireChromeImportSession(chromeImportInput(
      "darwin",
      "55555555-5555-4555-8555-555555555555",
      {
        coreLeaseId: input.coreLeaseId,
        operationId: input.operationId,
        transactionId: input.transactionId
      }
    ))).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_LEASE_CONFLICT"
    }));
    expect(fromPath).toHaveBeenCalledOnce();
    expect(() => registry.advanceChromeImportSession(first, {
      ...input,
      journalPhase: "awaitingFreshVerification",
      journalRevision: 5
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_LEASE_STALE"
    }));
    await expect(registry.releaseChromeImportSession(first))
      .rejects.toMatchObject({ code: "CHROMIUM_PROFILE_IMPORT_LEASE_STALE" });
    await expect(registry.releaseChromeImportSession(second)).resolves.toBe(true);
    expect(fromPath).toHaveBeenCalledOnce();
  });

  it("rejects Chrome-import conflicts and path identity errors before mutation", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const paths = rolePaths("darwin", roleId);
    const input = chromeImportInput("darwin", roleId);

    const activeNative = createSession();
    const activeRegistry = new ChromiumRoleSessionRegistry(
      createFactory(activeNative.session).factory,
      "darwin"
    );
    activeRegistry.ensure(roleId, paths);
    expect(() => activeRegistry.acquireChromeImportSession(input)).toThrowError(
      expect.objectContaining({ code: "CHROMIUM_PROFILE_IMPORT_SESSION_ACTIVE" })
    );

    const maintenanceNative = createSession();
    const maintenanceRegistry = new ChromiumRoleSessionRegistry(
      createFactory(maintenanceNative.session).factory,
      "darwin"
    );
    const maintenance = maintenanceRegistry.acquireRoleBrowserDataMaintenance({
      roleId,
      operationId: "clear-before-import",
      rolePaths: paths
    });
    if (maintenance.status !== "acquired") throw new Error("lease missing");
    expect(() => maintenanceRegistry.acquireChromeImportSession(input))
      .toThrowError(expect.objectContaining({
        code: "CHROMIUM_PROFILE_IMPORT_MAINTENANCE_ACTIVE"
      }));
    await maintenanceRegistry.releaseRoleBrowserDataMaintenance(maintenance.lease);

    const migrationNative = createSession();
    const migrationRegistry = new ChromiumRoleSessionRegistry(
      createFactory(migrationNative.session).factory,
      "darwin"
    );
    const migration = migrationRegistry.acquireMigrationSession({
      roleId,
      rolePaths: paths,
      transferId: "44444444-4444-4444-8444-444444444444",
      targetRevision: 1
    });
    expect(() => migrationRegistry.acquireChromeImportSession(input))
      .toThrowError(expect.objectContaining({
        code: "CHROMIUM_PROFILE_IMPORT_MIGRATION_ACTIVE"
      }));
    await migrationRegistry.releaseMigrationSession(migration);

    const invalidNative = createSession();
    const invalidFactory = createFactory(invalidNative.session);
    const invalidRegistry = new ChromiumRoleSessionRegistry(
      invalidFactory.factory,
      "darwin"
    );
    expect(() => invalidRegistry.acquireChromeImportSession({
      ...input,
      chromiumPathSha256: "f".repeat(64)
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH"
    }));
    expect(() => invalidRegistry.acquireChromeImportSession({
      ...input,
      launchOrigin: "https://game.example/path"
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_PROFILE_IMPORT_IDENTITY_INVALID"
    }));
    expect(invalidFactory.fromPath).not.toHaveBeenCalled();

    await invalidRegistry.dispose();
    expect(() => invalidRegistry.acquireChromeImportSession(input)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SESSION_REGISTRY_DRAINING" })
    );
  });

  it("retains the Chrome-import lease and shared owner after a failed flush", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const firstFlush = deferred();
    const native = createSession(vi.fn()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce(undefined));
    const ownership = new ChromiumSessionOwnershipLedger("darwin");
    const registry = new ChromiumRoleSessionRegistry(
      createFactory(native.session).factory,
      "darwin",
      ownership
    );
    const input = chromeImportInput("darwin", roleId);
    const lease = registry.acquireChromeImportSession(input);

    const release = registry.releaseChromeImportSession(lease);
    firstFlush.reject(new Error("cookie flush unknown"));
    await expect(release).rejects.toThrow("cookie flush unknown");
    expect(registry.activeChromeImportCount).toBe(1);
    expect(ownership.activeCount).toBe(1);
    expect(registry.acquireChromeImportSession(input)).toBe(lease);
    await expect(registry.releaseChromeImportSession(lease)).resolves.toBe(true);
    expect(native.flushStorageData).toHaveBeenCalledTimes(2);
    expect(native.cookieFlush).toHaveBeenCalledTimes(2);
    expect(registry.activeChromeImportCount).toBe(0);
    expect(ownership.activeCount).toBe(0);
  });

  it("exclusively leases one exact role session to browser-data maintenance", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const paths = rolePaths("darwin", roleId);
    const native = createSession();
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const input = {
      roleId,
      operationId: "browser-clear-operation-1",
      rolePaths: paths
    };

    const acquisition = registry.acquireRoleBrowserDataMaintenance(input);
    expect(acquisition.status).toBe("acquired");
    if (acquisition.status !== "acquired") throw new Error("lease missing");
    const { lease } = acquisition;
    expect(registry.acquireRoleBrowserDataMaintenance(input)).toEqual({
      status: "acquired",
      lease
    });
    expect(registry.acquireRoleBrowserDataMaintenance({
      ...input,
      operationId: "browser-clear-operation-2"
    })).toEqual({ status: "rejected", reason: "active-maintenance" });
    expect(registry.activeMaintenanceCount).toBe(1);
    expect(() => registry.ensure(roleId, paths)).toThrowError(
      expect.objectContaining({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
      })
    );
    expect(() => registry.acquireMigrationSession({
      roleId,
      rolePaths: paths,
      transferId: "22222222-2222-4222-8222-222222222222",
      targetRevision: 1
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
    }));
    await expect(registry.releaseRole(roleId, paths.chromiumUserDataDir))
      .rejects.toMatchObject({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
      });
    await expect(registry.dispose()).rejects.toMatchObject({
      code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
    });
    await expect(registry.releaseRoleBrowserDataMaintenance({ ...lease }))
      .rejects.toMatchObject({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_LEASE_STALE"
      });

    await expect(registry.releaseRoleBrowserDataMaintenance(lease))
      .resolves.toBe(true);
    expect(registry.activeMaintenanceCount).toBe(0);
    expect(native.flushStorageData).toHaveBeenCalledOnce();
    expect(native.cookieFlush).toHaveBeenCalledOnce();
  });

  it("reserves a fresh-helper clear path without opening it in the main process", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const paths = rolePaths("darwin", roleId);
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const input = {
      roleId,
      effectId: "effect-clear-role-browser-data",
      operationId: "operation-clear-role-browser-data",
      rolePaths: paths
    };

    const acquired = registry.reserveRoleBrowserDataMaintenance(input);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("reservation missing");
    expect(fromPath).not.toHaveBeenCalled();
    expect(registry.activeMaintenanceCount).toBe(1);
    expect(registry.reserveRoleBrowserDataMaintenance(input)).toEqual(acquired);
    expect(registry.reserveRoleBrowserDataMaintenance({
      ...input,
      effectId: "competing-effect"
    })).toEqual({ status: "rejected", reason: "active-maintenance" });
    expect(() => registry.ensure(roleId, paths)).toThrowError(
      expect.objectContaining({
        code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
      })
    );
    expect(() => registry.acquireMigrationSession({
      roleId,
      rolePaths: paths,
      transferId: "22222222-2222-4222-8222-222222222222",
      targetRevision: 1
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
    }));
    await expect(registry.dispose()).rejects.toMatchObject({
      code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_ACTIVE"
    });
    await expect(registry.releaseRoleBrowserDataMaintenanceReservation({
      ...acquired.reservation
    })).rejects.toMatchObject({
      code: "CHROMIUM_ROLE_BROWSER_DATA_MAINTENANCE_RESERVATION_STALE"
    });
    await expect(registry.releaseRoleBrowserDataMaintenanceReservation(
      acquired.reservation
    )).resolves.toBe(true);
    expect(registry.activeMaintenanceCount).toBe(0);
    expect(fromPath).not.toHaveBeenCalled();
  });

  it("rejects browser-data maintenance for active surface, migration, drain, and path alias", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const transferId = "22222222-2222-4222-8222-222222222222";
    const input = {
      roleId,
      operationId: "browser-clear-operation",
      rolePaths: rolePaths("darwin", roleId)
    };

    const activeNative = createSession();
    const activeRegistry = new ChromiumRoleSessionRegistry(
      createFactory(activeNative.session).factory,
      "darwin"
    );
    activeRegistry.ensure(roleId, input.rolePaths);
    expect(activeRegistry.acquireRoleBrowserDataMaintenance(input)).toEqual({
      status: "rejected",
      reason: "active-surface"
    });

    const migrationNative = createSession();
    const migrationRegistry = new ChromiumRoleSessionRegistry(
      createFactory(migrationNative.session).factory,
      "darwin"
    );
    const migration = migrationRegistry.acquireMigrationSession({
      roleId,
      rolePaths: input.rolePaths,
      transferId,
      targetRevision: 1
    });
    expect(migrationRegistry.acquireRoleBrowserDataMaintenance(input)).toEqual({
      status: "rejected",
      reason: "active-migration"
    });
    await migrationRegistry.releaseMigrationSession(migration);

    const drainingNative = createSession();
    const drainingRegistry = new ChromiumRoleSessionRegistry(
      createFactory(drainingNative.session).factory,
      "darwin"
    );
    const draining = drainingRegistry.dispose();
    expect(drainingRegistry.acquireRoleBrowserDataMaintenance(input)).toEqual({
      status: "rejected",
      reason: "draining"
    });
    await draining;

    const pathNative = createSession();
    const pathRegistry = new ChromiumRoleSessionRegistry(
      createFactory(pathNative.session).factory,
      "darwin"
    );
    pathRegistry.ensure(roleId, input.rolePaths);
    await pathRegistry.releaseRole(roleId, input.rolePaths.chromiumUserDataDir);
    const movedPaths = rolePaths("darwin", roleId, "/MovedRionData");
    expect(pathRegistry.acquireRoleBrowserDataMaintenance({
      ...input,
      rolePaths: movedPaths
    })).toEqual({ status: "rejected", reason: "path-conflict" });
  });

  it("retains an exact maintenance lease when its release flush is unknown", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const firstFlush = deferred();
    const native = createSession(vi.fn()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce(undefined));
    const registry = new ChromiumRoleSessionRegistry(
      createFactory(native.session).factory,
      "darwin"
    );
    const input = {
      roleId,
      operationId: "browser-clear-operation",
      rolePaths: rolePaths("darwin", roleId)
    };
    const acquisition = registry.acquireRoleBrowserDataMaintenance(input);
    if (acquisition.status !== "acquired") throw new Error("lease missing");

    const release = registry.releaseRoleBrowserDataMaintenance(acquisition.lease);
    expect(registry.acquireRoleBrowserDataMaintenance(input)).toEqual({
      status: "rejected",
      reason: "active-maintenance"
    });
    firstFlush.reject(new Error("flush unknown"));
    await expect(release).rejects.toThrow("flush unknown");
    expect(registry.acquireRoleBrowserDataMaintenance(input)).toEqual({
      status: "acquired",
      lease: acquisition.lease
    });
    await expect(registry.releaseRoleBrowserDataMaintenance(acquisition.lease))
      .resolves.toBe(true);
    expect(registry.activeMaintenanceCount).toBe(0);
  });

  it.each([
    ["darwin" as const, "/RionData/roles/role-1/browser/chromium"],
    ["win32" as const, "C:\\RionData\\roles\\role-1\\browser\\chromium"]
  ])("creates one persistent %s session at the exact Rust path", (platform, expected) => {
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, platform);
    const paths = rolePaths(platform, "role-1");

    const first = registry.ensure("role-1", paths);
    const second = registry.ensure("role-1", paths);

    expect(first).toBe(second);
    expect(first).toEqual({
      roleId: "role-1",
      chromiumUserDataDir: expected,
      session: native.session
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(fromPath).toHaveBeenCalledOnce();
    expect(fromPath).toHaveBeenCalledWith(expected, { cache: true });
    expect(registry.activeCount).toBe(1);
  });

  it("installs explicit deny handlers without taking over request or storage policy", () => {
    const native = createSession();
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    registry.ensure("role-1", rolePaths("darwin", "role-1"));

    expect(native.handlers.permissionCheck()?.(null, "geolocation", "https://game.test", {
      embeddingOrigin: "https://game.test",
      isMainFrame: true,
      mediaType: "unknown"
    })).toBe(false);
    const permissionCallback = vi.fn();
    native.handlers.permissionRequest()?.(
      {} as Electron.WebContents,
      "media",
      permissionCallback,
      {} as Electron.PermissionRequest
    );
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(native.handlers.devicePermission()?.({
      deviceType: "hid",
      origin: "https://game.test"
    } as Electron.DevicePermissionHandlerHandlerDetails)).toBe(false);
    const displayCallback = vi.fn();
    native.handlers.displayMediaRequest()?.(
      {} as Electron.DisplayMediaRequestHandlerHandlerRequest,
      displayCallback
    );
    expect(displayCallback).toHaveBeenCalledWith({});
    const pairingCallback = vi.fn();
    native.handlers.bluetoothPairingRequest()?.(
      {} as Electron.BluetoothPairingHandlerHandlerDetails,
      pairingCallback
    );
    expect(pairingCallback).toHaveBeenCalledWith({ confirmed: false });
    expect(Object.values(native.unsafeConfiguration).flatMap((value) =>
      typeof value === "object" ? Object.values(value) : [value]
    ).every((spy) => !spy.mock.calls.length)).toBe(true);
  });

  it("rejects non-canonical or non-Rust-owned profile paths before fromPath", () => {
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const relative = rolePaths("darwin", "role-1");
    relative.chromiumUserDataDir = "roles/role-1/browser/chromium";
    expect(() => registry.ensure("role-1", relative)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SESSION_PATH_INVALID" })
    );

    const traversing = rolePaths("darwin", "role-1");
    traversing.chromiumUserDataDir = "/RionData/roles/role-1/browser/../browser/chromium";
    expect(() => registry.ensure("role-1", traversing)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SESSION_PATH_INVALID" })
    );

    const sibling = rolePaths("darwin", "role-1");
    sibling.chromiumUserDataDir = "/RionData/roles/role-1/browser/not-chromium";
    expect(() => registry.ensure("role-1", sibling)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SESSION_PATH_MISMATCH" })
    );
    expect(fromPath).not.toHaveBeenCalled();
  });

  it("rejects a fresh role binding to another role's canonical directory", () => {
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");

    expect(() => registry.ensure("role-2", rolePaths("darwin", "role-1")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_PATH_MISMATCH"
      }));
    expect(fromPath).not.toHaveBeenCalled();
    expect(registry.activeCount).toBe(0);
  });

  it("rejects a native session whose storage path differs from the Rust path", () => {
    const native = createSession();
    Object.defineProperty(native.session, "storagePath", {
      value: "/RionData/roles/other/browser/chromium"
    });
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");

    expect(() => registry.ensure("role-1", rolePaths("darwin", "role-1")))
      .toThrowError(expect.objectContaining({
        code: "CHROMIUM_ROLE_SESSION_NATIVE_PATH_MISMATCH"
      }));
    expect(registry.activeCount).toBe(0);
    expect(native.handlers.permissionCheck()).toBeUndefined();
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "nested/role",
    "nested\\role",
    "line\nbreak",
    `control-${String.fromCharCode(0x1f)}`
  ])("matches Rust role-id path-safety validation for %j", (roleId) => {
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");

    expect(() => registry.ensure(roleId, rolePaths("darwin", "role-1")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_ID_INVALID"
      }));
    expect(fromPath).not.toHaveBeenCalled();
  });

  it("fences role, path, and native-session ownership", () => {
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const roleOne = rolePaths("darwin", "role-1");
    registry.ensure("role-1", roleOne);

    expect(() => registry.ensure("role-1", rolePaths("darwin", "role-2")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_PATH_MISMATCH"
      }));
    expect(() => registry.ensure("role-2", roleOne))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_PATH_MISMATCH"
      }));

    expect(() => registry.ensure("role-2", rolePaths("darwin", "role-2")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_NATIVE_ALIAS"
      }));
    expect(fromPath).toHaveBeenCalledTimes(2);
    expect(registry.activeCount).toBe(1);
  });

  it("treats Windows path casing aliases as one profile owner", () => {
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "win32");
    const first = registry.ensure(
      "role-1",
      rolePaths("win32", "role-1", "C:\\RionData")
    );

    const alias = rolePaths("win32", "role-1", "c:\\riondata");
    expect(registry.ensure("role-1", alias)).toBe(first);
    expect(fromPath).toHaveBeenCalledOnce();
  });

  it("keeps ownership fenced until the exact Chromium storage flush settles", async () => {
    const flush = deferred();
    const native = createSession(vi.fn(() => flush.promise));
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const paths = rolePaths("darwin", "role-1");
    registry.ensure("role-1", paths);

    await expect(registry.releaseRole(
      "role-1",
      rolePaths("darwin", "role-2").chromiumUserDataDir
    )).rejects.toMatchObject({ code: "ELECTRON_ROLE_SESSION_OWNERSHIP_CONFLICT" });
    expect(native.flushStorageData).not.toHaveBeenCalled();

    const firstRelease = registry.releaseRole("role-1", paths.chromiumUserDataDir);
    const secondRelease = registry.releaseRole("role-1", paths.chromiumUserDataDir);
    expect(firstRelease).toBe(secondRelease);
    expect(native.flushStorageData).toHaveBeenCalledOnce();
    expect(native.cookieFlush).toHaveBeenCalledOnce();
    expect(registry.activeCount).toBe(1);
    expect(() => registry.ensure("role-1", paths)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SESSION_RELEASING" })
    );

    flush.resolve();
    await expect(firstRelease).resolves.toBe(true);
    expect(registry.activeCount).toBe(0);
    await expect(registry.releaseRole("role-1", paths.chromiumUserDataDir))
      .resolves.toBe(false);
    expect(() => registry.ensure("role-2", paths)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SESSION_PATH_MISMATCH" })
    );
    expect(() => registry.ensure("role-1", rolePaths("darwin", "role-2")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_PATH_MISMATCH"
      }));
    expect(native.unsafeConfiguration.clearCache).not.toHaveBeenCalled();
    expect(native.unsafeConfiguration.clearStorageData).not.toHaveBeenCalled();
  });

  it("retains ownership after a failed flush so an exact release can retry", async () => {
    const firstFlush = deferred();
    const native = createSession(vi.fn()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce(undefined));
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const paths = rolePaths("darwin", "role-1");
    registry.ensure("role-1", paths);

    const release = registry.releaseRole("role-1", paths.chromiumUserDataDir);
    firstFlush.reject(new Error("flush failed"));
    await expect(release).rejects.toThrow("flush failed");
    expect(registry.activeCount).toBe(1);
    expect(registry.ensure("role-1", paths).session).toBe(native.session);
    await expect(registry.releaseRole("role-1", paths.chromiumUserDataDir))
      .resolves.toBe(true);
    expect(native.flushStorageData).toHaveBeenCalledTimes(2);
    expect(native.cookieFlush).toHaveBeenCalledTimes(2);
  });

  it("exclusively fences an exact migration identity until its native release", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const transferId = "22222222-2222-4222-8222-222222222222";
    const native = createSession();
    const { factory, fromPath } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const paths = rolePaths("darwin", roleId);
    const input = { roleId, rolePaths: paths, transferId, targetRevision: 7 };

    const lease = registry.acquireMigrationSession(input);
    expect(registry.acquireMigrationSession(input)).toBe(lease);
    expect(lease).toMatchObject({
      roleId,
      transferId,
      targetRevision: 7,
      chromiumUserDataDir: paths.chromiumUserDataDir,
      session: native.session
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(registry.activeMigrationCount).toBe(1);
    expect(() => registry.ensure(roleId, paths)).toThrowError(
      expect.objectContaining({ code: "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE" })
    );
    await expect(registry.releaseRole(roleId, paths.chromiumUserDataDir))
      .rejects.toMatchObject({ code: "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE" });
    expect(() => registry.acquireMigrationSession({ ...input, targetRevision: 8 }))
      .toThrowError(expect.objectContaining({
        code: "CHROMIUM_SESSION_MIGRATION_LEASE_CONFLICT"
      }));
    await expect(registry.releaseMigrationSession({ ...lease }))
      .rejects.toMatchObject({ code: "CHROMIUM_SESSION_MIGRATION_LEASE_STALE" });

    await expect(registry.releaseMigrationSession(lease)).resolves.toBe(true);
    expect(registry.activeMigrationCount).toBe(0);
    expect(registry.ensure(roleId, paths).session).toBe(native.session);
    expect(fromPath).toHaveBeenCalledTimes(2);
  });

  it("rejects migration acquisition while a normal role session is active", () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const native = createSession();
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const paths = rolePaths("darwin", roleId);
    registry.ensure(roleId, paths);

    expect(() => registry.acquireMigrationSession({
      roleId,
      rolePaths: paths,
      transferId: "22222222-2222-4222-8222-222222222222",
      targetRevision: 1
    })).toThrowError(expect.objectContaining({
      code: "CHROMIUM_SESSION_MIGRATION_SESSION_ACTIVE"
    }));
    expect(registry.activeMigrationCount).toBe(0);
  });

  it("does not let registry drain release an active migration lease", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const native = createSession();
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const paths = rolePaths("darwin", roleId);
    const lease = registry.acquireMigrationSession({
      roleId,
      rolePaths: paths,
      transferId: "22222222-2222-4222-8222-222222222222",
      targetRevision: 1
    });

    await expect(registry.dispose()).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_LEASE_ACTIVE"
    });
    expect(native.cookieFlush).not.toHaveBeenCalled();
    expect(registry.activeMigrationCount).toBe(1);
    await expect(registry.releaseMigrationSession(lease)).resolves.toBe(true);
    await expect(registry.dispose()).resolves.toBeUndefined();
  });

  it("rejects migration reacquisition while its native release is pending", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const flush = deferred();
    const native = createSession(vi.fn(() => flush.promise));
    const { factory } = createFactory(native.session);
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    const input = {
      roleId,
      rolePaths: rolePaths("darwin", roleId),
      transferId: "22222222-2222-4222-8222-222222222222",
      targetRevision: 1
    };
    const lease = registry.acquireMigrationSession(input);

    const release = registry.releaseMigrationSession(lease);
    expect(() => registry.acquireMigrationSession(input)).toThrowError(
      expect.objectContaining({
        code: "CHROMIUM_SESSION_MIGRATION_LEASE_RELEASING"
      })
    );
    flush.resolve();
    await expect(release).resolves.toBe(true);
  });

  it("drains every role on dispose, rejects new work, and supports failed-flush retry", async () => {
    const firstFailure = deferred();
    const firstNative = createSession(vi.fn()
      .mockImplementationOnce(() => firstFailure.promise)
      .mockResolvedValueOnce(undefined));
    const secondNative = createSession();
    const sessions = [firstNative.session, secondNative.session];
    const factory = {
      fromPath: vi.fn((path: string) => {
        const session = sessions.shift() as ChromiumRoleSessionPort;
        Object.defineProperty(session, "storagePath", { value: path });
        return session;
      })
    } satisfies ChromiumSessionFactoryPort;
    const registry = new ChromiumRoleSessionRegistry(factory, "darwin");
    registry.ensure("role-1", rolePaths("darwin", "role-1"));
    registry.ensure("role-2", rolePaths("darwin", "role-2"));

    const disposal = registry.dispose();
    expect(registry.dispose()).toBe(disposal);
    expect(() => registry.ensure("role-3", rolePaths("darwin", "role-3")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_REGISTRY_DRAINING"
      }));
    firstFailure.reject(new Error("role-1 flush failed"));
    await expect(disposal).rejects.toThrow("role-1 flush failed");
    expect(registry.activeCount).toBe(1);

    await expect(registry.dispose()).resolves.toBeUndefined();
    expect(registry.activeCount).toBe(0);
    expect(firstNative.flushStorageData).toHaveBeenCalledTimes(2);
    expect(firstNative.cookieFlush).toHaveBeenCalledTimes(2);
    expect(secondNative.flushStorageData).toHaveBeenCalledOnce();
    expect(secondNative.cookieFlush).toHaveBeenCalledOnce();
    expect(() => registry.ensure("role-3", rolePaths("darwin", "role-3")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SESSION_REGISTRY_DRAINING"
      }));
  });
});
