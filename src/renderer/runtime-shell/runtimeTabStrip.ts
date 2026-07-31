import { invoke } from "@tauri-apps/api/core";

import { applicationShortcutForKeyEvent } from "../../shared/applicationShortcuts";
import type { RuntimeTabAction, RuntimeTabStripState } from "../../shared/runtimeTabs";
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
};

type RuntimeTabMetadata = ProvisionalRuntimeTab & {
  audible: boolean;
  audioMuted: boolean;
  closeLabel: string;
  hideCloseButton: boolean;
  iconDataUrl?: string;
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
const dragActionQueue: RuntimeTabAction[] = [];

const OVERFLOW_EPSILON = 1;

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

function createTabControl(
  className: "close" | "more",
  text: string,
  label: string,
  action: RuntimeTabAction
): HTMLSpanElement {
  const control = document.createElement("span");
  control.className = className;
  control.textContent = text;
  control.role = "button";
  control.tabIndex = 0;
  control.ariaLabel = label;
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    dispatch(action);
  });
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    dispatch(action);
  });
  return control;
}

function createMoreControl(tabId: string, label: string): HTMLSpanElement {
  return createTabControl("more", "•••", label, { type: "openTabMenu", tabId });
}

function createCloseControl(tabId: string, label: string): HTMLSpanElement {
  return createTabControl("close", "×", label, { type: "stop", tabId });
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
  if (wasActive) {
    const remaining = tabElements();
    const successor = remaining[Math.min(closingIndex, remaining.length - 1)];
    if (successor?.dataset.tabId) optimisticallyActivateTab(successor.dataset.tabId);
    else {
      activeTabId = undefined;
      optimisticActiveTabId = undefined;
    }
  }
  requestAnimationFrame(updateScrollControls);
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
      const iconUrl = state.tabIconDataUrls[tab.id];
      const icon = iconUrl ? document.createElement("img") : document.createElement("span");
      icon.className = `icon${iconUrl ? "" : " fallback"}`;
      if (icon instanceof HTMLImageElement) icon.src = iconUrl;
      else icon.textContent = tab.type === "workspace" ? "W" : "R";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = tab.name;
      button.append(icon, name);
      if (tab.audioMuted || tab.audible) {
        const audio = document.createElement("span");
        audio.className = "audio";
        audio.textContent = tab.audioMuted ? "⌁" : "◖";
        audio.role = "img";
        audio.ariaLabel = tab.audioMuted ? labels.tabMuted : labels.playingAudio;
        button.append(audio);
      }
      button.append(createMoreControl(tab.id, labels.openTabMenu));
      if (!state.alwaysHideTabCloseButton) {
        button.append(createCloseControl(tab.id, labels.closeTab));
      }
      installTabButtonInteractions(button, tab.id);
      return button;
    });
  reconcileTabButtons(nextButtons);
  const nextActiveTabId = presentationActiveTabId;
  root.scrollLeft = previousScrollLeft;
  requestAnimationFrame(() => {
    if (revision !== renderRevision) return;
    updateScrollControls();
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
  let button = tabElements().find((candidate) => candidate.dataset.tabId === tab.id);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.dataset.tabId = tab.id;
    button.role = "tab";
    button.setAttribute("aria-selected", "false");
    button.title = tab.name;
    const icon = document.createElement("span");
    icon.className = "icon fallback";
    icon.textContent = tab.type === "workspace" ? "W" : "R";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = tab.name;
    const close = createCloseControl(tab.id, labels.closeTab);
    button.append(icon, name, close);
    installTabButtonInteractions(button, tab.id);
    root.append(button);
  }
};
window.__rionReserveRuntimeTab = (tab) => {
  window.__rionEnsureRuntimeTab?.(tab);
  optimisticallyActivateTab(tab.id);
  requestAnimationFrame(updateScrollControls);
};
window.__rionRemoveRuntimeTab = (tabId, nextTabId) => {
  tabElements().find((tab) => tab.dataset.tabId === tabId)?.remove();
  if (nextTabId) optimisticallyActivateTab(nextTabId);
  else {
    activeTabId = undefined;
    optimisticActiveTabId = undefined;
  }
  requestAnimationFrame(updateScrollControls);
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
  requestAnimationFrame(updateScrollControls);
};
window.__rionSetActiveRuntimeTab = (tabId) => {
  if (tabId) optimisticallyActivateTab(tabId);
  else {
    for (const tab of tabElements()) {
      tab.classList.remove("active");
      tab.setAttribute("aria-selected", "false");
    }
    activeTabId = undefined;
    optimisticActiveTabId = undefined;
  }
};
window.__rionUpdateRuntimeTabMetadata = (tab) => {
  const button = tabElements().find((candidate) => candidate.dataset.tabId === tab.id);
  if (!button) return;
  const labels = runtimeTabStripLabels(current?.language ?? "en");
  button.title = tab.tooltip;
  button.dataset.phase = tab.phase;
  button.dataset.sourceId = tab.sourceId;
  const name = button.querySelector<HTMLElement>(".name");
  if (name) name.textContent = tab.name;
  const previousIcon = button.querySelector<HTMLElement>(".icon");
  const icon = tab.iconDataUrl ? document.createElement("img") : document.createElement("span");
  icon.className = `icon${tab.iconDataUrl ? "" : " fallback"}`;
  if (icon instanceof HTMLImageElement) icon.src = tab.iconDataUrl ?? "";
  else icon.textContent = tab.type === "workspace" ? "W" : "R";
  previousIcon?.replaceWith(icon);

  button.querySelector(".audio")?.remove();
  if (tab.audioMuted || tab.audible) {
    const audio = document.createElement("span");
    audio.className = "audio";
    audio.textContent = tab.audioMuted ? "⌁" : "◖";
    audio.role = "img";
    audio.ariaLabel = tab.audioMuted ? tab.mutedLabel : tab.playingLabel;
    button.querySelector(".more, .close")?.before(audio);
  }

  let more = button.querySelector<HTMLElement>(".more");
  if (!more) {
    more = createMoreControl(tab.id, labels.openTabMenu);
    button.append(more);
  } else {
    more.ariaLabel = labels.openTabMenu;
  }
  let close = button.querySelector<HTMLElement>(".close");
  if (tab.hideCloseButton) close?.remove();
  else if (!close) {
    close = createCloseControl(tab.id, tab.closeLabel);
    button.append(close);
  }
  if (close) close.ariaLabel = tab.closeLabel;
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
root.addEventListener("scroll", updateScrollControls);
root.addEventListener("wheel", (event) => {
  if (!hasTabOverflow() || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  root.scrollLeft += event.deltaY;
  updateScrollControls();
}, { passive: false });
scrollLeftButton.addEventListener("click", () => scrollToAdjacentHiddenTab("left"));
scrollRightButton.addEventListener("click", () => scrollToAdjacentHiddenTab("right"));
addEventListener("resize", updateScrollControls);
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(updateScrollControls).observe(root);
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
  requestAnimationFrame(updateScrollControls);
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
  updateScrollControls();
}
