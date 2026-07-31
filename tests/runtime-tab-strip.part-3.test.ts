// @vitest-environment jsdom

import _userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabStripState } from "../src/shared/runtimeTabs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
let resizeObserverCallback: ResizeObserverCallback | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state: RuntimeTabStripState = {
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

describe("Tauri-owned Windows runtime tab strip", () => {
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
});
