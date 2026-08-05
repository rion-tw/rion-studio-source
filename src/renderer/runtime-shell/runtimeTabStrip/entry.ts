// Focused implementation extracted from runtimeTabStrip.ts.
import { invoke } from "@tauri-apps/api/core";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { applicationShortcutForKeyEvent } from "../../../shared/applicationShortcuts";

import type { RuntimeTabStripState } from "../../../shared/runtimeTabs";

import type {
  RuntimeTabActivationAcknowledgementRecord,
  RuntimeTabChromeProjectionRecord
} from "../../../shared/generated";

import { runtimeTabStripLabels } from "../../src/i18n";

import { OVERFLOW_EPSILON, add, adoptDragSurface, audioSignatureByButton, clearDragProxy, clearDragVisual, clearDropIndicator, createAudioIndicator, createCloseControl, createLucideSvg, createTabIcon, deferRuntimeTabOrder, dispatch, iconSignatureByButton, installTabButtonInteractions, localDropSessions, logicalRuntimeTabOrder, root, runtimeState, scrollLeftButton, scrollRightButton, setDropIndicator, suspendDragVisual, syncCloseControlState, terminalDragSessions, workspaceTemplateByTabId } from "../runtimeTabStrip";

import type { RuntimeTabModel } from "../runtimeTabStrip";

import { animateReorderedTabs, optimisticallyActivateTab, previewDragPosition, rememberDragInsertion, resolveStableDragInsertion, scheduleDragHover } from "./drag";

import {
  acknowledgeChromeProjection,
  announceChromeReady,
  stateFromChromeProjection
} from "./chromeProjection";

function createTabButton(tabId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  button.dataset.tabId = tabId;
  button.draggable = true;
  button.role = "tab";
  button.setAttribute("aria-selected", "false");
  installTabButtonInteractions(button, tabId);
  return button;
}

function patchTabButton(
  button: HTMLButtonElement,
  tab: RuntimeTabModel,
  state: RuntimeTabStripState,
  labels: ReturnType<typeof runtimeTabStripLabels>,
  active: boolean
): void {
  button.classList.toggle("active", active);
  button.draggable = true;
  button.setAttribute("aria-selected", String(active));
  button.title = tab.type === "workspace" && (tab.roleNames?.length ?? 0) > 0
    ? `${tab.name}${state.language.startsWith("zh") ? "：" : ":"}${(tab.roleNames ?? []).join(", ")}`
    : tab.name;

  const workspaceTemplate = workspaceTemplateByTabId.get(tab.id);
  const iconDataUrl = state.tabIconDataUrls[tab.id];
  const iconSignature = `${tab.type}\u0000${workspaceTemplate ?? ""}\u0000${iconDataUrl ?? ""}`;
  let icon = button.querySelector<HTMLElement>(".icon");
  if (!icon || iconSignatureByButton.get(button) !== iconSignature) {
    const replacement = createTabIcon(tab.type, iconDataUrl, workspaceTemplate);
    if (icon) icon.replaceWith(replacement);
    else button.prepend(replacement);
    icon = replacement;
    iconSignatureByButton.set(button, iconSignature);
  }

  let name = button.querySelector<HTMLElement>(".name");
  if (!name) {
    name = document.createElement("span");
    name.className = "name";
    icon.after(name);
  }
  if (name.textContent !== tab.name) name.textContent = tab.name;

  const audioSignature = `${tab.audioMuted}\u0000${tab.audible}\u0000${labels.tabMuted}\u0000${labels.playingAudio}`;
  const audio = button.querySelector<HTMLElement>(".audio");
  if (!audio || audioSignatureByButton.get(button) !== audioSignature) {
    const replacement = createAudioIndicator(
      tab.audioMuted,
      tab.audible,
      labels.tabMuted,
      labels.playingAudio
    );
    if (audio) audio.replaceWith(replacement);
    else name.after(replacement);
    audioSignatureByButton.set(button, audioSignature);
  }

  let close = button.querySelector<HTMLElement>(".close");
  if (state.alwaysHideTabCloseButton) close?.remove();
  else if (!close) {
    close = createCloseControl(tab.id, labels.closeTab);
    button.append(close);
  }
  if (close) close.ariaLabel = labels.closeTab;
  syncCloseControlState(button);
}

function render(
  state: RuntimeTabStripState,
  authoritative = false,
  projectionRevision?: number
): void {
  const revision = ++runtimeState.renderRevision;
  const previousScrollLeft = root.scrollLeft;
  const labels = runtimeTabStripLabels(state.language);
  runtimeState.current = state;
  if (authoritative && !runtimeState.latestDragIntentSessionId) {
    runtimeState.optimisticActiveTabId = undefined;
  }
  document.documentElement.lang = state.language;
  document.documentElement.dataset.theme = state.resolvedTheme;
  document.documentElement.style.colorScheme = state.resolvedTheme;
  document.body.dataset.toolbarVisible = String(state.toolbarVisible);
  const visibleTabs = state.tabs
    .filter((tab) => tab.windowId === state.windowId && !tab.hidden);
  for (const tab of visibleTabs) {
    const workspaceTemplate = state.tabWorkspaceTemplates[tab.id];
    if (workspaceTemplate) workspaceTemplateByTabId.set(tab.id, workspaceTemplate);
  }
  const snapshotActiveTabId = visibleTabs.find((tab) => tab.active)?.id;
  // Native presentation owns selection. A delayed Core projection may refresh metadata and
  // topology, but it must not repaint an older active tab over an optimistic pointer/key action.
  const optimisticSelectionIsVisible = runtimeState.optimisticActiveTabId
    && visibleTabs.some((tab) => tab.id === runtimeState.optimisticActiveTabId);
  if (runtimeState.optimisticActiveTabId && !optimisticSelectionIsVisible) runtimeState.optimisticActiveTabId = undefined;
  const presentationActiveTabId = optimisticSelectionIsVisible
    ? runtimeState.optimisticActiveTabId
    : snapshotActiveTabId;
  reconcileTabButtons(
    visibleTabs,
    state,
    labels,
    presentationActiveTabId,
    projectionRevision
  );
  for (const tab of tabElements()) syncCloseControlState(tab);
  const nextActiveTabId = presentationActiveTabId;
  root.scrollLeft = previousScrollLeft;
  scheduleScrollControlsUpdate();
  requestAnimationFrame(() => {
    if (revision !== runtimeState.renderRevision) return;
    if (nextActiveTabId !== runtimeState.activeTabId) {
      ensureTabVisible(nextActiveTabId);
    }
    runtimeState.activeTabId = nextActiveTabId;
  });
  add.ariaLabel = labels.openLauncher;
  add.title = labels.openLauncher;
  scrollLeftButton.ariaLabel = labels.scrollLeft;
  scrollRightButton.ariaLabel = labels.scrollRight;
  scrollLeftButton.title = scrollLeftButton.ariaLabel;
  scrollRightButton.title = scrollRightButton.ariaLabel;
}

function applyChromeProjection(projection: RuntimeTabChromeProjectionRecord): void {
  if (projection.rendererInstanceId !== runtimeState.rendererInstanceId
    || projection.projectionRevision < runtimeState.projectionRevision) return;
  runtimeState.projectionRevision = projection.projectionRevision;
  runtimeState.chromeHydrated = true;
  render(stateFromChromeProjection(projection), true, projection.projectionRevision);
  const observedOrder = logicalRuntimeTabOrder();
  const observedActiveTabId = exactActiveRuntimeTabId();
  const projectionMatchesObserved = ordersEqual(observedOrder, projection.tabOrder)
    && observedActiveTabId === projection.activeTabId;
  if (!runtimeState.latestDragIntentSessionId) {
    if (projection.activeTabId) optimisticallyActivateTab(projection.activeTabId);
    else window.__rionSetActiveRuntimeTab?.();
  }
  acknowledgeChromeProjection(
    projection,
    runtimeState.rendererInstanceId,
    tabElements(),
    observedOrder,
    runtimeState.latestDragIntentSessionId && !projectionMatchesObserved
      ? "superseded"
      : undefined
  );

  const activations = window.__rionPendingRuntimeTabActivations ?? [];
  window.__rionPendingRuntimeTabActivations = [];
  for (const request of activations) window.__rionApplyRuntimeTabActivation?.(request);

  const mutations = window.__rionPendingRuntimeTabChromeMutations ?? [];
  window.__rionPendingRuntimeTabChromeMutations = [];
  for (const pending of mutations) {
    if (pending.revision > projection.projectionRevision) {
      window.__rionApplyRuntimeTabChromeMutation?.(pending.revision, pending.mutation);
    }
  }

  for (const tab of window.__rionPendingRuntimeTabEnsures ?? []) {
    window.__rionEnsureRuntimeTab?.(tab);
  }
  window.__rionPendingRuntimeTabEnsures = [];
  for (const tab of window.__rionPendingRuntimeTabs ?? []) {
    window.__rionReserveRuntimeTab?.(tab);
  }
  window.__rionPendingRuntimeTabs = [];
  window.__rionPendingRuntimeTabOrder = [];
}

function ordersEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tabId, index) => tabId === right[index]);
}

function exactActiveRuntimeTabId(): string | undefined {
  const active = tabElements().filter((tab) =>
    tab.classList.contains("active") && tab.getAttribute("aria-selected") === "true"
  );
  return active.length === 1 ? active[0]?.dataset.tabId : undefined;
}

function reconcileTabButtons(
  tabs: RuntimeTabModel[],
  state: RuntimeTabStripState,
  labels: ReturnType<typeof runtimeTabStripLabels>,
  presentationActiveTabId?: string,
  projectionRevision?: number
): void {
  const existingById = new Map(tabElements().map((button) => [button.dataset.tabId, button]));
  const retained = new Set<string>();
  for (const tab of tabs) {
    retained.add(tab.id);
    const button = existingById.get(tab.id) ?? createTabButton(tab.id);
    if (!button.isConnected) root.append(button);
    patchTabButton(button, tab, state, labels, tab.id === presentationActiveTabId);
    existingById.set(tab.id, button);
  }
  for (const [tabId, existing] of existingById) {
    if (!tabId || retained.has(tabId)) continue;
    existing.remove();
    if (runtimeState.dragVisualState?.surface === existing) {
      runtimeState.dragVisualState.surface = undefined;
      runtimeState.dragVisualState.slot.remove();
      runtimeState.dragVisualState.suspended = true;
    }
  }

  const desiredOrder = tabs.map((tab) => tab.id);
  if (deferRuntimeTabOrder(desiredOrder, projectionRevision)) {
    const visual = runtimeState.dragVisualState;
    const incoming = visual ? existingById.get(visual.tabId) : undefined;
    if (visual && incoming && retained.has(visual.tabId) && visual.slot.isConnected
      && visual.surface !== incoming) {
      adoptDragSurface(incoming);
    }
  } else {
    applyRuntimeTabOrder(desiredOrder, false);
  }
}

export function applyRuntimeTabOrder(tabIds: string[], animate: boolean): void {
  const previousRects = new Map(
    [...Array.from(root.children), add]
      .map((child) => [child, child.getBoundingClientRect()] as const)
  );
  const byId = new Map(tabElements().map((tab) => [tab.dataset.tabId, tab]));
  let insertionPoint: Element | null = root.firstElementChild;
  for (const tabId of tabIds) {
    const tab = byId.get(tabId);
    if (!tab) continue;
    if (tab !== insertionPoint) root.insertBefore(tab, insertionPoint);
    insertionPoint = tab.nextElementSibling;
  }
  if (animate) animateReorderedTabs(previousRects);
  scheduleScrollControlsUpdate();
}

export type RuntimeTabDragPayload = {
  sessionId: string;
  tabId: string;
  tabWidth: number;
  tabHeight: number;
  grabRatioX: number;
};

export function runtimeTabDragPayload(
  dataTransfer: DataTransfer | null
): RuntimeTabDragPayload | undefined {
  if (!dataTransfer || typeof dataTransfer.getData !== "function") return undefined;
  const raw = dataTransfer.getData("text/rion-runtime-tab");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.sessionId !== "string" || typeof value.tabId !== "string"
      || typeof value.tabWidth !== "number" || !Number.isFinite(value.tabWidth)
      || typeof value.tabHeight !== "number" || !Number.isFinite(value.tabHeight)) return undefined;
    return {
      sessionId: value.sessionId,
      tabId: value.tabId,
      tabWidth: Math.max(1, value.tabWidth),
      tabHeight: Math.max(1, value.tabHeight),
      grabRatioX: clampRatio(
        typeof value.grabRatioX === "number" ? value.grabRatioX : 0.5
      )
    };
  } catch {
    return undefined;
  }
}

export function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

export function tabElements(): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button.tab"));
}

function visibleWidthWithoutScrollControls(): number {
  if (scrollLeftButton.hidden) return root.clientWidth;
  const bodyGap = Number.parseFloat(getComputedStyle(document.body).columnGap) || 0;
  return root.clientWidth + scrollLeftButton.offsetWidth + scrollRightButton.offsetWidth + bodyGap * 2;
}

function hasTabOverflow(): boolean {
  return root.scrollWidth - visibleWidthWithoutScrollControls() > OVERFLOW_EPSILON;
}

export function scheduleScrollControlsUpdate(): void {
  if (runtimeState.scrollControlsFrame !== undefined) return;
  runtimeState.scrollControlsFrame = requestAnimationFrame(() => {
    runtimeState.scrollControlsFrame = undefined;
    updateScrollControls();
  });
}

function updateScrollControls(): void {
  const overflowing = hasTabOverflow();
  scrollLeftButton.hidden = !overflowing;
  scrollRightButton.hidden = !overflowing;
  if (!overflowing) {
    scrollLeftButton.disabled = true;
    scrollRightButton.disabled = true;
    if (root.scrollLeft !== 0) root.scrollLeft = 0;
    return;
  }
  const maximum = Math.max(0, root.scrollWidth - root.clientWidth);
  scrollLeftButton.disabled = root.scrollLeft <= OVERFLOW_EPSILON;
  scrollRightButton.disabled = root.scrollLeft >= maximum - OVERFLOW_EPSILON;
}

function scrollTo(left: number, behavior: ScrollBehavior): void {
  const clamped = Math.max(0, Math.min(left, root.scrollWidth - root.clientWidth));
  if (typeof root.scrollTo === "function") {
    root.scrollTo({ behavior, left: clamped });
  } else {
    root.scrollLeft = clamped;
  }
  scheduleScrollControlsUpdate();
}

export function ensureTabVisible(tabId: string | undefined): void {
  if (!tabId) return;
  const tab = tabElements().find((candidate) => candidate.dataset.tabId === tabId);
  if (!tab) return;
  const visibleStart = root.scrollLeft;
  const visibleEnd = visibleStart + root.clientWidth;
  const tabStart = tab.offsetLeft;
  const tabEnd = tabStart + tab.offsetWidth;
  if (tabStart < visibleStart + OVERFLOW_EPSILON) {
    scrollTo(tabStart, "auto");
  } else if (tabEnd > visibleEnd - OVERFLOW_EPSILON) {
    scrollTo(tabEnd - root.clientWidth, "auto");
  }
}

function scrollToAdjacentHiddenTab(direction: "left" | "right"): void {
  const tabs = tabElements();
  const visibleStart = root.scrollLeft;
  const visibleEnd = visibleStart + root.clientWidth;
  if (direction === "left") {
    const target = tabs.filter((tab) => tab.offsetLeft < visibleStart - OVERFLOW_EPSILON).at(-1);
    scrollTo(target?.offsetLeft ?? 0, "smooth");
    return;
  }
  const target = tabs.find((tab) =>
    tab.offsetLeft + tab.offsetWidth > visibleEnd + OVERFLOW_EPSILON
  );
  scrollTo(
    target ? target.offsetLeft + target.offsetWidth - root.clientWidth : root.scrollWidth,
    "smooth"
  );
}

export function scrollForDragPoint(clientX: number, continuous = false): void {
  if (!hasTabOverflow()) return;
  const bounds = root.getBoundingClientRect();
  const edge = Math.min(36, bounds.width / 4);
  const delta = dragScrollDelta(clientX, bounds.left, bounds.right, edge);
  if (delta === 0) {
    stopEdgeScroll();
    return;
  }
  root.scrollLeft += delta;
  refreshDragVisualForScroll();
  scheduleScrollControlsUpdate();
  if (!continuous) return;
  runtimeState.edgeScrollClientX = clientX;
  if (runtimeState.edgeScrollFrame !== undefined) return;
  const tick = (): void => {
    runtimeState.edgeScrollFrame = undefined;
    if (runtimeState.edgeScrollClientX === undefined || !hasTabOverflow()) return;
    const nextBounds = root.getBoundingClientRect();
    const nextEdge = Math.min(36, nextBounds.width / 4);
    const nextDelta = dragScrollDelta(
      runtimeState.edgeScrollClientX,
      nextBounds.left,
      nextBounds.right,
      nextEdge
    );
    if (nextDelta === 0) {
      runtimeState.edgeScrollClientX = undefined;
      return;
    }
    root.scrollLeft += nextDelta;
    refreshDragVisualForScroll();
    scheduleScrollControlsUpdate();
    runtimeState.edgeScrollFrame = requestAnimationFrame(tick);
  };
  runtimeState.edgeScrollFrame = requestAnimationFrame(tick);
}

function refreshDragVisualForScroll(): void {
  const visual = runtimeState.dragVisualState;
  if (!visual || visual.suspended || visual.latestClientX === undefined
    || terminalDragSessions.has(visual.sessionId)) return;
  const payload: RuntimeTabDragPayload = {
    grabRatioX: visual.grabRatioX,
    sessionId: visual.sessionId,
    tabHeight: visual.tabHeight,
    tabId: visual.tabId,
    tabWidth: visual.tabWidth
  };
  const beforeTab = resolveStableDragInsertion(payload, visual.latestClientX);
  previewDragPosition(payload, beforeTab, visual.latestClientX);
}

function dragScrollDelta(clientX: number, left: number, right: number, edge: number): number {
  if (clientX < left + edge) {
    const strength = clampRatio((left + edge - clientX) / Math.max(1, edge));
    return -(2 + Math.round(strength * 14));
  }
  if (clientX > right - edge) {
    const strength = clampRatio((clientX - (right - edge)) / Math.max(1, edge));
    return 2 + Math.round(strength * 14);
  }
  return 0;
}

export function stopEdgeScroll(): void {
  runtimeState.edgeScrollClientX = undefined;
  if (runtimeState.edgeScrollFrame !== undefined) cancelAnimationFrame(runtimeState.edgeScrollFrame);
  runtimeState.edgeScrollFrame = undefined;
}

function cancelActiveTabDrag(): void {
  if (!runtimeState.draggingTabId || runtimeState.dragCancelled) return;
  runtimeState.dragCancelled = true;
  clearDropIndicator();
  clearDragVisual({ mode: "restore" });
  clearDragProxy();
  stopEdgeScroll();
  if (runtimeState.dragOriginActiveTabId) {
    optimisticallyActivateTab(runtimeState.dragOriginActiveTabId);
  }
  if (runtimeState.dragSessionId) dispatch({ type: "tabDragCancel", sessionId: runtimeState.dragSessionId });
}

export function installRuntimeTabStrip(): void {
  window.__rionApplyRuntimeTabActivation = (request) => {
    if (!window.__rionRuntimeTabChromeReady || !runtimeState.chromeHydrated) {
      window.__rionPendingRuntimeTabActivations ??= [];
      window.__rionPendingRuntimeTabActivations.push(request);
      return;
    }
    const stale = request.revision < runtimeState.activationRevision;
    if (!stale) {
      runtimeState.activationRevision = request.revision;
      if (request.mode === "reconcile") applyRuntimeTabOrder(request.orderedTabIds, false);
      optimisticallyActivateTab(request.targetTabId);
    }
    const activeTabs = tabElements().filter((tab) =>
      tab.classList.contains("active") && tab.getAttribute("aria-selected") === "true"
    );
    const observedActiveTabId = activeTabs.length === 1
      ? activeTabs[0]?.dataset.tabId
      : undefined;
    const acknowledgement: RuntimeTabActivationAcknowledgementRecord = {
      operationId: request.operationId,
      revision: request.revision,
      targetTabId: request.targetTabId,
      ...(observedActiveTabId ? { observedActiveTabId } : {}),
      status: stale
        ? "superseded"
        : observedActiveTabId === request.targetTabId ? "applied" : "failed"
    };
    void invoke("rion_runtime_tab_action", {
      action: { type: "tabActivationApplied", acknowledgement }
    }).catch(() => undefined);
  };

  window.__rionApplyRuntimeTabChromeMutation = (revision, mutation) => {
    if (!window.__rionRuntimeTabChromeReady || !runtimeState.chromeHydrated) {
      window.__rionPendingRuntimeTabChromeMutations ??= [];
      window.__rionPendingRuntimeTabChromeMutations.push({ mutation, revision });
      return;
    }
    mutation();
    void invoke("rion_runtime_tab_action", {
      action: { type: "presentationApplied", revision }
    }).catch(() => undefined);
  };

  window.__rionApplyRuntimeTabState = (state) => {
    runtimeState.chromeHydrated = true;
    render(state, true);
  };
  window.__rionApplyRuntimeTabChromeProjection = applyChromeProjection;

  window.__rionEnsureRuntimeTab = (tab) => {
    const labels = runtimeTabStripLabels(runtimeState.current?.language ?? "en");
    if (tab.workspaceTemplate) workspaceTemplateByTabId.set(tab.id, tab.workspaceTemplate);
    let button = tabElements().find((candidate) => candidate.dataset.tabId === tab.id);
    if (!button) {
      button = createTabButton(tab.id);
      button.title = tab.name;
      const icon = createTabIcon(tab.type, undefined, tab.workspaceTemplate);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = tab.name;
      const audio = createAudioIndicator(false, false, "", "");
      const close = createCloseControl(tab.id, labels.closeTab);
      button.append(icon, name, audio, close);
      iconSignatureByButton.set(button, `${tab.type}\u0000${tab.workspaceTemplate ?? ""}\u0000`);
      audioSignatureByButton.set(button, "false\u0000false\u0000\u0000");
      root.append(button);
      if (runtimeState.dragVisualState?.tabId === tab.id && runtimeState.dragVisualState.slot.isConnected) {
        adoptDragSurface(button);
      }
    }
    scheduleScrollControlsUpdate();
  };

  window.__rionReserveRuntimeTab = (tab) => {
    window.__rionEnsureRuntimeTab?.(tab);
    optimisticallyActivateTab(tab.id);
    scheduleScrollControlsUpdate();
  };

  window.__rionRemoveRuntimeTab = (tabId, nextTabId) => {
    const button = tabElements().find((tab) => tab.dataset.tabId === tabId);
    button?.remove();
    const visual = runtimeState.dragVisualState;
    if (visual && button && visual.surface === button) {
      visual.surface = undefined;
      visual.slot.remove();
      visual.suspended = true;
    }
    workspaceTemplateByTabId.delete(tabId);
    if (nextTabId) optimisticallyActivateTab(nextTabId);
    else {
      runtimeState.activeTabId = undefined;
      runtimeState.optimisticActiveTabId = undefined;
    }
    scheduleScrollControlsUpdate();
  };

  window.__rionReorderRuntimeTabs = (tabIds) => {
    if (deferRuntimeTabOrder(tabIds)) return;
    runtimeState.pendingRuntimeTabOrder = undefined;
    applyRuntimeTabOrder(tabIds, true);
  };

  window.__rionSetActiveRuntimeTab = (tabId) => {
    if (tabId) optimisticallyActivateTab(tabId);
    else {
      for (const tab of tabElements()) {
        tab.classList.remove("active");
        tab.setAttribute("aria-selected", "false");
        syncCloseControlState(tab);
      }
      runtimeState.activeTabId = undefined;
      runtimeState.optimisticActiveTabId = undefined;
    }
  };

  window.__rionUpdateRuntimeTabMetadata = (tab) => {
    const button = tabElements().find((candidate) => candidate.dataset.tabId === tab.id);
    if (!button) return;
    if (tab.workspaceTemplate) workspaceTemplateByTabId.set(tab.id, tab.workspaceTemplate);
    button.title = tab.tooltip;
    button.dataset.phase = tab.phase;
    button.dataset.sourceId = tab.sourceId;
    const name = button.querySelector<HTMLElement>(".name");
    if (name) name.textContent = tab.name;
    const previousIcon = button.querySelector<HTMLElement>(".icon");
    const icon = createTabIcon(
      tab.type,
      tab.iconDataUrl,
      workspaceTemplateByTabId.get(tab.id)
    );
    previousIcon?.replaceWith(icon);
    iconSignatureByButton.set(
      button,
      `${tab.type}\u0000${workspaceTemplateByTabId.get(tab.id) ?? ""}\u0000${tab.iconDataUrl ?? ""}`
    );
  
    const audio = createAudioIndicator(
      tab.audioMuted,
      tab.audible,
      tab.mutedLabel,
      tab.playingLabel
    );
    button.querySelector(".audio")?.replaceWith(audio);
    audioSignatureByButton.set(
      button,
      `${tab.audioMuted}\u0000${tab.audible}\u0000${tab.mutedLabel}\u0000${tab.playingLabel}`
    );
    let close = button.querySelector<HTMLElement>(".close");
    if (tab.hideCloseButton) close?.remove();
    else if (!close) {
      close = createCloseControl(tab.id, tab.closeLabel);
      button.append(close);
    }
    if (close) close.ariaLabel = tab.closeLabel;
    syncCloseControlState(button);
    scheduleScrollControlsUpdate();
  };

  window.__rionUpdateRuntimeTabMetadataBatch = (tabs) => {
    for (const tab of tabs) window.__rionUpdateRuntimeTabMetadata?.(tab);
  };

  window.__rionRuntimeTabChromeReady = true;
  announceChromeReady(
    runtimeState.rendererInstanceId,
    window.__rionRuntimeTabChromeIdentity
  );

  document.body.addEventListener("pointerenter", () => {
    if (runtimeState.current?.fullscreen && !runtimeState.current.alwaysShowToolbarInFullScreen) {
      dispatch({ type: "fullscreenToolbarEnter" });
    }
  });

  document.body.addEventListener("pointerleave", () => {
    if (runtimeState.current?.fullscreen && !runtimeState.current.alwaysShowToolbarInFullScreen) {
      dispatch({ type: "fullscreenToolbarLeave" });
    }
  });

  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && runtimeState.draggingTabId) {
      cancelActiveTabDrag();
      return;
    }
    const applicationCommand = applicationShortcutForKeyEvent(event);
    if (applicationCommand) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dispatch({ type: "applicationShortcut", command: applicationCommand });
      return;
    }
    if (event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    event.preventDefault();
    dispatch({ type: "activateAdjacent", direction: event.shiftKey ? "previous" : "next" });
  }, true);

  root.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const payload = runtimeTabDragPayload(event.dataTransfer);
    const beforeTab = resolveStableDragInsertion(payload, event.clientX);
    if (payload) clearDropIndicator();
    else setDropIndicator();
    previewDragPosition(payload, beforeTab, event.clientX);
    scheduleDragHover(payload, beforeTab?.dataset.tabId, event);
    scrollForDragPoint(event.clientX, Boolean(payload));
  });

  root.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
    clearDropIndicator();
    stopEdgeScroll();
  });

  root.addEventListener("drop", (event) => {
    event.preventDefault();
    clearDropIndicator();
    const payload = runtimeTabDragPayload(event.dataTransfer);
    if (!payload || !runtimeState.current) return;
    localDropSessions.add(payload.sessionId);
    const beforeTab = resolveStableDragInsertion(payload, event.clientX);
    previewDragPosition(payload, beforeTab, event.clientX);
    const orderedTabIds = logicalRuntimeTabOrder();
    dispatch({
      type: "tabDragDrop",
      sessionId: payload.sessionId,
      windowId: runtimeState.current.windowId,
      screenX: event.screenX,
      screenY: event.screenY,
      orderedTabIds,
      ...(beforeTab?.dataset.tabId ? { beforeTabId: beforeTab.dataset.tabId } : {})
    });
    clearDragVisual({ mode: "settle", sessionId: payload.sessionId });
    stopEdgeScroll();
  });

  document.body.addEventListener("dragover", (event) => {
    if (event.target instanceof Node && root.contains(event.target)) return;
    const payload = runtimeTabDragPayload(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    clearDropIndicator();
    const beforeTab = event.clientX <= root.getBoundingClientRect().left
      ? tabElements().find((tab) => tab.dataset.tabId !== payload.tabId)
      : undefined;
    rememberDragInsertion(payload, beforeTab, event.clientX);
    previewDragPosition(payload, beforeTab, event.clientX);
    scheduleDragHover(payload, beforeTab?.dataset.tabId, event);
    stopEdgeScroll();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  document.body.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && document.body.contains(event.relatedTarget)) return;
    suspendDragVisual();
    stopEdgeScroll();
  });

  document.body.addEventListener("drop", (event) => {
    if (event.target instanceof Node && root.contains(event.target)) return;
    const payload = runtimeTabDragPayload(event.dataTransfer);
    if (!payload || !runtimeState.current) return;
    localDropSessions.add(payload.sessionId);
    event.preventDefault();
    const beforeTab = event.clientX <= root.getBoundingClientRect().left
      ? tabElements().find((tab) => tab.dataset.tabId !== payload.tabId)
      : undefined;
    rememberDragInsertion(payload, beforeTab, event.clientX);
    previewDragPosition(payload, beforeTab, event.clientX);
    const orderedTabIds = logicalRuntimeTabOrder();
    dispatch({
      type: "tabDragDrop",
      sessionId: payload.sessionId,
      windowId: runtimeState.current.windowId,
      screenX: event.screenX,
      screenY: event.screenY,
      orderedTabIds,
      ...(beforeTab?.dataset.tabId ? { beforeTabId: beforeTab.dataset.tabId } : {})
    });
    clearDragVisual({ mode: "settle", sessionId: payload.sessionId });
    stopEdgeScroll();
  });

  add.addEventListener("click", () => dispatch({ type: "openLauncher" }));

  add.addEventListener("contextmenu", (event) => event.preventDefault());

  root.addEventListener("scroll", () => {
    scheduleScrollControlsUpdate();
    refreshDragVisualForScroll();
  });

  root.addEventListener("wheel", (event) => {
    if (!hasTabOverflow() || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    root.scrollLeft += event.deltaY;
    scheduleScrollControlsUpdate();
  }, { passive: false });

  scrollLeftButton.addEventListener("click", () => scrollToAdjacentHiddenTab("left"));

  scrollRightButton.addEventListener("click", () => scrollToAdjacentHiddenTab("right"));

  scrollLeftButton.replaceChildren(createLucideSvg(ChevronLeft));

  scrollRightButton.replaceChildren(createLucideSvg(ChevronRight));

  add.replaceChildren(createLucideSvg(Plus));

  addEventListener("resize", scheduleScrollControlsUpdate);

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(scheduleScrollControlsUpdate).observe(root);
  }

  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(scheduleScrollControlsUpdate).observe(root, {
      characterData: true,
      childList: true,
      subtree: true
    });
  }

  void runtimeState.current;
}
