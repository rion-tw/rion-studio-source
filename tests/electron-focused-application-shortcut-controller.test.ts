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

function emptyRuntimeSnapshot(platform: "darwin" | "win32"): ChromiumRuntimeExecutorSnapshot {
  const snapshot = runtimeSnapshot(platform);
  return { ...snapshot, windows: [{ ...snapshot.windows[0]!, activeTabId: "", tabIds: [] }] };
}

const emptyWindowRoutes = [
  { platform: "darwin", route: "explicit BaseWindow", omittedWindow: false },
  { platform: "win32", route: "explicit native window", omittedWindow: false },
  { platform: "darwin", route: "retained AppKit fallback", omittedWindow: true }
] as const;

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
  const zoomFocusedRuntimeRole = vi.fn(async () => false);
  const controller = new ElectronFocusedApplicationShortcutController({
    platform,
    executeMainWindowShortcut,
    readMainWindow: () => mainWindow,
    readRuntimeSnapshot: () => snapshot,
    requestMainWindowQuickAccess,
    requestRuntimeTabQuickAccess,
    toggleRuntimeWindowFullscreen: toggleRuntimeWindowFullscreen as never,
    zoomRuntimeWindow: zoomRuntimeWindow as never,
    zoomFocusedRuntimeRole
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
    zoomRuntimeWindow,
    zoomFocusedRuntimeRole
  };
}

describe("focused native application shortcut controller", () => {
  it.each(["darwin", "win32"] as const)("routes %s focused workspace zoom without window fanout or failure fallback", async platform => {
    const state = harness(platform);
    state.zoomFocusedRuntimeRole.mockResolvedValue(true);
    await state.controller.execute("zoomIn", state.runtimeWindow);
    expect(state.zoomFocusedRuntimeRole).toHaveBeenCalledWith(expect.objectContaining({ windowId: "window-a", activeTabId: "tab-a" }), "in");
    expect(state.zoomRuntimeWindow).not.toHaveBeenCalled();
    state.zoomFocusedRuntimeRole.mockRejectedValue(new Error("exact Role retired"));
    await expect(state.controller.execute("zoomOut", state.runtimeWindow)).rejects.toThrow("exact Role retired");
    expect(state.zoomRuntimeWindow).not.toHaveBeenCalled();
    expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
  });

  it("uses the same focused Role routing for the retained AppKit menu callback", async () => {
    const state = harness("darwin");
    state.zoomFocusedRuntimeRole.mockResolvedValue(true);
    await state.controller.execute("zoomReset");
    expect(state.zoomFocusedRuntimeRole).toHaveBeenCalledWith(expect.objectContaining({ windowId: "window-a" }), "reset");
    expect(state.zoomRuntimeWindow).not.toHaveBeenCalled();
  });

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

  it.each(emptyWindowRoutes)("allows $platform exact empty-window fullscreen through $route", async ({ platform, omittedWindow }) => {
    const state = harness(platform, emptyRuntimeSnapshot(platform));
    const nativeFullscreen = vi.spyOn(state.runtimeWindow, "setFullScreen");

    await expect(state.controller.execute("toggleFullscreen",
      omittedWindow ? undefined : state.runtimeWindow)).resolves.toBeUndefined();

    if (platform === "darwin" && !omittedWindow) {
      expect(nativeFullscreen).toHaveBeenCalledExactlyOnceWith(true);
      expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
    } else {
      expect(state.toggleRuntimeWindowFullscreen).toHaveBeenCalledExactlyOnceWith({
        activeTabId: "", parentNativeHostId: 52, windowGeneration: 3,
        topologyRevision: 9, windowId: "window-a",
        ...(platform === "darwin" ? { appKitIdentity: {
          logicalWindowId: "window-a", launchGeneration: "launch-a", nativeGeneration: 4
        } } : {})
      });
      expect(nativeFullscreen).not.toHaveBeenCalled();
    }
    expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
    expect(state.zoomFocusedRuntimeRole).not.toHaveBeenCalled();
    expect(state.zoomRuntimeWindow).not.toHaveBeenCalled();
  });

  it.each(emptyWindowRoutes)("keeps $platform empty-window tab commands strict through $route", async ({ platform, omittedWindow }) => {
    const state = harness(platform, emptyRuntimeSnapshot(platform));
    const window = omittedWindow ? undefined : state.runtimeWindow;
    for (const command of ["zoomIn", "zoomOut", "zoomReset"] as const) {
      await expect(state.controller.execute(command, window)).rejects.toMatchObject({
        code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE"
      });
    }
    expect(() => state.controller.executeQuickAccess(window)).toThrow(
      expect.objectContaining({ code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE" })
    );
    expect(state.requestRuntimeTabQuickAccess).not.toHaveBeenCalled();
    expect(state.requestMainWindowQuickAccess).not.toHaveBeenCalled();
    expect(state.zoomFocusedRuntimeRole).not.toHaveBeenCalled();
    expect(state.zoomRuntimeWindow).not.toHaveBeenCalled();
    expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
    expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
    expect(state.runtimeWindow.fullscreen).toBe(false);
  });

  it.each(emptyWindowRoutes)("rejects $platform invisible empty-window fullscreen through $route", async ({ platform, omittedWindow }) => {
    const original = emptyRuntimeSnapshot(platform);
    const snapshot = { ...original, windows: [{ ...original.windows[0]!, visible: false }] };
    const state = harness(platform, snapshot);

    await expect(state.controller.execute("toggleFullscreen",
      omittedWindow ? undefined : state.runtimeWindow)).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE"
    });
    expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
    expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
    expect(state.runtimeWindow.fullscreen).toBe(false);
  });

  describe.each(emptyWindowRoutes)("$platform malformed cohort through $route", ({ platform, omittedWindow }) => {
    it.each([
      { name: "an active tab on an empty cohort", activeTabId: "tab-a", tabIds: [] },
      { name: "a dangling active tab", activeTabId: "orphan", tabIds: ["tab-a"] },
      { name: "no active tab on a populated cohort", activeTabId: "", tabIds: ["tab-a"] }
    ])("rejects fullscreen for $name", async ({ activeTabId, tabIds }) => {
      const original = runtimeSnapshot(platform);
      const snapshot = { ...original, windows: [{ ...original.windows[0]!, activeTabId, tabIds }] };
      const state = harness(platform, snapshot);
      await expect(state.controller.execute("toggleFullscreen",
        omittedWindow ? undefined : state.runtimeWindow)).rejects.toMatchObject({
        code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE"
      });
      expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
      expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
      expect(state.runtimeWindow.fullscreen).toBe(false);
    });
  });

  describe.each(["darwin", "win32"] as const)("%s empty-window fullscreen owner fences", platform => {
    it.each(["native-owner", "generation", "revision", "focus", "dead-host", "platform-marker"] as const)(
      "rejects a stale %s", async invalid => {
        const original = emptyRuntimeSnapshot(platform);
        const runtime = { ...original.windows[0]! };
        if (invalid === "native-owner") runtime.parentNativeHostId = 0;
        if (invalid === "generation") runtime.windowGeneration = 0;
        if (invalid === "revision") runtime.topologyRevision = 0;
        if (invalid === "focus") runtime.focused = false;
        if (invalid === "platform-marker") {
          if (platform === "darwin") delete runtime.appKitIdentity;
          else runtime.appKitIdentity = { logicalWindowId: "window-a",
            launchGeneration: "unexpected-appkit", nativeGeneration: 1 };
        }
        const state = harness(platform, { ...original, windows: [runtime] });
        if (invalid === "dead-host") state.runtimeWindow.destroyed = true;

        await expect(state.controller.execute("toggleFullscreen", state.runtimeWindow))
          .rejects.toMatchObject({ code: invalid === "native-owner"
            ? "ELECTRON_APPLICATION_SHORTCUT_TARGET_UNAVAILABLE"
            : "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE" });
        expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
        expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
        expect(state.runtimeWindow.fullscreen).toBe(false);
      }
    );
  });

  it.each(["logical-window", "launch-generation", "native-generation"] as const)(
    "retains the empty AppKit fallback's exact %s fence", async invalid => {
      const snapshot = emptyRuntimeSnapshot("darwin");
      const identity = snapshot.windows[0]!.appKitIdentity!;
      if (invalid === "logical-window") identity.logicalWindowId = "replaced-window";
      if (invalid === "launch-generation") identity.launchGeneration = "";
      if (invalid === "native-generation") identity.nativeGeneration = 0;
      const state = harness("darwin", snapshot);

      await expect(state.controller.execute("toggleFullscreen")).rejects.toMatchObject({
        code: "ELECTRON_APPLICATION_SHORTCUT_TARGET_STALE"
      });
      expect(state.toggleRuntimeWindowFullscreen).not.toHaveBeenCalled();
      expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
    }
  );

  describe.each(emptyWindowRoutes.filter(route => route.platform === "win32" || route.omittedWindow))(
    "$platform exact empty-window Core receipt through $route", ({ platform, omittedWindow }) => {
      it.each(["superseded", "degraded"] as const)("rejects a %s terminal receipt without fallback", async status => {
        const state = harness(platform, emptyRuntimeSnapshot(platform));
        state.toggleRuntimeWindowFullscreen.mockResolvedValueOnce({ ...applied, status });

        await expect(state.controller.execute("toggleFullscreen",
          omittedWindow ? undefined : state.runtimeWindow)).rejects.toMatchObject({
          code: "ELECTRON_APPLICATION_SHORTCUT_RUNTIME_NOT_APPLIED"
        });
        expect(state.toggleRuntimeWindowFullscreen).toHaveBeenCalledTimes(1);
        expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
        expect(state.runtimeWindow.fullscreen).toBe(false);
      });

      it("propagates the original Core failure without another native submission", async () => {
        const state = harness(platform, emptyRuntimeSnapshot(platform));
        const failure = new Error("The exact empty-window effect was rejected");
        state.toggleRuntimeWindowFullscreen.mockRejectedValueOnce(failure);

        await expect(state.controller.execute("toggleFullscreen",
          omittedWindow ? undefined : state.runtimeWindow)).rejects.toBe(failure);
        expect(state.toggleRuntimeWindowFullscreen).toHaveBeenCalledTimes(1);
        expect(state.executeMainWindowShortcut).not.toHaveBeenCalled();
        expect(state.runtimeWindow.fullscreen).toBe(false);
      });
    }
  );
});
