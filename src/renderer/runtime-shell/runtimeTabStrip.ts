import { invoke } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Gamepad2,
  Grid2x2,
  Plus,
  Square,
  Volume2,
  VolumeX,
  X,
  type LucideIcon
} from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { applicationShortcutForKeyEvent } from "../../shared/applicationShortcuts";
import type { RuntimeTabAction, RuntimeTabStripState } from "../../shared/runtimeTabs";
import type { WorkspaceLayoutTemplate } from "../../shared/types";
import { runtimeTabStripLabels } from "../src/i18n";

declare global {
  interface Window {
    __rionApplyRuntimeTabState?: (state: RuntimeTabStripState) => void;
    __rionEnsureRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionPendingRuntimeTabOrder?: string[];
    __rionPendingRuntimeTabEnsures?: ProvisionalRuntimeTab[];
    __rionPendingRuntimeTabs?: ProvisionalRuntimeTab[];
    __rionRemoveRuntimeTab?: (tabId: string, nextTabId?: string) => void;
    __rionReorderRuntimeTabs?: (tabIds: string[]) => void;
    __rionReserveRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionSetActiveRuntimeTab?: (tabId?: string) => void;
    __rionUpdateRuntimeTabMetadata?: (tab: RuntimeTabMetadata) => void;
    __rionUpdateRuntimeTabMetadataBatch?: (tabs: RuntimeTabMetadata[]) => void;
  }
}

type ProvisionalRuntimeTab = {
  id: string;
  name: string;
  type: "role" | "workspace";
  workspaceTemplate?: WorkspaceLayoutTemplate | null;
};

type RuntimeTabMetadata = ProvisionalRuntimeTab & {
  audible: boolean;
  audioMuted: boolean;
  closeLabel: string;
  hideCloseButton: boolean;
  iconDataUrl?: string | null;
  mutedLabel: string;
  phase: "reserved" | "attaching" | "loading" | "ready" | "degraded" | "failed";
  playingLabel: string;
  sourceId: string;
  tooltip: string;
};

const root = document.querySelector<HTMLDivElement>("#tabs")!;
const add = document.querySelector<HTMLButtonElement>("#add")!;
const scrollLeftButton = document.querySelector<HTMLButtonElement>("#scroll-left")!;
const scrollRightButton = document.querySelector<HTMLButtonElement>("#scroll-right")!;
let current: RuntimeTabStripState | undefined;
let draggingTabId: string | undefined;
let dragSessionId: string | undefined;
let dragCancelled = false;
let dragMoveFrame: number | undefined;
let pendingDragPoint: { screenX: number; screenY: number } | undefined;
let lastDragPoint: { screenX: number; screenY: number } | undefined;
let edgeScrollFrame: number | undefined;
let edgeScrollClientX: number | undefined;
let dragInsertionState: {
  sessionId: string;
  beforeTabId?: string;
  visualCenterX: number;
} | undefined;
let dragProxyElement: HTMLElement | undefined;
let dragVisualState: RuntimeTabDragVisualState | undefined;
let pendingRuntimeTabOrder: string[] | undefined;
let renderRevision = 0;
let activeTabId: string | undefined;
let optimisticActiveTabId: string | undefined;
let dragActionPending = false;
let scrollControlsFrame: number | undefined;
const dragActionQueue: RuntimeTabAction[] = [];
const terminalDragSessions = new Set<string>();
const cancelledDragSessions = new Set<string>();
const localDropSessions = new Set<string>();
const workspaceTemplateByTabId = new Map<string, WorkspaceLayoutTemplate>();
const iconMarkup = new Map<LucideIcon, string>();
const iconSignatureByButton = new WeakMap<HTMLButtonElement, string>();
const audioSignatureByButton = new WeakMap<HTMLButtonElement, string>();
const reorderAnimationFrameByElement = new Map<HTMLElement, number>();

const OVERFLOW_EPSILON = 1;
const TAB_REORDER_HYSTERESIS_RATIO = 0.025;
const TAB_REORDER_HYSTERESIS_MIN = 2;
const TAB_REORDER_HYSTERESIS_MAX = 5;
const FINISHED_DRAG_SESSION_LIMIT = 128;

type RuntimeTabModel = RuntimeTabStripState["tabs"][number];

type RuntimeTabDragVisualState = {
  beforeTabId?: string;
  grabRatioX: number;
  latestClientX?: number;
  originOrder: string[];
  sessionId: string;
  slot: HTMLDivElement;
  surface?: HTMLButtonElement;
  suspended: boolean;
  tabHeight: number;
  tabId: string;
  tabWidth: number;
};

function createLucideSvg(Icon: LucideIcon): SVGSVGElement {
  let markup = iconMarkup.get(Icon);
  if (!markup) {
    markup = renderToStaticMarkup(createElement(Icon, {
      "aria-hidden": true,
      className: "glyph",
      focusable: false,
      size: 16,
      strokeWidth: 2
    }));
    iconMarkup.set(Icon, markup);
  }
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.querySelector<SVGSVGElement>("svg")!;
}

function fallbackIconForTab(
  type: ProvisionalRuntimeTab["type"],
  workspaceTemplate?: WorkspaceLayoutTemplate | null
): LucideIcon {
  if (type === "role") return Gamepad2;
  if (workspaceTemplate === "single") return Square;
  if (workspaceTemplate?.includes("columns")
    || workspaceTemplate?.includes("left")
    || workspaceTemplate?.includes("right")) {
    return Columns2;
  }
  return Grid2x2;
}

function createTabIcon(
  type: ProvisionalRuntimeTab["type"],
  iconDataUrl?: string | null,
  workspaceTemplate?: WorkspaceLayoutTemplate | null
): HTMLImageElement | HTMLSpanElement {
  if (iconDataUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.className = "icon";
    image.draggable = false;
    image.src = iconDataUrl;
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = "icon fallback";
  fallback.ariaHidden = "true";
  fallback.append(createLucideSvg(fallbackIconForTab(type, workspaceTemplate)));
  return fallback;
}

function createAudioIndicator(
  audioMuted: boolean,
  audible: boolean,
  mutedLabel: string,
  playingLabel: string
): HTMLSpanElement {
  const audio = document.createElement("span");
  audio.className = "audio";
  if (!audioMuted && !audible) {
    audio.classList.add("idle");
    audio.ariaHidden = "true";
    return audio;
  }
  audio.role = "img";
  audio.ariaLabel = audioMuted ? mutedLabel : playingLabel;
  audio.append(createLucideSvg(audioMuted ? VolumeX : Volume2));
  return audio;
}

const dispatch = (action: RuntimeTabAction): void => {
  if (action.type === "activate") optimisticallyActivateTab(action.tabId);
  else if (action.type === "activateAdjacent") optimisticallyActivateAdjacentTab(action.direction);
  else if (action.type === "stop") optimisticallyCloseTab(action.tabId);
  if (action.type.startsWith("tabDrag")) {
    const isMotion = action.type === "tabDragMove" || action.type === "tabDragHover";
    if (isMotion && terminalDragSessions.has(action.sessionId)) return;
    if (action.type === "tabDragDrop" || action.type === "tabDragEnd"
      || action.type === "tabDragCancel") {
      rememberTerminalDragSession(action.sessionId);
    }
    const queued = dragActionQueue.at(-1);
    const queuedIsMotion = queued?.type === "tabDragMove" || queued?.type === "tabDragHover";
    if (isMotion && queuedIsMotion && action.sessionId === queued.sessionId) {
      dragActionQueue[dragActionQueue.length - 1] = action;
    } else {
      if ((action.type === "tabDragDrop" || action.type === "tabDragEnd")
        && dragActionQueue.length > 0) {
        for (let index = dragActionQueue.length - 1; index >= 0; index -= 1) {
          const pending = dragActionQueue[index];
          if (pending.type !== "tabDragMove" && pending.type !== "tabDragHover") continue;
          if (pending.sessionId === action.sessionId) dragActionQueue.splice(index, 1);
        }
      }
      dragActionQueue.push(action);
    }
    dispatchNextDragAction();
    return;
  }
  void invoke("rion_runtime_tab_action", { action }).catch(() => {
    // Selection and close intent remain visually committed. The shell reports the
    // persistent error, while a later revision/snapshot may reconcile metadata without
    // making an old tab or viewport reappear.
  });
};

function rememberTerminalDragSession(sessionId: string): void {
  terminalDragSessions.add(sessionId);
  while (terminalDragSessions.size > FINISHED_DRAG_SESSION_LIMIT) {
    const oldest = terminalDragSessions.values().next().value as string | undefined;
    if (!oldest) break;
    terminalDragSessions.delete(oldest);
    cancelledDragSessions.delete(oldest);
  }
}

function createCloseControl(tabId: string, label: string): HTMLSpanElement {
  const control = document.createElement("span");
  control.className = "close";
  control.role = "button";
  control.tabIndex = -1;
  control.ariaLabel = label;
  control.ariaHidden = "true";
  control.append(createLucideSvg(X));
  control.addEventListener("pointerdown", (event) => event.stopPropagation());
  control.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    dispatch({ type: "stop", tabId });
  });
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "stop", tabId });
  });
  return control;
}

function syncCloseControlState(button: HTMLButtonElement): void {
  const close = button.querySelector<HTMLElement>(".close");
  if (!close) return;
  const visible = button.classList.contains("active");
  close.tabIndex = visible ? 0 : -1;
  close.ariaHidden = String(!visible);
}

function installTabButtonInteractions(button: HTMLButtonElement, tabId: string): void {
  let grabRatioX = 0.5;
  let grabRatioY = 0.5;
  button.draggable = true;
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const bounds = button.getBoundingClientRect();
    grabRatioX = clampRatio((event.clientX - bounds.left) / Math.max(1, bounds.width));
    grabRatioY = clampRatio((event.clientY - bounds.top) / Math.max(1, bounds.height));
  });
  button.addEventListener("click", () => dispatch({ type: "activate", tabId }));
  button.addEventListener("auxclick", (event) => {
    if (event.button === 1) dispatch({ type: "stop", tabId });
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    dispatch({ type: "openTabMenu", tabId });
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "openTabMenu", tabId });
  });
  button.addEventListener("dragstart", (event) => {
    clearDropIndicator();
    clearDragVisual({ mode: "restore" });
    optimisticallyActivateTab(tabId);
    draggingTabId = tabId;
    dragSessionId = crypto.randomUUID();
    dragCancelled = false;
    lastDragPoint = { screenX: event.screenX, screenY: event.screenY };
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    const bounds = button.getBoundingClientRect();
    const tabWidth = Math.max(1, bounds.width || button.offsetWidth || 1);
    const tabHeight = Math.max(1, bounds.height || button.offsetHeight || 28);
    const payload: RuntimeTabDragPayload = {
      sessionId: dragSessionId,
      tabId,
      tabWidth,
      tabHeight,
      grabRatioX
    };
    installTransparentDragImage(event.dataTransfer);
    beginDragVisual(payload, button, event.clientX);
    event.dataTransfer?.setData("text/rion-runtime-tab", JSON.stringify(payload));
    dispatch({
      type: "tabDragStart",
      sessionId: dragSessionId,
      tabId,
      screenX: event.screenX,
      screenY: event.screenY,
      grabRatioX,
      grabRatioY,
      tabWidth,
      tabHeight
    });
  });
  button.addEventListener("drag", (event) => {
    if (!dragSessionId || dragCancelled || (event.screenX === 0 && event.screenY === 0)) return;
    pendingDragPoint = { screenX: event.screenX, screenY: event.screenY };
    lastDragPoint = pendingDragPoint;
    if (dragMoveFrame !== undefined) return;
    dragMoveFrame = requestAnimationFrame(() => {
      dragMoveFrame = undefined;
      if (!dragSessionId || !pendingDragPoint) return;
      dispatch({ type: "tabDragMove", sessionId: dragSessionId, ...pendingDragPoint });
      pendingDragPoint = undefined;
    });
  });
  button.addEventListener("dragend", (event) => {
    const endingSessionId = dragSessionId;
    clearDropIndicator();
    stopEdgeScroll();
    if (dragMoveFrame !== undefined) {
      cancelAnimationFrame(dragMoveFrame);
      dragMoveFrame = undefined;
    }
    if (dragSessionId && event.dataTransfer?.dropEffect !== "move") {
      const terminalPoint = pendingDragPoint ?? (
        event.screenX !== 0 || event.screenY !== 0
          ? { screenX: event.screenX, screenY: event.screenY }
          : lastDragPoint
      ) ?? { screenX: event.screenX, screenY: event.screenY };
      dispatch({
        type: "tabDragEnd",
        sessionId: dragSessionId,
        cancelled: dragCancelled,
        ...terminalPoint
      });
    }
    clearDragVisual({ mode: dragCancelled ? "restore" : "settle" });
    clearDragProxy();
    if (endingSessionId && !dragCancelled && !localDropSessions.has(endingSessionId)) {
      flushPendingRuntimeTabOrder();
    }
    if (endingSessionId) localDropSessions.delete(endingSessionId);
    draggingTabId = undefined;
    dragSessionId = undefined;
    pendingDragPoint = undefined;
    lastDragPoint = undefined;
    dragCancelled = false;
  });
  button.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = runtimeTabDragPayload(event.dataTransfer);
    const beforeTab = resolveStableDragInsertion(payload, event.clientX);
    if (payload) clearDropIndicator();
    else setDropIndicator(beforeTab);
    previewDragPosition(payload, beforeTab, event.clientX);
    scheduleDragHover(payload, beforeTab?.dataset.tabId, event);
    scrollForDragPoint(event.clientX, Boolean(payload));
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  button.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearDropIndicator();
    const payload = runtimeTabDragPayload(event.dataTransfer);
    if (!payload || !current) return;
    localDropSessions.add(payload.sessionId);
    const beforeTab = resolveStableDragInsertion(payload, event.clientX);
    dispatch({
      type: "tabDragDrop",
      sessionId: payload.sessionId,
      windowId: current.windowId,
      screenX: event.screenX,
      screenY: event.screenY,
      beforeTabId: beforeTab?.dataset.tabId === payload.tabId
        ? nextTabElement(beforeTab)?.dataset.tabId
        : beforeTab?.dataset.tabId
    });
    stopEdgeScroll();
    clearDragVisual({ mode: "settle", sessionId: payload.sessionId });
  });
}

function installTransparentDragImage(dataTransfer: DataTransfer | null): void {
  clearDragProxy();
  if (!dataTransfer || typeof dataTransfer.setDragImage !== "function") return;
  // Chromium falls back to the source element when the custom drag image is fully
  // transparent or outside the viewport. Keep a drawable 1px canvas in the viewport;
  // its tokenized 1% alpha background is imperceptible but prevents WebView2 from
  // briefly painting the default cloned-tab ghost.
  const proxy = document.createElement("canvas");
  proxy.className = "drag-proxy";
  proxy.ariaHidden = "true";
  proxy.width = 1;
  proxy.height = 1;
  document.body.append(proxy);
  proxy.getBoundingClientRect();
  dataTransfer.setDragImage(proxy, 0, 0);
  dragProxyElement = proxy;
}

function clearDragProxy(): void {
  dragProxyElement?.remove();
  dragProxyElement = undefined;
}

function createDragSlot(payload: RuntimeTabDragPayload): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "tab drag-slot";
  slot.dataset.dragSlotSession = payload.sessionId;
  slot.dataset.dragSlotTab = payload.tabId;
  slot.ariaHidden = "true";
  slot.style.width = `${payload.tabWidth}px`;
  slot.style.minWidth = `${payload.tabWidth}px`;
  slot.style.maxWidth = `${payload.tabWidth}px`;
  slot.style.height = `${payload.tabHeight}px`;
  return slot;
}

function beginDragVisual(
  payload: RuntimeTabDragPayload,
  button: HTMLButtonElement,
  clientX: number
): void {
  const originOrder = tabElements().map((tab) => tab.dataset.tabId).filter(Boolean) as string[];
  const nextTabId = nextTabElement(button)?.dataset.tabId;
  const slot = createDragSlot(payload);
  root.insertBefore(slot, button);
  dragVisualState = {
    ...(nextTabId ? { beforeTabId: nextTabId } : {}),
    grabRatioX: payload.grabRatioX,
    latestClientX: clientX,
    originOrder,
    sessionId: payload.sessionId,
    slot,
    suspended: false,
    tabHeight: payload.tabHeight,
    tabId: payload.tabId,
    tabWidth: payload.tabWidth
  };
  adoptDragSurface(button);
}

function adoptDragSurface(button: HTMLButtonElement): void {
  const visual = dragVisualState;
  if (!visual || button.dataset.tabId !== visual.tabId) return;
  if (visual.surface && visual.surface !== button) clearDragSurfaceStyles(visual.surface);
  visual.surface = button;
  visual.slot.after(button);
  button.classList.add("drag-surface");
  button.classList.remove("drag-placeholder", "drag-surface-suspended", "dragging");
  button.setAttribute("aria-grabbed", "true");
  button.setAttribute("aria-hidden", "true");
  button.style.width = `${visual.tabWidth}px`;
  button.style.minWidth = `${visual.tabWidth}px`;
  button.style.maxWidth = `${visual.tabWidth}px`;
  button.style.height = `${visual.tabHeight}px`;
  if (visual.latestClientX !== undefined) positionDragSurface(visual.latestClientX);
}

function clearDragSurfaceStyles(button: HTMLButtonElement): void {
  button.classList.remove(
    "drag-surface",
    "drag-surface-suspended",
    "dragging",
    "drag-placeholder"
  );
  button.removeAttribute("aria-grabbed");
  button.removeAttribute("aria-hidden");
  button.style.removeProperty("width");
  button.style.removeProperty("min-width");
  button.style.removeProperty("max-width");
  button.style.removeProperty("height");
  button.style.removeProperty("left");
  button.style.removeProperty("top");
}

function positionDragSurface(clientX: number): void {
  const visual = dragVisualState;
  if (!visual?.surface || !Number.isFinite(clientX)) return;
  const rootBounds = root.getBoundingClientRect();
  const left = clientX - rootBounds.left + root.scrollLeft
    - visual.grabRatioX * visual.tabWidth;
  visual.surface.style.left = `${left}px`;
  visual.surface.style.top = "0px";
}

function suspendDragVisual(): void {
  const visual = dragVisualState;
  if (!visual) return;
  visual.suspended = true;
  visual.surface?.classList.add("drag-surface-suspended");
  visual.slot.remove();
}

function clearDragVisual(options: {
  mode: "discard" | "restore" | "settle";
  sessionId?: string;
}): void {
  const visual = dragVisualState;
  if (!visual || (options.sessionId && options.sessionId !== visual.sessionId)) return;
  const surface = visual.surface;
  if (surface) {
    if (options.mode === "discard" || (visual.suspended && options.mode === "settle")) {
      surface.remove();
    } else if (options.mode === "restore" && !visual.originOrder.includes(visual.tabId)) {
      surface.remove();
    } else if (visual.slot.isConnected) {
      visual.slot.replaceWith(surface);
    }
    clearDragSurfaceStyles(surface);
  }
  visual.slot.remove();
  dragVisualState = undefined;
  dragInsertionState = undefined;
  if (options.mode === "restore" && visual.originOrder.length > 0) {
    applyRuntimeTabOrder(visual.originOrder, true);
  }
  scheduleScrollControlsUpdate();
}

function setDropIndicator(beforeTab?: HTMLButtonElement): void {
  root.classList.toggle("drop-at-end", !beforeTab);
  for (const tab of tabElements()) {
    tab.classList.toggle("drop-before", tab === beforeTab);
  }
}

function clearDropIndicator(): void {
  root.classList.remove("drop-at-end");
  for (const tab of tabElements()) tab.classList.remove("drop-before");
}

function nextTabElement(tab: HTMLButtonElement): HTMLButtonElement | undefined {
  let candidate = tab.nextElementSibling;
  while (candidate) {
    if (candidate instanceof HTMLButtonElement && candidate.classList.contains("tab")) {
      return candidate;
    }
    candidate = candidate.nextElementSibling;
  }
  return undefined;
}

function resolveStableDragInsertion(
  payload: RuntimeTabDragPayload | undefined,
  clientX: number
): HTMLButtonElement | undefined {
  if (!payload) return undefined;
  const candidates = tabElements().filter((tab) => tab.dataset.tabId !== payload.tabId);
  const draggedFrame = dragTabFrame(payload, clientX);
  const visualCenterX = draggedFrame.center - root.getBoundingClientRect().left + root.scrollLeft;
  if (candidates.length === 0) {
    dragInsertionState = { sessionId: payload.sessionId, visualCenterX };
    return undefined;
  }
  const geometries = candidates.map((tab) => transformFreeTabGeometry(tab));
  const rawIndex = geometries.findIndex(({ center }) => draggedFrame.center < center);
  const desiredIndex = rawIndex < 0 ? candidates.length : rawIndex;
  let insertionIndex = currentDragInsertionIndex(payload, candidates, desiredIndex);

  const previousInsertionState = dragInsertionState?.sessionId === payload.sessionId
    ? dragInsertionState
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
  dragInsertionState = {
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
  if (dragInsertionState?.sessionId === payload.sessionId) {
    if (!dragInsertionState.beforeTabId) return candidates.length;
    const rememberedIndex = candidates.findIndex(
      (tab) => tab.dataset.tabId === dragInsertionState?.beforeTabId
    );
    if (rememberedIndex >= 0) return rememberedIndex;
  }

  const marker = dragVisualState?.sessionId === payload.sessionId
    ? dragVisualState.slot
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

function rememberDragInsertion(
  payload: RuntimeTabDragPayload,
  beforeTab?: HTMLButtonElement,
  clientX?: number
): void {
  const previousCenter = dragInsertionState?.sessionId === payload.sessionId
    ? dragInsertionState.visualCenterX
    : undefined;
  const frame = clientX !== undefined && Number.isFinite(clientX)
    ? dragTabFrame(payload, clientX)
    : undefined;
  const visualCenterX = frame
    ? frame.center - root.getBoundingClientRect().left + root.scrollLeft
    : previousCenter ?? 0;
  dragInsertionState = {
    sessionId: payload.sessionId,
    visualCenterX,
    ...(beforeTab?.dataset.tabId ? { beforeTabId: beforeTab.dataset.tabId } : {})
  };
}

function previewDragPosition(
  payload: RuntimeTabDragPayload | undefined,
  beforeTab?: HTMLButtonElement,
  clientX?: number
): void {
  if (!payload) return;
  if (terminalDragSessions.has(payload.sessionId)) return;
  if (dragVisualState?.sessionId !== payload.sessionId) {
    clearDragVisual({ mode: "discard" });
    const slot = createDragSlot(payload);
    dragVisualState = {
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
  const visual = dragVisualState;
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

function animateReorderedTabs(previousRects: Map<Element, DOMRect>): void {
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

function scheduleDragHover(
  payload: RuntimeTabDragPayload | undefined,
  beforeTabId: string | undefined,
  event: DragEvent
): void {
  if (!payload || !current) return;
  const visual = dragVisualState?.sessionId === payload.sessionId ? dragVisualState : undefined;
  const preview = visual?.surface ?? visual?.slot
    ?? tabElements().find((tab) => tab.dataset.tabId === payload.tabId);
  const bounds = preview?.getBoundingClientRect();
  dispatch({
    type: "tabDragHover",
    sessionId: payload.sessionId,
    windowId: current.windowId,
    screenX: event.screenX,
    screenY: event.screenY,
    tabWidth: Math.max(1, bounds?.width || payload.tabWidth),
    tabHeight: Math.max(1, bounds?.height || payload.tabHeight),
    ...(beforeTabId && beforeTabId !== payload.tabId ? { beforeTabId } : {})
  });
}

function optimisticallyActivateTab(tabId: string): void {
  for (const tab of tabElements()) {
    const active = tab.dataset.tabId === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    syncCloseControlState(tab);
  }
  activeTabId = tabId;
  optimisticActiveTabId = tabId;
  ensureTabVisible(tabId);
}

function optimisticallyActivateAdjacentTab(direction: "next" | "previous"): void {
  const tabs = tabElements();
  if (tabs.length === 0) return;
  const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.classList.contains("active")));
  const targetIndex = direction === "previous"
    ? (currentIndex + tabs.length - 1) % tabs.length
    : (currentIndex + 1) % tabs.length;
  const targetId = tabs[targetIndex]?.dataset.tabId;
  if (targetId) optimisticallyActivateTab(targetId);
}

function optimisticallyCloseTab(tabId: string): void {
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
      activeTabId = undefined;
      optimisticActiveTabId = undefined;
    }
  }
  scheduleScrollControlsUpdate();
}

const dispatchNextDragAction = (): void => {
  if (dragActionPending) return;
  const action = dragActionQueue.shift();
  if (!action) return;
  dragActionPending = true;
  void invoke("rion_runtime_tab_action", { action })
    .then(() => {
      if (action.type === "tabDragDrop" || action.type === "tabDragEnd"
        || action.type === "tabDragCancel") {
        completeTerminalDragAction(action.sessionId);
      }
    })
    .catch(() => {
      if ((action.type === "tabDragDrop" || action.type === "tabDragEnd")
        && !cancelledDragSessions.has(action.sessionId)) {
        cancelledDragSessions.add(action.sessionId);
        dragActionQueue.unshift({ type: "tabDragCancel", sessionId: action.sessionId });
      }
    })
    .finally(() => {
      dragActionPending = false;
      dispatchNextDragAction();
    });
};

function completeTerminalDragAction(sessionId: string): void {
  if (dragVisualState?.sessionId === sessionId) {
    clearDragVisual({
      mode: cancelledDragSessions.has(sessionId) ? "restore" : "settle",
      sessionId
    });
  }
  localDropSessions.delete(sessionId);
  flushPendingRuntimeTabOrder();
}

function flushPendingRuntimeTabOrder(): void {
  if (!pendingRuntimeTabOrder) return;
  const order = pendingRuntimeTabOrder;
  pendingRuntimeTabOrder = undefined;
  applyRuntimeTabOrder(order, true);
}

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

function render(state: RuntimeTabStripState): void {
  const revision = ++renderRevision;
  const previousScrollLeft = root.scrollLeft;
  const labels = runtimeTabStripLabels(state.language);
  current = state;
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
  const optimisticSelectionIsVisible = optimisticActiveTabId
    && visibleTabs.some((tab) => tab.id === optimisticActiveTabId);
  if (optimisticActiveTabId && !optimisticSelectionIsVisible) optimisticActiveTabId = undefined;
  const presentationActiveTabId = optimisticSelectionIsVisible
    ? optimisticActiveTabId
    : snapshotActiveTabId;
  reconcileTabButtons(visibleTabs, state, labels, presentationActiveTabId);
  for (const tab of tabElements()) syncCloseControlState(tab);
  const nextActiveTabId = presentationActiveTabId;
  root.scrollLeft = previousScrollLeft;
  scheduleScrollControlsUpdate();
  requestAnimationFrame(() => {
    if (revision !== renderRevision) return;
    if (nextActiveTabId !== activeTabId) {
      ensureTabVisible(nextActiveTabId);
    }
    activeTabId = nextActiveTabId;
  });
  add.ariaLabel = labels.openLauncher;
  add.title = labels.openLauncher;
  scrollLeftButton.ariaLabel = labels.scrollLeft;
  scrollRightButton.ariaLabel = labels.scrollRight;
  scrollLeftButton.title = scrollLeftButton.ariaLabel;
  scrollRightButton.title = scrollRightButton.ariaLabel;
}

function reconcileTabButtons(
  tabs: RuntimeTabModel[],
  state: RuntimeTabStripState,
  labels: ReturnType<typeof runtimeTabStripLabels>,
  presentationActiveTabId?: string
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
    if (dragVisualState?.surface === existing) {
      dragVisualState.surface = undefined;
      dragVisualState.slot.remove();
      dragVisualState.suspended = true;
    }
  }

  const desiredOrder = tabs.map((tab) => tab.id);
  if (dragVisualState) {
    pendingRuntimeTabOrder = desiredOrder;
    const incoming = existingById.get(dragVisualState.tabId);
    if (incoming && retained.has(dragVisualState.tabId) && dragVisualState.slot.isConnected
      && dragVisualState.surface !== incoming) {
      adoptDragSurface(incoming);
    }
  } else {
    applyRuntimeTabOrder(desiredOrder, false);
  }
}

window.__rionApplyRuntimeTabState = render;
window.__rionEnsureRuntimeTab = (tab) => {
  const labels = runtimeTabStripLabels(current?.language ?? "en");
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
    if (dragVisualState?.tabId === tab.id && dragVisualState.slot.isConnected) {
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
  const visual = dragVisualState;
  if (visual && button && visual.surface === button) {
    visual.surface = undefined;
    visual.slot.remove();
    visual.suspended = true;
  }
  workspaceTemplateByTabId.delete(tabId);
  if (nextTabId) optimisticallyActivateTab(nextTabId);
  else {
    activeTabId = undefined;
    optimisticActiveTabId = undefined;
  }
  scheduleScrollControlsUpdate();
};
window.__rionReorderRuntimeTabs = (tabIds) => {
  if (dragVisualState) {
    pendingRuntimeTabOrder = [...tabIds];
    return;
  }
  pendingRuntimeTabOrder = undefined;
  applyRuntimeTabOrder(tabIds, true);
};

function applyRuntimeTabOrder(tabIds: string[], animate: boolean): void {
  const previousRects = new Map(
    Array.from(root.children).map((child) => [child, child.getBoundingClientRect()] as const)
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
window.__rionSetActiveRuntimeTab = (tabId) => {
  if (tabId) optimisticallyActivateTab(tabId);
  else {
    for (const tab of tabElements()) {
      tab.classList.remove("active");
      tab.setAttribute("aria-selected", "false");
      syncCloseControlState(tab);
    }
    activeTabId = undefined;
    optimisticActiveTabId = undefined;
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
for (const tab of window.__rionPendingRuntimeTabEnsures ?? []) {
  window.__rionEnsureRuntimeTab(tab);
}
window.__rionPendingRuntimeTabEnsures = [];
for (const tab of window.__rionPendingRuntimeTabs ?? []) {
  window.__rionReserveRuntimeTab(tab);
}
window.__rionPendingRuntimeTabs = [];
window.__rionReorderRuntimeTabs(window.__rionPendingRuntimeTabOrder ?? []);
window.__rionPendingRuntimeTabOrder = [];
document.body.addEventListener("pointerenter", () => {
  if (current?.fullscreen && !current.alwaysShowToolbarInFullScreen) {
    dispatch({ type: "fullscreenToolbarEnter" });
  }
});
document.body.addEventListener("pointerleave", () => {
  if (current?.fullscreen && !current.alwaysShowToolbarInFullScreen) {
    dispatch({ type: "fullscreenToolbarLeave" });
  }
});
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && draggingTabId) {
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
  if (!payload || !current) return;
  localDropSessions.add(payload.sessionId);
  const beforeTab = resolveStableDragInsertion(payload, event.clientX);
  dispatch({
    type: "tabDragDrop",
    sessionId: payload.sessionId,
    windowId: current.windowId,
    screenX: event.screenX,
    screenY: event.screenY,
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
  if (!payload || !current) return;
  localDropSessions.add(payload.sessionId);
  event.preventDefault();
  const beforeTab = event.clientX <= root.getBoundingClientRect().left
    ? tabElements().find((tab) => tab.dataset.tabId !== payload.tabId)
    : undefined;
  rememberDragInsertion(payload, beforeTab, event.clientX);
  dispatch({
    type: "tabDragDrop",
    sessionId: payload.sessionId,
    windowId: current.windowId,
    screenX: event.screenX,
    screenY: event.screenY,
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

void current;

type RuntimeTabDragPayload = {
  sessionId: string;
  tabId: string;
  tabWidth: number;
  tabHeight: number;
  grabRatioX: number;
};

function runtimeTabDragPayload(
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

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function tabElements(): HTMLButtonElement[] {
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

function scheduleScrollControlsUpdate(): void {
  if (scrollControlsFrame !== undefined) return;
  scrollControlsFrame = requestAnimationFrame(() => {
    scrollControlsFrame = undefined;
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

function ensureTabVisible(tabId: string | undefined): void {
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

function scrollForDragPoint(clientX: number, continuous = false): void {
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
  edgeScrollClientX = clientX;
  if (edgeScrollFrame !== undefined) return;
  const tick = (): void => {
    edgeScrollFrame = undefined;
    if (edgeScrollClientX === undefined || !hasTabOverflow()) return;
    const nextBounds = root.getBoundingClientRect();
    const nextEdge = Math.min(36, nextBounds.width / 4);
    const nextDelta = dragScrollDelta(
      edgeScrollClientX,
      nextBounds.left,
      nextBounds.right,
      nextEdge
    );
    if (nextDelta === 0) {
      edgeScrollClientX = undefined;
      return;
    }
    root.scrollLeft += nextDelta;
    refreshDragVisualForScroll();
    scheduleScrollControlsUpdate();
    edgeScrollFrame = requestAnimationFrame(tick);
  };
  edgeScrollFrame = requestAnimationFrame(tick);
}

function refreshDragVisualForScroll(): void {
  const visual = dragVisualState;
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

function stopEdgeScroll(): void {
  edgeScrollClientX = undefined;
  if (edgeScrollFrame !== undefined) cancelAnimationFrame(edgeScrollFrame);
  edgeScrollFrame = undefined;
}

function cancelActiveTabDrag(): void {
  if (!draggingTabId || dragCancelled) return;
  dragCancelled = true;
  clearDropIndicator();
  clearDragVisual({ mode: "restore" });
  clearDragProxy();
  stopEdgeScroll();
  if (dragSessionId) dispatch({ type: "tabDragCancel", sessionId: dragSessionId });
}
