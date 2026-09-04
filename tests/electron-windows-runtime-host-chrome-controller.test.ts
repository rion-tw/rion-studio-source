import { describe, expect, it, vi } from "vitest";

import { WindowsRuntimeHostChromeController } from
  "../src/electron/main/windowsRuntimeHostChromeController";
import {
  isWindowsRuntimeHostCommand,
  isWindowsRuntimeHostProjection,
  WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL
} from "../src/shared/windowsRuntimeHost";

const windowId = "10000000-0000-4000-8000-000000000001";
const tabId = "20000000-0000-4000-8000-000000000001";
const secondTabId = "20000000-0000-4000-8000-000000000002";
const targetWindowId = "10000000-0000-4000-8000-000000000002";
const attemptGeneration = "workspace-attempt-1";
const gestureId = "30000000-0000-4000-8000-000000000001";
const documentUrl = "file:///Rion/out/renderer/runtime-windows-host.html";

function projection(active = tabId) {
  return {
    activeTabId: active,
    alwaysShowToolbarInFullScreen: false,
    contentBounds: { height: 640, width: 960, x: 0, y: 40 },
    fullscreen: false,
    lifecycleEpoch: 3,
    moveTargets: [],
    projectionRevision: 1,
    tabs: [
      { active: true, hidden: false, name: "Role", phase: "ready" as const, tabId }
    ],
    toolbarVisible: true,
    topologyRevision: 1,
    windowGeneration: 1,
    workspaceDividers: [],
    windowId
  };
}

function harness() {
  const state = {
    destroyed: false,
    fullscreen: false,
    maximized: false,
    minimized: false,
    minimizeThrows: false
  };
  const native = {
    isDestroyed: () => state.destroyed,
    isFullScreen: () => state.fullscreen,
    isMaximized: () => state.maximized,
    isMinimized: () => state.minimized,
    maximize: vi.fn(() => { state.maximized = true; }),
    minimize: vi.fn(() => {
      if (state.minimizeThrows) throw new Error("native minimize failed");
      state.minimized = true;
    }),
    setFullScreen: vi.fn((value: boolean) => { state.fullscreen = value; }),
    unmaximize: vi.fn(() => { state.maximized = false; })
  };
  const send = vi.fn();
  const requestWindowControl = vi.fn(async () => undefined);
  const requestTabControl = vi.fn(async () => undefined);
  const requestTabReload = vi.fn(async (): Promise<void> => undefined);
  const requestWorkspaceDividerPointer = vi.fn(async (event) => ({
    eventId: event.eventId,
    gestureId: event.gestureId,
    pointerSequence: event.pointerSequence,
    phase: event.phase,
    status: event.phase === "cancel" ? "cancelled" as const : "applied" as const,
    changed: event.phase === "move",
    durable: event.phase === "end",
    ...(event.phase === "move" ? { position: event.requestedPosition } : {}),
    windowGeneration: event.windowGeneration,
    topologyRevision: event.phase === "move"
      ? event.topologyRevision + 1
      : event.topologyRevision,
    workspaceSlots: []
  }));
  const readProjection = () => ({
    bounds: { height: 680, width: 960, x: 100, y: 80 },
    displayId: 7,
    focused: true,
    presentation: state.fullscreen
      ? "fullscreen" as const
      : state.maximized ? "maximized" as const : "normal" as const,
    visible: true
  });
  const controller = new WindowsRuntimeHostChromeController({
    documentUrl,
    hostGeneration: 1,
    native,
    nativeHostId: 41,
    readProjection,
    readLifecycleEpoch: () => 3,
    requestWindowControl,
    requestTabControl,
    requestTabReload,
    requestWorkspaceDividerPointer,
    send,
    windowId
  });
  const relayout = vi.fn(async () => undefined);
  controller.bindLayout(relayout);
  return {
    controller, native, readProjection, relayout, requestWindowControl,
    requestTabControl, requestTabReload, requestWorkspaceDividerPointer, send, state
  };
}

describe("Windows runtime-host chrome controller", () => {
  it("strictly rejects an active flag on a tab other than activeTabId", () => {
    expect(isWindowsRuntimeHostProjection(projection())).toBe(true);
    expect(isWindowsRuntimeHostProjection({
      ...projection(),
      activeTabId: "30000000-0000-4000-8000-000000000001"
    })).toBe(false);
    expect(isWindowsRuntimeHostProjection({
      ...projection(),
      tabs: [{ active: true, hidden: false, name: "Role", phase: "unknown", tabId }]
    })).toBe(false);
    expect(isWindowsRuntimeHostCommand({
      projectionRevision: 2,
      tabId,
      type: "activateTab",
      windowId
    })).toBe(true);
    expect(isWindowsRuntimeHostCommand({
      projectionRevision: 2,
      type: "closeTab",
      windowId
    })).toBe(false);
    expect(isWindowsRuntimeHostCommand({
      gestureId,
      orderedVisibleTabIds: [secondTabId, tabId],
      projectionRevision: 2,
      tabId: secondTabId,
      beforeTabId: tabId,
      type: "reorderTab",
      windowId
    })).toBe(true);
    expect(isWindowsRuntimeHostCommand({
      projectionRevision: 2,
      tabId,
      targetWindowGeneration: 3,
      targetWindowId,
      type: "moveTab",
      windowId
    })).toBe(true);
    expect(isWindowsRuntimeHostCommand({
      lifecycleEpoch: 3,
      projectionRevision: 2,
      tabId,
      topologyRevision: 7,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    })).toBe(true);
    expect(isWindowsRuntimeHostCommand({
      lifecycleEpoch: 0,
      projectionRevision: 2,
      tabId,
      topologyRevision: 7,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    })).toBe(false);
    expect(isWindowsRuntimeHostCommand({
      projectionRevision: 2,
      type: "revealToolbar",
      windowId
    })).toBe(true);
    expect(isWindowsRuntimeHostCommand({
      extra: true,
      projectionRevision: 2,
      type: "revealToolbar",
      windowId
    })).toBe(false);
    expect(isWindowsRuntimeHostCommand({
      attemptGeneration,
      dividerIndex: 0,
      gestureId,
      phase: "start",
      pointerSequence: 1,
      projectionRevision: 2,
      requestedPosition: 0.5,
      tabId,
      type: "workspaceDividerPointer",
      windowId
    })).toBe(false);
  });

  it("keeps active native loading visible until the exact ready projection", async () => {
    const subject = harness();
    const apply = (phase: "loading" | "ready", topologyRevision: number) =>
      subject.controller.applyCoreProjection({
        activeTabId: tabId,
        contentBounds: { height: 640, width: 960, x: 0, y: 40 },
        moveTargets: [],
        tabs: [{ active: true, hidden: false, name: "Role", phase, tabId }],
        topologyRevision,
        windowGeneration: 4,
        workspaceDividers: [],
        windowId
      });

    await apply("loading", 9);
    subject.controller.documentLoaded(documentUrl);
    expect(subject.send).toHaveBeenLastCalledWith(
      WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
      expect.objectContaining({
        topologyRevision: 9,
        tabs: [expect.objectContaining({ phase: "loading", tabId })]
      })
    );

    await apply("ready", 10);
    expect(subject.send).toHaveBeenLastCalledWith(
      WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
      expect.objectContaining({
        topologyRevision: 10,
        tabs: [expect.objectContaining({ phase: "ready", tabId })]
      })
    );

    await subject.controller.applyRetainedPhaseLayoutProjection({
      activeTabId: tabId,
      contentBounds: { height: 600, width: 900, x: 0, y: 40 },
      tabs: [{ active: true, hidden: false, name: "Role", tabId }],
      topologyRevision: 10,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    expect(subject.send).toHaveBeenLastCalledWith(
      WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
      expect.objectContaining({
        tabs: [expect.objectContaining({ phase: "ready", tabId })]
      })
    );
    await expect(subject.controller.applyRetainedPhaseLayoutProjection({
      activeTabId: secondTabId,
      contentBounds: { height: 600, width: 900, x: 0, y: 40 },
      tabs: [{ active: true, hidden: false, name: "Invented", tabId: secondTabId }],
      topologyRevision: 10,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    })).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_LAYOUT_PHASE_FENCE_STALE"
    });
  });

  it("routes visible tab activation and close through the ordered Core lane", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [
        { active: true, hidden: false, name: "Role A", phase: "ready", tabId },
        {
          active: false,
          hidden: false,
          name: "Role B",
          phase: "ready",
          tabId: secondTabId
        }
      ],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;

    await subject.controller.handleCommand(documentUrl, {
      projectionRevision,
      tabId: secondTabId,
      type: "activateTab",
      windowId
    });
    await subject.controller.handleCommand(documentUrl, {
      projectionRevision,
      tabId,
      type: "closeTab",
      windowId
    });

    expect(subject.requestTabControl.mock.calls).toEqual([
      [secondTabId, { type: "activateTab" }],
      [tabId, { type: "closeTab" }]
    ]);
    await expect(subject.controller.handleCommand(documentUrl, {
      projectionRevision,
      tabId: "missing-tab",
      type: "activateTab",
      windowId
    })).rejects.toMatchObject({ code: "ELECTRON_WINDOWS_RUNTIME_TAB_COMMAND_STALE" });
  });

  it("submits a non-active visible Reload with its captured exact fence", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [
        { active: true, hidden: false, name: "Role A", phase: "ready", tabId },
        {
          active: false,
          hidden: false,
          name: "Role B",
          phase: "ready",
          tabId: secondTabId
        }
      ],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;

    await subject.controller.handleCommand(documentUrl, {
      lifecycleEpoch: 3,
      projectionRevision,
      tabId: secondTabId,
      topologyRevision: 9,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    });

    expect(subject.requestTabReload).toHaveBeenCalledOnce();
    expect(subject.requestTabReload).toHaveBeenCalledWith({
      lifecycleEpoch: 3,
      tabId: secondTabId,
      topologyRevision: 9,
      windowGeneration: 4,
      windowId
    });
    const nextProjectionRevision =
      subject.controller.readObservation().projectionRevision;
    expect(nextProjectionRevision).toBe(projectionRevision + 1);
    await expect(subject.controller.handleCommand(documentUrl, {
      lifecycleEpoch: 3,
      projectionRevision: nextProjectionRevision,
      tabId: secondTabId,
      topologyRevision: 10,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    })).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_TAB_RELOAD_FENCE_STALE"
    });
    expect(subject.requestTabReload).toHaveBeenCalledOnce();
  });

  it("admits close and move commands while an EventBound Reload is pending", async () => {
    const subject = harness();
    let finishReload!: () => void;
    subject.requestTabReload.mockImplementationOnce(() => new Promise<void>(
      (resolve) => { finishReload = resolve; }
    ));
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [
        { active: true, hidden: false, name: "Role A", phase: "ready", tabId },
        {
          active: false,
          hidden: false,
          name: "Role B",
          phase: "ready",
          tabId: secondTabId
        }
      ],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;
    const reload = subject.controller.handleCommand(documentUrl, {
      lifecycleEpoch: 3,
      projectionRevision,
      tabId,
      topologyRevision: 9,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    });
    await vi.waitFor(() => expect(subject.requestTabReload).toHaveBeenCalledOnce());

    await subject.controller.handleCommand(documentUrl, {
      projectionRevision,
      tabId: secondTabId,
      type: "closeTab",
      windowId
    });
    await subject.controller.handleCommand(documentUrl, {
      projectionRevision,
      tabId,
      type: "moveTabToNewWindow",
      windowId
    });
    expect(subject.requestTabControl.mock.calls).toEqual([
      [secondTabId, { type: "closeTab" }],
      [tabId, { type: "moveTabToNewWindow" }]
    ]);

    finishReload();
    await expect(reload).resolves.toBeUndefined();
    const secondProjectionRevision =
      subject.controller.readObservation().projectionRevision;
    expect(secondProjectionRevision).toBe(projectionRevision + 1);
    await subject.controller.handleCommand(documentUrl, {
      lifecycleEpoch: 3,
      projectionRevision: secondProjectionRevision,
      tabId,
      topologyRevision: 9,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    });
    expect(subject.requestTabReload).toHaveBeenCalledTimes(2);
    expect(subject.controller.readObservation().projectionRevision)
      .toBe(secondProjectionRevision + 1);
  });

  it("does not publish Reload completion into a destroyed native host", async () => {
    const subject = harness();
    let finishReload!: () => void;
    subject.requestTabReload.mockImplementationOnce(() => new Promise<void>(
      (resolve) => { finishReload = resolve; }
    ));
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;
    const sendCount = subject.send.mock.calls.length;
    const reload = subject.controller.handleCommand(documentUrl, {
      lifecycleEpoch: 3,
      projectionRevision,
      tabId,
      topologyRevision: 9,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    });
    await vi.waitFor(() => expect(subject.requestTabReload).toHaveBeenCalledOnce());
    subject.state.destroyed = true;
    finishReload();

    await expect(reload).resolves.toBeUndefined();
    expect(subject.send).toHaveBeenCalledTimes(sendCount);
    expect(subject.controller.readObservation().projectionRevision)
      .toBe(projectionRevision);
  });

  it("does not publish completion after the exact Reload tab is hidden", async () => {
    const subject = harness();
    let finishReload!: () => void;
    subject.requestTabReload.mockImplementationOnce(() => new Promise<void>(
      (resolve) => { finishReload = resolve; }
    ));
    const apply = (hidden: boolean) => subject.controller.applyCoreProjection({
      activeTabId: hidden ? null : tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: !hidden, hidden, name: "Role", phase: "ready" as const, tabId }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    await apply(false);
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;
    const reload = subject.controller.handleCommand(documentUrl, {
      lifecycleEpoch: 3,
      projectionRevision,
      tabId,
      topologyRevision: 9,
      type: "reloadTab",
      windowGeneration: 4,
      windowId
    });
    await vi.waitFor(() => expect(subject.requestTabReload).toHaveBeenCalledOnce());
    await apply(true);
    const hiddenRevision = subject.controller.readObservation().projectionRevision;
    const sendCount = subject.send.mock.calls.length;
    finishReload();

    await expect(reload).resolves.toBeUndefined();
    expect(subject.send).toHaveBeenCalledTimes(sendCount);
    expect(subject.controller.readObservation().projectionRevision).toBe(hiddenRevision);
  });

  it("routes visible reorder, hide, move, and detach through exact Core fences", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [{
        name: "Target Window",
        windowGeneration: 3,
        windowId: targetWindowId
      }],
      tabs: [
        { active: true, hidden: false, name: "Role A", phase: "ready", tabId },
        {
          active: false,
          hidden: false,
          name: "Role B",
          phase: "ready",
          tabId: secondTabId
        }
      ],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    const revision = subject.controller.readObservation().projectionRevision;

    await subject.controller.handleCommand(documentUrl, {
      beforeTabId: tabId,
      gestureId,
      orderedVisibleTabIds: [secondTabId, tabId],
      projectionRevision: revision,
      tabId: secondTabId,
      type: "reorderTab",
      windowId
    });
    await subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      tabId: secondTabId,
      type: "hideTab",
      windowId
    });
    await subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      tabId,
      targetWindowGeneration: 3,
      targetWindowId,
      type: "moveTab",
      windowId
    });
    await subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      tabId,
      type: "moveTabToNewWindow",
      windowId
    });

    expect(subject.requestTabControl.mock.calls).toEqual([
      [secondTabId, { beforeTabId: tabId, type: "reorderTab" }],
      [secondTabId, { type: "hideTab" }],
      [tabId, { targetWindowId, type: "moveTab" }],
      [tabId, { type: "moveTabToNewWindow" }]
    ]);
  });

  it("rejects stale move generations and mismatched complete drag previews", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [{
        name: "Target Window",
        windowGeneration: 3,
        windowId: targetWindowId
      }],
      tabs: [
        { active: true, hidden: false, name: "Role A", phase: "ready", tabId },
        {
          active: false,
          hidden: false,
          name: "Role B",
          phase: "ready",
          tabId: secondTabId
        }
      ],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    let revision = subject.controller.readObservation().projectionRevision;

    await expect(subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      tabId,
      targetWindowGeneration: 2,
      targetWindowId,
      type: "moveTab",
      windowId
    })).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_TAB_MOVE_TARGET_STALE"
    });
    revision = subject.controller.readObservation().projectionRevision;
    await expect(subject.controller.handleCommand(documentUrl, {
      beforeTabId: tabId,
      gestureId,
      orderedVisibleTabIds: [tabId, secondTabId],
      projectionRevision: revision,
      tabId: secondTabId,
      type: "reorderTab",
      windowId
    })).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_TAB_REORDER_PREVIEW_STALE"
    });
    expect(subject.requestTabControl).not.toHaveBeenCalled();
  });

  it("routes a real Windows divider gesture through exact Core host fences", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{
        active: true,
        hidden: false,
        name: "Mixed workspace",
        phase: "ready",
        tabId
      }],
      topologyRevision: 9,
      windowGeneration: 4,
      windowId,
      workspaceDividers: [{
        attemptGeneration,
        axis: "vertical",
        bounds: { x: 478, y: 40, width: 4, height: 640 },
        dividerIndex: 0,
        tabId,
        visible: true
      }]
    });
    subject.controller.documentLoaded(documentUrl);
    const revision = subject.controller.readObservation().projectionRevision;
    const submit = (phase: "start" | "move" | "end", pointerSequence: number) =>
      subject.controller.handleCommand(documentUrl, {
        attemptGeneration,
        dividerIndex: 0,
        gestureId,
        phase,
        pointerSequence,
        projectionRevision: revision,
        ...(phase === "move" ? { requestedPosition: 0.65 } : {}),
        tabId,
        type: "workspaceDividerPointer",
        windowId
      });

    await submit("start", 1);
    await submit("move", 2);
    await submit("end", 3);

    expect(subject.requestWorkspaceDividerPointer).toHaveBeenCalledTimes(3);
    expect(subject.requestWorkspaceDividerPointer.mock.calls.map(
      ([event]) => ({
        phase: event.phase,
        pointerSequence: event.pointerSequence,
        topologyRevision: event.topologyRevision
      })
    )).toEqual([
      { phase: "start", pointerSequence: 1, topologyRevision: 9 },
      { phase: "move", pointerSequence: 2, topologyRevision: 9 },
      { phase: "end", pointerSequence: 3, topologyRevision: 10 }
    ]);
    expect(subject.requestWorkspaceDividerPointer.mock.calls[0]![0]).toMatchObject({
      hostIdentity: { kind: "windows", nativeHostId: 41, hostGeneration: 1 },
      platform: "windows",
      windowGeneration: 4,
      windowId
    });
    expect(subject.controller.hasActiveWorkspaceDividerGestures).toBe(false);
  });

  it("terminalizes a live Windows divider gesture on host release", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{
        active: true,
        hidden: false,
        name: "Mixed workspace",
        phase: "ready",
        tabId
      }],
      topologyRevision: 5,
      windowGeneration: 2,
      windowId,
      workspaceDividers: [{
        attemptGeneration,
        axis: "vertical",
        bounds: { x: 478, y: 40, width: 4, height: 640 },
        dividerIndex: 0,
        tabId,
        visible: true
      }]
    });
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;
    await subject.controller.handleCommand(documentUrl, {
      attemptGeneration,
      dividerIndex: 0,
      gestureId,
      phase: "start",
      pointerSequence: 1,
      projectionRevision,
      tabId,
      type: "workspaceDividerPointer",
      windowId
    });

    await subject.controller.drainWorkspaceDividerGestures();

    expect(subject.requestWorkspaceDividerPointer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "cancel",
        pointerSequence: 2,
        topologyRevision: 5
      })
    );
    expect(subject.controller.hasActiveWorkspaceDividerGestures).toBe(false);
  });

  it("drains a live divider before awaiting the Core-owned close lane", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{
        active: true,
        hidden: false,
        name: "Mixed workspace",
        phase: "ready",
        tabId
      }],
      topologyRevision: 5,
      windowGeneration: 2,
      windowId,
      workspaceDividers: [{
        attemptGeneration,
        axis: "vertical",
        bounds: { x: 478, y: 40, width: 4, height: 640 },
        dividerIndex: 0,
        tabId,
        visible: true
      }]
    });
    subject.controller.documentLoaded(documentUrl);
    const projectionRevision = subject.controller.readObservation().projectionRevision;
    await subject.controller.handleCommand(documentUrl, {
      attemptGeneration,
      dividerIndex: 0,
      gestureId,
      phase: "start",
      pointerSequence: 1,
      projectionRevision,
      tabId,
      type: "workspaceDividerPointer",
      windowId
    });

    await subject.controller.handleCommand(documentUrl, {
      projectionRevision,
      type: "closeWindow",
      windowId
    });

    expect(subject.requestWorkspaceDividerPointer).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "cancel", pointerSequence: 2 })
    );
    expect(subject.requestWindowControl).toHaveBeenCalledWith("closeWindow");
    expect(subject.controller.hasActiveWorkspaceDividerGestures).toBe(false);
  });

  it("terminalizes fullscreen only from native events and relayouts reveal/pin live", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    expect(subject.send).toHaveBeenLastCalledWith(
      WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
      expect.objectContaining({ projectionRevision: 2, toolbarVisible: true })
    );
    await expect(subject.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 10,
      windowGeneration: 4,
      windowId
    })).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_FENCE_STALE"
    });

    const fullscreen = subject.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 9,
      windowGeneration: 4,
      windowId
    });
    let settled = false;
    void fullscreen.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(subject.native.setFullScreen).toHaveBeenCalledWith(true);

    await subject.controller.nativePresentationChanged("unmaximized");
    expect(settled).toBe(false);
    expect(subject.relayout).not.toHaveBeenCalled();

    await subject.controller.nativePresentationChanged("enteredFullscreen");
    await expect(fullscreen).resolves.toEqual(subject.readProjection());
    await expect(subject.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 9,
      windowGeneration: 4,
      windowId
    })).resolves.toEqual(subject.readProjection());
    expect(subject.native.setFullScreen).toHaveBeenCalledTimes(1);
    expect(subject.controller.contentInset).toBe(2);
    expect(subject.controller.readObservation()).toMatchObject({
      fullscreen: true,
      nativeControlsVisible: false,
      nativeWindowControlCount: 0,
      toolbarVisible: false
    });

    await subject.controller.handleCommand(documentUrl, {
      projectionRevision: subject.controller.readObservation().projectionRevision,
      type: "revealToolbar",
      windowId
    });
    expect(subject.controller.contentInset).toBe(40);
    expect(subject.controller.readObservation()).toMatchObject({
      nativeControlsVisible: true,
      nativeWindowControlCount: 3,
      revealed: true,
      toolbarVisible: true
    });

    await subject.controller.applyPreferences({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: false
    });
    expect(subject.controller.readObservation()).toMatchObject({
      alwaysShowToolbarInFullScreen: true,
      revealed: false,
      toolbarVisible: true
    });
    await subject.controller.applyPreferences({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: false
    });
    expect(subject.controller.contentInset).toBe(2);
    expect(subject.relayout).toHaveBeenCalledTimes(5);
  });

  it("awaits Core window controls and recovers after synchronous minimize failure", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 1,
      windowGeneration: 1,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    let revision = subject.controller.readObservation().projectionRevision;
    subject.state.minimizeThrows = true;
    await expect(subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      type: "minimizeWindow",
      windowId
    })).rejects.toThrow("native minimize failed");

    subject.state.minimizeThrows = false;
    revision = subject.controller.readObservation().projectionRevision;
    const minimize = subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      type: "minimizeWindow",
      windowId
    });
    await Promise.resolve();
    subject.controller.nativeMinimized();
    await expect(minimize).resolves.toBeUndefined();

    const close = subject.controller.handleCommand(documentUrl, {
      projectionRevision: revision,
      type: "closeWindow",
      windowId
    });
    await expect(close).resolves.toBeUndefined();
    expect(subject.requestWindowControl).toHaveBeenCalledWith("closeWindow");
  });

  it("compensates a live preference projection that loses its Core revision fence", async () => {
    const subject = harness();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    subject.controller.documentLoaded(documentUrl);
    let release!: () => void;
    const firstRelayout = new Promise<void>((resolve) => { release = resolve; });
    const relayout = vi.fn()
      .mockImplementationOnce(() => firstRelayout)
      .mockResolvedValue(undefined);
    subject.controller.bindLayout(relayout);

    const preference = subject.controller.applyPreferences({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: false
    });
    await Promise.resolve();
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 10,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    release();

    await expect(preference).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_PREFERENCES_FENCE_STALE"
    });
    expect(subject.controller.readObservation()).toMatchObject({
      alwaysShowToolbarInFullScreen: false,
      topologyRevision: 10
    });
    expect(relayout).toHaveBeenCalledTimes(2);
  });

  it("publishes native placement only after layout and a live Core fence", async () => {
    const subject = harness();
    const order: string[] = [];
    subject.controller.bindLayout(async () => { order.push("layout"); });
    subject.controller.bindPlacement(async () => { order.push("placement"); });

    await subject.controller.nativeBoundsChanged();
    expect(order).toEqual(["layout"]);

    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });
    await subject.controller.nativeBoundsChanged();

    expect(order).toEqual(["layout", "layout", "placement"]);
    expect(() => subject.controller.bindPlacement(async () => undefined))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_OBSERVER_INVALID"
      }));
  });

  it("does not relayout or persist intermediate presentation geometry", async () => {
    const subject = harness();
    const placement = vi.fn(async () => undefined);
    subject.controller.bindPlacement(placement);
    await subject.controller.applyCoreProjection({
      activeTabId: tabId,
      contentBounds: { height: 640, width: 960, x: 0, y: 40 },
      moveTargets: [],
      tabs: [{ active: true, hidden: false, name: "Role", phase: "ready", tabId }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId
    });

    const fullscreen = subject.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 9,
      windowGeneration: 4,
      windowId
    });
    await subject.controller.nativeBoundsChanged();
    expect(subject.relayout).not.toHaveBeenCalled();
    expect(placement).not.toHaveBeenCalled();

    await subject.controller.nativePresentationChanged("enteredFullscreen");
    await fullscreen;
    expect(subject.relayout).toHaveBeenCalledOnce();
    await subject.controller.nativeBoundsChanged();
    expect(subject.relayout).toHaveBeenCalledTimes(2);
    expect(placement).toHaveBeenCalledOnce();
  });
});
