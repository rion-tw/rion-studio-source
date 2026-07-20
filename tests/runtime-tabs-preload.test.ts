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
    expect(document.querySelector(".runtime-tab-audio")).toBeNull();
  });

  it("renders audio indicators immediately before close without adding a mute action", () => {
    renderState("role", { audible: true });

    const tab = document.querySelector<HTMLElement>('[role="tab"]');
    const indicator = document.querySelector<HTMLElement>(".runtime-tab-audio");
    const closeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="停止並關閉分頁"]'
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("aria-label")).toBe("正在播放聲音");
    expect([...indicator?.querySelectorAll("path") ?? []].map((path) => path.getAttribute("d")))
      .toContain("M15.5 8.5a5 5 0 0 1 0 7");
    expect(tab?.children[tab.children.length - 2]).toBe(indicator);
    expect(tab?.lastElementChild).toBe(closeButton);

    renderState("role", { audioMuted: true });
    const mutedIndicator = document.querySelector<HTMLElement>(".runtime-tab-audio");
    expect(mutedIndicator?.getAttribute("aria-label")).toBe("分頁已靜音");
    expect([...mutedIndicator?.querySelectorAll("path") ?? []].map((path) => path.getAttribute("d")))
      .toContain("m16 9 5 6");
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

  it("renders workspace role names in the hover tip and removes tab badges", () => {
    renderState("workspace");

    const styleText = [...document.head.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .join("\n");
    const tab = document.querySelector<HTMLElement>('[role="tab"]');

    expect(styleText).toContain("--runtime-tab-active: rgba(24,26,32,.045)");
    expect(styleText).toContain("--runtime-tab-active: rgba(255,255,255,.075)");
    expect(styleText).not.toContain("--runtime-tab-active: rgba(255,255,255,.68)");
    expect(styleText).not.toContain("runtime-tab-count");
    expect(tab?.title).toBe("Test tab：角色 1, 角色 2, 角色 3, 角色 4");
    expect(document.querySelector(".runtime-tab-count")).toBeNull();
  });
});

function renderState(
  kind: "role" | "workspace" = "role",
  audio: { audible?: boolean; audioMuted?: boolean } = {}
): void {
  const workspace = kind === "workspace";
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
      displayId: 11,
      hidden: false,
      id: "tab-1",
      name: "Test tab",
      roleIds: workspace
        ? ["role-1", "role-2", "role-3", "role-4"]
        : ["role-1"],
      ...(workspace
        ? { roleNames: ["角色 1", "角色 2", "角色 3", "角色 4"] }
        : {}),
      sourceId: "role-1",
      type: kind,
      audible: audio.audible ?? false,
      audioMuted: audio.audioMuted ?? false
    }],
    toolbarVisible: true,
    windowFullscreen: false,
    windows: []
  });
}
