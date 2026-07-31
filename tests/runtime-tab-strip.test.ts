// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
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
    expect(tab?.querySelector(".lucide-volume-2")).toBeTruthy();

    tab?.querySelector<HTMLElement>('[aria-label="停止並關閉分頁"]')?.click();

    expect(document.querySelector('[data-tab-id="tab-1"]')).toBeNull();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "stop", tabId: "tab-1" }
    });
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
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "stop", tabId: "provisional-1" }
    });

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
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_runtime_tab_action", {
      action: { type: "stop", tabId: "tab-1" }
    });
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

  it("uses an equal-width placeholder and live DOM order while dragging", () => {
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

    expect(dragged.classList.contains("drag-placeholder")).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab"))
      .map((candidate) => candidate.dataset.tabId)).toEqual([
      "tab-3", "tab-1", "tab-2", "tab-4"
    ]);

    const overEnd = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(overEnd, {
      clientX: { value: 900 },
      dataTransfer: { value: dataTransfer }
    });
    document.querySelector("#tabs")?.dispatchEvent(overEnd);

    expect(Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab"))
      .map((candidate) => candidate.dataset.tabId)).toEqual([
      "tab-1", "tab-2", "tab-4", "tab-3"
    ]);
    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    document.querySelector("#tabs")?.dispatchEvent(drop);
    expect(dragged.classList.contains("drag-placeholder")).toBe(false);
  });

  it("uses spatial hysteresis so a reordered tab does not oscillate at the midpoint", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    const positions: Record<string, number> = {
      "tab-1": 0,
      "tab-2": 106,
      "tab-3": 212,
      "tab-4": 318
    };
    for (const tab of document.querySelectorAll<HTMLElement>("#tabs .tab")) {
      const tabId = tab.dataset.tabId!;
      Object.defineProperties(tab, {
        offsetLeft: { configurable: true, get: () => positions[tabId] },
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
    const order = () => Array.from(
      document.querySelectorAll<HTMLElement>("#tabs .tab"),
      (tab) => tab.dataset.tabId
    );

    dragOverAt(273);
    expect(order()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);

    dragOverAt(275);
    expect(order()).toEqual(["tab-1", "tab-3", "tab-2", "tab-4"]);

    dragOverAt(251);
    expect(order()).toEqual(["tab-1", "tab-3", "tab-2", "tab-4"]);

    dragOverAt(249);
    expect(order()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
    document.querySelector("#tabs")?.dispatchEvent(new Event("dragleave", { bubbles: true }));
  });

  it("preserves the pointer grab ratios and measured tab geometry", async () => {
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
      expect.objectContaining({ className: expect.stringContaining("drag-proxy") }),
      0,
      0
    );
    const preview = document.querySelector<HTMLElement>(".drag-preview")!;
    expect(preview.classList.contains("active")).toBe(true);
    expect(preview.querySelector(".name")?.textContent).toBe("四人隊伍");
    expect(document.body.contains(preview)).toBe(true);
    expect(preview.style.left).toBe("100px");
    expect(preview.style.top).toBe("30px");

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
    expect(preview.style.left).toBe("210px");
    expect(preview.style.top).toBe("30px");
    dragOverAt(320, 29);
    expect(preview.style.left).toBe("270px");
    expect(preview.style.top).toBe("30px");

    document.body.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(document.querySelector(".drag-preview")).toBeNull();
    dragOverAt(340, 14);
    const reattachedPreview = document.querySelector<HTMLElement>(".drag-preview")!;
    expect(reattachedPreview.style.left).toBe("290px");
    expect(reattachedPreview.style.top).toBe("30px");

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: { ...dataTransfer, dropEffect: "move" } },
      screenX: { value: 350 },
      screenY: { value: 240 }
    });
    tab.dispatchEvent(dragEnd);
    expect(document.querySelector(".drag-preview")).toBeNull();
    expect(document.querySelector(".drag-proxy")).toBeNull();
  });

  it("realigns a reattached drag preview to the target strip without following clientY", () => {
    window.__rionApplyRuntimeTabState?.(stateWithTabs());
    const root = document.querySelector<HTMLDivElement>("#tabs")!;
    const dataTransfer = dragTransfer({
      grabRatioX: 0.25,
      previewMarkup: '<span class="name">External tab</span>',
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
    const sourcePreview = document.querySelector<HTMLElement>(".drag-preview")!;
    expect(sourcePreview.style.left).toBe("60px");
    expect(sourcePreview.style.top).toBe("1.5px");
    dragOverAt(180, 30);
    expect(sourcePreview.style.left).toBe("140px");
    expect(sourcePreview.style.top).toBe("1.5px");

    root.dispatchEvent(new Event("dragleave", { bubbles: true }));
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
    const targetPreview = document.querySelector<HTMLElement>(".drag-preview")!;
    expect(targetPreview.querySelector(".name")?.textContent).toBe("External tab");
    expect(targetPreview.style.left).toBe("180px");
    expect(targetPreview.style.top).toBe("101.5px");
    root.dispatchEvent(new Event("dragleave", { bubbles: true }));
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
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: expect.objectContaining({ type: "tabDragCancel" })
    });
    expect(document.querySelector(".drag-placeholder")).toBeNull();

    const dragEnd = new Event("dragend", { bubbles: true });
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: dataTransfer },
      screenX: { value: 120 },
      screenY: { value: 80 }
    });
    tab.dispatchEvent(dragEnd);
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
