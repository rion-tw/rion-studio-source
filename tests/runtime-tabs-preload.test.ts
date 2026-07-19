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
  vi.stubGlobal("process", { platform: "win32" });
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

describe("runtime tabs HTML preload", () => {
  it("renders a stop-and-close button that emits stop", () => {
    renderState();

    const closeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="停止並關閉分頁"]'
    );
    expect(closeButton?.textContent).toBe("×");

    closeButton?.click();

    expect(ipcRenderer.send).toHaveBeenCalledWith("runtime-tabs:action", {
      type: "stop",
      tabId: "tab-1"
    });
  });

  it("opens the native tab menu from the HTML tab context menu", () => {
    renderState();

    const tab = document.querySelector<HTMLElement>('[role="tab"]');
    expect(tab).not.toBeNull();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2
    });

    expect(tab?.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(ipcRenderer.send).toHaveBeenCalledWith("runtime-tabs:action", {
      type: "openTabMenu",
      tabId: "tab-1"
    });
  });
});

function renderState(): void {
  document.dispatchEvent(new Event("DOMContentLoaded"));
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
