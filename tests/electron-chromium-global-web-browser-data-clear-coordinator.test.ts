import { describe, expect, it, vi } from "vitest";

import type { Cookie, ClearStorageDataOptions } from "electron";

import type { GlobalWebProfilePathsRecord } from "../src/shared/generated";
import {
  ChromiumGlobalWebBrowserDataClearCoordinator,
  type ChromiumGlobalWebBrowserDataMaintenancePort
} from "../src/electron/main/chromiumGlobalWebBrowserDataClearCoordinator";
import type {
  ChromiumGlobalWebMaintenanceAcquireResult,
  ChromiumGlobalWebMaintenanceLease
} from "../src/electron/main/chromiumGlobalWebSessionRegistry";
import { CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES } from
  "../src/electron/main/chromiumRoleBrowserDataClearCoordinator";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";

const OPERATION_ID = "clear-global-web-11111111-1111-4111-8111-111111111111";

function profile(platform: "darwin" | "win32"): GlobalWebProfilePathsRecord {
  return {
    profileKey: "global-web",
    chromiumUserDataDir: platform === "win32"
      ? "C:\\RionData\\web-profiles\\global-web\\chromium"
      : "/RionData/web-profiles/global-web/chromium"
  };
}

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nativeSession(
  storagePath: string,
  options: Readonly<{
    clear?: () => unknown;
    flush?: () => unknown;
    readback?: () => unknown;
  }> = {}
) {
  const order: string[] = [];
  const clearStorageData = vi.fn((_input?: ClearStorageDataOptions) => {
    order.push("clear");
    return options.clear?.() ?? Promise.resolve(undefined);
  });
  const flushStore = vi.fn(() => {
    order.push("flush");
    return options.flush?.() ?? Promise.resolve(undefined);
  });
  const get = vi.fn(() => {
    order.push("readback");
    return options.readback?.() ?? Promise.resolve([] as Cookie[]);
  });
  const session = {
    storagePath,
    clearStorageData,
    flushStorageData: vi.fn(),
    cookies: { flushStore, get }
  } as unknown as ChromiumRoleSessionPort;
  return { session, clearStorageData, flushStore, get, order };
}

function maintenance(
  platform: "darwin" | "win32",
  options: Readonly<{
    acquisition?: ChromiumGlobalWebMaintenanceAcquireResult;
    release?: () => Promise<boolean>;
    sessionOptions?: Parameters<typeof nativeSession>[1];
    lease?: Partial<ChromiumGlobalWebMaintenanceLease>;
  }> = {}
) {
  const paths = profile(platform);
  const native = nativeSession(
    paths.chromiumUserDataDir,
    options.sessionOptions
  );
  const lease: ChromiumGlobalWebMaintenanceLease = {
    profileKey: "global-web",
    operationId: OPERATION_ID,
    chromiumUserDataDir: paths.chromiumUserDataDir,
    session: native.session,
    ...options.lease
  };
  const acquire = vi.fn(() => options.acquisition ?? {
    status: "acquired" as const,
    lease
  });
  const release = vi.fn(async (): Promise<boolean> => {
    native.order.push("release");
    return options.release ? await options.release() : true;
  });
  const port: ChromiumGlobalWebBrowserDataMaintenancePort = {
    acquire,
    release
  };
  return { paths, native, lease, acquire, release, port };
}

describe("Electron Chromium global Web browser-data clear", () => {
  it.each(["darwin" as const, "win32" as const])(
    "clears and verifies the exact shared %s profile",
    async (platform) => {
      const state = maintenance(platform);
      const subject = new ChromiumGlobalWebBrowserDataClearCoordinator({
        maintenance: state.port,
        platform
      });

      await expect(subject.clear({
        operationId: OPERATION_ID,
        profile: state.paths
      })).resolves.toEqual({
        status: "applied",
        receipt: {
          profileKey: "global-web",
          operationId: OPERATION_ID,
          clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
          cookieReadbackCount: 0,
          evidence: "electron-clear-storage-data-promise-and-cookie-readback"
        }
      });

      expect(state.acquire).toHaveBeenCalledWith(OPERATION_ID, state.paths);
      expect(state.native.clearStorageData).toHaveBeenCalledWith({
        storages: [...CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES]
      });
      expect(state.native.get).toHaveBeenCalledWith({});
      expect(state.release).toHaveBeenCalledWith(state.lease);
      expect(state.native.order).toEqual([
        "clear", "flush", "readback", "release"
      ]);
    }
  );

  it("rejects malformed identity and non-global paths before native acquisition", async () => {
    const state = maintenance("darwin");
    const subject = new ChromiumGlobalWebBrowserDataClearCoordinator({
      maintenance: state.port,
      platform: "darwin"
    });

    await expect(subject.clear({
      operationId: "",
      profile: state.paths
    })).resolves.toMatchObject({
      status: "failed",
      stableErrorCode: "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_IDENTITY_INVALID"
    });
    await expect(subject.clear({
      operationId: OPERATION_ID,
      profile: {
        profileKey: "global-web",
        chromiumUserDataDir: "/RionData/roles/global-web/chromium"
      }
    })).resolves.toMatchObject({
      status: "failed",
      stableErrorCode: "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_PATH_MISMATCH"
    });
    expect(state.acquire).not.toHaveBeenCalled();
  });

  it.each([
    ["active-surface", "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_SESSION_ACTIVE"],
    ["active-maintenance", "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_OPERATION_CONFLICT"],
    ["draining", "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_REGISTRY_DRAINING"],
    ["path-conflict", "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_PATH_CONFLICT"],
    ["releasing", "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_SESSION_RELEASING"]
  ] as const)("fails closed for exclusive lease rejection %s", async (
    reason,
    stableErrorCode
  ) => {
    const state = maintenance("darwin", {
      acquisition: { status: "rejected", reason }
    });
    const subject = new ChromiumGlobalWebBrowserDataClearCoordinator({
      maintenance: state.port,
      platform: "darwin"
    });

    await expect(subject.clear({
      operationId: OPERATION_ID,
      profile: state.paths
    })).resolves.toEqual({
      status: "failed",
      stableErrorCode,
      mutation: "not-started"
    });
    expect(state.native.clearStorageData).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });

  it("coalesces an exact operation and rejects a competing clear", async () => {
    const clearing = deferred();
    const state = maintenance("darwin", {
      sessionOptions: { clear: () => clearing.promise }
    });
    const subject = new ChromiumGlobalWebBrowserDataClearCoordinator({
      maintenance: state.port,
      platform: "darwin"
    });
    const input = { operationId: OPERATION_ID, profile: state.paths };

    const first = subject.clear(input);
    expect(subject.clear({ ...input, profile: { ...input.profile } })).toBe(first);
    await expect(subject.clear({
      ...input,
      operationId: `${OPERATION_ID}-other`
    })).resolves.toMatchObject({
      status: "failed",
      stableErrorCode: "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_OPERATION_CONFLICT"
    });

    clearing.resolve(undefined);
    await expect(first).resolves.toMatchObject({ status: "applied" });
    expect(state.acquire).toHaveBeenCalledOnce();
  });

  it("does not guess success after clear, flush, or readback uncertainty", async () => {
    for (const [sessionOptions, stableErrorCode] of [
      [
        { clear: () => Promise.reject(new Error("clear")) },
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_ACKNOWLEDGEMENT_INDETERMINATE"
      ],
      [
        { flush: () => Promise.reject(new Error("flush")) },
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_FLUSH_INDETERMINATE"
      ],
      [
        { readback: () => Promise.reject(new Error("readback")) },
        "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_INDETERMINATE"
      ]
    ] as const) {
      const state = maintenance("darwin", { sessionOptions });
      const subject = new ChromiumGlobalWebBrowserDataClearCoordinator({
        maintenance: state.port,
        platform: "darwin"
      });
      await expect(subject.clear({
        operationId: OPERATION_ID,
        profile: state.paths
      })).resolves.toEqual({
        status: "indeterminate",
        stableErrorCode,
        mutation: "unknown"
      });
      expect(state.release).toHaveBeenCalledOnce();
    }
  });

  it("reports non-empty cookie readback as partial and release ambiguity as unknown", async () => {
    const nonempty = maintenance("darwin", {
      sessionOptions: {
        readback: () => Promise.resolve([{ name: "sid" }] as Cookie[])
      }
    });
    await expect(new ChromiumGlobalWebBrowserDataClearCoordinator({
      maintenance: nonempty.port,
      platform: "darwin"
    }).clear({
      operationId: OPERATION_ID,
      profile: nonempty.paths
    })).resolves.toEqual({
      status: "failed",
      stableErrorCode: "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_COOKIE_READBACK_NONEMPTY",
      mutation: "partial"
    });

    const releaseUnknown = maintenance("darwin", {
      release: () => Promise.reject(new Error("release"))
    });
    await expect(new ChromiumGlobalWebBrowserDataClearCoordinator({
      maintenance: releaseUnknown.port,
      platform: "darwin"
    }).clear({
      operationId: OPERATION_ID,
      profile: releaseUnknown.paths
    })).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_RELEASE_INDETERMINATE",
      mutation: "unknown"
    });
  });

  it("rejects a maintenance lease whose native session path does not match Core", async () => {
    const state = maintenance("darwin", {
      lease: {
        chromiumUserDataDir: "/RionData/web-profiles/global-web/chromium",
        session: nativeSession(
          "/RionData/web-profiles/other/chromium"
        ).session
      }
    });
    await expect(new ChromiumGlobalWebBrowserDataClearCoordinator({
      maintenance: state.port,
      platform: "darwin"
    }).clear({
      operationId: OPERATION_ID,
      profile: state.paths
    })).resolves.toEqual({
      status: "failed",
      stableErrorCode: "CHROMIUM_GLOBAL_WEB_DATA_CLEAR_LEASE_INVALID",
      mutation: "not-started"
    });
    expect(state.native.clearStorageData).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });
});
