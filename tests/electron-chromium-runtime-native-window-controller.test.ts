import { describe, expect, it, vi } from "vitest";

import { ChromiumRuntimeNativeWindowController } from
  "../src/electron/main/chromiumRuntimeNativeWindowController";

const windowId = "10000000-0000-4000-8000-000000000001";
const tabId = "20000000-0000-4000-8000-000000000001";

function nativeSnapshot(presentation: "maximized" | "normal" = "normal") {
  return {
    roles: [],
    tabs: [{ audioMuted: false, audible: false, tabId, windowId }],
    webSurfaces: [],
    windows: [{
      activeTabId: tabId,
      bounds: { height: 680, width: 960, x: 100, y: 80 },
      displayId: 7,
      focused: true,
      presentation,
      tabIds: [tabId],
      topologyRevision: 9,
      visible: true,
      windowGeneration: 4,
      windowId
    }]
  };
}

function explicitNativeSnapshot(focused = true, topologyRevision = 9) {
  const snapshot = nativeSnapshot();
  return {
    ...snapshot,
    windows: [{
      ...snapshot.windows[0],
      focused,
      parentNativeHostId: 77,
      topologyRevision,
      windowZoomFactor: topologyRevision === 9 ? 1 : 1.05
    }]
  };
}

const explicitTarget = {
  activeTabId: tabId,
  parentNativeHostId: 77,
  topologyRevision: 9,
  windowGeneration: 4,
  windowId
} as const;

function appSnapshot(presentation: "maximized" | "normal" = "normal") {
  return {
    logicalWindows: [{
      activeTabId: tabId,
      presentation,
      revision: 9,
      tabs: [{ id: tabId }],
      windowGeneration: 4,
      windowId
    }]
  };
}

describe("Core-owned native runtime-window controls", () => {
  it("maps native activate and close controls to the exact Core-owned tab actions", async () => {
    const execute = vi.fn(async (intent: { action: { type: string } }) => ({
      status: "applied",
      value: intent.action.type === "moveGameWindowTabToNewWindow"
        ? { receipt: { status: "applied" }, targetWindowId: "new-window" }
        : { status: "applied", action: intent.action.type }
    }));
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute } as never,
      core: { invoke: vi.fn() } as never,
      platform: "win32",
      readNativeSnapshot: () => nativeSnapshot()
    });

    await subject.requestTabControl(tabId, { type: "activateTab" });
    await subject.requestTabControl(tabId, { type: "closeTab" });
    await subject.requestTabControl(tabId, { type: "hideTab" });
    await subject.requestTabControl(tabId, { muted: true, type: "setTabMuted" });
    await subject.requestTabControl(tabId, {
      targetWindowId: "target-window",
      type: "moveTab"
    });
    await subject.requestTabControl(tabId, {
      beforeTabId: "before-tab",
      type: "reorderTab"
    });
    await subject.requestTabControl(tabId, { type: "moveTabToNewWindow" });

    expect(execute.mock.calls.map(([intent]) => intent.action)).toEqual([
      { tabId, type: "showGameWindowTab" },
      { tabId, type: "stopGameWindowTab" },
      { hidden: true, tabId, type: "setGameWindowTabHidden" },
      { muted: true, tabId, type: "setGameWindowTabMuted" },
      { tabId, type: "moveGameWindowTab", windowId: "target-window" },
      { beforeTabId: "before-tab", tabId, type: "reorderGameWindowTab" },
      { tabId, type: "moveGameWindowTabToNewWindow" }
    ]);
  });

  it("does not treat a superseded detached-window receipt as applied", async () => {
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: {
        execute: vi.fn(async () => ({
          status: "applied",
          value: {
            receipt: { status: "superseded" },
            targetWindowId: "new-window"
          }
        }))
      } as never,
      core: { invoke: vi.fn() } as never,
      platform: "win32",
      readNativeSnapshot: () => nativeSnapshot()
    });

    await expect(subject.requestTabControl(tabId, { type: "moveTabToNewWindow" }))
      .rejects.toMatchObject({ code: "ELECTRON_RUNTIME_TAB_CONTROL_NOT_APPLIED" });
  });

  it("does not treat a superseded inner tab summary as applied", async () => {
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: {
        execute: vi.fn(async () => ({
          status: "applied",
          value: { status: "superseded" }
        }))
      } as never,
      core: { invoke: vi.fn() } as never,
      platform: "win32",
      readNativeSnapshot: () => nativeSnapshot()
    });

    await expect(subject.requestTabControl(tabId, { type: "activateTab" }))
      .rejects.toMatchObject({ code: "ELECTRON_RUNTIME_TAB_CONTROL_NOT_APPLIED" });
  });

  it("does not treat a superseded inner close summary as applied", async () => {
    const execute = vi.fn(async () => ({
      status: "applied",
      value: { status: "superseded" }
    }));
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute } as never,
      core: { invoke: vi.fn() } as never,
      platform: "win32",
      readNativeSnapshot: () => nativeSnapshot()
    });

    await expect(subject.requestWindowControl(windowId, "closeWindow"))
      .rejects.toMatchObject({ code: "ELECTRON_RUNTIME_WINDOW_CLOSE_NOT_APPLIED" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("awaits the exact Core presentation terminal result", async () => {
    const invoke = vi.fn(async (command: { type: string }) => {
      if (command.type === "appSnapshot") return appSnapshot();
      if (command.type === "embeddedWindowPresentation") {
        return { status: "failed" };
      }
      throw new Error(`Unexpected command ${command.type}`);
    });
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute: vi.fn() } as never,
      core: { invoke } as never,
      platform: "win32",
      readNativeSnapshot: () => nativeSnapshot()
    });

    await expect(subject.requestWindowControl(windowId, "toggleMaximizeWindow"))
      .rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_WINDOW_PRESENTATION_NOT_APPLIED"
      });
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      presentation: "maximized",
      topologyRevision: 9,
      type: "embeddedWindowPresentation",
      windowGeneration: 4,
      windowId
    }));
  });

  it("rejects a presentation request when Core and native readback diverge", async () => {
    const invoke = vi.fn(async () => appSnapshot("maximized"));
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute: vi.fn() } as never,
      core: { invoke } as never,
      platform: "win32",
      readNativeSnapshot: () => nativeSnapshot("normal")
    });

    await expect(subject.requestWindowControl(windowId, "toggleMaximizeWindow"))
      .rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_WINDOW_PRESENTATION_FENCE_STALE"
      });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("revalidates focus after a queued zoom capture", async () => {
    let focused = true;
    const invoke = vi.fn();
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute: vi.fn() } as never,
      core: { invoke } as never,
      platform: "win32",
      readNativeSnapshot: () => explicitNativeSnapshot(focused)
    });

    const pending = subject.zoomRuntimeWindow(explicitTarget, "in");
    focused = false;
    await expect(pending).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE"
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Core zoom receipt before native terminal readback", async () => {
    const invoke = vi.fn(async (command: { operationId: string }) => ({
      operationId: command.operationId,
      windowId,
      windowGeneration: 4,
      sourceTopologyRevision: 9,
      topologyRevision: 10,
      action: "in",
      previousZoomFactor: 0.95,
      nextZoomFactor: 1.05,
      status: "applied",
      roleSurfaceCount: 1,
      globalWebSurfaceCount: 0,
      popupSurfaceCount: 0
    }));
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute: vi.fn() } as never,
      core: { invoke } as never,
      platform: "win32",
      readNativeSnapshot: () => explicitNativeSnapshot()
    });

    await expect(subject.zoomRuntimeWindow(explicitTarget, "in"))
      .rejects.toMatchObject({ code: "ELECTRON_RUNTIME_WINDOW_ZOOM_NOT_APPLIED" });
  });
});
