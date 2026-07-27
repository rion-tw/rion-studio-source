// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabStripState } from "../src/shared/runtimeTabs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state: RuntimeTabStripState = {
  alwaysHideTabCloseButton: false,
  alwaysShowToolbarInFullScreen: false,
  displayId: 11,
  windowId: "window-1",
  displays: [],
  fullscreen: false,
  language: "zh-TW",
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
  document.body.innerHTML = '<button id="scroll-left" hidden>‹</button><div id="tabs" role="tablist"></div><button id="scroll-right" hidden>›</button><button id="add">+</button>';
  await import("../src/renderer/runtime-shell/runtimeTabStrip");
});

beforeEach(async () => {
  invoke.mockClear();
  installScrollGeometry(1_000, 140);
  window.__rionApplyRuntimeTabState?.(state);
  await nextAnimationFrame();
});

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function installScrollGeometry(clientWidth: number, scrollWidth: number) {
  const root = document.querySelector<HTMLDivElement>("#tabs")!;
  let scrollLeft = 0;
  const scrollTo = vi.fn((options: ScrollToOptions | number) => {
    const next = typeof options === "number" ? options : options.left ?? 0;
    scrollLeft = Number(next);
    root.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperties(root, {
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = value; }
    },
    scrollTo: { configurable: true, value: scrollTo },
    scrollWidth: { configurable: true, get: () => scrollWidth }
  });
  Object.defineProperty(root, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 31,
      height: 31,
      left: 0,
      right: clientWidth,
      toJSON: () => ({}),
      top: 0,
      width: clientWidth,
      x: 0,
      y: 0
    })
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

function setTabGeometry(width = 140, spacing = 10): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab, index) => {
    Object.defineProperties(tab, {
      offsetLeft: { configurable: true, get: () => index * (width + spacing) },
      offsetWidth: { configurable: true, get: () => width }
    });
  });
}

describe("Tauri-owned Windows runtime tab strip", () => {
  it("renders workspace detail, audio state, and a stop control", () => {
    const tab = document.querySelector<HTMLElement>('[role="tab"]');
    expect(tab?.title).toBe("四人隊伍：米娜, 露娜");
    expect(tab?.querySelector('[aria-label="正在播放聲音"]')).toBeTruthy();

    tab?.querySelector<HTMLElement>('[aria-label="停止並關閉分頁"]')?.click();

    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "stop", tabId: "tab-1" }
    });
  });

  it("keeps Ctrl+Tab and Ctrl+Shift+Tab inside the scoped bridge", () => {
    dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, code: "Tab", key: "Tab" }));
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
      action: { type: "activateAdjacent", direction: "previous" }
    });
  });

  it("opens the scoped role/workspace launcher from the add button", () => {
    const add = document.querySelector<HTMLButtonElement>("#add");
    add?.click();
    add?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_runtime_tab_action", {
      action: { type: "openLauncher" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "openLauncher" }
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
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "stop", tabId: "tab-1" }
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
    expect(right.disabled).toBe(true);
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
    expect(geometry.scrollLeft).toBe(56);
  });
});
