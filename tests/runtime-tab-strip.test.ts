// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabChromeProjectionRecord } from "../src/shared/generated";
import type { RuntimeTabStripState } from "../src/shared/runtimeTabs";

const { emit, invoke } = vi.hoisted(() => ({
  emit: vi.fn(() => Promise.resolve()),
  invoke: vi.fn((): Promise<unknown> => Promise.resolve(undefined))
}));
let resizeObserverCallback: ResizeObserverCallback | undefined;
let runtimeTabStripModule: typeof import("../src/renderer/runtime-shell/runtimeTabStrip");

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit }));

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
  tabPhases: {},
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
  runtimeTabStripModule = await import("../src/renderer/runtime-shell/runtimeTabStrip");
});

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  emit.mockReset();
  emit.mockResolvedValue(undefined);
  window.__rionRuntimeTabChromeIdentity = undefined;
  installScrollGeometry(1_000, 140);
  window.__rionApplyRuntimeTabState?.(state);
  await nextAnimationFrame();
});

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function expectStopIntentAt(callIndex: number, tabId: string): void {
  expect(invoke).toHaveBeenNthCalledWith(callIndex, "rion_runtime_tab_action", {
    action: {
      type: "stop",
      intent: {
        adapterSequence: expect.any(Number),
        intentId: expect.any(String),
        intentKind: "stop",
        rendererInstanceId: expect.any(String),
        tabId
      }
    }
  });
}

function authoritativeSingleTabProjection(
  projectionRevision: number,
  topologyRevision: number
): RuntimeTabChromeProjectionRecord {
  return {
    rendererInstanceId: runtimeTabStripModule.runtimeState.rendererInstanceId,
    windowId: "window-1",
    windowGeneration: 7,
    lifecycleEpoch: 3,
    projectionRevision,
    topologyRevision,
    tabs: [{
      id: "tab-1",
      name: "Workspace",
      type: "workspace",
      hidden: false,
      audible: false,
      muted: false,
      loading: false,
      degraded: false,
      closable: true,
      sourceId: "workspace-1",
      phase: "ready",
      roleIds: ["role-1"],
      roleNames: []
    }],
    tabOrder: ["tab-1"],
    activeTabId: "tab-1",
    displayId: 11,
    displays: [],
    windowName: "Rion Studio",
    windowMaximized: false,
    fullscreen: false,
    windowFullscreen: false,
    toolbarVisible: true,
    alwaysHideTabCloseButton: false,
    alwaysShowToolbarInFullScreen: false,
    language: "en",
    theme: "light"
  };
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

function stateWithTabs(activeIndex = 0): RuntimeTabStripState {
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

function runtimeTabMetadata(
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

function notifyResizeObserver(): void {
  resizeObserverCallback?.([], {} as ResizeObserver);
}

function setTabGeometry(width = 140, spacing = 10): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab, index) => {
    Object.defineProperties(tab, {
      offsetLeft: { configurable: true, get: () => index * (width + spacing) },
      offsetWidth: { configurable: true, get: () => width }
    });
  });
}

function _dragTransfer(payload?: Record<string, unknown>) {
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

async function _flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

describe("Tauri-owned Windows runtime tab strip", () => {
it("acknowledges a tab chrome revision only after applying and painting its mutation", async () => {
    const mutation = vi.fn(() => {
      document.body.dataset.appliedRevision = "41";
    });

    window.__rionApplyRuntimeTabChromeMutation?.(41, mutation);

    expect(mutation).toHaveBeenCalledOnce();
    expect(document.body.dataset.appliedRevision).toBe("41");
    expect(invoke).not.toHaveBeenCalled();
    await nextAnimationFrame();
    await nextAnimationFrame();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "presentationApplied", revision: 41 }
    });
  });

it("defers tab chrome acknowledgement until the strip is ready and painted", async () => {
    window.__rionRuntimeTabChromeReady = false;
    window.__rionPendingRuntimeTabChromeMutations = [];
    const mutation = vi.fn();

    window.__rionApplyRuntimeTabChromeMutation?.(42, mutation);

    expect(mutation).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(window.__rionPendingRuntimeTabChromeMutations).toHaveLength(1);

    window.__rionRuntimeTabChromeReady = true;
    for (const pending of window.__rionPendingRuntimeTabChromeMutations ?? []) {
      window.__rionApplyRuntimeTabChromeMutation?.(pending.revision, pending.mutation);
    }
    window.__rionPendingRuntimeTabChromeMutations = [];

    expect(mutation).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    await nextAnimationFrame();
    await nextAnimationFrame();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "presentationApplied", revision: 42 }
    });
  });

it("projects the resolved app theme onto an already-open tab document", () => {
    window.__rionApplyRuntimeTabState?.({ ...state, resolvedTheme: "dark" });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    window.__rionApplyRuntimeTabState?.({ ...state, resolvedTheme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

it("routes intentional Windows titlebar drag and caption controls through the scoped action bridge", async () => {
    window.__rionApplyRuntimeTabState?.(state);
    invoke.mockClear();

    const dragRegion = document.querySelector("#window-drag-region");
    dragRegion?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 10,
      detail: 1
    }));
    expect(invoke).not.toHaveBeenCalled();
    document.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      clientX: 30,
      clientY: 10
    }));
    document.querySelector<HTMLButtonElement>("#window-minimize")?.click();
    document.querySelector<HTMLButtonElement>("#window-maximize")?.click();
    document.querySelector<HTMLButtonElement>("#window-close")?.click();
    await Promise.resolve();

    expect(invoke.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { action: { type: "startWindowDrag" } },
      { action: { type: "windowControl", control: "minimize" } },
      { action: { type: "windowControl", control: "zoom" } },
      { action: { type: "windowControl", control: "close" } }
    ]);
    expect(document.querySelector("#window-name")?.textContent).toBe("主遊戲視窗");
    expect(document.querySelector<HTMLButtonElement>("#window-maximize")?.ariaLabel)
      .toBe("最大化視窗");

    window.__rionApplyRuntimeTabState?.({
      ...state,
      fullscreen: true,
      windowFullscreen: true
    });
    invoke.mockClear();
    dragRegion?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      detail: 1
    }));
    document.querySelector<HTMLButtonElement>("#window-maximize")?.click();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "windowControl", control: "toggleFullscreen" }
    });
    expect(document.querySelector<HTMLButtonElement>("#window-maximize")?.ariaLabel)
      .toBe("還原視窗");
  });

it("does not start native dragging for a click and maps a titlebar double-click only to zoom", () => {
    window.__rionApplyRuntimeTabState?.(state);
    invoke.mockClear();
    const dragRegion = document.querySelector("#window-drag-region");

    dragRegion?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 10,
      detail: 1
    }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    dragRegion?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "windowControl", control: "zoom" }
    });
  });

it("renders workspace detail, audio state, and a stop control", () => {
    const tab = document.querySelector<HTMLElement>('[role="tab"]');
    expect(tab?.title).toBe("四人隊伍：米娜, 露娜");
    expect(tab?.querySelector('[aria-label="正在播放聲音"]')).toBeTruthy();
    expect(tab?.querySelector(".lucide-volume-2")).toBeTruthy();

    tab?.querySelector<HTMLElement>('[aria-label="停止並關閉分頁"]')?.click();

    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();
    expectStopIntentAt(1, "tab-1");
  });

it("shows a keyboard-accessible close control only on the active tab", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    window.__rionSetActiveRuntimeTab?.("tab-1");

    const firstClose = document.querySelector<HTMLElement>('[data-tab-id="tab-1"] .close')!;
    const secondClose = document.querySelector<HTMLElement>('[data-tab-id="tab-2"] .close')!;
    expect(firstClose.ariaHidden).toBe("false");
    expect(firstClose.tabIndex).toBe(0);
    expect(secondClose.ariaHidden).toBe("true");
    expect(secondClose.tabIndex).toBe(-1);

    document.querySelector<HTMLElement>('[data-tab-id="tab-2"]')?.click();

    expect(firstClose.ariaHidden).toBe("true");
    expect(firstClose.tabIndex).toBe(-1);
    expect(secondClose.ariaHidden).toBe("false");
    expect(secondClose.tabIndex).toBe(0);
  });

it("uses macOS-equivalent Lucide fallbacks while preserving custom icons", () => {
    const iconState = stateWithTabs();
    iconState.tabs[0] = { ...iconState.tabs[0], type: "role" };
    iconState.tabWorkspaceTemplates = {
      "tab-2": "single",
      "tab-3": "two_columns",
      "tab-4": "quad"
    };
    iconState.tabIconDataUrls = {
      "tab-4": "data:image/png;base64,AA=="
    };

    window.__rionApplyRuntimeTabState?.(iconState);

    expect(document.querySelector('[data-tab-id="tab-1"] .lucide-gamepad-2')).toBeTruthy();
    expect(document.querySelector('[data-tab-id="tab-2"] .lucide-square')).toBeTruthy();
    expect(document.querySelector('[data-tab-id="tab-3"] .lucide-columns-2')).toBeTruthy();
    expect(document.querySelector('[data-tab-id="tab-4"] img.icon')?.getAttribute("src"))
      .toBe("data:image/png;base64,AA==");
    expect(document.querySelector("#scroll-left .lucide-chevron-left")).toBeTruthy();
    expect(document.querySelector("#scroll-right .lucide-chevron-right")).toBeTruthy();
    expect(document.querySelector("#add .lucide-plus")).toBeTruthy();

    window.__rionUpdateRuntimeTabMetadata?.(runtimeTabMetadata({
      id: "tab-4",
      workspaceTemplate: "quad"
    }));
    expect(document.querySelector('[data-tab-id="tab-4"] .lucide-grid-2x2')).toBeTruthy();
  });

it("keeps Ctrl+Tab and Ctrl+Shift+Tab inside the scoped bridge", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, code: "Tab", key: "Tab" }));
    expect(document.querySelector('[data-tab-id="tab-2"]')?.classList.contains("active")).toBe(true);
    dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, code: "Tab", key: "Tab" }));
    expect(document.querySelector('[data-tab-id="tab-3"]')?.classList.contains("active")).toBe(true);
    dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      shiftKey: true,
      code: "Tab",
      key: "Tab"
    }));

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "activateAdjacent", direction: "next" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "activateAdjacent", direction: "next" }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_runtime_tab_action", {
      action: { type: "activateAdjacent", direction: "previous" }
    });
    expect(document.querySelector('[data-tab-id="tab-2"]')?.classList.contains("active")).toBe(true);
  });

it("updates a clicked tab's active state before the native command settles", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    document.querySelector<HTMLElement>('[data-tab-id="tab-3"]')?.click();

    expect(document.querySelector('[data-tab-id="tab-1"]')?.classList.contains("active")).toBe(false);
    expect(document.querySelector('[data-tab-id="tab-3"]')?.classList.contains("active")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "activate", tabId: "tab-3" }
    });
  });

it("keeps keyed tab elements mounted across projection and reorder updates", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    const original = document.querySelector<HTMLElement>('[data-tab-id="tab-2"]');
    const reordered = stateWithTabs(1);
    reordered.tabs = [reordered.tabs[2], reordered.tabs[1], reordered.tabs[0], reordered.tabs[3]];

    window.__rionApplyRuntimeTabState?.(reordered);

    expect(document.querySelector('[data-tab-id="tab-2"]')).toBe(original);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".tab"), (tab) => tab.dataset.tabId))
      .toEqual(["tab-3", "tab-2", "tab-1", "tab-4"]);
    expect(original?.classList.contains("active")).toBe(true);
  });

it("applies metadata batches without changing topology or presentation selection", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs(2));
    const original = document.querySelector<HTMLElement>('[data-tab-id="tab-2"]');
    const order = Array.from(
      document.querySelectorAll<HTMLElement>(".tab"),
      (tab) => tab.dataset.tabId
    );

    window.__rionUpdateRuntimeTabMetadataBatch?.([
      {
        audible: false,
        audioMuted: true,
        closeLabel: "Close updated tab",
        hideCloseButton: false,
        id: "tab-2",
        mutedLabel: "Muted",
        name: "Updated metadata",
        phase: "loading",
        playingLabel: "Playing",
        sourceId: "role-updated",
        tooltip: "Updated tooltip",
        type: "role"
      },
      {
        audible: false,
        audioMuted: false,
        closeLabel: "Close",
        hideCloseButton: false,
        id: "unknown-tab",
        mutedLabel: "Muted",
        name: "Unknown",
        phase: "ready",
        playingLabel: "Playing",
        sourceId: "unknown",
        tooltip: "Unknown",
        type: "role"
      }
    ]);

    expect(document.querySelector('[data-tab-id="tab-2"]')).toBe(original);
    expect(original?.dataset.phase).toBe("loading");
    expect(original?.dataset.sourceId).toBe("role-updated");
    expect(original?.querySelector(".name")?.textContent).toBe("Updated metadata");
    expect(document.querySelector('[data-tab-id="tab-3"]')?.classList.contains("active"))
      .toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".tab"), (tab) => tab.dataset.tabId))
      .toEqual(order);
    expect(document.querySelector('[data-tab-id="unknown-tab"]')).toBeNull();
  });

it("reorders existing native tabs without recreating their controls", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs(1));
    const original = document.querySelector<HTMLElement>('[data-tab-id="tab-2"]');

    window.__rionReorderRuntimeTabs?.(["tab-4", "tab-2", "missing-tab", "tab-1", "tab-3"]);

    expect(document.querySelector('[data-tab-id="tab-2"]')).toBe(original);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".tab"), (tab) => tab.dataset.tabId))
      .toEqual(["tab-4", "tab-2", "tab-1", "tab-3"]);
    expect(original?.classList.contains("active")).toBe(true);
  });

it("waits for an in-flight reorder before closing the window", async () => {
    let resolveReorder!: () => void;
    const reorderReceipt = new Promise<void>((resolve) => {
      resolveReorder = resolve;
    });
    invoke.mockImplementationOnce(() => reorderReceipt);

    const reorder = runtimeTabStripModule.commitRuntimeTabReorder("tab-1", "tab-2");
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>("#window-close")?.click();

    expect(invoke).toHaveBeenCalledOnce();
    expect((invoke.mock.calls[0] as unknown[])?.[1]).toEqual({
      action: { beforeTabId: "tab-2", tabId: "tab-1", type: "reorder" }
    });

    resolveReorder();
    await reorder;
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect((invoke.mock.calls[1] as unknown[])?.[1]).toEqual({
      action: { control: "close", type: "windowControl" }
    });
  });

it("ensures a projected tab exists without changing the active tab", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs(1));

    window.__rionEnsureRuntimeTab?.({
      id: "tab-5",
      name: "Workspace 5",
      type: "workspace"
    });

    expect(document.querySelector('[data-tab-id="tab-5"]')).not.toBeNull();
    expect(document.querySelector('[data-tab-id="tab-2"]')?.classList.contains("active"))
      .toBe(true);
    expect(document.querySelector('[data-tab-id="tab-5"]')?.classList.contains("active"))
      .toBe(false);
  });

it("keeps close intent committed when the scoped native command is rejected", async () => {
    invoke.mockRejectedValueOnce(new Error("rejected"));
    document.querySelector<HTMLElement>('[aria-label="停止並關閉分頁"]')?.click();
    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();

    await Promise.resolve();

    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();
  });

it("requests an authoritative projection and rehydrates a rejected optimistic close", async () => {
    window.__rionRuntimeTabChromeIdentity = {
      lifecycleEpoch: 3,
      windowGeneration: 7,
      windowId: "window-1"
    };
    invoke.mockResolvedValueOnce({
      intentId: "intent-rejected",
      status: "superseded",
      topologyCommitted: false,
      topologyRevision: 9,
      windowGeneration: 7
    });

    document.querySelector<HTMLElement>("[data-tab-id='tab-1'] .close")?.click();
    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: {
        type: "tabChromeReady",
        ready: {
          lifecycleEpoch: 3,
          rendererInstanceId: runtimeTabStripModule.runtimeState.rendererInstanceId,
          windowGeneration: 7,
          windowId: "window-1"
        }
      }
    });

    window.__rionApplyRuntimeTabChromeProjection?.(authoritativeSingleTabProjection(100, 10));
    expect(document.querySelector('[data-tab-id="tab-1"]')).not.toBeNull();
    await nextAnimationFrame();
    await nextAnimationFrame();
  });

it("keeps a committed close removed when cleanup is degraded", async () => {
    invoke.mockResolvedValueOnce({
      cleanupOperationId: "cleanup-1",
      failureCode: "NATIVE_CLEANUP_DEGRADED",
      intentId: "intent-committed",
      status: "degraded",
      topologyCommitted: true,
      topologyRevision: 11,
      windowGeneration: 7
    });

    document.querySelector<HTMLElement>("[data-tab-id='tab-1'] .close")?.click();

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("rion://shell-error", {
      code: "NATIVE_CLEANUP_DEGRADED",
      message: "The tab was closed, but native cleanup completed with reduced guarantees."
    }));
    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

it("selects the right tab immediately when closing the active tab", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs(1));

    document.querySelector<HTMLElement>(
      '[data-tab-id="tab-2"] [aria-label="停止並關閉分頁"]'
    )?.click();

    expect(document.querySelector('[data-tab-id="tab-2"]')).toBeNull();
    expect(document.querySelector('[data-tab-id="tab-3"]')?.classList.contains("active"))
      .toBe(true);
  });

it("routes Windows application shortcuts through the scoped tab-strip bridge", () => {
    dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      code: "KeyN",
      key: "n"
    }));
    dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      code: "F11",
      key: "F11"
    }));
    dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      shiftKey: true,
      code: "Equal",
      key: "+"
    }));

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "applicationShortcut", command: "newGameWindow" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "applicationShortcut", command: "toggleFullscreen" }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_runtime_tab_action", {
      action: { type: "applicationShortcut", command: "zoomIn" }
    });
  });

it("opens the scoped role/workspace launcher exactly once per pointer or keyboard action", async () => {
    const user = userEvent.setup();
    const add = document.querySelector<HTMLButtonElement>("#add");
    add?.click();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("rion_runtime_tab_action", {
      action: { type: "openLauncher" }
    });

    invoke.mockClear();
    add?.focus();
    await user.keyboard("{Enter}");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("rion_runtime_tab_action", {
      action: { type: "openLauncher" }
    });

    invoke.mockClear();
    await user.keyboard(" ");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("rion_runtime_tab_action", {
      action: { type: "openLauncher" }
    });
  });

it("localizes add and close accessibility labels without rendering a menu glyph", () => {
    for (const [language, expected] of [
      ["en", ["Open role or workspace", "Stop and close tab"]],
      ["zh-TW", ["開啟角色或工作區", "停止並關閉分頁"]],
      ["zh-CN", ["打开角色或工作区", "停止并关闭标签页"]],
      ["ja", ["ロールまたはワークスペースを開く", "停止してタブを閉じる"]]
    ] as const) {
      window.__rionApplyRuntimeTabState?.({ ...state, language });
      expect(document.querySelector<HTMLButtonElement>("#add")?.ariaLabel).toBe(expected[0]);
      expect(document.querySelector(".more")).toBeNull();
      expect(document.querySelector<HTMLElement>(".close")?.ariaLabel).toBe(expected[1]);
    }
  });

it("gives provisional and metadata-created tab controls the same keyboard behavior", () => {
    window.__rionReserveRuntimeTab?.({
      id: "provisional-1",
      name: "載入中…",
      type: "role"
    });
    const provisional = document.querySelector<HTMLElement>('[data-tab-id="provisional-1"]')!;
    provisional.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    provisional.querySelector<HTMLElement>(".close")?.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Enter"
    }));

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "openTabMenu", tabId: "provisional-1" }
    });
    expectStopIntentAt(2, "provisional-1");

    invoke.mockClear();
    window.__rionUpdateRuntimeTabMetadata?.({
      audible: false,
      audioMuted: false,
      closeLabel: "停止並關閉分頁",
      hideCloseButton: false,
      id: "tab-1",
      mutedLabel: "分頁已靜音",
      name: "四人隊伍",
      phase: "ready",
      playingLabel: "正在播放聲音",
      sourceId: "workspace-1",
      tooltip: "四人隊伍",
      type: "workspace"
    });
    const metadataTab = document.querySelector<HTMLElement>('[data-tab-id="tab-1"]')!;
    metadataTab.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ContextMenu"
    }));
    metadataTab.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "F10",
      shiftKey: true
    }));
    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "openTabMenu", tabId: "tab-1" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "openTabMenu", tabId: "tab-1" }
    });
  });

it("reveals and collapses the toolbar through bounded fullscreen actions", () => {
    window.__rionApplyRuntimeTabState?.({ ...state, fullscreen: true, toolbarVisible: false });
    document.body.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));

    expect(document.body.dataset.toolbarVisible).toBe("false");
    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "fullscreenToolbarEnter" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "fullscreenToolbarLeave" }
    });
  });

it("removes close controls while preserving context-menu and middle-click stop actions", () => {
    window.__rionApplyRuntimeTabState?.({ ...state, alwaysHideTabCloseButton: true });
    const tab = document.querySelector<HTMLElement>('[role="tab"]')!;

    expect(tab.querySelector(".close")).toBeNull();
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    tab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "openTabMenu", tabId: "tab-1" }
    });
    expectStopIntentAt(2, "tab-1");
  });

it("removes a presentation-locked tab close control without removing its action menu", () => {
    window.__rionUpdateRuntimeTabMetadata?.(runtimeTabMetadata({ hideCloseButton: true }));
    const tab = document.querySelector<HTMLElement>('[data-tab-id="tab-1"]')!;

    expect(tab.querySelector(".close")).toBeNull();
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "openTabMenu", tabId: "tab-1" }
    });
  });

it("shows bounded overflow controls and scrolls to the next hidden tab", async () => {
    const geometry = installScrollGeometry(200, 590);
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    setTabGeometry();
    await nextAnimationFrame();

    const left = document.querySelector<HTMLButtonElement>("#scroll-left")!;
    const right = document.querySelector<HTMLButtonElement>("#scroll-right")!;
    expect(left.hidden).toBe(false);
    expect(left.disabled).toBe(true);
    expect(right.hidden).toBe(false);
    expect(right.disabled).toBe(false);

    right.click();
    expect(geometry.scrollTo).toHaveBeenCalledWith({ behavior: "smooth", left: 90 });
    expect(geometry.scrollLeft).toBe(90);

    geometry.scrollLeft = 390;
    document.querySelector("#tabs")?.dispatchEvent(new Event("scroll"));
    await nextAnimationFrame();
    expect(right.disabled).toBe(true);
  });

it("rechecks overflow after an ensure-only tab insertion", async () => {
    const geometry = installScrollGeometry(320, 280);
    window.__rionApplyRuntimeTabState?.(state);
    await nextAnimationFrame();
    expect(document.querySelector<HTMLButtonElement>("#scroll-left")?.hidden).toBe(true);

    geometry.scrollWidth = 480;
    window.__rionEnsureRuntimeTab?.({
      id: "tab-2",
      name: "Second workspace",
      type: "workspace"
    });
    await nextAnimationFrame();

    expect(document.querySelector<HTMLButtonElement>("#scroll-left")?.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#scroll-right")?.hidden).toBe(false);
  });

it("rechecks overflow after metadata grows or shrinks tab content", async () => {
    const geometry = installScrollGeometry(300, 260);
    window.__rionApplyRuntimeTabState?.(state);
    await nextAnimationFrame();

    geometry.scrollWidth = 480;
    window.__rionUpdateRuntimeTabMetadata?.(runtimeTabMetadata({
      audible: true,
      name: "A much longer workspace name"
    }));
    await nextAnimationFrame();

    const left = document.querySelector<HTMLButtonElement>("#scroll-left")!;
    const right = document.querySelector<HTMLButtonElement>("#scroll-right")!;
    expect(left.hidden).toBe(false);
    expect(left.disabled).toBe(true);
    expect(right.hidden).toBe(false);
    expect(right.disabled).toBe(false);

    geometry.scrollLeft = 50;
    geometry.scrollWidth = 250;
    window.__rionUpdateRuntimeTabMetadata?.(runtimeTabMetadata({
      hideCloseButton: true,
      name: "Short"
    }));
    await nextAnimationFrame();

    expect(left.hidden).toBe(true);
    expect(left.disabled).toBe(true);
    expect(right.hidden).toBe(true);
    expect(right.disabled).toBe(true);
    expect(geometry.scrollLeft).toBe(0);
  });

it("coalesces metadata, mutation, and resize notifications into one frame measurement", async () => {
    const geometry = installScrollGeometry(1_000, 140);
    window.__rionApplyRuntimeTabState?.(state);
    await nextAnimationFrame();
    geometry.resetScrollWidthReadCount();

    window.__rionUpdateRuntimeTabMetadataBatch?.([
      runtimeTabMetadata({ name: "First update" }),
      runtimeTabMetadata({ name: "Second update", audible: true })
    ]);
    notifyResizeObserver();
    notifyResizeObserver();
    await Promise.resolve();
    await nextAnimationFrame();

    expect(geometry.scrollWidthReadCount).toBe(1);

    geometry.resetScrollWidthReadCount();
    const name = document.querySelector<HTMLElement>("[data-tab-id=\"tab-1\"] .name")!;
    name.textContent = "Mutation observer update";
    await Promise.resolve();
    await nextAnimationFrame();

    expect(geometry.scrollWidthReadCount).toBe(1);
  });

it("keeps the one-pixel overflow threshold stable after controls resize the tab viewport", async () => {
    const geometry = installScrollGeometry(200, 201, { shrinkForScrollControls: true });
    window.__rionApplyRuntimeTabState?.(state);
    await nextAnimationFrame();
    const left = document.querySelector<HTMLButtonElement>("#scroll-left")!;
    const right = document.querySelector<HTMLButtonElement>("#scroll-right")!;
    expect(left.hidden).toBe(true);
    expect(right.hidden).toBe(true);

    geometry.scrollWidth = 202;
    notifyResizeObserver();
    await nextAnimationFrame();
    expect(left.hidden).toBe(false);
    expect(right.hidden).toBe(false);

    notifyResizeObserver();
    await nextAnimationFrame();
    expect(left.hidden).toBe(false);
    expect(right.hidden).toBe(false);

    geometry.scrollWidth = 201;
    notifyResizeObserver();
    await nextAnimationFrame();
    expect(left.hidden).toBe(true);
    expect(right.hidden).toBe(true);

    notifyResizeObserver();
    await nextAnimationFrame();
    expect(left.hidden).toBe(true);
    expect(right.hidden).toBe(true);
  });

it("keeps a newly active offscreen tab visible without resetting status-only updates", async () => {
    const geometry = installScrollGeometry(200, 590);
    window.__rionApplyRuntimeTabState?.(stateWithTabs(3));
    setTabGeometry();
    await nextAnimationFrame();

    expect(geometry.scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 390 });
    geometry.scrollTo.mockClear();
    geometry.scrollLeft = 170;
    window.__rionApplyRuntimeTabState?.({
      ...stateWithTabs(3),
      tabs: stateWithTabs(3).tabs.map((tab) => ({ ...tab, audible: !tab.audible }))
    });
    setTabGeometry();
    await nextAnimationFrame();

    expect(geometry.scrollTo).not.toHaveBeenCalled();
    expect(geometry.scrollLeft).toBe(170);
  });
});

it("renders the shared dormant, progress, degraded, and failed phase indicators", () => {
    window.__rionApplyRuntimeTabState?.({
      ...stateWithTabs(0),
      tabPhases: {
        "tab-1": "dormant",
        "tab-2": "activating",
        "tab-3": "degraded",
        "tab-4": "failed"
      }
    });

    const phases = Array.from(
      document.querySelectorAll<HTMLElement>(".phase-indicator")
    ).map((indicator) => indicator.dataset.phase);
    expect(phases).toEqual(["dormant", "activating", "degraded", "failed"]);
    const dormant = document.querySelector<HTMLButtonElement>("[data-tab-id=\"tab-1\"]")!;
    expect(dormant.title).toContain("分頁待命中");
    expect(dormant.ariaLabel).toContain("分頁待命中");
});
