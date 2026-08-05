// Focused implementation extracted from runtimeTabStrip.ts.
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import type { RuntimeTabDragSessionRecord, SystemRuntimeOperationSummaryRecord } from "../../../shared/generated";

import { handleSystemRuntimeReceipt } from "../../src/app/systemRuntimeReceipt";

import { applyRuntimeTabOrder, ensureTabVisible, scheduleScrollControlsUpdate, tabElements } from "./entry";

import type { RuntimeTabDragPayload } from "./entry";

import { TAB_REORDER_HYSTERESIS_MAX, TAB_REORDER_HYSTERESIS_MIN, TAB_REORDER_HYSTERESIS_RATIO, adoptDragSurface, cancelledDragSessions, clearDragVisual, createDragSlot, dispatch, dragActionQueue, dragIntentOrders, localDropSessions, logicalRuntimeTabOrder, positionDragSurface, reorderAnimationFrameByElement, root, runtimeState, syncCloseControlState, terminalDragSessions, workspaceTemplateByTabId } from "../runtimeTabStrip";

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
  const previousRects = new Map(
    Array.from(root.children).map((child) => [child, child.getBoundingClientRect()] as const)
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
    if (visual.surface) visual.slot.after(visual.surface);
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
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.classList.contains("drag-surface")) continue;
    const previous = previousRects.get(child);
    if (!previous) continue;
    const next = child.getBoundingClientRect();
    const deltaX = previous.left - next.left;
    if (Math.abs(deltaX) < 0.5) continue;
    const pendingFrame = reorderAnimationFrameByElement.get(child);
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    child.style.transition = "none";
    child.style.transform = `translateX(${deltaX}px)`;
    const frame = requestAnimationFrame(() => {
      reorderAnimationFrameByElement.delete(child);
      child.style.transition = "transform 120ms ease-out";
      child.style.transform = "";
    });
    reorderAnimationFrameByElement.set(child, frame);
  }
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
  try {
    handleSystemRuntimeReceipt(receipt);
  } catch (error) {
    const issue = error as { code?: string; message?: string };
    void emit("rion://shell-error", {
      code: issue.code ?? receipt.failureCode ?? "SYSTEM_TAB_DRAG_FAILED",
      message: issue.message ?? "The native tab drag could not be committed."
    });
  }
  completeTerminalDragAction(sessionId);
}

export function handleRuntimeTabDragSession(session: RuntimeTabDragSessionRecord): void {
  if (session.status === "active") return;
  if (session.status === "cancelled" || session.status === "failed"
    || session.status === "indeterminate") {
    cancelledDragSessions.add(session.sessionId);
  }
  if (session.status === "failed" || session.status === "indeterminate") {
    const code = session.failureCode ?? "SYSTEM_TAB_DRAG_FAILED";
    void emit("rion://shell-error", {
      code,
      message: session.status === "indeterminate"
        ? `The native tab drag could not be confirmed (${code}). Restart Rion Studio before trying again.`
        : `The native tab drag failed (${code}).`
    });
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
  const intent = dragIntentOrders.get(sessionId);
  const cancelled = cancelledDragSessions.has(sessionId);
  if (runtimeState.dragVisualState?.sessionId === sessionId) {
    clearDragVisual({
      mode: cancelled ? "restore" : "settle",
      sessionId
    });
  }
  localDropSessions.delete(sessionId);
  runtimeState.latestDragIntentSessionId = undefined;
  const pending = runtimeState.pendingRuntimeTabOrder?.ownerSessionId === sessionId
    ? runtimeState.pendingRuntimeTabOrder
    : undefined;
  if (pending) runtimeState.pendingRuntimeTabOrder = undefined;
  if (cancelled) {
    if (intent?.originOrder.length) applyRuntimeTabOrder(intent.originOrder, true);
    if (pending) applyRuntimeTabOrder(pending.order, true);
  } else if (pending) {
    const finalOrder = intent?.finalOrder ?? logicalRuntimeTabOrder();
    if (ordersEqual(pending.order, finalOrder)) applyRuntimeTabOrder(pending.order, true);
  }
  dragIntentOrders.delete(sessionId);
}

function ordersEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tabId, index) => tabId === right[index]);
}
