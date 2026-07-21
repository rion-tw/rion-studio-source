// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabChromeState } from "../src/shared/runtimeTabs";

const { ipcRenderer } = vi.hoisted(() => ({
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn()
  }
}));

vi.mock("electron", () => ({ ipcRenderer }));

let stateListener: (_event: unknown, state: RuntimeTabChromeState) => void;

beforeAll(async () => {
  vi.stubGlobal("process", { platform: "darwin" });
  await import("../src/preload/runtime-tabs");
  stateListener = ipcRenderer.on.mock.calls[0][1] as typeof stateListener;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  document.body.innerHTML = '<main id="runtime-tabs-root"></main>';
  ipcRenderer.send.mockClear();
});

describe("macOS runtime tabs HTML fallback preload", () => {
  it("matches native tab close by emitting stop", () => {
    renderState();

    document.querySelector<HTMLButtonElement>(
      'button[aria-label="停止並關閉分頁"]'
    )?.click();

    expect(ipcRenderer.send).toHaveBeenCalledWith("runtime-tabs:action", {
      type: "stop",
      tabId: "tab-1"
    });
  });

  it("maps the macOS window close control to a window close action", () => {
    renderState();

    document.querySelector<HTMLButtonElement>(
      'button[aria-label="關閉遊戲視窗"]'
    )?.click();

    expect(ipcRenderer.send).toHaveBeenCalledWith("runtime-tabs:action", {
      type: "windowControl",
      control: "close"
    });
  });
});

function renderState(): void {
  window.dispatchEvent(new Event("DOMContentLoaded"));
  stateListener({}, {
    alwaysShowToolbarInFullScreen: false,
    displayId: 11,
    displays: [],
    fullscreen: false,
    language: "zh-TW",
    tabIconDataUrls: {},
    tabWorkspaceTemplates: {},
    tabs: [{
      active: true,
      audioMuted: false,
      audible: false,
      displayId: 11,
      hidden: false,
      id: "tab-1",
      name: "Test tab",
      roleIds: ["role-1"],
      sourceId: "role-1",
      type: "role"
    }],
    toolbarVisible: true,
    windowFullscreen: false,
    windows: []
  });
}
