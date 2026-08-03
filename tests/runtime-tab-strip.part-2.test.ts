// @vitest-environment jsdom

import _userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabStripState } from "../src/shared/runtimeTabs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
let resizeObserverCallback: ResizeObserverCallback | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

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
    roleNames: ["米娜", "露娜"],
    sourceId: "workspace-1",
    type: "workspace"
  }],
  toolbarVisible: true,
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
  document.body.innerHTML = '<button id="scroll-left" hidden></button><div id="tabs" role="tablist"></div><button id="scroll-right" hidden></button><button id="add"></button>';
  await import("../src/renderer/runtime-shell/runtimeTabStrip");
});

beforeEach(async () => {
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

function _notifyResizeObserver(): void {
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

function dragLayoutOrder(): string[] {
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

describe("Tauri-owned Windows runtime tab strip", () => {
it("maps a vertical wheel and drag-edge movement into horizontal scrolling", async () => {
    const geometry = installScrollGeometry(200, 590);
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    setTabGeometry();
    await nextAnimationFrame();
    const root = document.querySelector<HTMLDivElement>("#tabs")!;

    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: 40 });
    root.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(geometry.scrollLeft).toBe(40);

    const drag = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(drag, "clientX", { value: 195 });
    root.dispatchEvent(drag);
    expect(geometry.scrollLeft).toBe(54);
  });

it("continues distance-sensitive edge scrolling until the drag leaves the strip", async () => {
    const geometry = installScrollGeometry(200, 590);
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    setTabGeometry();
    await nextAnimationFrame();
    const root = document.querySelector<HTMLDivElement>("#tabs")!;
    const drag = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(drag, {
      clientX: { value: 199 },
      dataTransfer: { value: dragTransfer({
        sessionId: "edge-scroll",
        tabId: "external-tab",
        tabWidth: 160,
        tabHeight: 28
      }) }
    });
    root.dispatchEvent(drag);
    const first = geometry.scrollLeft;
    await nextAnimationFrame();
    await nextAnimationFrame();
    expect(geometry.scrollLeft).toBeGreaterThan(first);

    root.dispatchEvent(new Event("dragleave", { bubbles: true }));
    const stopped = geometry.scrollLeft;
    await nextAnimationFrame();
    expect(geometry.scrollLeft).toBe(stopped);
  });

it("uses the original tab as the only drag surface with an equal-width transparent slot", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    const dragged = document.querySelector<HTMLElement>('[data-tab-id="tab-3"]')!;
    document.querySelectorAll<HTMLElement>("#tabs .tab").forEach((tab, index) => {
      Object.defineProperties(tab, {
        offsetLeft: { configurable: true, get: () => index * 206 },
        offsetWidth: { configurable: true, get: () => 200 }
      });
    });
    const dataTransfer = dragTransfer({
      sessionId: "drag-placeholder",
      tabId: "tab-3",
      tabWidth: 168,
      tabHeight: 28
    });
    const overTab = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(overTab, {
      clientX: { value: 40 },
      dataTransfer: { value: dataTransfer }
    });
    document.querySelector<HTMLElement>('[data-tab-id="tab-1"]')?.dispatchEvent(overTab);

    const slot = document.querySelector<HTMLElement>('[data-drag-slot-session="drag-placeholder"]')!;
    expect(dragged.classList.contains("drag-surface")).toBe(true);
    expect(dragged.getAttribute("aria-hidden")).toBe("true");
    expect(slot.textContent).toBe("");
    expect(slot.style.width).toBe("168px");
    expect(dragged.style.left).toBe("-44px");
    expect(dragged.style.top).toBe("0px");
    expect(document.querySelector(".drag-preview")).toBeNull();
    expect(dragLayoutOrder()).toEqual(["tab-3", "tab-1", "tab-2", "tab-4"]);

    const overEnd = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(overEnd, {
      clientX: { value: 900 },
      dataTransfer: { value: dataTransfer }
    });
    document.querySelector("#tabs")?.dispatchEvent(overEnd);

    expect(dragLayoutOrder()).toEqual(["tab-1", "tab-2", "tab-4", "tab-3"]);
    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    document.querySelector("#tabs")?.dispatchEvent(drop);
    expect(dragged.classList.contains("drag-surface")).toBe(false);
    expect(dragged.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelector(".drag-slot")).toBeNull();
    expect(Array.from(document.querySelectorAll<HTMLElement>("#tabs button.tab"))
      .map((candidate) => candidate.dataset.tabId)).toEqual([
      "tab-1", "tab-2", "tab-4", "tab-3"
    ]);
  });

it("patches drag metadata in place and defers native reorder projections until drop", async () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    const original = document.querySelector<HTMLButtonElement>('[data-tab-id="tab-2"]')!;
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      clientX: { value: 150 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 350 },
      screenY: { value: 240 }
    });
    original.dispatchEvent(dragStart);

    const overEnd = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(overEnd, {
      clientX: { value: 900 },
      dataTransfer: { value: dataTransfer }
    });
    document.querySelector("#tabs")?.dispatchEvent(overEnd);
    expect(dragLayoutOrder()).toEqual(["tab-1", "tab-3", "tab-4", "tab-2"]);

    const projection = stateWithTabs(1);
    projection.tabs = [projection.tabs[3], projection.tabs[1], projection.tabs[0], projection.tabs[2]];
    projection.tabs[1] = { ...projection.tabs[1], name: "Renamed during drag" };
    window.__rionApplyRuntimeTabState?.(projection);
    window.__rionUpdateRuntimeTabMetadata?.(runtimeTabMetadata({
      id: "tab-2",
      name: "Final metadata",
      type: "role"
    }));
    window.__rionReorderRuntimeTabs?.(["tab-4", "tab-1", "tab-3", "tab-2"]);

    expect(document.querySelector('[data-tab-id="tab-2"]')).toBe(original);
    expect(original.classList.contains("drag-surface")).toBe(true);
    expect(original.getAttribute("aria-hidden")).toBe("true");
    expect(original.querySelector(".name")?.textContent).toBe("Final metadata");
    expect(dragLayoutOrder()).toEqual(["tab-1", "tab-3", "tab-4", "tab-2"]);

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      clientX: { value: 900 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 1_100 },
      screenY: { value: 240 }
    });
    document.querySelector("#tabs")?.dispatchEvent(drop);
    await flushMicrotasks();

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: { ...dataTransfer, dropEffect: "move" } },
      screenX: { value: 1_100 },
      screenY: { value: 240 }
    });
    original.dispatchEvent(dragEnd);
    await flushPostedDragAction();

    expect(document.querySelector('[data-tab-id="tab-2"]')).toBe(original);
    expect(Array.from(document.querySelectorAll<HTMLElement>("#tabs button.tab"))
      .map((candidate) => candidate.dataset.tabId)).toEqual([
      "tab-4", "tab-1", "tab-3", "tab-2"
    ]);
  });

it("uses the moving tab edge with tight hysteresis and does not oscillate", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    for (const tab of document.querySelectorAll<HTMLElement>("#tabs .tab")) {
      const tabId = tab.dataset.tabId!;
      Object.defineProperties(tab, {
        offsetLeft: {
          configurable: true,
          get: () => dragLayoutOrder().indexOf(tabId) * 106
        },
        offsetWidth: { configurable: true, get: () => 100 }
      });
    }
    const dataTransfer = dragTransfer({
      sessionId: "drag-hysteresis",
      tabId: "tab-2",
      tabWidth: 100,
      tabHeight: 28
    });
    const tab3 = document.querySelector<HTMLElement>('[data-tab-id="tab-3"]')!;
    const dragOverAt = (clientX: number) => {
      const event = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: clientX },
        dataTransfer: { value: dataTransfer }
      });
      tab3.dispatchEvent(event);
    };
    const order = dragLayoutOrder;

    dragOverAt(156);
    dragOverAt(214);
    expect(order()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);

    dragOverAt(216);
    expect(order()).toEqual(["tab-1", "tab-3", "tab-2", "tab-4"]);

    dragOverAt(204);
    expect(order()).toEqual(["tab-1", "tab-3", "tab-2", "tab-4"]);

    dragOverAt(203);
    expect(order()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    document.querySelector("#tabs")?.dispatchEvent(drop);
  });

it("preserves native grab geometry on the one real HTML drag surface", async () => {
    const tab = document.querySelector<HTMLElement>('[data-tab-id="tab-1"]')!;
    Object.defineProperty(tab, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 58, height: 28, left: 100, right: 300,
        toJSON: () => ({}), top: 30, width: 200, x: 100, y: 30
      })
    });
    tab.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 150,
      clientY: 37
    }));
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      clientX: { value: 150 },
      clientY: { value: 37 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 350 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragStart);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: expect.objectContaining({
        type: "tabDragStart",
        grabRatioX: 0.25,
        grabRatioY: 0.25,
        tabWidth: 200,
        tabHeight: 28
      })
    });
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(
      expect.objectContaining({
        className: expect.stringContaining("drag-proxy"),
        textContent: expect.stringContaining("四人隊伍")
      }),
      50,
      7
    );
    expect(dataTransfer.setDragImage.mock.calls[0]?.[0]).toBeInstanceOf(HTMLButtonElement);
    const dragSurface = document.querySelector<HTMLElement>(".drag-surface")!;
    expect(dragSurface).toBe(tab);
    expect(dragSurface.classList.contains("active")).toBe(true);
    expect(dragSurface.querySelector(".name")?.textContent).toBe("四人隊伍");
    expect(document.querySelector(".drag-preview")).toBeNull();
    expect(document.querySelector(".drag-slot")?.textContent).toBe("");
    expect(dragSurface.getAttribute("aria-hidden")).toBe("true");
    expect(dragSurface.style.left).toBe("100px");
    expect(dragSurface.style.top).toBe("0px");
    expect(JSON.parse(dataTransfer.getData("text/rion-runtime-tab"))).not.toHaveProperty(
      "previewMarkup"
    );

    const dragOverAt = (clientX: number, clientY: number) => {
      const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperties(dragOver, {
        clientX: { value: clientX },
        clientY: { value: clientY },
        dataTransfer: { value: dataTransfer },
        screenX: { value: clientX + 200 },
        screenY: { value: clientY + 200 }
      });
      document.querySelector("#tabs")?.dispatchEvent(dragOver);
    };
    dragOverAt(260, 1);
    dragOverAt(320, 29);
    expect(dragSurface.style.left).toBe("270px");
    expect(dragSurface.style.top).toBe("0px");

    document.body.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(dragSurface.getAttribute("aria-hidden")).toBe("true");
    expect(dragSurface.classList.contains("drag-surface-suspended")).toBe(true);
    expect(document.querySelector(".drag-slot")).toBeNull();
    dragOverAt(340, 14);
    expect(document.querySelector(".drag-surface")).toBe(dragSurface);
    expect(dragSurface.getAttribute("aria-hidden")).toBe("true");
    expect(dragSurface.classList.contains("drag-surface-suspended")).toBe(false);
    expect(dragSurface.style.left).toBe("290px");

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: { ...dataTransfer, dropEffect: "move" } },
      screenX: { value: 350 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragEnd);
    await flushPostedDragAction();
    expect(document.querySelector(".drag-preview")).toBeNull();
    expect(document.querySelector(".drag-proxy")).toBeNull();
  });

it("hands an external slot to the real target tab without creating preview markup", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    const root = document.querySelector<HTMLDivElement>("#tabs")!;
    const dataTransfer = dragTransfer({
      grabRatioX: 0.25,
      sessionId: "cross-window-preview",
      tabHeight: 28,
      tabId: "external-tab",
      tabWidth: 160
    });
    const dragOverAt = (clientX: number, clientY: number) => {
      const event = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: clientX },
        clientY: { value: clientY },
        dataTransfer: { value: dataTransfer }
      });
      root.dispatchEvent(event);
    };

    dragOverAt(100, 2);
    expect(document.querySelector(".drag-preview")).toBeNull();
    expect(document.querySelector<HTMLElement>(".drag-slot")?.textContent).toBe("");
    expect(document.querySelector(".drag-surface")).toBeNull();
    dragOverAt(180, 30);

    document.body.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(document.querySelector(".drag-slot")).toBeNull();
    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 131,
        height: 31,
        left: 0,
        right: 1_000,
        toJSON: () => ({}),
        top: 100,
        width: 1_000,
        x: 0,
        y: 100
      })
    });
    dragOverAt(220, 120);
    window.__rionEnsureRuntimeTab?.({ id: "external-tab", name: "External tab", type: "role" });
    const targetSurface = document.querySelector<HTMLElement>(
      '[data-tab-id="external-tab"]'
    )!;
    expect(targetSurface.classList.contains("drag-surface")).toBe(true);
    expect(targetSurface.getAttribute("aria-hidden")).toBe("true");
    expect(targetSurface.querySelector(".name")?.textContent).toBe("External tab");
    expect(targetSurface.style.left).toBe("180px");
    expect(targetSurface.style.top).toBe("0px");
    expect(document.querySelectorAll('[data-tab-id="external-tab"]')).toHaveLength(1);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 420 },
      screenY: { value: 220 }
    });
    root.dispatchEvent(drop);
    expect(document.querySelector(".drag-slot")).toBeNull();
    expect(targetSurface.classList.contains("drag-surface")).toBe(false);
    expect(targetSurface.hasAttribute("aria-hidden")).toBe(false);
  });

it("selects an inactive tab as soon as its drag starts", async () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs(0));
    const tab = document.querySelector<HTMLElement>('[data-tab-id="tab-2"]')!;
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 260 },
      screenY: { value: 100 }
    });
    tab.dispatchEvent(dragStart);

    expect(tab.classList.contains("active")).toBe(true);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-tab-id="tab-1"]')?.classList.contains("active"))
      .toBe(false);

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: { ...dataTransfer, dropEffect: "move" } },
      screenX: { value: 260 },
      screenY: { value: 100 }
    });
    tab.dispatchEvent(dragEnd);
    await flushPostedDragAction();
  });

it("cancels an active drag with Escape and removes its placeholder", async () => {
    const tab = document.querySelector<HTMLElement>('[data-tab-id="tab-1"]')!;
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 120 },
      screenY: { value: 80 }
    });
    tab.dispatchEvent(dragStart);
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await flushMicrotasks();

    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: expect.objectContaining({ type: "tabDragCancel" })
    });
    expect(document.querySelector(".drag-slot")).toBeNull();
    expect(document.querySelector(".drag-surface")).toBeNull();

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 120 },
      screenY: { value: 80 }
    });
    tab.dispatchEvent(dragEnd);
    await flushPostedDragAction();
  });

it("does not treat HTML drag pointer handoff as cancellation", async () => {
    const tab = document.querySelector<HTMLElement>('[data-tab-id="tab-1"]')!;
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      clientX: { value: 120 },
      dataTransfer: { value: dataTransfer },
      screenX: { value: 320 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragStart);
    window.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    window.dispatchEvent(new Event("lostpointercapture", { bubbles: true }));
    await flushMicrotasks();

    expect(invoke.mock.calls.some((call) => (
      call as unknown as [string, { action: { type: string } }]
    )[1].action.type === "tabDragCancel")).toBe(false);

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: { ...dataTransfer, dropEffect: "none" } },
      screenX: { value: 520 },
      screenY: { value: 340 }
    });
    tab.dispatchEvent(dragEnd);
    expect(invoke.mock.calls.some((call) => (
      call as unknown as [string, { action: { type: string } }]
    )[1].action.type === "tabDragSourceEnd")).toBe(false);
    await flushPostedDragAction();

    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: expect.objectContaining({
        type: "tabDragSourceEnd",
        cancelled: false,
        dropAccepted: false,
        screenX: 520,
        screenY: 340
      })
    });
  });

it("keeps the source tab recoverable while a cross-window drop is being committed", async () => {
    const tab = document.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;
    const dataTransfer = dragTransfer();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(dragStart, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 320 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragStart);
    document.body.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(tab.classList.contains("drag-surface-suspended")).toBe(true);

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: { ...dataTransfer, dropEffect: "move" } },
      screenX: { value: 520 },
      screenY: { value: 340 }
    });
    tab.dispatchEvent(dragEnd);
    await flushPostedDragAction();

    expect(document.querySelector('[data-tab-id="tab-1"]')).toBe(tab);
    expect(tab.classList.contains("drag-surface")).toBe(false);
    expect(tab.hasAttribute("aria-hidden")).toBe(false);
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
      action: expect.objectContaining({ type: "tabDragDrop", windowId: "window-1" })
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
