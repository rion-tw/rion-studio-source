// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTabChromeProjectionRecord } from "../src/shared/generated";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(vi.fn()))
}));

let rendererInstanceId = "";

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class {
    disconnect() {}
    observe() {}
    unobserve() {}
  });
  document.body.innerHTML = '<div id="window-identity"><span id="window-name"></span></div><button id="scroll-left" hidden></button><div id="tabs" role="tablist"></div><button id="scroll-right" hidden></button><button id="add"></button><div id="window-drag-region"></div><div id="window-controls"><button id="window-minimize"></button><button id="window-maximize"></button><button id="window-close"></button></div>';
  const tabStrip = await import("../src/renderer/runtime-shell/runtimeTabStrip");
  rendererInstanceId = tabStrip.runtimeState.rendererInstanceId;
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("Windows runtime tab chrome projection", () => {
  it("atomically rehydrates order, active ARIA state, metadata, and removes stale tabs", async () => {
    window.__rionEnsureRuntimeTab?.({ id: "stale-tab", name: "Stale", type: "role" });
    const authoritativeProjection: RuntimeTabChromeProjectionRecord = {
      rendererInstanceId,
      windowId: "window-1",
      windowGeneration: 7,
      lifecycleEpoch: 3,
      projectionRevision: 9,
      topologyRevision: 21,
      tabs: [
        {
          automaticInputRestartRequired: false,
          id: "tab-2",
          name: "Second",
          type: "role",
          hidden: false,
          audible: false,
          muted: false,
          loading: false,
          degraded: false,
          closable: true,
          sourceId: "role-2",
          phase: "ready",
          roleIds: ["role-2"],
          roleNames: []
        },
        {
          automaticInputRestartRequired: false,
          id: "tab-1",
          name: "Renamed Workspace",
          type: "workspace",
          hidden: false,
          audible: true,
          muted: false,
          loading: false,
          degraded: false,
          closable: true,
          sourceId: "workspace-1",
          phase: "ready",
          roleIds: ["role-1"],
          roleNames: ["Mina"],
          workspaceTemplate: "single"
        }
      ],
      tabOrder: ["tab-2", "tab-1"],
      activeTabId: "tab-2",
      displayId: 11,
      displays: [],
      windowName: "Main Game Window",
      windowMaximized: false,
      fullscreen: false,
      windowFullscreen: false,
      toolbarVisible: true,
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      language: "en",
      theme: "dark"
    };
    window.__rionApplyRuntimeTabChromeProjection?.(authoritativeProjection);

    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("button.tab"));
    expect(tabs.map((tab) => tab.dataset.tabId)).toEqual(["tab-2", "tab-1"]);
    expect(document.querySelector('[data-tab-id="stale-tab"]')).toBeNull();
    expect(tabs[0]?.classList.contains("active")).toBe(true);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]?.querySelector(".name")?.textContent).toBe("Renamed Workspace");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector("#window-name")?.textContent).toBe("Main Game Window");
    expect(invoke).not.toHaveBeenCalled();
    await nextPaint();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: {
        type: "tabChromeProjectionApplied",
        acknowledgement: {
          rendererInstanceId,
          projectionRevision: 9,
          topologyRevision: 21,
          observedTabOrder: ["tab-2", "tab-1"],
          observedActiveTabId: "tab-2",
          status: "applied"
        }
      }
    });

    invoke.mockClear();
    const beforeStaleProjection = document.querySelector("#tabs")?.innerHTML;
    window.__rionApplyRuntimeTabChromeProjection?.({
      ...authoritativeProjection,
      projectionRevision: 8,
      topologyRevision: 20,
      tabs: [],
      tabOrder: [],
      activeTabId: undefined
    });
    expect(document.querySelector("#tabs")?.innerHTML).toBe(beforeStaleProjection);
    await nextPaint();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("acknowledges an authoritative empty projection after the paint boundary", async () => {
    const emptyProjection: RuntimeTabChromeProjectionRecord = {
      rendererInstanceId,
      windowId: "window-1",
      windowGeneration: 7,
      lifecycleEpoch: 3,
      projectionRevision: 10,
      topologyRevision: 22,
      tabs: [],
      tabOrder: [],
      displayId: 11,
      displays: [],
      windowName: "Empty Game Window",
      windowMaximized: false,
      fullscreen: false,
      windowFullscreen: false,
      toolbarVisible: true,
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      language: "en",
      theme: "light"
    };

    window.__rionApplyRuntimeTabChromeProjection?.(emptyProjection);

    expect(document.querySelectorAll("button.tab")).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
    await nextPaint();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: {
        type: "tabChromeProjectionApplied",
        acknowledgement: {
          rendererInstanceId,
          projectionRevision: 10,
          topologyRevision: 22,
          observedTabOrder: [],
          status: "applied"
        }
      }
    });
  });

  it("replays mutations queued before hydration across independent revision domains", async () => {
    const mutation = vi.fn();
    window.__rionRuntimeTabChromeReady = false;
    window.__rionPendingRuntimeTabChromeMutations = [{ mutation, revision: 3 }];
    window.__rionRuntimeTabChromeReady = true;

    window.__rionApplyRuntimeTabChromeProjection?.({
      rendererInstanceId,
      windowId: "window-1",
      windowGeneration: 7,
      lifecycleEpoch: 3,
      projectionRevision: 1_000,
      topologyRevision: 1_000,
      tabs: [],
      tabOrder: [],
      displayId: 11,
      displays: [],
      windowName: "Empty Game Window",
      windowMaximized: false,
      fullscreen: false,
      windowFullscreen: false,
      toolbarVisible: true,
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      language: "en",
      theme: "light"
    });

    expect(mutation).toHaveBeenCalledOnce();
    await nextPaint();
    expect(invoke).toHaveBeenCalledWith("rion_runtime_tab_action", {
      action: { type: "presentationApplied", revision: 3 }
    });
  });

  it("rejects projections for an obsolete renderer instance without mutating the DOM", () => {
    const before = document.querySelector("#tabs")?.innerHTML;
    window.__rionApplyRuntimeTabChromeProjection?.({
      rendererInstanceId: "obsolete-renderer",
      windowId: "window-1",
      windowGeneration: 7,
      lifecycleEpoch: 3,
      projectionRevision: 10,
      topologyRevision: 22,
      tabs: [],
      tabOrder: [],
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
    });

    expect(document.querySelector("#tabs")?.innerHTML).toBe(before);
    expect(invoke).not.toHaveBeenCalled();
  });
});

async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
