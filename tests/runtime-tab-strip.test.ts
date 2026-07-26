// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabStripState } from "../src/shared/runtimeTabs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state: RuntimeTabStripState = {
  alwaysShowToolbarInFullScreen: false,
  displayId: 11,
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
    displayId: 11,
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
  document.body.innerHTML = '<div id="tabs" role="tablist"></div><button id="add">+</button>';
  await import("../src/renderer/runtime-shell/runtimeTabStrip");
});

beforeEach(() => {
  invoke.mockClear();
  window.__rionApplyRuntimeTabState?.(state);
});

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
});
