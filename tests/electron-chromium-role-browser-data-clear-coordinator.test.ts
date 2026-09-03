import { posix, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ChromeProfileImportHelperProcessResultInternal } from
  "../src/electron/core/coreAddonClient";
import {
  CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
  ChromiumRoleBrowserDataClearCoordinator,
  type ChromiumRoleBrowserDataClearInput,
  type ChromiumRoleBrowserDataMaintenanceRejection,
  type ChromiumRoleBrowserDataMaintenanceReservation,
  type ChromiumRoleBrowserDataMaintenanceReservationPort
} from "../src/electron/main/chromiumRoleBrowserDataClearCoordinator";
import {
  chromiumRoleBrowserDataClearFreshHelperResponseMetadata,
  parseChromiumRoleBrowserDataClearFreshHelperRequest,
  type ChromiumRoleBrowserDataClearFreshHelperRequest
} from
  "../src/electron/main/chromiumRoleBrowserDataClearFreshHelperContract";
import type { RolePathsRecord } from "../src/shared/generated";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "role-browser-clear-effect";
const OPERATION_ID = "role-browser-clear-operation";

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

function clearInput(
  platform: "darwin" | "win32"
): ChromiumRoleBrowserDataClearInput {
  return {
    roleId: ROLE_ID,
    effectId: EFFECT_ID,
    operationId: OPERATION_ID,
    rolePaths: rolePaths(platform)
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function helperResult(
  request: ChromiumRoleBrowserDataClearFreshHelperRequest,
  options: Readonly<{
    outcome?: "applied" | "failed" | "indeterminate";
    response?: Record<string, unknown>;
    exitEvidenceSha256?: string;
  }> = {}
): ChromeProfileImportHelperProcessResultInternal {
  const outcome = options.outcome ?? "applied";
  return {
    outcome,
    metadataBytes: chromiumRoleBrowserDataClearFreshHelperResponseMetadata(
      request,
      options.response ?? (outcome === "applied"
        ? {
          cookieReadbackCount: 0,
          storageClearAcknowledgement:
            "electron-clear-storage-data-promise",
          processInstanceId: "22222222-2222-4222-8222-222222222222",
          sessionDrainEvidenceSha256: "a".repeat(64)
        }
        : {
          stableErrorCode:
            "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAILED"
        })
    ),
    secretBytes: Buffer.alloc(0),
    exitEvidenceSha256: options.exitEvidenceSha256 ?? "b".repeat(64)
  };
}

function harness(
  platform: "darwin" | "win32",
  options: Readonly<{
    rejectReason?: ChromiumRoleBrowserDataMaintenanceRejection;
    reservation?: Partial<ChromiumRoleBrowserDataMaintenanceReservation>;
    release?: () => unknown;
    launch?: (
      request: ChromiumRoleBrowserDataClearFreshHelperRequest,
      signal?: AbortSignal
    ) => Promise<ChromeProfileImportHelperProcessResultInternal>;
  }> = {}
) {
  const order: string[] = [];
  const requests: ChromiumRoleBrowserDataClearFreshHelperRequest[] = [];
  const reserve = vi.fn((input: ChromiumRoleBrowserDataClearInput) => {
    order.push("reserve-main-path");
    if (options.rejectReason) {
      return { status: "rejected" as const, reason: options.rejectReason };
    }
    return {
      status: "acquired" as const,
      reservation: Object.freeze({
        roleId: input.roleId,
        effectId: input.effectId,
        operationId: input.operationId,
        chromiumUserDataDir: input.rolePaths.chromiumUserDataDir,
        ...options.reservation
      })
    };
  });
  const release = vi.fn((
    _reservation: ChromiumRoleBrowserDataMaintenanceReservation
  ) => {
    order.push("release-main-path");
    return options.release?.() ?? Promise.resolve(true);
  });
  const maintenance: ChromiumRoleBrowserDataMaintenanceReservationPort = {
    reserve,
    release: release as unknown as
      ChromiumRoleBrowserDataMaintenanceReservationPort["release"]
  };
  const launch = vi.fn(async (
    metadataBytes: Buffer,
    secretBytes: Buffer,
    signal?: AbortSignal
  ) => {
    order.push("launch-fresh-helper");
    expect(secretBytes.byteLength).toBe(0);
    const request = parseChromiumRoleBrowserDataClearFreshHelperRequest(
      metadataBytes
    );
    requests.push(request);
    return options.launch
      ? await options.launch(request, signal)
      : helperResult(request);
  });
  const coordinator = new ChromiumRoleBrowserDataClearCoordinator({
    launcher: { launchChromeProfileImportHelperInternal: launch },
    maintenance,
    platform
  });
  return { coordinator, launch, order, release, requests, reserve };
}

describe("ChromiumRoleBrowserDataClearCoordinator", () => {
  it.each(["darwin" as const, "win32" as const])(
    "accepts an exact clean-exit fresh-process clear on %s",
    async (platform) => {
      const subject = harness(platform);
      const input = clearInput(platform);

      await expect(subject.coordinator.clear(input)).resolves.toEqual({
        status: "applied",
        receipt: {
          roleId: ROLE_ID,
          operationId: OPERATION_ID,
          clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
          cookieReadbackCount: 0,
          evidence:
            "electron-clear-storage-data-promise-and-cookie-readback"
        }
      });
      expect(subject.reserve).toHaveBeenCalledWith(input);
      expect(subject.requests).toEqual([expect.objectContaining({
        platform,
        roleId: ROLE_ID,
        effectId: EFFECT_ID,
        operationId: OPERATION_ID,
        rolePaths: input.rolePaths,
        evidenceRevision: 1
      })]);
      expect(subject.order).toEqual([
        "reserve-main-path",
        "launch-fresh-helper",
        "release-main-path"
      ]);
    }
  );

  it.each([
    [{ roleId: "not-a-uuid" },
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_IDENTITY_INVALID"],
    [{ effectId: "" },
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_IDENTITY_INVALID"],
    [{ operationId: "" },
      "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_IDENTITY_INVALID"]
  ] as const)("rejects malformed identity before reservation", async (
    replacement,
    stableErrorCode
  ) => {
    const subject = harness("darwin");
    await expect(subject.coordinator.clear({
      ...clearInput("darwin"),
      ...replacement
    })).resolves.toEqual({
      status: "failed",
      stableErrorCode,
      mutation: "not-started"
    });
    expect(subject.reserve).not.toHaveBeenCalled();
    expect(subject.launch).not.toHaveBeenCalled();
  });

  it("rejects a role/path mismatch before reservation", async () => {
    const subject = harness("darwin");
    const input = clearInput("darwin");
    input.rolePaths.chromiumUserDataDir =
      "/RionData/roles/44444444-4444-4444-8444-444444444444/browser/chromium";
    await expect(subject.coordinator.clear(input)).resolves.toMatchObject({
      status: "failed",
      stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_PATH_MISMATCH"
    });
    expect(subject.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["active-surface", "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_SESSION_ACTIVE"],
    ["active-migration", "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_MIGRATION_ACTIVE"],
    ["active-import", "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_IMPORT_ACTIVE"],
    ["active-maintenance", "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_OPERATION_CONFLICT"],
    ["draining", "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_REGISTRY_DRAINING"],
    ["path-conflict", "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_PATH_CONFLICT"]
  ] satisfies Array<[ChromiumRoleBrowserDataMaintenanceRejection, string]>) (
    "fails closed for reservation rejection %s",
    async (rejectReason, stableErrorCode) => {
      const subject = harness("darwin", { rejectReason });
      await expect(subject.coordinator.clear(clearInput("darwin")))
        .resolves.toEqual({
          status: "failed",
          stableErrorCode,
          mutation: "not-started"
        });
      expect(subject.launch).not.toHaveBeenCalled();
      expect(subject.release).not.toHaveBeenCalled();
    }
  );

  it("coalesces one exact evidence lane and rejects a competing effect", async () => {
    const pending = deferred<ChromeProfileImportHelperProcessResultInternal>();
    const subject = harness("darwin", {
      launch: () => pending.promise
    });
    const input = clearInput("darwin");
    const first = subject.coordinator.clear(input);
    expect(subject.coordinator.clear({
      ...input,
      rolePaths: { ...input.rolePaths }
    })).toBe(first);
    await expect(subject.coordinator.clear({
      ...input,
      effectId: "competing-effect"
    })).resolves.toMatchObject({
      status: "failed",
      stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_OPERATION_CONFLICT"
    });
    pending.resolve(helperResult(subject.requests[0]!));
    await expect(first).resolves.toMatchObject({ status: "applied" });
    expect(subject.reserve).toHaveBeenCalledOnce();
    expect(subject.launch).toHaveBeenCalledOnce();
  });

  it("keeps launch or malformed clean-exit evidence indeterminate", async () => {
    const launchUnknown = harness("darwin", {
      launch: () => Promise.reject(new Error("launcher acknowledgement lost"))
    });
    await expect(launchUnknown.coordinator.clear(clearInput("darwin")))
      .resolves.toEqual({
        status: "indeterminate",
        stableErrorCode:
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_LAUNCH_INDETERMINATE",
        mutation: "unknown"
      });
    expect(launchUnknown.release).toHaveBeenCalledOnce();

    const malformed = harness("darwin", {
      launch: async (request) => helperResult(request, {
        exitEvidenceSha256: "not-a-digest"
      })
    });
    await expect(malformed.coordinator.clear(clearInput("darwin")))
      .resolves.toMatchObject({
        status: "indeterminate",
        stableErrorCode:
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RECEIPT_INVALID"
      });

    const mismatched = harness("darwin", {
      launch: async (request) => helperResult(request, {
        response: {
          effectId: "other-effect",
          cookieReadbackCount: 0,
          storageClearAcknowledgement:
            "electron-clear-storage-data-promise",
          processInstanceId: "22222222-2222-4222-8222-222222222222",
          sessionDrainEvidenceSha256: "a".repeat(64)
        }
      })
    });
    await expect(mismatched.coordinator.clear(clearInput("darwin")))
      .resolves.toMatchObject({
        status: "indeterminate",
        stableErrorCode:
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RECEIPT_INVALID"
      });
  });

  it.each(["failed" as const, "indeterminate" as const])(
    "never promotes a %s child terminal outcome",
    async (outcome) => {
      const subject = harness("darwin", {
        launch: async (request) => helperResult(request, { outcome })
      });
      await expect(subject.coordinator.clear(clearInput("darwin")))
        .resolves.toEqual({
          status: outcome,
          stableErrorCode:
            "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAILED",
          mutation: outcome === "failed" ? "not-started" : "unknown"
        });
      expect(subject.release).toHaveBeenCalledOnce();
    }
  );

  it("rejects a confused reservation before launching the helper", async () => {
    const subject = harness("darwin", {
      reservation: { effectId: "other-effect" }
    });
    await expect(subject.coordinator.clear(clearInput("darwin")))
      .resolves.toEqual({
        status: "failed",
        stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_LEASE_INVALID",
        mutation: "not-started"
      });
    expect(subject.launch).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledOnce();
  });

  it("treats reservation release uncertainty as indeterminate", async () => {
    const subject = harness("darwin", {
      release: () => Promise.reject(new Error("reservation release lost"))
    });
    await expect(subject.coordinator.clear(clearInput("darwin")))
      .resolves.toEqual({
        status: "indeterminate",
        stableErrorCode:
          "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE",
        mutation: "unknown"
      });
  });

  it("rejects pre-abort before reserving or launching", async () => {
    const subject = harness("darwin");
    const controller = new AbortController();
    controller.abort();

    await expect(subject.coordinator.clear(
      clearInput("darwin"),
      controller.signal
    )).resolves.toEqual({
      status: "failed",
      stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED",
      mutation: "not-started"
    });
    expect(subject.reserve).not.toHaveBeenCalled();
    expect(subject.launch).not.toHaveBeenCalled();
    expect(subject.release).not.toHaveBeenCalled();
  });

  it("aborts the exact helper, releases its reservation, and permits reacquisition", async () => {
    let launchCount = 0;
    const subject = harness("darwin", {
      launch: (request, signal) => {
        launchCount += 1;
        if (launchCount > 1) return Promise.resolve(helperResult(request));
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("native helper exited after cancellation"));
          }, { once: true });
        });
      }
    });
    const controller = new AbortController();
    const first = subject.coordinator.clear(
      clearInput("darwin"),
      controller.signal
    );
    await vi.waitFor(() => expect(subject.launch).toHaveBeenCalledOnce());

    controller.abort();
    await expect(first).resolves.toEqual({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED",
      mutation: "unknown"
    });
    expect(subject.release).toHaveBeenCalledOnce();

    await expect(subject.coordinator.clear(clearInput("darwin")))
      .resolves.toMatchObject({ status: "applied" });
    expect(subject.reserve).toHaveBeenCalledTimes(2);
    expect(subject.release).toHaveBeenCalledTimes(2);
  });
});
