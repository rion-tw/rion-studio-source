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
  document.body.innerHTML = '<button id="scroll-left" hidden>‹</button><div id="tabs" role="tablist"></div><button id="scroll-right" hidden>›</button><button id="add">+</button>';
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
  it("projects the resolved app theme onto an already-open tab document", () => {
    window.__rionApplyRuntimeTabState?.({ ...state, resolvedTheme: "dark" });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    window.__rionApplyRuntimeTabState?.({ ...state, resolvedTheme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("renders workspace detail, audio state, and a stop control", () => {
    const tab = document.querySelector<HTMLElement>('[role="tab"]');
    expect(tab?.title).toBe("四人隊伍：米娜, 露娜");
    expect(tab?.querySelector('[aria-label="正在播放聲音"]')).toBeTruthy();

    tab?.querySelector<HTMLElement>('[aria-label="停止並關閉分頁"]')?.click();

    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "stop", tabId: "tab-1" }
    });
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

  it("keeps close intent committed when the scoped native command is rejected", async () => {
    invoke.mockRejectedValueOnce(new Error("rejected"));
    document.querySelector<HTMLElement>('[aria-label="停止並關閉分頁"]')?.click();
    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();

    await Promise.resolve();

    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();
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
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: expect.objectContaining({ type: "tabDragDrop", windowId: "window-1" })
    });

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperty(dragEnd, "dataTransfer", { value: dataTransfer });
    tab.dispatchEvent(dragEnd);
  });
});
