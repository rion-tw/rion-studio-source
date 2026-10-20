import { vi } from "vitest";

import { WindowsRuntimeHostChromeController } from
  "../../src/electron/main/windowsRuntimeHostChromeController";

type ControllerInput = ConstructorParameters<typeof WindowsRuntimeHostChromeController>[0];

export const windowId = "10000000-0000-4000-8000-000000000001";
export const tabId = "20000000-0000-4000-8000-000000000001";
export const secondTabId = "20000000-0000-4000-8000-000000000002";
export const targetWindowId = "10000000-0000-4000-8000-000000000002";
export const attemptGeneration = "workspace-attempt-1";
export const gestureId = "30000000-0000-4000-8000-000000000001";
export const documentUrl = "file:///Rion/out/renderer/runtime-windows-host.html";

export function projection(active = tabId) {
  return {
    activeTabId: active,
    alwaysShowToolbarInFullScreen: false,
    contentBounds: { height: 640, width: 960, x: 0, y: 40 },
    fullscreen: false,
    lifecycleEpoch: 3,
    moveTargets: [],
    projectionRevision: 1,
    tabs: [
      { active: true, audioMuted: false, hidden: false, name: "Role", phase: "ready" as const, tabId }
    ],
    toolbarVisible: true,
    topologyRevision: 1,
    windowGeneration: 1,
    workspaceDividers: [],
    windowId,
    windowMaximized: false,
    windowName: ""
  };
}

export function harness(readCursorScreenPoint?: () => Readonly<{ x: number; y: number }>, initialWorkspaceBackground: "black" | "material" = "material", initialWindowName = "", readLifecycleEpoch: () => number = () => 3) {
  const state = {
    destroyed: false,
    focused: true,
    fullscreen: false,
    maximized: false,
    minimized: false,
    minimizeThrows: false
  };
  const native = {
    getContentBounds: () => ({ height: 680, width: 960, x: 100, y: 80 }),
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    focus: vi.fn(() => { state.focused = true; }),
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
  const resizeIndicators = { update: vi.fn<NonNullable<ControllerInput["resizeIndicators"]>["update"]>() };
  const send = vi.fn<ControllerInput["send"]>();
  const requestWindowControl = vi.fn(async () => undefined);
  const requestTabControl = vi.fn(async () => undefined);
  const requestTabDrag = vi.fn<NonNullable<ControllerInput["requestTabDrag"]>>();
  const onCommandError = vi.fn<NonNullable<ControllerInput["onCommandError"]>>();
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
    initialWindowName,
    initialWorkspaceBackground,
    documentUrl,
    hostGeneration: 1,
    native,
    nativeHostId: 41,
    onCommandError,
    readProjection,
    ...(readCursorScreenPoint ? { readCursorScreenPoint } : {}),
    readLifecycleEpoch,
    requestWindowControl,
    requestTabControl,
    requestTabReload,
    requestTabDrag,
    requestWorkspaceDividerPointer,
    resizeIndicators,
    send,
    windowId
  });
  const relayout = vi.fn(async () => undefined);
  controller.bindLayout(relayout);
  return {
    resizeIndicators, controller, native, onCommandError, readProjection, relayout, requestWindowControl,
    requestTabControl, requestTabReload, requestTabDrag, requestWorkspaceDividerPointer, send, state
  };
}
