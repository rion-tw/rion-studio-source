import { invoke } from "@tauri-apps/api/core";

import type {
  RuntimeTabChromeAcknowledgementRecord,
  RuntimeTabChromeProjectionRecord,
  RuntimeTabChromeReadyRecord
} from "../../../shared/generated";

import type { RuntimeTabStripState } from "../../../shared/runtimeTabs";

export function stateFromChromeProjection(
  projection: RuntimeTabChromeProjectionRecord
): RuntimeTabStripState {
  const display = projection.displays.find((candidate) => candidate.id === projection.displayId);
  const bounds = display?.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    revision: projection.projectionRevision,
    capturedAt: new Date().toISOString(),
    alwaysHideTabCloseButton: projection.alwaysHideTabCloseButton,
    alwaysShowToolbarInFullScreen: projection.alwaysShowToolbarInFullScreen,
    displayId: projection.displayId,
    windowId: projection.windowId,
    displays: projection.displays,
    fullscreen: projection.fullscreen,
    language: projection.language as RuntimeTabStripState["language"],
    resolvedTheme: projection.theme as RuntimeTabStripState["resolvedTheme"],
    savedWindows: [],
    tabIconDataUrls: Object.fromEntries(
      projection.tabs.flatMap((tab) => tab.iconDataUrl ? [[tab.id, tab.iconDataUrl]] : [])
    ),
    tabWorkspaceTemplates: Object.fromEntries(
      projection.tabs.flatMap((tab) => tab.workspaceTemplate
        ? [[tab.id, tab.workspaceTemplate]]
        : [])
    ),
    tabs: projection.tabs.map((tab) => ({
      active: projection.activeTabId === tab.id,
      audible: tab.audible,
      audioMuted: tab.muted,
      hidden: tab.hidden,
      id: tab.id,
      name: tab.name,
      roleIds: tab.roleIds,
      roleNames: tab.roleNames,
      slots: [],
      sourceId: tab.sourceId,
      type: tab.type,
      windowId: projection.windowId
    })),
    toolbarVisible: projection.toolbarVisible,
    windowFullscreen: projection.windowFullscreen,
    windows: [{
      id: projection.windowId,
      windowId: projection.windowId,
      displayId: projection.displayId,
      bounds,
      visible: true,
      activeTabId: projection.activeTabId,
      tabCount: projection.tabs.length
    }]
  };
}

function observedChromeState(
  tabs: HTMLButtonElement[],
  observedTabOrder?: string[]
): { activeTabId?: string; tabOrder: string[] } {
  const active = tabs.filter((tab) =>
    tab.classList.contains("active") && tab.getAttribute("aria-selected") === "true"
  );
  return {
    ...(active.length === 1 && active[0]?.dataset.tabId
      ? { activeTabId: active[0].dataset.tabId }
      : {}),
    tabOrder: observedTabOrder
      ?? tabs.flatMap((tab) => tab.dataset.tabId ? [tab.dataset.tabId] : [])
  };
}

export function acknowledgeChromeProjection(
  projection: RuntimeTabChromeProjectionRecord,
  rendererInstanceId: string,
  tabs: HTMLButtonElement[],
  observedTabOrder?: string[],
  forcedStatus?: "superseded" | "failed"
): void {
  const observed = observedChromeState(tabs, observedTabOrder);
  const acknowledgement: RuntimeTabChromeAcknowledgementRecord = {
    rendererInstanceId,
    projectionRevision: projection.projectionRevision,
    observedTabOrder: observed.tabOrder,
    ...(observed.activeTabId ? { observedActiveTabId: observed.activeTabId } : {}),
    status: forcedStatus ?? (observed.tabOrder.length === projection.tabOrder.length
      && observed.tabOrder.every((tabId, index) => tabId === projection.tabOrder[index])
      && observed.activeTabId === projection.activeTabId
      ? "applied"
      : "failed")
  };
  void invoke("rion_runtime_tab_action", {
    action: { type: "tabChromeProjectionApplied", acknowledgement }
  }).catch(() => undefined);
}

export function announceChromeReady(
  rendererInstanceId: string,
  identity: Window["__rionRuntimeTabChromeIdentity"],
  attempt = 0
): void {
  if (!identity) return;
  const ready: RuntimeTabChromeReadyRecord = { rendererInstanceId, ...identity };
  void invoke("rion_runtime_tab_action", {
    action: { type: "tabChromeReady", ready }
  }).catch(() => {
    if (attempt >= 3) return;
    setTimeout(
      () => announceChromeReady(rendererInstanceId, identity, attempt + 1),
      [50, 150, 400][attempt] ?? 400
    );
  });
}
