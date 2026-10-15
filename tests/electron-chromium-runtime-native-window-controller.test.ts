import { describe, expect, it, vi } from "vitest";

import { ChromiumRuntimeNativeWindowController } from
  "../src/electron/main/chromiumRuntimeNativeWindowController";
import type { ChromiumRuntimeWindowActionTarget } from
  "../src/electron/main/chromiumRuntimeNativeWindowController";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeSnapshot";

const windowId = "10000000-0000-4000-8000-000000000001";
const tabId = "20000000-0000-4000-8000-000000000001";

function nativeSnapshot(presentation: "maximized" | "normal" | "fullscreen" = "normal") {
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

function appSnapshot(presentation: "maximized" | "normal" | "fullscreen" = "normal") {
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

function emptyWindowHarness(platform: "darwin" | "win32" = "darwin") {
  const appKitIdentity = { logicalWindowId: windowId, launchGeneration: "launch-empty", nativeGeneration: 5 };
  const native = {
    ...explicitNativeSnapshot(), tabs: [] as Array<ChromiumRuntimeExecutorSnapshot["tabs"][number]>,
    windows: [{ ...explicitNativeSnapshot().windows[0]!, activeTabId: "", tabIds: [] as string[],
      ...(platform === "darwin" ? { appKitIdentity } : {}) }]
  };
  const target: ChromiumRuntimeWindowActionTarget = {
    ...explicitTarget, activeTabId: "", ...(platform === "darwin" ? { appKitIdentity } : {})
  };
  const logical = { ...appSnapshot().logicalWindows[0]!, activeTabId: undefined as string | undefined,
    tabs: [] as Array<{ id: string }> };
  const invoke = vi.fn(async (command: { type: string; presentation?: "normal" | "maximized" | "fullscreen" }) => {
    if (command.type === "appSnapshot") return { logicalWindows: [logical] };
    if (command.type !== "embeddedWindowPresentation") throw new Error("Unexpected command");
    native.windows[0]!.presentation = command.presentation!;
    native.windows[0]!.topologyRevision += 1;
    logical.presentation = command.presentation!;
    logical.revision = native.windows[0]!.topologyRevision;
    return { status: "applied", topologyRevision: logical.revision };
  });
  const subject = new ChromiumRuntimeNativeWindowController({ platform,
    backend: { execute: vi.fn() } as never, core: { invoke } as never,
    readNativeSnapshot: () => native });
  return { subject, invoke, native, logical, target };
}

describe("Core-owned native runtime-window controls", () => {
  it.each(["darwin", "win32"] as const)("allows the exact empty %s window fullscreen target through Core and its terminal readback", async platform => {
    const { subject, invoke, native, target } = emptyWindowHarness(platform);
    await expect(subject.toggleFullscreenForTarget(target)).resolves.toMatchObject({ status: "applied" });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ type: "embeddedWindowPresentation",
      windowId, windowGeneration: 4, topologyRevision: 9, presentation: "fullscreen" }));
    expect(native.windows[0]!.activeTabId).toBe("");
    expect(native.windows[0]!.tabIds).toEqual([]);
  });

  it("keeps empty windows unavailable to zoom and tab-origin fullscreen actions", async () => {
    const { subject, invoke, native, target } = emptyWindowHarness();
    await expect(subject.zoomRuntimeWindow(target, "in")).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE"
    });
    native.tabs.push({ audioMuted: false, audible: false, tabId, windowId });
    await expect(subject.toggleFullscreenForTab(tabId)).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE"
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["admission", "snapshot", "acknowledgement"] as const)(
    "preserves all exact empty-window fences at %s", async boundary => {
      for (const changed of ["focus", "visible", "parent", "generation", "revision", "appkit", "cohort"]) {
        const { subject, invoke, native, logical, target } = emptyWindowHarness();
        const mutate = () => {
          const window = native.windows[0]!;
          if (changed === "focus") window.focused = false;
          if (changed === "visible") window.visible = false;
          if (changed === "parent") window.parentNativeHostId! += 1;
          if (changed === "generation") {
            window.windowGeneration += 1;
            logical.windowGeneration = window.windowGeneration;
          }
          if (changed === "revision") {
            window.topologyRevision += 1;
            logical.revision = window.topologyRevision;
          }
          if (changed === "appkit") window.appKitIdentity = { ...window.appKitIdentity!, nativeGeneration: 6 };
          if (changed === "cohort") {
            window.tabIds = ["new-tab"]; window.activeTabId = "new-tab";
            logical.tabs = [{ id: "new-tab" }]; logical.activeTabId = "new-tab";
          }
        };
        const original = invoke.getMockImplementation()!;
        invoke.mockImplementation(async command => {
          const result = await original(command);
          if ((boundary === "snapshot" && command.type === "appSnapshot") ||
              (boundary === "acknowledgement" && command.type === "embeddedWindowPresentation")) mutate();
          return result;
        });
        if (boundary === "admission") mutate();
        await expect(Promise.resolve().then(() => subject.toggleFullscreenForTarget(target)),
          `${boundary}/${changed}`).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE" });
        expect(invoke.mock.calls.filter(([command]) => command.type === "embeddedWindowPresentation"))
          .toHaveLength(boundary === "acknowledgement" ? 1 : 0);
      }
    }
  );

  it("revalidates an empty fullscreen target after waiting in its exact window lane", async () => {
    const { subject, invoke, target } = emptyWindowHarness();
    let entered!: () => void, release!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async command => {
      if (command.type === "embeddedWindowPresentation") { entered(); await gate; }
      return original(command);
    });
    const first = subject.toggleFullscreenForTarget(target);
    await dispatched;
    const second = expect(subject.toggleFullscreenForTarget(target)).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE"
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "applied" });
    await second;
    expect(invoke.mock.calls.filter(([command]) => command.type === "embeddedWindowPresentation")).toHaveLength(1);
  });

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

  it.each(["normal", "maximized", "fullscreen"] as const)("routes the fullscreen toolbar control through Core from %s", async presentation => {
    const invoke = vi.fn(async (command: { type: string }) => command.type === "appSnapshot"
      ? appSnapshot(presentation) : { status: "applied" });
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute: vi.fn() } as never, core: { invoke } as never,
      platform: "win32", readNativeSnapshot: () => nativeSnapshot(presentation)
    });
    await subject.requestWindowControl(windowId, "toggleFullscreen");
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "embeddedWindowPresentation", windowId, topologyRevision: 9, windowGeneration: 4,
      presentation: presentation === "fullscreen" ? "normal" : "fullscreen"
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

  it("rejects a blurred Win32 fullscreen target now that no owner admits one", async () => {
    const invoke = vi.fn(async (command: { type: string }) => {
      if (command.type === "appSnapshot") return appSnapshot();
      throw new Error(`Unexpected command ${command.type}`);
    });
    const subject = new ChromiumRuntimeNativeWindowController({
      backend: { execute: vi.fn() } as never,
      core: { invoke } as never,
      platform: "win32",
      readNativeSnapshot: () => explicitNativeSnapshot(false)
    });

    // The Win32 shortcut owner no longer dispatches F11, so every fullscreen
    // request arrives from a before-input-event on a focused surface. Nothing
    // may admit a blurred native window any more.
    await expect(subject.toggleFullscreenForTab(tabId)).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE"
    });
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowPresentation"
    }));
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
