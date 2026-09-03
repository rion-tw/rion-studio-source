import { describe, expect, it, vi } from "vitest";

import {
  ElectronFocusedApplicationShortcutController,
  type ElectronFocusedShortcutWindowPort
} from "../src/electron/main/electronFocusedApplicationShortcutController";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeSnapshot";
import type { SystemRuntimeOperationSummaryRecord } from
  "../src/shared/generated";

const applied: SystemRuntimeOperationSummaryRecord = {
  acceptedAt: "2026-08-31T00:00:00.000Z",
  capturedAt: "2026-08-31T00:00:00.100Z",
  completionPolicy: "eventBound",
  completionScope: "nativeAcknowledgement",
  elapsedMs: 100,
  operationId: "operation-1",
  platform: "macos" as const,
  stage: "applied",
  status: "applied" as const,
  subsystem: "presentation" as const,
  trigger: "applicationShortcut"
};

function runtimeSnapshot(platform: "darwin" | "win32"):
ChromiumRuntimeExecutorSnapshot {
  return {
    windows: [{
      windowId: "window-a",
      activeTabId: "tab-a",
      tabIds: ["tab-a"],
      displayId: 7,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      visible: true,
      focused: true,
      presentation: "normal",
      windowGeneration: 3,
      topologyRevision: 9,
      parentNativeHostId: 52,
      ...(platform === "darwin"
        ? {
            appKitIdentity: {
              logicalWindowId: "window-a",
              launchGeneration: "launch-a",
              nativeGeneration: 4
            }
          }
        : {})
    }],
    tabs: [],
    roles: [],
    webSurfaces: []
  };
}

function windowPort(id: number): ElectronFocusedShortcutWindowPort & {
  destroyed: boolean;
  fullscreen: boolean;
} {
  return {
    id,
    destroyed: false,
    fullscreen: false,
    isDestroyed() { return this.destroyed; },
    isFullScreen() { return this.fullscreen; },
    setFullScreen(fullscreen) { this.fullscreen = fullscreen; }
  };
}

function harness(
  platform: "darwin" | "win32" = "darwin",
  snapshot: ChromiumRuntimeExecutorSnapshot = runtimeSnapshot(platform)
) {
  const mainWindow = windowPort(41);
  const runtimeWindow = windowPort(52);
  const executeMainWindowShortcut = vi.fn(async () => undefined);
  const requestMainWindowQuickAccess = vi.fn();
  const requestRuntimeTabQuickAccess = vi.fn();
  const toggleRuntimeWindowFullscreen = vi.fn(async () => applied);
  const zoomRuntimeWindow = vi.fn(async () => applied);
  const controller = new ElectronFocusedApplicationShortcutController({
    platform,
    executeMainWindowShortcut,
    readMainWindow: () => mainWindow,
    readRuntimeSnapshot: () => snapshot,
    requestMainWindowQuickAccess,
    requestRuntimeTabQuickAccess,
    toggleRuntimeWindowFullscreen: toggleRuntimeWindowFullscreen as never,
    zoomRuntimeWindow: zoomRuntimeWindow as never
  });
  return {
    controller,
    executeMainWindowShortcut,
    mainWindow,
    requestMainWindowQuickAccess,
    requestRuntimeTabQuickAccess,
    runtimeWindow,
    snapshot,
    toggleRuntimeWindowFullscreen,
    zoomRuntimeWindow
  };
}

describe("focused native application shortcut controller", () => {
  it("keeps global New Window and Quit on the authenticated main lane", async () => {
    const state = harness();

    await state.controller.execute("newGameWindow", state.runtimeWindow);
    await state.controller.execute("quitApplication", state.runtimeWindow);

    expect(state.executeMainWindowShortcut.mock.calls).toEqual([
      ["newGameWindow"],
      ["quitApplication"]
    ]);
    expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
  });

  it("uses the main window when it is focused or no native target is supplied", async () => {
    const original = runtimeSnapshot("darwin");
    const snapshot: ChromiumRuntimeExecutorSnapshot = {
      ...original,
      windows: [{ ...original.windows[0]!, focused: false }]
    };
    const state = harness("darwin", snapshot);

    await state.controller.execute("zoomIn", state.mainWindow);
    await state.controller.execute("toggleFullscreen");

    expect(state.executeMainWindowShortcut.mock.calls).toEqual([
      ["zoomIn"],
      ["toggleFullscreen"]
    ]);
  });

  it("recovers the exact focused AppKit runtime when Electron omits its BaseWindow", async () => {
    const state = harness();

    await state.controller.execute("toggleFullscreen");

    expect(state.toggleRuntimeWindowFullscreen).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTabId: "tab-a",
        appKitIdentity: expect.objectContaining({ logicalWindowId: "window-a" }),
        parentNativeHostId: 52,
        windowId: "window-a"
      })
    );
    expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
  });

  it("routes native Quick Access to the exact focused runtime or main window", () => {
    const state = harness();

    state.controller.executeQuickAccess();
    state.controller.executeQuickAccess(state.runtimeWindow);
    state.controller.executeQuickAccess(state.mainWindow);

    expect(state.requestRuntimeTabQuickAccess.mock.calls).toEqual([
      ["tab-a"],
      ["tab-a"]
    ]);
    expect(state.requestMainWindowQuickAccess).toHaveBeenCalledTimes(1);
  });

  it.each(["darwin", "win32"] as const)(
    "routes %s runtime fullscreen and zoom through exact native/Core fences",
    async (platform) => {
      const state = harness(platform);

      await state.controller.execute("toggleFullscreen", state.runtimeWindow);
      await state.controller.execute("zoomOut", state.runtimeWindow);

      const expected = {
        activeTabId: "tab-a",
        parentNativeHostId: 52,
        topologyRevision: 9,
        windowGeneration: 3,
        windowId: "window-a"
      };
      expect(state.zoomRuntimeWindow).toHaveBeenCalledWith(
        expect.objectContaining(expected),
        "out"
      );
      expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
      if (platform === "darwin") {
        expect(state.runtimeWindow.fullscreen).toBe(true);
        expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
      } else {
        expect(state.toggleRuntimeWindowFullscreen).toHaveBeenCalledWith(
          expect.objectContaining(expected)
        );
      }
    }
  );

  it("fails closed for unknown, destroyed, or marker-mismatched runtime hosts", async () => {
    const unknown = harness();
    await expect(unknown.controller.execute("zoomIn", windowPort(999)))
      .rejects.toMatchObject({
        code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_UNAVAILABLE"
      });

    const destroyed = harness();
    destroyed.runtimeWindow.destroyed = true;
    await expect(destroyed.controller.execute("zoomIn", destroyed.runtimeWindow))
      .rejects.toMatchObject({ code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE" });

    const mismatch = harness("win32", runtimeSnapshot("darwin"));
    await expect(mismatch.controller.execute("zoomIn", mismatch.runtimeWindow))
      .rejects.toMatchObject({ code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE" });
  });

  it("rejects non-applied Core runtime receipts", async () => {
    const state = harness("win32");
    state.toggleRuntimeWindowFullscreen.mockResolvedValueOnce({
      ...applied,
      status: "superseded"
    });

    await expect(state.controller.execute(
      "toggleFullscreen",
      state.runtimeWindow
    )).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_SHORTCUT_RUNTIME_NOT_APPLIED"
    });
  });
});
