import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

import { Columns2, Gamepad2, Grid2x2, Square, Volume2, VolumeX, X, type LucideIcon } from "lucide-react";

import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";

import type { RuntimeTabAction, RuntimeTabStripState } from "../../shared/runtimeTabs";
import type {
  RuntimeTabActivationRequestRecord,
  RuntimeTabChromeProjectionRecord,
  RuntimeTabDragSessionRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";

import type { WorkspaceLayoutTemplate } from "../../shared/types";

import { handleSystemRuntimeReceipt } from "../src/app/systemRuntimeReceipt";

import { dispatchNextDragAction, handleRuntimeTabDragSession, optimisticallyActivateAdjacentTab, optimisticallyActivateTab, optimisticallyCloseTab, previewDragPosition, resolveStableDragInsertion, scheduleDragHover } from "./runtimeTabStrip/drag";

import { applyRuntimeTabOrder, clampRatio, installRuntimeTabStrip, runtimeTabDragPayload, scheduleScrollControlsUpdate, scrollForDragPoint, stopEdgeScroll, tabElements } from "./runtimeTabStrip/entry";

import type { RuntimeTabDragPayload } from "./runtimeTabStrip/entry";

declare global {
  interface Window {
    __rionApplyRuntimeTabState?: (state: RuntimeTabStripState) => void;
    __rionApplyRuntimeTabChromeMutation?: (
      revision: number,
      mutation: () => void
    ) => void;
    __rionApplyRuntimeTabActivation?: (request: RuntimeTabActivationRequestRecord) => void;
    __rionApplyRuntimeTabChromeProjection?: (
      projection: RuntimeTabChromeProjectionRecord
    ) => void;
    __rionEnsureRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionPendingRuntimeTabOrder?: string[];
    __rionPendingRuntimeTabEnsures?: ProvisionalRuntimeTab[];
    __rionPendingRuntimeTabChromeMutations?: Array<{
      mutation: () => void;
      revision: number;
    }>;
    __rionPendingRuntimeTabActivations?: RuntimeTabActivationRequestRecord[];
    __rionPendingRuntimeTabs?: ProvisionalRuntimeTab[];
    __rionRemoveRuntimeTab?: (tabId: string, nextTabId?: string) => void;
    __rionReorderRuntimeTabs?: (tabIds: string[]) => void;
    __rionReserveRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionSetActiveRuntimeTab?: (tabId?: string) => void;
    __rionRuntimeTabChromeReady?: boolean;
    __rionRuntimeTabChromeIdentity?: {
      lifecycleEpoch: number;
      windowGeneration: number;
      windowId: string;
    };
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

export const root = document.querySelector<HTMLDivElement>("#tabs")!;

export const add = document.querySelector<HTMLButtonElement>("#add")!;

export const scrollLeftButton = document.querySelector<HTMLButtonElement>("#scroll-left")!;

export const scrollRightButton = document.querySelector<HTMLButtonElement>("#scroll-right")!;

export const runtimeState = {
  current: undefined as RuntimeTabStripState | undefined,
  draggingTabId: undefined as string | undefined,
  dragOriginActiveTabId: undefined as string | undefined,
  dragSessionId: undefined as string | undefined,
  dragCancelled: false,
  dragMoveFrame: undefined as number | undefined,
  pendingDragPoint: undefined as { screenX: number; screenY: number } | undefined,
  lastDragPoint: undefined as { screenX: number; screenY: number } | undefined,
  edgeScrollFrame: undefined as number | undefined,
  edgeScrollClientX: undefined as number | undefined,
  dragInsertionState: undefined as {
  sessionId: string;
  beforeTabId?: string;
  visualCenterX: number;
} | undefined,
  dragProxyElement: undefined as HTMLElement | undefined,
  dragVisualState: undefined as RuntimeTabDragVisualState | undefined,
  pendingRuntimeTabOrder: undefined as PendingRuntimeTabOrder | undefined,
  latestDragIntentSessionId: undefined as string | undefined,
  renderRevision: 0,
  activeTabId: undefined as string | undefined,
  optimisticActiveTabId: undefined as string | undefined,
  activationRevision: 0,
  chromeHydrated: false,
  projectionRevision: 0,
  rendererInstanceId: globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  dragActionPending: false,
  scrollControlsFrame: undefined as number | undefined,
};

export const dragActionQueue: Array<Extract<RuntimeTabAction, { sessionId: string }>> = [];

export const terminalDragSessions = new Set<string>();

export const cancelledDragSessions = new Set<string>();

export const localDropSessions = new Set<string>();

export const dragIntentOrders = new Map<string, {
  finalOrder: string[];
  originOrder: string[];
}>();

export const workspaceTemplateByTabId = new Map<string, WorkspaceLayoutTemplate>();

const iconMarkup = new Map<LucideIcon, string>();

export const iconSignatureByButton = new WeakMap<HTMLButtonElement, string>();

export const audioSignatureByButton = new WeakMap<HTMLButtonElement, string>();

export const reorderAnimationFrameByElement = new Map<HTMLElement, number>();

export const OVERFLOW_EPSILON = 1;

export const TAB_REORDER_HYSTERESIS_RATIO = 0.025;

export const TAB_REORDER_HYSTERESIS_MIN = 2;

export const TAB_REORDER_HYSTERESIS_MAX = 5;

const FINISHED_DRAG_SESSION_LIMIT = 128;

export type RuntimeTabModel = RuntimeTabStripState["tabs"][number];

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

export type PendingRuntimeTabOrder = {
  order: string[];
  ownerSessionId: string;
  projectionRevision?: number;
};

export function pinsSingleLocalDrag(): boolean {
  const visual = runtimeState.dragVisualState;
  return visual?.originOrder.length === 1
    && visual.originOrder[0] === visual.tabId;
}

export function logicalRuntimeTabOrder(): string[] {
  const seen = new Set<string>();
  return Array.from(root.children).flatMap((child) => {
    if (!(child instanceof HTMLElement) || child.classList.contains("drag-surface")) return [];
    const tabId = child.dataset.dragSlotTab ?? child.dataset.tabId;
    if (!tabId || seen.has(tabId)) return [];
    seen.add(tabId);
    return [tabId];
  });
}

export function deferRuntimeTabOrder(
  order: string[],
  projectionRevision?: number
): boolean {
  const ownerSessionId = runtimeState.latestDragIntentSessionId;
  if (!ownerSessionId) return false;
  const pending = runtimeState.pendingRuntimeTabOrder;
  if (pending?.ownerSessionId === ownerSessionId
    && pending.projectionRevision !== undefined
    && (projectionRevision === undefined || projectionRevision < pending.projectionRevision)) {
    return true;
  }
  runtimeState.pendingRuntimeTabOrder = {
    order: [...order],
    ownerSessionId,
    ...(projectionRevision !== undefined ? { projectionRevision } : {})
  };
  return true;
}

export function createLucideSvg(Icon: LucideIcon): SVGSVGElement {
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

export function createTabIcon(
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

export function createAudioIndicator(
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

export const dispatch = (action: RuntimeTabAction): void => {
  if (action.type === "activate") optimisticallyActivateTab(action.tabId);
  else if (action.type === "activateAdjacent") optimisticallyActivateAdjacentTab(action.direction);
  else if (action.type === "stop") optimisticallyCloseTab(action.tabId);
  if (action.type.startsWith("tabDrag")) {
    const isMotion = action.type === "tabDragMove" || action.type === "tabDragHover";
    if (isMotion && terminalDragSessions.has(action.sessionId)) return;
    if (action.type === "tabDragSourceEnd" || action.type === "tabDragEnd"
      || action.type === "tabDragCancel") {
      rememberTerminalDragSession(action.sessionId);
    }
    const queued = dragActionQueue.at(-1);
    const queuedIsMotion = queued?.type === "tabDragMove" || queued?.type === "tabDragHover";
    if (isMotion && queuedIsMotion && action.sessionId === queued.sessionId) {
      dragActionQueue[dragActionQueue.length - 1] = action;
    } else {
      if ((action.type === "tabDragSourceEnd" || action.type === "tabDragEnd")
        && dragActionQueue.length > 0) {
        for (let index = dragActionQueue.length - 1; index >= 0; index -= 1) {
          const pending = dragActionQueue[index];
          if (pending.type !== "tabDragMove" && pending.type !== "tabDragHover") continue;
          if (pending.sessionId === action.sessionId) dragActionQueue.splice(index, 1);
        }
      }
      dragActionQueue.push(action as Extract<RuntimeTabAction, { sessionId: string }>);
    }
    dispatchNextDragAction();
    return;
  }
  const committedAction: RuntimeTabAction = action.type === "stop" ? {
    ...action,
    orderedTabIds: tabElements().map((tab) => tab.dataset.tabId).filter(Boolean) as string[],
    ...(runtimeState.activeTabId ? { activeTabId: runtimeState.activeTabId } : {}),
    ...(window.__rionRuntimeTabChromeIdentity?.windowGeneration
      ? { windowGeneration: window.__rionRuntimeTabChromeIdentity.windowGeneration }
      : {})
  } : action;
  void invoke<SystemRuntimeOperationSummaryRecord | null>("rion_runtime_tab_action", {
    action: committedAction
  })
    .then(async (receipt) => {
      const handlesReceipt = action.type === "activate"
        || action.type === "activateAdjacent"
        || action.type === "hide"
        || action.type === "move"
        || action.type === "reorder"
        || action.type === "stop"
        || (action.type === "windowControl" && action.control !== "close");
      if (!handlesReceipt || !receipt) return;
      try {
        handleSystemRuntimeReceipt(receipt);
        if (receipt.status === "degraded") {
          await emit("rion://shell-error", {
            code: receipt.failureCode ?? "SYSTEM_NATIVE_OPERATION_DEGRADED",
            message: action.type === "activate" || action.type === "activateAdjacent"
              ? "The tab content changed, but its native tab state could not be fully confirmed."
              : "The native window operation completed with reduced guarantees."
          });
        }
      } catch (error) {
        const issue = error as { code?: string; message?: string };
        await emit("rion://shell-error", {
          code: issue.code ?? receipt.failureCode ?? "SYSTEM_NATIVE_OPERATION_FAILED",
          message: issue.message ?? "The native window operation failed."
        });
      }
    })
    .catch(() => {
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

export function createCloseControl(tabId: string, label: string): HTMLSpanElement {
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

export function syncCloseControlState(button: HTMLButtonElement): void {
  const close = button.querySelector<HTMLElement>(".close");
  if (!close) return;
  const visible = button.classList.contains("active");
  close.tabIndex = visible ? 0 : -1;
  close.ariaHidden = String(!visible);
}

export function installTabButtonInteractions(button: HTMLButtonElement, tabId: string): void {
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
    runtimeState.dragOriginActiveTabId = runtimeState.activeTabId;
    optimisticallyActivateTab(tabId);
    runtimeState.draggingTabId = tabId;
    runtimeState.dragSessionId = crypto.randomUUID();
    runtimeState.latestDragIntentSessionId = runtimeState.dragSessionId;
    if (runtimeState.pendingRuntimeTabOrder) {
      runtimeState.pendingRuntimeTabOrder.ownerSessionId = runtimeState.dragSessionId;
    }
    runtimeState.dragCancelled = false;
    runtimeState.lastDragPoint = { screenX: event.screenX, screenY: event.screenY };
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    const bounds = button.getBoundingClientRect();
    const tabWidth = Math.max(1, bounds.width || button.offsetWidth || 1);
    const tabHeight = Math.max(1, bounds.height || button.offsetHeight || 28);
    const payload: RuntimeTabDragPayload = {
      sessionId: runtimeState.dragSessionId,
      tabId,
      tabWidth,
      tabHeight,
      grabRatioX
    };
    installDragImage(event.dataTransfer, button, payload, grabRatioY);
    beginDragVisual(payload, button, event.clientX);
    event.dataTransfer?.setData("text/rion-runtime-tab", JSON.stringify(payload));
    dispatch({
      type: "tabDragStart",
      sessionId: runtimeState.dragSessionId,
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
    if (!runtimeState.dragSessionId || runtimeState.dragCancelled || (event.screenX === 0 && event.screenY === 0)) return;
    runtimeState.pendingDragPoint = { screenX: event.screenX, screenY: event.screenY };
    runtimeState.lastDragPoint = runtimeState.pendingDragPoint;
    if (runtimeState.dragMoveFrame !== undefined) return;
    runtimeState.dragMoveFrame = requestAnimationFrame(() => {
      runtimeState.dragMoveFrame = undefined;
      if (!runtimeState.dragSessionId || !runtimeState.pendingDragPoint) return;
      dispatch({ type: "tabDragMove", sessionId: runtimeState.dragSessionId, ...runtimeState.pendingDragPoint });
      runtimeState.pendingDragPoint = undefined;
    });
  });
  button.addEventListener("dragend", (event) => {
    const endingSessionId = runtimeState.dragSessionId;
    clearDropIndicator();
    stopEdgeScroll();
    if (runtimeState.dragMoveFrame !== undefined) {
      cancelAnimationFrame(runtimeState.dragMoveFrame);
      runtimeState.dragMoveFrame = undefined;
    }
    if (runtimeState.dragSessionId) {
      const terminalPoint = runtimeState.pendingDragPoint ?? (
        event.screenX !== 0 || event.screenY !== 0
          ? { screenX: event.screenX, screenY: event.screenY }
          : runtimeState.lastDragPoint
      ) ?? { screenX: event.screenX, screenY: event.screenY };
      const sourceEndAction: RuntimeTabAction = {
        type: "tabDragSourceEnd",
        sessionId: runtimeState.dragSessionId,
        cancelled: runtimeState.dragCancelled,
        dropAccepted: event.dataTransfer?.dropEffect === "move",
        ...terminalPoint
      };
      // WebView2 implements HTML drag through a nested OLE loop. Posting the
      // terminal action guarantees native topology changes cannot run from the
      // dragend callback itself.
      setTimeout(() => dispatch(sourceEndAction), 0);
    }
    clearDragVisual({
      mode: runtimeState.dragCancelled || runtimeState.dragVisualState?.suspended
        ? "restore"
        : "settle"
    });
    clearDragProxy();
    if (endingSessionId) localDropSessions.delete(endingSessionId);
    runtimeState.draggingTabId = undefined;
    runtimeState.dragOriginActiveTabId = undefined;
    runtimeState.dragSessionId = undefined;
    runtimeState.pendingDragPoint = undefined;
    runtimeState.lastDragPoint = undefined;
    runtimeState.dragCancelled = false;
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
      beforeTabId: beforeTab?.dataset.tabId === payload.tabId
        ? nextTabElement(beforeTab)?.dataset.tabId
        : beforeTab?.dataset.tabId
    });
    stopEdgeScroll();
    clearDragVisual({ mode: "settle", sessionId: payload.sessionId });
  });
}

function installDragImage(
  dataTransfer: DataTransfer | null,
  button: HTMLButtonElement,
  payload: RuntimeTabDragPayload,
  grabRatioY: number
): void {
  clearDragProxy();
  if (!dataTransfer || typeof dataTransfer.setDragImage !== "function") return;
  const proxy = button.cloneNode(true) as HTMLButtonElement;
  proxy.removeAttribute("id");
  proxy.removeAttribute("data-tab-id");
  proxy.className = "tab active drag-proxy";
  proxy.ariaHidden = "true";
  proxy.draggable = false;
  proxy.style.width = `${payload.tabWidth}px`;
  proxy.style.height = `${payload.tabHeight}px`;
  document.body.append(proxy);
  proxy.getBoundingClientRect();
  dataTransfer.setDragImage(
    proxy,
    Math.round(payload.tabWidth * payload.grabRatioX),
    Math.round(payload.tabHeight * grabRatioY)
  );
  runtimeState.dragProxyElement = proxy;
}

export function clearDragProxy(): void {
  runtimeState.dragProxyElement?.remove();
  runtimeState.dragProxyElement = undefined;
}

export function createDragSlot(payload: RuntimeTabDragPayload): HTMLDivElement {
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
  runtimeState.dragVisualState = {
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
  dragIntentOrders.set(payload.sessionId, { finalOrder: originOrder, originOrder });
  if (!pinsSingleLocalDrag()) {
    root.insertBefore(slot, button);
    adoptDragSurface(button);
  }
}

export function adoptDragSurface(button: HTMLButtonElement): void {
  const visual = runtimeState.dragVisualState;
  if (!visual || button.dataset.tabId !== visual.tabId) return;
  if (visual.surface && visual.surface !== button) clearDragSurfaceStyles(visual.surface);
  visual.surface = button;
  document.body.append(button);
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

export function positionDragSurface(clientX: number): void {
  const visual = runtimeState.dragVisualState;
  if (!visual?.surface || !Number.isFinite(clientX)) return;
  const rootBounds = root.getBoundingClientRect();
  const left = clientX - visual.grabRatioX * visual.tabWidth;
  visual.surface.style.left = `${left}px`;
  visual.surface.style.top = `${rootBounds.top}px`;
  positionAddAfterVisibleDragTail();
}

function positionAddAfterVisibleDragTail(): void {
  if (!runtimeState.dragVisualState || !scrollRightButton.hidden) {
    resetAddAfterDrag();
    return;
  }
  const visibleTabs = tabElements().filter(
    (tab) => !tab.classList.contains("drag-surface-suspended")
  );
  if (visibleTabs.length === 0) return;
  const pendingFrame = reorderAnimationFrameByElement.get(add);
  if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  reorderAnimationFrameByElement.delete(add);
  add.style.transition = "none";
  add.style.transform = "";
  const rootBounds = root.getBoundingClientRect();
  const layoutLeft = add.getBoundingClientRect().left;
  const spacing = Math.max(0, layoutLeft - rootBounds.right);
  const visibleTail = Math.max(
    ...visibleTabs.map((tab) => tab.getBoundingClientRect().right)
  );
  const deltaX = visibleTail + spacing - layoutLeft;
  add.style.transform = Math.abs(deltaX) >= 0.5
    ? `translateX(${deltaX}px)`
    : "";
}

function resetAddAfterDrag(): void {
  const pendingFrame = reorderAnimationFrameByElement.get(add);
  if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  reorderAnimationFrameByElement.delete(add);
  add.style.removeProperty("transition");
  add.style.removeProperty("transform");
}

export function suspendDragVisual(): void {
  const visual = runtimeState.dragVisualState;
  if (!visual) return;
  visual.suspended = true;
  visual.surface?.classList.add("drag-surface-suspended");
  visual.slot.remove();
  resetAddAfterDrag();
}

export function clearDragVisual(options: {
  mode: "discard" | "restore" | "settle";
  sessionId?: string;
}): void {
  const visual = runtimeState.dragVisualState;
  if (!visual || (options.sessionId && options.sessionId !== visual.sessionId)) return;
  const intent = dragIntentOrders.get(visual.sessionId);
  if (intent) {
    intent.finalOrder = options.mode === "restore"
      ? [...intent.originOrder]
      : logicalRuntimeTabOrder();
  }
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
  runtimeState.dragVisualState = undefined;
  runtimeState.dragInsertionState = undefined;
  resetAddAfterDrag();
  if (options.mode === "restore" && visual.originOrder.length > 0) {
    applyRuntimeTabOrder(visual.originOrder, true);
  }
  scheduleScrollControlsUpdate();
}

export function setDropIndicator(beforeTab?: HTMLButtonElement): void {
  root.classList.toggle("drop-at-end", !beforeTab);
  for (const tab of tabElements()) {
    tab.classList.toggle("drop-before", tab === beforeTab);
  }
}

export function clearDropIndicator(): void {
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

installRuntimeTabStrip();
void listen<RuntimeTabDragSessionRecord>(
  "rion://runtime-tab-drag-session",
  ({ payload }) => handleRuntimeTabDragSession(payload)
).catch(() => undefined);
