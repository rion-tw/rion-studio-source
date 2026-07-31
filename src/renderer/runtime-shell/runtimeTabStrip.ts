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
let renderRevision = 0;
let activeTabId: string | undefined;
let optimisticActiveTabId: string | undefined;
let dragActionPending = false;
let scrollControlsFrame: number | undefined;
const dragActionQueue: RuntimeTabAction[] = [];
const workspaceTemplateByTabId = new Map<string, WorkspaceLayoutTemplate>();
const iconMarkup = new Map<LucideIcon, string>();

const OVERFLOW_EPSILON = 1;

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
    const queued = dragActionQueue.at(-1);
    if (action.type === "tabDragMove" && queued?.type === "tabDragMove"
      && action.sessionId === queued.sessionId) {
      dragActionQueue[dragActionQueue.length - 1] = action;
    } else {
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

function createCloseControl(tabId: string, label: string): HTMLSpanElement {
  const control = document.createElement("span");
  control.className = "close";
  control.role = "button";
  control.tabIndex = -1;
  control.ariaLabel = label;
  control.ariaHidden = "true";
  control.append(createLucideSvg(X));
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
  button.draggable = true;
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
    button.classList.add("dragging");
    draggingTabId = tabId;
    dragSessionId = crypto.randomUUID();
    dragCancelled = false;
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    event.dataTransfer?.setData("text/rion-runtime-tab", JSON.stringify({
      sessionId: dragSessionId,
      tabId
    }));
    dispatch({
      type: "tabDragStart",
      sessionId: dragSessionId,
      tabId,
      screenX: event.screenX,
      screenY: event.screenY
    });
  });
  button.addEventListener("drag", (event) => {
    if (!dragSessionId || dragCancelled || (event.screenX === 0 && event.screenY === 0)) return;
    pendingDragPoint = { screenX: event.screenX, screenY: event.screenY };
    if (dragMoveFrame !== undefined) return;
    dragMoveFrame = requestAnimationFrame(() => {
      dragMoveFrame = undefined;
      if (!dragSessionId || !pendingDragPoint) return;
      dispatch({ type: "tabDragMove", sessionId: dragSessionId, ...pendingDragPoint });
      pendingDragPoint = undefined;
    });
  });
  button.addEventListener("dragend", (event) => {
    button.classList.remove("dragging");
    clearDropIndicator();
    if (dragMoveFrame !== undefined) {
      cancelAnimationFrame(dragMoveFrame);
      dragMoveFrame = undefined;
    }
    if (dragSessionId && event.dataTransfer?.dropEffect !== "move") {
      dispatch({
        type: "tabDragEnd",
        sessionId: dragSessionId,
        cancelled: dragCancelled
      });
    }
    draggingTabId = undefined;
    dragSessionId = undefined;
    pendingDragPoint = undefined;
    dragCancelled = false;
  });
  button.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDropIndicator(button);
    scrollForDragPoint(event.clientX);
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  button.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearDropIndicator();
    const payload = runtimeTabDragPayload(event.dataTransfer);
    if (!payload || !current) return;
    dispatch({
      type: "tabDragDrop",
      sessionId: payload.sessionId,
      windowId: current.windowId,
      beforeTabId: payload.tabId === tabId ? undefined : tabId
    });
  });
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
    .catch(() => {
      if (action.type === "tabDragDrop" || action.type === "tabDragEnd") {
        dragActionQueue.unshift({ type: "tabDragCancel", sessionId: action.sessionId });
      }
    })
    .finally(() => {
      dragActionPending = false;
      dispatchNextDragAction();
    });
};

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
  const nextButtons = visibleTabs
    .map((tab) => {
      const active = tab.id === presentationActiveTabId;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tab${active ? " active" : ""}`;
      button.dataset.tabId = tab.id;
      button.draggable = true;
      button.role = "tab";
      button.setAttribute("aria-selected", String(active));
      button.title = tab.type === "workspace" && (tab.roleNames?.length ?? 0) > 0
        ? `${tab.name}${state.language.startsWith("zh") ? "：" : ":"}${(tab.roleNames ?? []).join(", ")}`
        : tab.name;
      const icon = createTabIcon(
        tab.type,
        state.tabIconDataUrls[tab.id],
        workspaceTemplateByTabId.get(tab.id)
      );
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = tab.name;
      button.append(
        icon,
        name,
        createAudioIndicator(tab.audioMuted, tab.audible, labels.tabMuted, labels.playingAudio)
      );
      if (!state.alwaysHideTabCloseButton) {
        button.append(createCloseControl(tab.id, labels.closeTab));
      }
      installTabButtonInteractions(button, tab.id);
      return button;
    });
  reconcileTabButtons(nextButtons);
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

function reconcileTabButtons(nextButtons: HTMLButtonElement[]): void {
  const existingById = new Map(tabElements().map((button) => [button.dataset.tabId, button]));
  const retained = new Set<string>();
  let insertionPoint: Element | null = root.firstElementChild;
  for (const desired of nextButtons) {
    const tabId = desired.dataset.tabId;
    if (!tabId) continue;
    retained.add(tabId);
    const existing = existingById.get(tabId) as HTMLButtonElement | undefined;
    const resolved = existing ?? desired;
    if (existing) {
      existing.className = desired.className;
      existing.title = desired.title;
      existing.draggable = desired.draggable;
      existing.setAttribute("aria-selected", desired.getAttribute("aria-selected") ?? "false");
      existing.replaceChildren(...desired.childNodes);
    }
    if (resolved !== insertionPoint) root.insertBefore(resolved, insertionPoint);
    insertionPoint = resolved.nextElementSibling;
  }
  for (const [tabId, existing] of existingById) {
    if (tabId && !retained.has(tabId)) existing.remove();
  }
}

window.__rionApplyRuntimeTabState = render;
window.__rionEnsureRuntimeTab = (tab) => {
  const labels = runtimeTabStripLabels(current?.language ?? "en");
  if (tab.workspaceTemplate) workspaceTemplateByTabId.set(tab.id, tab.workspaceTemplate);
  let button = tabElements().find((candidate) => candidate.dataset.tabId === tab.id);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.dataset.tabId = tab.id;
    button.role = "tab";
    button.setAttribute("aria-selected", "false");
    button.title = tab.name;
    const icon = createTabIcon(tab.type, undefined, tab.workspaceTemplate);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = tab.name;
    const audio = createAudioIndicator(false, false, "", "");
    const close = createCloseControl(tab.id, labels.closeTab);
    button.append(icon, name, audio, close);
    installTabButtonInteractions(button, tab.id);
    root.append(button);
  }
  scheduleScrollControlsUpdate();
};
window.__rionReserveRuntimeTab = (tab) => {
  window.__rionEnsureRuntimeTab?.(tab);
  optimisticallyActivateTab(tab.id);
  scheduleScrollControlsUpdate();
};
window.__rionRemoveRuntimeTab = (tabId, nextTabId) => {
  tabElements().find((tab) => tab.dataset.tabId === tabId)?.remove();
  workspaceTemplateByTabId.delete(tabId);
  if (nextTabId) optimisticallyActivateTab(nextTabId);
  else {
    activeTabId = undefined;
    optimisticActiveTabId = undefined;
  }
  scheduleScrollControlsUpdate();
};
window.__rionReorderRuntimeTabs = (tabIds) => {
  const byId = new Map(tabElements().map((tab) => [tab.dataset.tabId, tab]));
  let insertionPoint: Element | null = root.firstElementChild;
  for (const tabId of tabIds) {
    const tab = byId.get(tabId);
    if (!tab) continue;
    if (tab !== insertionPoint) root.insertBefore(tab, insertionPoint);
    insertionPoint = tab.nextElementSibling;
  }
  scheduleScrollControlsUpdate();
};
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

  const audio = createAudioIndicator(
    tab.audioMuted,
    tab.audible,
    tab.mutedLabel,
    tab.playingLabel
  );
  button.querySelector(".audio")?.replaceWith(audio);
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
    dragCancelled = true;
    clearDropIndicator();
    if (dragSessionId) dispatch({ type: "tabDragCancel", sessionId: dragSessionId });
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
  setDropIndicator();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  scrollForDragPoint(event.clientX);
});
root.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
  clearDropIndicator();
});
root.addEventListener("drop", (event) => {
  event.preventDefault();
  clearDropIndicator();
  const payload = runtimeTabDragPayload(event.dataTransfer);
  if (!payload || !current) return;
  dispatch({
    type: "tabDragDrop",
    sessionId: payload.sessionId,
    windowId: current.windowId
  });
});
add.addEventListener("click", () => dispatch({ type: "openLauncher" }));
add.addEventListener("contextmenu", (event) => event.preventDefault());
root.addEventListener("scroll", scheduleScrollControlsUpdate);
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

function runtimeTabDragPayload(
  dataTransfer: DataTransfer | null
): { sessionId: string; tabId: string } | undefined {
  const raw = dataTransfer?.getData("text/rion-runtime-tab");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.sessionId !== "string" || typeof value.tabId !== "string") return undefined;
    return { sessionId: value.sessionId, tabId: value.tabId };
  } catch {
    return undefined;
  }
}

function tabElements(): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".tab"));
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

function scrollForDragPoint(clientX: number): void {
  if (!hasTabOverflow()) return;
  const bounds = root.getBoundingClientRect();
  const edge = Math.min(36, bounds.width / 4);
  if (clientX < bounds.left + edge) {
    root.scrollLeft -= 16;
  } else if (clientX > bounds.right - edge) {
    root.scrollLeft += 16;
  } else {
    return;
  }
  scheduleScrollControlsUpdate();
}
