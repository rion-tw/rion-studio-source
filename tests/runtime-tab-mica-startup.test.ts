// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RuntimeTabChromeProjectionRecord,
  RuntimeTabChromeReadyRecord
} from "../src/shared/generated";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, payload?: unknown) => Promise<unknown>>()
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const identity = {
  lifecycleEpoch: 3,
  windowGeneration: 2,
  windowId: "window-1"
};

function installTabStripDocument(): void {
  document.body.innerHTML = `
    <div id="window-identity"><span id="window-name"></span></div>
    <button id="scroll-left" hidden></button>
    <div id="tabs" role="tablist"></div>
    <button id="scroll-right" hidden></button>
    <button id="add"></button>
    <div id="window-drag-region"></div>
    <div id="window-controls">
      <button id="window-minimize"></button>
      <button id="window-maximize"></button>
      <button id="window-close"></button>
    </div>
  `;
}

function projection(rendererInstanceId: string): RuntimeTabChromeProjectionRecord {
  return {
    activeTabId: undefined,
    alwaysHideTabCloseButton: false,
    alwaysShowToolbarInFullScreen: false,
    displayId: 1,
    displays: [],
    fullscreen: false,
    language: "en",
    lifecycleEpoch: identity.lifecycleEpoch,
    projectionRevision: 1,
    topologyRevision: 1,
    rendererInstanceId,
    tabOrder: [],
    tabs: [],
    theme: "light",
    toolbarVisible: true,
    windowFullscreen: false,
    windowGeneration: identity.windowGeneration,
    windowId: identity.windowId,
    windowMaximized: false,
    windowName: "Rion Studio"
  };
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockClear();
  invoke.mockResolvedValue(null);
  vi.stubGlobal("ResizeObserver", class {
    disconnect() {}
    observe() {}
    unobserve() {}
  });
  installTabStripDocument();
  delete document.documentElement.dataset.windowsMica;
  window.__rionRuntimeTabChromeReady = false;
  window.__rionRuntimeTabChromeIdentity = identity;
  window.__rionPendingRuntimeTabChromeMutations = [];
  window.__rionPendingRuntimeTabEnsures = [];
  window.__rionPendingRuntimeTabOrder = [];
  window.__rionPendingRuntimeTabs = [{
    id: "pending-tab",
    name: "Pending workspace",
    type: "workspace"
  }];
});

describe.each([
  { enabled: true, expected: "enabled" },
  { enabled: false, expected: "fallback" }
])("Windows runtime tab material startup ($expected)", ({ enabled, expected }) => {
  it("announces ready and renders pending tabs after the first projection", async () => {
    window.__rionRuntimeTabWindowsMicaEnabled = enabled;

    await import("../src/renderer/runtime-shell/runtimeTabStrip");

    expect(document.documentElement.dataset.windowsMica).toBe(expected);
    const readyCall = invoke.mock.calls.find(([, payload]) =>
      (payload as { action?: { type?: string } }).action?.type === "tabChromeReady"
    );
    expect(readyCall).toBeDefined();
    const ready = (readyCall?.[1] as {
      action: { ready: RuntimeTabChromeReadyRecord };
    }).action.ready;
    expect(ready).toMatchObject(identity);

    window.__rionAnnounceRuntimeTabChromeReady?.();
    const readyCalls = invoke.mock.calls.filter(([, payload]) =>
      (payload as { action?: { type?: string } }).action?.type === "tabChromeReady"
    );
    expect(readyCalls).toHaveLength(2);
    expect((readyCalls[1]?.[1] as {
      action: { ready: RuntimeTabChromeReadyRecord };
    }).action.ready).toEqual(ready);

    window.__rionApplyRuntimeTabChromeProjection?.(projection(ready.rendererInstanceId));

    expect(document.querySelector('[data-tab-id="pending-tab"]')).not.toBeNull();
    expect(window.__rionPendingRuntimeTabs).toEqual([]);
  });
});
