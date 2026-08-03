// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppUpdates } from "../src/renderer/src/hooks/useAppUpdates";
import type { RionStudioApi } from "../src/shared/api";
import type { AppUpdateStatus } from "../src/shared/types";

const idleStatus: AppUpdateStatus = {
  autoUpdateEnabled: true,
  currentVersion: "1.0.0",
  installMode: "automatic",
  isPackaged: true,
  state: "idle"
};

const acceptedAttempt = {
  attemptId: "update-install-1",
  targetVersion: "2.0.0",
  phase: "accepted" as const,
  startedAt: "2026-08-03T00:00:00Z",
  updatedAt: "2026-08-03T00:00:00Z"
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  vi.restoreAllMocks();
});

describe("useAppUpdates", () => {
  it("coalesces overlapping checks and permits another check after success", async () => {
    let resolveCheck = (_status: AppUpdateStatus): void => undefined;
    const firstCheck = new Promise<AppUpdateStatus>((resolve) => {
      resolveCheck = resolve;
    });
    const checkForUpdates = vi
      .fn<() => Promise<AppUpdateStatus>>()
      .mockReturnValueOnce(firstCheck)
      .mockResolvedValue(idleStatus);
    installBridge(checkForUpdates);
    const { result } = renderHook(() => useAppUpdates({ enabled: true, onError: vi.fn() }));

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.checkForUpdates();
      duplicate = result.current.checkForUpdates();
    });
    expect(checkForUpdates).toHaveBeenCalledOnce();

    resolveCheck(idleStatus);
    await act(async () => Promise.all([first, duplicate]));
    await act(() => result.current.checkForUpdates());

    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("releases the renderer check gate after an error", async () => {
    const onError = vi.fn();
    const checkForUpdates = vi
      .fn<() => Promise<AppUpdateStatus>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(idleStatus);
    installBridge(checkForUpdates);
    const { result } = renderHook(() => useAppUpdates({ enabled: true, onError }));

    await act(() => result.current.checkForUpdates());
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await act(() => result.current.checkForUpdates());

    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("delegates installation to the verified native update", async () => {
    const installDownloadedUpdate = vi.fn().mockResolvedValue(acceptedAttempt);
    installBridge(vi.fn().mockResolvedValue(idleStatus), installDownloadedUpdate);
    const { result } = renderHook(() => useAppUpdates({ enabled: true, onError: vi.fn() }));

    await act(() => result.current.installDownloadedUpdate());

    expect(installDownloadedUpdate).toHaveBeenCalledOnce();
  });

  it("surfaces startup install failures and treats transaction phases as busy", async () => {
    const failedStatus: AppUpdateStatus = {
      ...idleStatus,
      state: "install_failed",
      availableVersion: "2.0.0",
      canRetryInstall: false,
      errorCode: "UPDATE_INSTALL_VERSION_UNCHANGED",
      installAttempt: {
        ...acceptedAttempt,
        phase: "failedAfterDrain",
        failureCode: "UPDATE_INSTALL_VERSION_UNCHANGED"
      }
    };
    let publishStatus = (_status: AppUpdateStatus): void => undefined;
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        checkForUpdates: vi.fn().mockResolvedValue(idleStatus),
        getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
        getUpdateStatus: vi.fn().mockResolvedValue(failedStatus),
        installDownloadedUpdate: vi.fn().mockResolvedValue(acceptedAttempt),
        onUpdateStatusChanged: vi.fn((callback: (status: AppUpdateStatus) => void) => {
          publishStatus = callback;
          return vi.fn();
        })
      } as unknown as RionStudioApi
    });
    const { result } = renderHook(() => useAppUpdates({ enabled: true, onError: vi.fn() }));

    await waitFor(() => expect(result.current.status?.state).toBe("install_failed"));
    expect(result.current.status?.canRetryInstall).toBe(false);
    expect(result.current.isBusy).toBe(false);

    act(() => publishStatus({ ...failedStatus, state: "installing" }));
    expect(result.current.isBusy).toBe(true);
    act(() => publishStatus({ ...failedStatus, state: "restart_pending" }));
    expect(result.current.isBusy).toBe(true);
    act(() => publishStatus(failedStatus));
    expect(result.current.isBusy).toBe(false);
  });
});

function installBridge(
  checkForUpdates: () => Promise<AppUpdateStatus>,
  installDownloadedUpdate = vi.fn().mockResolvedValue(acceptedAttempt)
): void {
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: {
      checkForUpdates,
      getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
      getUpdateStatus: vi.fn().mockResolvedValue(idleStatus),
      installDownloadedUpdate,
      onUpdateStatusChanged: vi.fn(() => vi.fn())
    } as unknown as RionStudioApi
  });
}
