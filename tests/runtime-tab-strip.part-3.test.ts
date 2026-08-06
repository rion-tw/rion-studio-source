// @vitest-environment jsdom

import _userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabStripState } from "../src/shared/runtimeTabs";

const { emit, eventListeners, invoke, listen } = vi.hoisted(() => {
  const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    emit: vi.fn(() => Promise.resolve()),
    eventListeners,
    invoke: vi.fn((_command?: string, _payload?: unknown): Promise<unknown> => Promise.resolve()),
    listen: vi.fn((event: string, listener: (event: { payload: unknown }) => void) => {
      eventListeners.set(event, listener);
      return Promise.resolve(vi.fn());
    })
  };
});
let resizeObserverCallback: ResizeObserverCallback | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));

const state: RuntimeTabStripState = {
  revision: 1,
  capturedAt: "2026-08-03T00:00:00Z",
  alwaysHideTabCloseButton: false,
  alwaysShowToolbarInFullScreen: false,
  displayId: 11,
  windowId: "window-1",
  displays: [],
  fullscreen: false,
  language: "zh-TW",
  resolvedTheme: "light",
  savedWindows: [],
  tabIconDataUrls: {},
  tabWorkspaceTemplates: {},
  tabs: [{
    active: true,
    audible: true,
    audioMuted: false,
    windowId: "window-1",
    hidden: false,
    id: "tab-1",
    name: "四人隊伍",
    roleIds: ["role-1", "role-2"],
    slots: [],
    roleNames: ["米娜", "露娜"],
    sourceId: "workspace-1",
    type: "workspace"
  }],
  toolbarVisible: true,
  windowMaximized: false,
  windowName: "主遊戲視窗",
  windowFullscreen: false,
  windows: []
};

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback;
    }

    disconnect() {}
    observe() {}
    unobserve() {}
  });
  document.body.innerHTML = '<div id="window-identity"><span id="window-name"></span></div><button id="scroll-left" hidden></button><div id="tabs" role="tablist"></div><button id="scroll-right" hidden></button><button id="add"></button><div id="window-drag-region"></div><div id="window-controls"><button id="window-minimize"></button><button id="window-maximize"></button><button id="window-close"></button></div>';
  await import("../src/renderer/runtime-shell/runtimeTabStrip");
});

beforeEach(async () => {
  emit.mockClear();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  installScrollGeometry(1_000, 140);
  window.__rionApplyRuntimeTabState?.(state);
  await nextAnimationFrame();
});

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function installScrollGeometry(
  clientWidth: number,
  initialScrollWidth: number,
  options: { shrinkForScrollControls?: boolean } = {}
) {
  const root = document.querySelector<HTMLDivElement>("#tabs")!;
  let scrollLeft = 0;
  let scrollWidth = initialScrollWidth;
  let scrollWidthReadCount = 0;
  const effectiveClientWidth = () => options.shrinkForScrollControls
    && !document.querySelector<HTMLButtonElement>("#scroll-left")?.hidden
    ? clientWidth - 48
    : clientWidth;
  const scrollTo = vi.fn((options: ScrollToOptions | number) => {
    const next = typeof options === "number" ? options : options.left ?? 0;
    scrollLeft = Number(next);
    root.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperties(root, {
    clientWidth: { configurable: true, get: effectiveClientWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = value; }
    },
    scrollTo: { configurable: true, value: scrollTo },
    scrollWidth: {
      configurable: true,
      get: () => {
        scrollWidthReadCount += 1;
        return scrollWidth;
      }
    }
  });
  Object.defineProperty(root, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const width = effectiveClientWidth();
      return {
        bottom: 31,
        height: 31,
        left: 0,
        right: width,
        toJSON: () => ({}),
        top: 0,
        width,
        x: 0,
        y: 0
      };
    }
  });
  for (const id of ["#scroll-left", "#scroll-right"]) {
    Object.defineProperty(document.querySelector(id), "offsetWidth", {
      configurable: true,
      get: () => 24
    });
  }
  return {
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(value: number) { scrollLeft = value; },
    get scrollWidth() { return scrollWidth; },
    set scrollWidth(value: number) { scrollWidth = value; },
    get scrollWidthReadCount() { return scrollWidthReadCount; },
    resetScrollWidthReadCount() { scrollWidthReadCount = 0; },
    scrollTo
  };
}

function _stateWithTabs(activeIndex = 0): RuntimeTabStripState {
  return {
    ...state,
    tabs: Array.from({ length: 4 }, (_, index) => ({
      ...state.tabs[0],
      active: index === activeIndex,
      id: `tab-${index + 1}`,
      name: `Workspace ${index + 1}`,
      sourceId: `workspace-${index + 1}`
    }))
  };
}

type RuntimeTabMetadataInput = Parameters<
  NonNullable<typeof window.__rionUpdateRuntimeTabMetadata>
>[0];

function _runtimeTabMetadata(
  overrides: Partial<RuntimeTabMetadataInput> = {}
): RuntimeTabMetadataInput {
  return {
    audible: false,
    audioMuted: false,
    closeLabel: "Close tab",
    hideCloseButton: false,
    id: "tab-1",
    mutedLabel: "Muted",
    name: "Workspace",
    phase: "ready",
    playingLabel: "Playing",
    sourceId: "workspace-1",
    tooltip: "Workspace",
    type: "workspace",
    ...overrides
  };
}

function _notifyResizeObserver(): void {
  resizeObserverCallback?.([], {} as ResizeObserver);
}

function _setTabGeometry(width = 140, spacing = 10): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab, index) => {
    Object.defineProperties(tab, {
      offsetLeft: { configurable: true, get: () => index * (width + spacing) },
      offsetWidth: { configurable: true, get: () => width }
    });
  });
}

function dragTransfer(payload?: Record<string, unknown>) {
  const values = new Map<string, string>();
  if (payload) values.set("text/rion-runtime-tab", JSON.stringify(payload));
  return {
    dropEffect: "move",
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setDragImage: vi.fn(),
    setData: (type: string, value: string) => values.set(type, value)
  };
}

function _dragLayoutOrder(): string[] {
  return Array.from(document.querySelector("#tabs")?.children ?? []).flatMap((child) => {
    if (!(child instanceof HTMLElement) || child.classList.contains("drag-surface")) return [];
    const tabId = child.dataset.tabId ?? child.dataset.dragSlotTab;
    return tabId ? [tabId] : [];
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

async function flushPostedDragAction(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
}

function dispatchDrag(
  target: Element,
  type: "dragend" | "dragover" | "dragstart" | "drop",
  dataTransfer: ReturnType<typeof dragTransfer>,
  clientX: number
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    dataTransfer: { value: dataTransfer },
    screenX: { value: clientX + 200 },
    screenY: { value: 240 }
  });
  target.dispatchEvent(event);
}

function dragSession(
  sessionId: string,
  status: "applied" | "cancelled" | "superseded"
) {
  return {
    sessionId,
    operationId: `operation-${sessionId}`,
    sourceWindowId: "window-1",
    sourceTabId: "tab-1",
    lifecycleEpoch: 7,
    topologyRevision: 11,
    phase: "completed",
    status,
    startedAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:01Z"
  };
}

describe("Tauri-owned Windows runtime tab strip", () => {
  it("keeps a single local tab fixed while its detach gesture remains active", () => {
    _setTabGeometry();
    const tab = document.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;
    const transfer = dragTransfer();

    dispatchDrag(tab, "dragstart", transfer, 40);
    dispatchDrag(document.querySelector("#tabs")!, "dragover", transfer, 500);

    expect(document.querySelector(".drag-slot")).toBeNull();
    expect(tab.classList.contains("drag-surface")).toBe(false);
    expect(tab.parentElement?.id).toBe("tabs");
    dispatchDrag(tab, "dragend", transfer, 500);
  });

  it("keeps the newest drag intent when an older projection and terminal arrive late", async () => {
    window.__rionApplyRuntimeTabState?.(_stateWithTabs());
    _setTabGeometry();
    const listener = eventListeners.get("rion://runtime-tab-drag-session");
    const tabA = document.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;

    const firstTransfer = dragTransfer();
    dispatchDrag(tabA, "dragstart", firstTransfer, 20);
    const firstPayload = JSON.parse(firstTransfer.getData("text/rion-runtime-tab")) as {
      sessionId: string;
    };
    dispatchDrag(document.querySelector("#tabs")!, "dragover", firstTransfer, 900);
    dispatchDrag(document.querySelector("#tabs")!, "drop", firstTransfer, 900);
    dispatchDrag(tabA, "dragend", firstTransfer, 900);
    expect(_dragLayoutOrder()).toEqual(["tab-2", "tab-3", "tab-4", "tab-1"]);

    const secondTransfer = dragTransfer();
    dispatchDrag(tabA, "dragstart", secondTransfer, 900);
    const secondPayload = JSON.parse(secondTransfer.getData("text/rion-runtime-tab")) as {
      sessionId: string;
    };
    dispatchDrag(document.querySelector("#tabs")!, "dragover", secondTransfer, 0);
    expect(_dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
    dispatchDrag(document.querySelector("#tabs")!, "drop", secondTransfer, 0);
    dispatchDrag(tabA, "dragend", secondTransfer, 0);

    const runtimeModule = await import("../src/renderer/runtime-shell/runtimeTabStrip");
    window.__rionReorderRuntimeTabs?.(["tab-2", "tab-3", "tab-4", "tab-1"]);
    listener?.({ payload: dragSession(firstPayload.sessionId, "superseded") });
    expect(runtimeModule.runtimeState.latestDragIntentSessionId).toBe(secondPayload.sessionId);
    expect(_dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);

    invoke.mockClear();
    window.__rionApplyRuntimeTabChromeProjection?.({
      rendererInstanceId: runtimeModule.runtimeState.rendererInstanceId,
      windowId: "window-1",
      windowGeneration: 3,
      lifecycleEpoch: 7,
      projectionRevision: 10_000,
      tabs: _stateWithTabs().tabs.map((tab) => ({
        audible: tab.audible,
        closable: true,
        degraded: false,
        hidden: tab.hidden,
        id: tab.id,
        loading: false,
        muted: tab.audioMuted,
        name: tab.name,
        phase: "ready",
        roleIds: tab.roleIds,
        roleNames: tab.roleNames ?? [],
        sourceId: tab.sourceId,
        type: tab.type
      })),
      tabOrder: ["tab-2", "tab-3", "tab-4", "tab-1"],
      activeTabId: "tab-1",
      displayId: 11,
      displays: [],
      windowName: "主遊戲視窗",
      windowMaximized: false,
      fullscreen: false,
      windowFullscreen: false,
      toolbarVisible: true,
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      language: "zh-TW",
      theme: "light"
    });
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: {
        type: "tabChromeProjectionApplied",
        acknowledgement: expect.objectContaining({
          observedTabOrder: ["tab-1", "tab-2", "tab-3", "tab-4"],
          projectionRevision: 10_000,
          rendererInstanceId: runtimeModule.runtimeState.rendererInstanceId,
          status: "superseded"
        })
      }
    });
    expect(_dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);

    window.__rionReorderRuntimeTabs?.(["tab-1", "tab-2", "tab-3", "tab-4"]);
    listener?.({ payload: dragSession(secondPayload.sessionId, "applied") });
    expect(document.querySelector(".drag-slot")).toBeNull();
    expect(_dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
  });

  it("never replays a background order when the newest drag terminal is cancelled", () => {
    const durable = _stateWithTabs(3);
    durable.tabs = [durable.tabs[1], durable.tabs[2], durable.tabs[3], durable.tabs[0]];
    window.__rionApplyRuntimeTabState?.(durable);
    _setTabGeometry();
    const tabA = document.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;
    const transfer = dragTransfer();
    dispatchDrag(tabA, "dragstart", transfer, 900);
    const payload = JSON.parse(transfer.getData("text/rion-runtime-tab")) as {
      sessionId: string;
    };
    dispatchDrag(document.querySelector("#tabs")!, "dragover", transfer, 0);
    dispatchDrag(document.querySelector("#tabs")!, "drop", transfer, 0);
    dispatchDrag(tabA, "dragend", transfer, 0);
    expect(_dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);

    window.__rionReorderRuntimeTabs?.(["tab-2", "tab-3", "tab-4", "tab-1"]);
    eventListeners.get("rion://runtime-tab-drag-session")?.({
      payload: dragSession(payload.sessionId, "cancelled")
    });

    expect(_dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
  });

  it("keeps activation one-way when native presentation reports a background failure", async () => {
    window.__rionEnsureRuntimeTab?.({ id: "tab-2", name: "Second", type: "role" });
    invoke.mockResolvedValueOnce({
      acceptedAt: "2026-08-03T00:00:00Z",
      capturedAt: "2026-08-03T00:00:01Z",
      completionScope: "nativeAcknowledgement",
      deadlineAt: "2026-08-03T00:00:10Z",
      elapsedMs: 20,
      failureCode: "NATIVE_ACTIVE_STYLE_RETRY_PENDING",
      operationId: "presentation-300",
      platform: "windows",
      revision: 300,
      stage: "presentationRetryPending",
      status: "degraded",
      subsystem: "presentation",
      tabId: "tab-2",
      timeoutMs: 10_000,
      trigger: "pointer",
      windowId: "window-1"
    });

    document.querySelector<HTMLButtonElement>('[data-tab-id="tab-2"]')?.click();
    await flushMicrotasks();

    expect(document.querySelector('[data-tab-id="tab-2"]')?.classList.contains("active")).toBe(true);
    expect(emit).not.toHaveBeenCalledWith("rion://shell-error", expect.anything());
  });

it("retires an asynchronous indeterminate drag diagnostic without changing the UI", async () => {
    const listener = eventListeners.get("rion://runtime-tab-drag-session");
    expect(listener).toBeTypeOf("function");

    listener?.({
      payload: {
        sessionId: "drag-session",
        operationId: "native-drag-1",
        sourceWindowId: "window-1",
        sourceTabId: "tab-1",
        lifecycleEpoch: 7,
        topologyRevision: 11,
        phase: "indeterminate",
        status: "indeterminate",
        startedAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-03T00:00:01Z",
        failureCode: "TAURI_TAB_DRAG_ROLLBACK_FAILED"
      }
    });
    await flushMicrotasks();

    expect(emit).not.toHaveBeenCalledWith("rion://shell-error", expect.anything());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels a rejected terminal drag once and ignores late motion for that session", async () => {
    invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("drop rejected"))
      .mockResolvedValueOnce(undefined);
    const tab = document.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      clientX: { value: 120 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 320 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragStart);

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      clientX: { value: 120 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 320 },
      screenY: { value: 240 }
    });
    document.querySelector("#tabs")?.dispatchEvent(drop);
    await flushMicrotasks();

    const lateHover = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(lateHover, {
      clientX: { value: 500 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 700 },
      screenY: { value: 240 }
    });
    document.querySelector("#tabs")?.dispatchEvent(lateHover);
    await flushMicrotasks();

    const actionTypes = invoke.mock.calls.map((call) => (
      call as unknown as [string, { action: { type: string } }]
    )[1].action.type);
    expect(actionTypes).toEqual([
      "tabDragStart", "tabDragDrop", "tabDragCancel"
    ]);
    expect(document.querySelector(".drag-slot")).toBeNull();
    expect(document.querySelector(".drag-surface")).toBeNull();
  });

  it("serializes drag lifecycle actions until the previous native action settles", async () => {
    let resolveStart!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveStart = resolve;
    }));
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "move",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value)
    };
    const tab = document.querySelector<HTMLElement>('[role="tab"]')!;
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 320 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragStart);

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    document.querySelector("#tabs")?.dispatchEvent(drop);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: expect.objectContaining({ type: "tabDragStart", tabId: "tab-1" })
    });

    resolveStart();
    await flushMicrotasks();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: expect.objectContaining({
        type: "tabDragDrop",
        windowId: "window-1",
        orderedTabIds: expect.arrayContaining(["tab-1"])
      })
    });

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperty(dragEnd, "dataTransfer", { value: dataTransfer });
    tab.dispatchEvent(dragEnd);
    await flushPostedDragAction();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_runtime_tab_action", {
      action: expect.objectContaining({
        type: "tabDragSourceEnd",
        dropAccepted: true
      })
    });
  });
});
