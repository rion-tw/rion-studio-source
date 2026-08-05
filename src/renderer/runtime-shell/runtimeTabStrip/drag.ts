// Focused implementation extracted from runtimeTabStrip.ts.
import { invoke } from "@tauri-apps/api/core";

import type { RuntimeTabDragSessionRecord, SystemRuntimeOperationSummaryRecord } from "../../../shared/generated";

import { ensureTabVisible, scheduleScrollControlsUpdate, tabElements } from "./entry";

import type { RuntimeTabDragPayload } from "./entry";

import { TAB_REORDER_HYSTERESIS_MAX, TAB_REORDER_HYSTERESIS_MIN, TAB_REORDER_HYSTERESIS_RATIO, add, adoptDragSurface, cancelledDragSessions, clearDragVisual, createDragSlot, dispatch, dragActionQueue, dragIntentOrders, localDropSessions, logicalRuntimeTabOrder, pinsSingleLocalDrag, positionDragSurface, reorderAnimationFrameByElement, root, runtimeState, scrollRightButton, syncCloseControlState, terminalDragSessions, workspaceTemplateByTabId } from "../runtimeTabStrip";

export function resolveStableDragInsertion(
  payload: RuntimeTabDragPayload | undefined,
  clientX: number
): HTMLButtonElement | undefined {
  if (!payload) return undefined;
  const candidates = tabElements().filter((tab) => tab.dataset.tabId !== payload.tabId);
  const draggedFrame = dragTabFrame(payload, clientX);
  const visualCenterX = draggedFrame.center - root.getBoundingClientRect().left + root.scrollLeft;
  if (candidates.length === 0) {
    runtimeState.dragInsertionState = { sessionId: payload.sessionId, visualCenterX };
    return undefined;
  }
  const geometries = candidates.map((tab) => transformFreeTabGeometry(tab));
  const rawIndex = geometries.findIndex(({ center }) => draggedFrame.center < center);
  const desiredIndex = rawIndex < 0 ? candidates.length : rawIndex;
  let insertionIndex = currentDragInsertionIndex(payload, candidates, desiredIndex);

  const previousInsertionState = runtimeState.dragInsertionState?.sessionId === payload.sessionId
    ? runtimeState.dragInsertionState
    : undefined;
  let insertionProbeX = draggedFrame.center;
  let shouldResolveInsertion = true;
  if (previousInsertionState) {
    const deltaX = visualCenterX - previousInsertionState.visualCenterX;
    if (deltaX > 0.1) insertionProbeX = draggedFrame.maximum;
    else if (deltaX < -0.1) insertionProbeX = draggedFrame.minimum;
    else shouldResolveInsertion = false;
  }
  if (shouldResolveInsertion) {
    insertionIndex = stableDragInsertionIndex(insertionProbeX, geometries, insertionIndex);
  }

  const beforeTab = candidates[insertionIndex];
  runtimeState.dragInsertionState = {
    sessionId: payload.sessionId,
    visualCenterX,
    ...(beforeTab?.dataset.tabId ? { beforeTabId: beforeTab.dataset.tabId } : {})
  };
  return beforeTab;
}

function dragTabFrame(
  payload: RuntimeTabDragPayload,
  clientX: number
): { center: number; maximum: number; minimum: number } {
  const minimum = clientX - payload.grabRatioX * payload.tabWidth;
  const maximum = minimum + payload.tabWidth;
  return { center: (minimum + maximum) / 2, maximum, minimum };
}

function stableDragInsertionIndex(
  pointX: number,
  geometries: { center: number; width: number }[],
  currentIndex: number
): number {
  const rawIndex = geometries.findIndex(({ center }) => pointX < center);
  const desiredIndex = rawIndex < 0 ? geometries.length : rawIndex;
  let insertionIndex = Math.min(currentIndex, geometries.length);
  if (desiredIndex > insertionIndex) {
    while (insertionIndex < desiredIndex) {
      const boundary = geometries[insertionIndex];
      if (!boundary
        || pointX < boundary.center + tabReorderHysteresis(boundary.width)) break;
      insertionIndex += 1;
    }
  } else if (desiredIndex < insertionIndex) {
    while (insertionIndex > desiredIndex) {
      const boundary = geometries[insertionIndex - 1];
      if (!boundary
        || pointX > boundary.center - tabReorderHysteresis(boundary.width)) break;
      insertionIndex -= 1;
    }
  }
  return insertionIndex;
}

function currentDragInsertionIndex(
  payload: RuntimeTabDragPayload,
  candidates: HTMLButtonElement[],
  fallbackIndex: number
): number {
  if (runtimeState.dragInsertionState?.sessionId === payload.sessionId) {
    if (!runtimeState.dragInsertionState.beforeTabId) return candidates.length;
    const rememberedIndex = candidates.findIndex(
      (tab) => tab.dataset.tabId === runtimeState.dragInsertionState?.beforeTabId
    );
    if (rememberedIndex >= 0) return rememberedIndex;
  }

  const marker = runtimeState.dragVisualState?.sessionId === payload.sessionId
    ? runtimeState.dragVisualState.slot
    : tabElements().find((tab) => tab.dataset.tabId === payload.tabId);
  if (!marker) return fallbackIndex;
  const children = Array.from(root.children);
  const markerIndex = children.indexOf(marker);
  if (markerIndex < 0) return fallbackIndex;
  return candidates.filter((candidate) => children.indexOf(candidate) < markerIndex).length;
}

function transformFreeTabGeometry(tab: HTMLButtonElement): { center: number; width: number } {
  const bounds = tab.getBoundingClientRect();
  const width = Math.max(1, tab.offsetWidth || bounds.width);
  if (tab.offsetWidth <= 0) return { center: bounds.left + width / 2, width };
  const offsetParent = tab.offsetParent;
  const offsetParentLeft = offsetParent?.getBoundingClientRect().left ?? 0;
  const offsetParentBorder = offsetParent instanceof HTMLElement ? offsetParent.clientLeft : 0;
  return {
    center: offsetParentLeft + offsetParentBorder + tab.offsetLeft - root.scrollLeft + width / 2,
    width
  };
}

function tabReorderHysteresis(width: number): number {
  return Math.min(
    TAB_REORDER_HYSTERESIS_MAX,
    Math.max(TAB_REORDER_HYSTERESIS_MIN, Math.round(width * TAB_REORDER_HYSTERESIS_RATIO))
  );
}

export function rememberDragInsertion(
  payload: RuntimeTabDragPayload,
  beforeTab?: HTMLButtonElement,
  clientX?: number
): void {
  const previousCenter = runtimeState.dragInsertionState?.sessionId === payload.sessionId
    ? runtimeState.dragInsertionState.visualCenterX
    : undefined;
  const frame = clientX !== undefined && Number.isFinite(clientX)
    ? dragTabFrame(payload, clientX)
    : undefined;
  const visualCenterX = frame
    ? frame.center - root.getBoundingClientRect().left + root.scrollLeft
    : previousCenter ?? 0;
  runtimeState.dragInsertionState = {
    sessionId: payload.sessionId,
    visualCenterX,
    ...(beforeTab?.dataset.tabId ? { beforeTabId: beforeTab.dataset.tabId } : {})
  };
}

export function previewDragPosition(
  payload: RuntimeTabDragPayload | undefined,
  beforeTab?: HTMLButtonElement,
  clientX?: number
): void {
  if (!payload) return;
  if (terminalDragSessions.has(payload.sessionId)) return;
  if (runtimeState.dragVisualState?.sessionId !== payload.sessionId) {
    clearDragVisual({ mode: "discard" });
    const slot = createDragSlot(payload);
    runtimeState.dragVisualState = {
      grabRatioX: payload.grabRatioX,
      ...(Number.isFinite(clientX) ? { latestClientX: clientX } : {}),
      originOrder: tabElements().map((tab) => tab.dataset.tabId).filter(Boolean) as string[],
      sessionId: payload.sessionId,
      slot,
      suspended: false,
      tabHeight: payload.tabHeight,
      tabId: payload.tabId,
      tabWidth: payload.tabWidth
    };
  }
  const visual = runtimeState.dragVisualState;
  if (!visual) return;
  if (pinsSingleLocalDrag()) {
    visual.suspended = false;
    visual.slot.remove();
    return;
  }
  const previousRects = new Map(
    [...Array.from(root.children), add]
      .map((child) => [child, child.getBoundingClientRect()] as const)
  );
  const local = tabElements().find((tab) => tab.dataset.tabId === payload.tabId);
  const nextBeforeTabId = beforeTab?.dataset.tabId;
  const insertionChanged = visual.suspended || !visual.slot.isConnected
    || visual.beforeTabId !== nextBeforeTabId;
  visual.suspended = false;
  visual.surface?.classList.remove("drag-surface-suspended");
  if (insertionChanged) {
    if (beforeTab) root.insertBefore(visual.slot, beforeTab);
    else root.append(visual.slot);
    visual.beforeTabId = nextBeforeTabId;
    animateReorderedTabs(previousRects);
  }
  if (local && visual.surface !== local) adoptDragSurface(local);
  if (clientX !== undefined && Number.isFinite(clientX)) {
    visual.latestClientX = clientX;
    positionDragSurface(clientX);
  }
}

export function animateReorderedTabs(previousRects: Map<Element, DOMRect>): void {
  if (typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layoutChildren = Array.from(root.children) as HTMLElement[];
  for (const child of layoutChildren) {
    if (child.classList.contains("drag-surface")) continue;
    const previous = previousRects.get(child);
    if (!previous) continue;
    const next = child.getBoundingClientRect();
    const deltaX = previous.left - next.left;
    animateHorizontalReorder(child, deltaX);
  }

  const lastLayoutChild = [...layoutChildren].reverse().find(
    (child) => !child.classList.contains("drag-surface")
  );
  const previousLast = lastLayoutChild
    ? previousRects.get(lastLayoutChild)
    : undefined;
  const nextLast = lastLayoutChild?.getBoundingClientRect();
  const previousAdd = previousRects.get(add);
  const nextAdd = add.getBoundingClientRect();
  const addDeltaX = scrollRightButton.hidden && previousLast && nextLast
    ? previousLast.left - nextLast.left
    : previousAdd ? previousAdd.left - nextAdd.left : 0;
  animateHorizontalReorder(add, addDeltaX);
}

function animateHorizontalReorder(element: HTMLElement, deltaX: number): void {
  if (Math.abs(deltaX) < 0.5) return;
  const pendingFrame = reorderAnimationFrameByElement.get(element);
  if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  element.style.transition = "none";
  element.style.transform = `translateX(${deltaX}px)`;
  const frame = requestAnimationFrame(() => {
    reorderAnimationFrameByElement.delete(element);
    element.style.transition = "transform 120ms ease-out";
    element.style.transform = "";
  });
  reorderAnimationFrameByElement.set(element, frame);
}

export function scheduleDragHover(
  payload: RuntimeTabDragPayload | undefined,
  beforeTabId: string | undefined,
  event: DragEvent
): void {
  if (!payload || !runtimeState.current) return;
  const visual = runtimeState.dragVisualState?.sessionId === payload.sessionId ? runtimeState.dragVisualState : undefined;
  const preview = visual?.surface ?? visual?.slot
    ?? tabElements().find((tab) => tab.dataset.tabId === payload.tabId);
  const bounds = preview?.getBoundingClientRect();
  dispatch({
    type: "tabDragHover",
    sessionId: payload.sessionId,
    windowId: runtimeState.current.windowId,
    screenX: event.screenX,
    screenY: event.screenY,
    tabWidth: Math.max(1, bounds?.width || payload.tabWidth),
    tabHeight: Math.max(1, bounds?.height || payload.tabHeight),
    orderedTabIds: logicalRuntimeTabOrder(),
    ...(beforeTabId && beforeTabId !== payload.tabId ? { beforeTabId } : {})
  });
}

export function optimisticallyActivateTab(tabId: string): void {
  for (const tab of tabElements()) {
    const active = tab.dataset.tabId === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    syncCloseControlState(tab);
  }
  runtimeState.activeTabId = tabId;
  runtimeState.optimisticActiveTabId = tabId;
  ensureTabVisible(tabId);
}

export function optimisticallyActivateAdjacentTab(direction: "next" | "previous"): void {
  const tabs = tabElements();
  if (tabs.length === 0) return;
  const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.classList.contains("active")));
  const targetIndex = direction === "previous"
    ? (currentIndex + tabs.length - 1) % tabs.length
    : (currentIndex + 1) % tabs.length;
  const targetId = tabs[targetIndex]?.dataset.tabId;
  if (targetId) optimisticallyActivateTab(targetId);
}

export function optimisticallyCloseTab(tabId: string): void {
  const tabs = tabElements();
  const closingIndex = tabs.findIndex((tab) => tab.dataset.tabId === tabId);
  if (closingIndex < 0) return;
  const wasActive = tabs[closingIndex].classList.contains("active");
  tabs[closingIndex].remove();
  workspaceTemplateByTabId.delete(tabId);
  if (wasActive) {
    const remaining = tabElements();
    const successor = remaining[Math.min(closingIndex, remaining.length - 1)];
    if (successor?.dataset.tabId) optimisticallyActivateTab(successor.dataset.tabId);
    else {
      runtimeState.activeTabId = undefined;
      runtimeState.optimisticActiveTabId = undefined;
    }
  }
  scheduleScrollControlsUpdate();
}

export const dispatchNextDragAction = (): void => {
  if (runtimeState.dragActionPending) return;
  const action = dragActionQueue.shift();
  if (!action) return;
  runtimeState.dragActionPending = true;
  void invoke<RuntimeTabDragSessionRecord | SystemRuntimeOperationSummaryRecord | null>(
    "rion_runtime_tab_action",
    { action }
  )
    .then((result) => {
      if (!result) {
        if (action.type === "tabDragSourceEnd" || action.type === "tabDragEnd"
          || action.type === "tabDragCancel") completeTerminalDragAction(action.sessionId);
        return;
      }
      if (isSystemRuntimeReceipt(result)) handleRuntimeTabDragReceipt(action.sessionId, result);
      else handleRuntimeTabDragSession(result);
    })
    .catch(() => {
      if (action.type === "tabDragStart" || action.type === "tabDragCancel") {
        cancelledDragSessions.add(action.sessionId);
        completeTerminalDragAction(action.sessionId);
        return;
      }
      if ((action.type === "tabDragDrop" || action.type === "tabDragSourceEnd"
        || action.type === "tabDragEnd")
        && !cancelledDragSessions.has(action.sessionId)) {
        cancelledDragSessions.add(action.sessionId);
        dispatch({ type: "tabDragCancel", sessionId: action.sessionId });
      }
    })
    .finally(() => {
      runtimeState.dragActionPending = false;
      dispatchNextDragAction();
    });
};

function isSystemRuntimeReceipt(
  result: RuntimeTabDragSessionRecord | SystemRuntimeOperationSummaryRecord
): result is SystemRuntimeOperationSummaryRecord {
  return "completionScope" in result;
}

function handleRuntimeTabDragReceipt(
  sessionId: string,
  receipt: SystemRuntimeOperationSummaryRecord
): void {
  if (receipt.status === "cancelled" || receipt.status === "failed"
    || receipt.status === "indeterminate") {
    cancelledDragSessions.add(sessionId);
  }
  completeTerminalDragAction(sessionId);
}

export function handleRuntimeTabDragSession(session: RuntimeTabDragSessionRecord): void {
  if (session.status === "active") return;
  if (session.status === "cancelled" || session.status === "failed"
    || session.status === "indeterminate") {
    cancelledDragSessions.add(session.sessionId);
  }
  completeTerminalDragAction(session.sessionId);
}

function completeTerminalDragAction(sessionId: string): void {
  const isLatestIntent = runtimeState.latestDragIntentSessionId === sessionId;
  if (!isLatestIntent) {
    localDropSessions.delete(sessionId);
    dragIntentOrders.delete(sessionId);
    return;
  }
  if (runtimeState.dragVisualState?.sessionId === sessionId) {
    clearDragVisual({
      mode: "settle",
      sessionId
    });
  }
  localDropSessions.delete(sessionId);
  runtimeState.latestDragIntentSessionId = undefined;
  dragIntentOrders.delete(sessionId);
}
