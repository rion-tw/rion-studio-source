import { posix, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ChromiumGlobalWebSessionRegistry,
  type ChromiumGlobalWebProfilePaths
} from "../src/electron/main/chromiumGlobalWebSessionRegistry";
import type {
  ChromiumRoleSessionPort,
  ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";

function profile(
  platform: "darwin" | "win32",
  root?: string
): ChromiumGlobalWebProfilePaths {
  const paths = platform === "win32" ? win32 : posix;
  const userData = root ?? (platform === "win32" ? "C:\\RionData" : "/RionData");
  return {
    profileKey: "global-web",
    chromiumUserDataDir: paths.join(
      userData,
      "web-profiles",
      "global-web",
      "chromium"
    )
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

function createNativeSession(
  storagePath: string,
  cookieFlush = vi.fn<() => Promise<void>>(async () => undefined)
) {
  const handlers: Record<string, unknown> = {};
  const session = {
    on: vi.fn((event, listener) => {
      handlers[event] = listener;
    }),
    storagePath,
    cookies: { flushStore: cookieFlush },
    clearStorageData: vi.fn(async () => undefined),
    flushStorageData: vi.fn(),
    protocol: {},
    setPermissionCheckHandler: vi.fn((handler) => {
      handlers.permissionCheck = handler;
    }),
    setPermissionRequestHandler: vi.fn((handler) => {
      handlers.permissionRequest = handler;
    }),
    setDevicePermissionHandler: vi.fn((handler) => {
      handlers.devicePermission = handler;
    }),
    setDisplayMediaRequestHandler: vi.fn((handler) => {
      handlers.displayMedia = handler;
    }),
    setBluetoothPairingHandler: vi.fn((handler) => {
      handlers.bluetooth = handler;
    })
  } as unknown as ChromiumRoleSessionPort;
  return {
    session,
    handlers,
    flushStorageData: session.flushStorageData,
    cookieFlush
  };
}

function createFactory(
  makeSession: (path: string) => ChromiumRoleSessionPort
): Readonly<{
  factory: ChromiumSessionFactoryPort;
  fromPath: ReturnType<typeof vi.fn>;
}> {
  const fromPath = vi.fn((path: string) => makeSession(path));
  return {
    factory: { fromPath },
    fromPath
  };
}

describe("Chromium global Web session registry", () => {
  it.each([
    ["darwin" as const, "/RionData/web-profiles/global-web/chromium"],
    ["win32" as const, "C:\\RionData\\web-profiles\\global-web\\chromium"]
  ])("shares one exact Rust-owned %s profile across surface leases", (
    platform,
    expectedPath
  ) => {
    const native = createNativeSession(expectedPath);
    const { factory, fromPath } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, platform);

    const first = registry.acquireSurface("web-tab-1-1", 1, profile(platform));
    const duplicate = registry.acquireSurface("web-tab-1-1", 1, profile(platform));
    const second = registry.acquireSurface("web-tab-2-1", 4, profile(platform));

    expect(duplicate).toBe(first);
    expect(first.session).toBe(second.session);
    expect(first).toMatchObject({
      profileKey: "global-web",
      chromiumUserDataDir: expectedPath,
      surfaceId: "web-tab-1-1",
      surfaceGeneration: 1
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(fromPath).toHaveBeenCalledOnce();
    expect(fromPath).toHaveBeenCalledWith(expectedPath, { cache: true });
    expect(registry.activeSurfaceCount).toBe(2);
  });

  it("allows only contained fullscreen and denies device, media, and page permissions", () => {
    const paths = profile("darwin");
    const native = createNativeSession(paths.chromiumUserDataDir);
    const { factory } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");
    registry.acquireSurface("web-tab-1-1", 1, paths);

    expect((native.handlers.permissionCheck as () => false)()).toBe(false);
    const permissionCheck = native.handlers.permissionCheck as (
      contents: unknown,
      permission: string,
      requestingOrigin: string,
      details: { isMainFrame: boolean }
    ) => boolean;
    expect(permissionCheck({}, "fullscreen", "https://fixture.test", {
      isMainFrame: true
    })).toBe(true);
    expect(permissionCheck({}, "fullscreen", "https://fixture.test", {
      isMainFrame: false
    })).toBe(false);
    const permission = vi.fn();
    (native.handlers.permissionRequest as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void)({}, "geolocation", permission);
    expect(permission).toHaveBeenCalledWith(false);
    const fullscreenPermission = vi.fn();
    (native.handlers.permissionRequest as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { isMainFrame: boolean }
    ) => void)({}, "fullscreen", fullscreenPermission, { isMainFrame: true });
    expect(fullscreenPermission).toHaveBeenCalledWith(true);
    expect((native.handlers.devicePermission as () => false)()).toBe(false);
    const media = vi.fn();
    (native.handlers.displayMedia as (
      request: unknown,
      callback: (streams: object) => void
    ) => void)({}, media);
    expect(media).toHaveBeenCalledWith({});
    const bluetooth = vi.fn();
    (native.handlers.bluetooth as (
      details: unknown,
      callback: (response: object) => void
    ) => void)({}, bluetooth);
    expect(bluetooth).toHaveBeenCalledWith({ confirmed: false });
    const download = { preventDefault: vi.fn() };
    (native.handlers["will-download"] as (
      event: { preventDefault: () => void }
    ) => void)(download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });

  it("releases only the final shared lease through exact Chromium flush evidence", async () => {
    const paths = profile("darwin");
    const flush = deferred();
    const native = createNativeSession(
      paths.chromiumUserDataDir,
      vi.fn(() => flush.promise)
    );
    const { factory } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");
    const first = registry.acquireSurface("web-tab-1-1", 1, paths);
    const second = registry.acquireSurface("web-tab-2-1", 1, paths);

    await expect(registry.releaseSurface(first)).resolves.toBe(false);
    expect(native.flushStorageData).not.toHaveBeenCalled();
    const finalRelease = registry.releaseSurface(second);
    expect(registry.releaseSurface(second)).toBe(finalRelease);
    expect(native.flushStorageData).toHaveBeenCalledOnce();
    expect(native.cookieFlush).toHaveBeenCalledOnce();
    expect(() => registry.acquireSurface("web-tab-3-1", 1, paths))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SESSION_RELEASING"
      }));
    flush.resolve();
    await expect(finalRelease).resolves.toBe(true);
    expect(registry.activeSurfaceCount).toBe(0);
    await expect(registry.releaseSurface(second)).resolves.toBe(false);
  });

  it("retains the final lease after an unknown flush and allows an exact retry", async () => {
    const paths = profile("darwin");
    const firstFlush = deferred();
    const native = createNativeSession(
      paths.chromiumUserDataDir,
      vi.fn()
        .mockImplementationOnce(() => firstFlush.promise)
        .mockResolvedValueOnce(undefined)
    );
    const { factory } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");
    const lease = registry.acquireSurface("web-tab-1-1", 1, paths);

    const release = registry.releaseSurface(lease);
    firstFlush.reject(new Error("cookie flush unknown"));
    await expect(release).rejects.toThrow("cookie flush unknown");
    expect(registry.activeSurfaceCount).toBe(1);
    expect(registry.acquireSurface("web-tab-1-1", 1, paths)).toBe(lease);
    await expect(registry.releaseSurface(lease)).resolves.toBe(true);
    expect(native.cookieFlush).toHaveBeenCalledTimes(2);
  });

  it("fences surface generations, permanent path binding, and native storage path", async () => {
    const paths = profile("darwin");
    const native = createNativeSession(paths.chromiumUserDataDir);
    const { factory, fromPath } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");
    const lease = registry.acquireSurface("web-tab-1-1", 1, paths);

    expect(() => registry.acquireSurface("web-tab-1-1", 2, paths))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SESSION_SURFACE_CONFLICT"
      }));
    await registry.releaseSurface(lease);
    expect(() => registry.acquireSurface(
      "web-tab-2-1",
      1,
      profile("darwin", "/MovedRionData")
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_GLOBAL_WEB_SESSION_PATH_CONFLICT"
    }));
    expect(fromPath).toHaveBeenCalledOnce();

    const mismatched = createNativeSession("/RionData/roles/role-1/browser/chromium");
    const other = new ChromiumGlobalWebSessionRegistry(
      createFactory(() => mismatched.session).factory,
      "darwin"
    );
    expect(() => other.acquireSurface("web-tab-1-1", 1, paths))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SESSION_NATIVE_PATH_MISMATCH"
      }));
  });

  it.each([
    { profileKey: "role-1", chromiumUserDataDir: "/RionData/web-profiles/global-web/chromium" },
    { profileKey: "global-web", chromiumUserDataDir: "web-profiles/global-web/chromium" },
    { profileKey: "global-web", chromiumUserDataDir: "/RionData/roles/global-web/chromium" },
    { profileKey: "global-web", chromiumUserDataDir: "/RionData/web-profiles/global-web/not-chromium" }
  ])("rejects a non-Rust-owned profile descriptor %#", (invalid) => {
    const paths = profile("darwin");
    const native = createNativeSession(paths.chromiumUserDataDir);
    const { factory, fromPath } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");

    expect(() => registry.acquireSurface(
      "web-tab-1-1",
      1,
      invalid as ChromiumGlobalWebProfilePaths
    )).toThrow();
    expect(fromPath).not.toHaveBeenCalled();
  });

  it("rejects Windows device paths before Chromium session creation", () => {
    const paths: ChromiumGlobalWebProfilePaths = {
      profileKey: "global-web",
      chromiumUserDataDir:
        "\\\\?\\C:\\RionData\\web-profiles\\global-web\\chromium"
    };
    const native = createNativeSession(paths.chromiumUserDataDir);
    const { factory, fromPath } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "win32");

    expect(() => registry.acquireSurface("web-tab-1-1", 1, paths))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SESSION_PATH_INVALID"
      }));
    expect(fromPath).not.toHaveBeenCalled();
  });

  it("grants an exclusive maintenance lease only after all surfaces release", async () => {
    const paths = profile("darwin");
    const nativeSessions = [
      createNativeSession(paths.chromiumUserDataDir),
      createNativeSession(paths.chromiumUserDataDir)
    ];
    const { factory } = createFactory(() => nativeSessions.shift()!.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");
    const surface = registry.acquireSurface("web-tab-1-1", 1, paths);

    expect(registry.acquireMaintenance("clear-global-web", paths)).toEqual({
      status: "rejected",
      reason: "active-surface"
    });
    await registry.releaseSurface(surface);
    const acquisition = registry.acquireMaintenance("clear-global-web", paths);
    if (acquisition.status !== "acquired") throw new Error("maintenance missing");
    expect(registry.acquireMaintenance("clear-global-web", paths)).toEqual(acquisition);
    expect(registry.acquireMaintenance("other-clear", paths)).toEqual({
      status: "rejected",
      reason: "active-maintenance"
    });
    expect(() => registry.acquireSurface("web-tab-2-1", 1, paths))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SESSION_MAINTENANCE_ACTIVE"
      }));
    await expect(registry.dispose()).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_SESSION_MAINTENANCE_ACTIVE"
    });
    await expect(registry.releaseMaintenance(acquisition.lease)).resolves.toBe(true);
    expect(registry.maintenanceActive).toBe(false);
  });

  it("drains multiple exact leases with one final native flush", async () => {
    const paths = profile("darwin");
    const native = createNativeSession(paths.chromiumUserDataDir);
    const { factory } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "darwin");
    registry.acquireSurface("web-tab-1-1", 1, paths);
    registry.acquireSurface("web-tab-1-2", 1, paths);

    const dispose = registry.dispose();
    expect(() => registry.acquireSurface("web-tab-2-1", 1, paths))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SESSION_REGISTRY_DRAINING"
      }));
    await expect(dispose).resolves.toBeUndefined();
    expect(native.flushStorageData).toHaveBeenCalledOnce();
    expect(native.cookieFlush).toHaveBeenCalledOnce();
    await expect(registry.dispose()).resolves.toBeUndefined();
  });

  it("treats Windows path casing as one exact profile binding", async () => {
    const upper = profile("win32", "C:\\RionData");
    const native = createNativeSession(upper.chromiumUserDataDir.toLowerCase());
    const { factory, fromPath } = createFactory(() => native.session);
    const registry = new ChromiumGlobalWebSessionRegistry(factory, "win32");
    const first = registry.acquireSurface("web-tab-1-1", 1, upper);
    const lower = profile("win32", "c:\\riondata");

    const second = registry.acquireSurface("web-tab-1-2", 1, lower);
    expect(second.session).toBe(first.session);
    expect(fromPath).toHaveBeenCalledOnce();
    await registry.dispose();
  });
});
