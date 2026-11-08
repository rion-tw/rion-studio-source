import { describe, expect, it, vi } from "vitest";

import type {
  BrowserWorkspaceDividerPointerReceiptRecord,
  BrowserWorkspaceDividerPointerRecord,
  DisplayTopologySnapshotRecord,
  GameBrowserSettingsRecord,
  SourceWindowMemoryRecord
} from "../src/shared/generated";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { isChromiumRolePagePresentationMessage } from
  "../src/electron/ipc/chromiumRolePagePresentationProtocol";
import { ChromiumRolePagePresentation } from "../src/electron/main/chromiumRolePagePresentation";
import { rememberedLaunchGeometry } from "../src/electron/main/chromiumRuntimeLaunchMemory";
import { fitMainWindowMemory, trackMainWindowMemory } from "../src/electron/main/electronMainWindowMemory";
import type { ChromiumRuntimeExecutorSnapshot } from "../src/electron/main/chromiumRuntimeSnapshot";
import { assembleRuntimeIndicatorScript, installChromiumRolePagePresentation } from
  "../src/electron/preload/installChromiumRolePagePresentation";

function snapshot(): ChromiumRuntimeExecutorSnapshot {
  return {
    windows: [{ windowId: "window-1", activeTabId: "tab-1" }],
    tabs: [],
    roles: [
      { roleId: "role-a", tabId: "tab-1", windowId: "window-1", generation: 3, ownerGeneration: 1, zoomFactor: 1.1 },
      { roleId: "role-b", tabId: "tab-1", windowId: "window-1", generation: 4, ownerGeneration: 1, zoomFactor: 1 },
      { roleId: "role-c", tabId: "tab-2", windowId: "window-1", generation: 5, ownerGeneration: 1 }
    ],
    webSurfaces: []
  } as unknown as ChromiumRuntimeExecutorSnapshot;
}

function presenter() {
  const send = vi.fn((_roleId: string, _generation: number, _message: unknown) => true);
  return { send, presentation: new ChromiumRolePagePresentation({ send, snapshot }) };
}

describe("Chromium role page presentation", () => {
  it("shows a window zoom only on the active tab's role surfaces", () => {
    const { send, presentation } = presenter();
    presentation.showWindowZoom("window-1", 1.05);
    expect(send.mock.calls).toEqual([
      ["role-a", 3, { type: "zoomIndicator", label: "105%" }],
      ["role-b", 4, { type: "zoomIndicator", label: "105%" }]
    ]);
  });

  it("shows a role zoom from the exact surface's committed factor", () => {
    const { send, presentation } = presenter();
    presentation.showRoleZoom("role-a", 3);
    presentation.showRoleZoom("role-a", 99);
    expect(send.mock.calls).toEqual([["role-a", 3, { type: "zoomIndicator", label: "110%" }]]);
  });

  it("labels every viewport's share while a divider moves and hides it at the end", () => {
    const { send, presentation } = presenter();
    const event = { eventId: "event-1", windowId: "window-1", tabId: "tab-1", phase: "move" } as
      BrowserWorkspaceDividerPointerRecord;
    const receipt = {
      eventId: "event-1", status: "applied",
      workspaceSlots: [
        { id: "a", roleId: "role-a", rect: { x: 0, y: 0, width: 0.375, height: 1 } },
        { id: "b", roleId: "role-b", rect: { x: 0.375, y: 0, width: 0.625, height: 1 } }
      ]
    } as unknown as BrowserWorkspaceDividerPointerReceiptRecord;
    presentation.showWorkspaceDivider(event, receipt);
    presentation.showWorkspaceDivider({ ...event, phase: "end" }, receipt);
    expect(send.mock.calls).toEqual([
      ["role-a", 3, { type: "resizeIndicator", label: "37.5% × 100%" }],
      ["role-b", 4, { type: "resizeIndicator", label: "62.5% × 100%" }],
      ["role-a", 3, { type: "resizeIndicatorHide" }],
      ["role-b", 4, { type: "resizeIndicatorHide" }]
    ]);
    for (const [, , message] of send.mock.calls) {
      expect(isChromiumRolePagePresentationMessage(message)).toBe(true);
    }
  });

  it("broadcasts effect settings only when their runtime projection changes", () => {
    const { send, presentation } = presenter();
    expect(presentation.effectsForDocumentStart()).toEqual({
      enabled: false, brightness: 1, dimBrightSkills: false, hideHitEffects: false
    });
    const enabled: GameBrowserSettingsRecord = {
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      effects: { enabled: true, level: "heavy", dimBrightSkills: true, hideHitEffects: false }
    };
    presentation.observeGameBrowserSettings(enabled);
    presentation.observeGameBrowserSettings({ ...enabled });
    expect(presentation.effectsForDocumentStart()).toEqual({
      enabled: true, brightness: 0.08, dimBrightSkills: true, hideHitEffects: false
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![2]).toEqual({ type: "effects", settings: presentation.effectsForDocumentStart() });
  });
});

describe("Chromium role page preload", () => {
  function ports(initial: unknown) {
    const listeners: Array<(event: unknown, message: unknown) => void> = [];
    const setter = vi.fn();
    const executeInMainWorld = vi.fn(() => setter);
    const executeJavaScriptInIsolatedWorld = vi.fn(() => Promise.resolve(undefined));
    installChromiumRolePagePresentation({
      contextBridge: { executeInMainWorld },
      ipc: { sendSync: () => initial, on: (_channel, listener) => listeners.push(listener) },
      webFrame: { executeJavaScriptInIsolatedWorld },
      isMainFrame: true
    });
    return { listeners, setter, executeInMainWorld, executeJavaScriptInIsolatedWorld };
  }

  it("never hooks WebGL on a page loaded while dimming is off", () => {
    const { executeInMainWorld } = ports({ enabled: false, brightness: 1, dimBrightSkills: false, hideHitEffects: false });
    expect(executeInMainWorld).not.toHaveBeenCalled();
  });

  it("installs at document start when enabled and applies later changes live", () => {
    const { listeners, setter, executeInMainWorld } =
      ports({ enabled: true, brightness: 0.25, dimBrightSkills: true, hideHitEffects: false });
    expect(executeInMainWorld).toHaveBeenCalledTimes(1);
    listeners[0]!(undefined, {
      type: "effects",
      settings: { enabled: false, brightness: 1, dimBrightSkills: false, hideHitEffects: false }
    });
    expect(setter).toHaveBeenCalledWith(1, false, false);
  });

  it("runs indicators in the isolated overlay world and ignores malformed messages", () => {
    const { listeners, executeJavaScriptInIsolatedWorld } = ports(null);
    listeners[0]!(undefined, { type: "zoomIndicator", label: "<img>" });
    listeners[0]!(undefined, { type: "zoomIndicator", label: "125%" });
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    const [worldId, scripts] = executeJavaScriptInIsolatedWorld.mock.calls[0] as unknown as
      [number, Array<{ code: string }>];
    expect(worldId).toBe(1004);
    expect(scripts[0]!.code).toContain("__rionStudioZoomIndicator?.(\"125%\")");
    expect(scripts[0]!.code).not.toContain("__RION_STUDIO_RUNTIME_INDICATOR_CSS__");
    expect(() => new Function(assembleRuntimeIndicatorScript({ type: "resizeIndicatorHide" }))).not.toThrow();
  });
});

describe("window memory geometry", () => {
  const topology = {
    displays: [{
      id: 1, isPrimary: true, scaleFactor: 2,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 33, width: 1512, height: 949 },
      label: "Built-in", isInternal: true, resolution: { width: 1512, height: 982 }
    }]
  } as unknown as DisplayTopologySnapshotRecord;
  const entry = (bounds: { x: number; y: number; width: number; height: number }, id = 1):
    SourceWindowMemoryRecord => ({
    key: "role:a",
    targetDisplay: { id },
    placement: { normalBounds: bounds, savedWorkArea: bounds, presentation: "normal" },
    windowZoomFactor: 1,
    updatedAt: "2026-11-08T00:00:00Z"
  });

  it("reopens a source on its display, fitted to the current work area", () => {
    expect(rememberedLaunchGeometry(entry({ x: 900, y: 500, width: 1000, height: 800 }), topology, []))
      .toEqual({
        displayId: 1, scaleFactor: 2, workArea: { x: 0, y: 33, width: 1512, height: 949 },
        bounds: { x: 512, y: 182, width: 1000, height: 800 }, presentation: "normal"
      });
  });

  it("cascades instead of stacking on a live window and ignores missing displays", () => {
    const bounds = { x: 100, y: 100, width: 800, height: 600 };
    expect(rememberedLaunchGeometry(entry(bounds), topology, [bounds])?.bounds)
      .toEqual({ x: 124, y: 124, width: 800, height: 600 });
    expect(rememberedLaunchGeometry(entry(bounds, 7), topology, [])).toBeNull();
  });

  it("restores the main window only where it stays reachable", () => {
    const areas = [{ x: 0, y: 33, width: 1512, height: 949 }];
    const minimum = { width: 960, height: 640 };
    expect(fitMainWindowMemory({ bounds: { x: 40, y: 50, width: 1200, height: 800 }, maximized: false }, areas, minimum))
      .toEqual({ x: 40, y: 50, width: 1200, height: 800 });
    expect(fitMainWindowMemory({ bounds: { x: 4000, y: 50, width: 1200, height: 800 }, maximized: false }, areas, minimum))
      .toBeNull();
  });

  it("records only completed native frame changes outside full screen", () => {
    const listeners = new Map<string, () => void>();
    let fullScreen = false;
    const invoke = vi.fn(() => Promise.resolve({ sources: [] }));
    trackMainWindowMemory({
      getNormalBounds: () => ({ x: 10, y: 40, width: 1100, height: 700 }),
      isDestroyed: () => false,
      isFullScreen: () => fullScreen,
      isMaximized: () => false,
      isMinimized: () => false,
      maximize: vi.fn(),
      on: (event, listener) => listeners.set(event, listener),
      once: vi.fn()
    }, { invoke } as never, undefined);
    listeners.get("resized")!();
    listeners.get("moved")!();
    fullScreen = true;
    listeners.get("resized")!();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({
      type: "mainWindowMemoryReplace",
      record: { bounds: { x: 10, y: 40, width: 1100, height: 700 }, maximized: false }
    });
  });
});
