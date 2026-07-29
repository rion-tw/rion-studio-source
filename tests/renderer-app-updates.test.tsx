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
});

function installBridge(checkForUpdates: () => Promise<AppUpdateStatus>): void {
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: {
      checkForUpdates,
      getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
      getUpdateStatus: vi.fn().mockResolvedValue(idleStatus),
      onUpdateStatusChanged: vi.fn(() => vi.fn())
    } as unknown as RionStudioApi
  });
}
