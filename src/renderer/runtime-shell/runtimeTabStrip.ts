import { invoke } from "@tauri-apps/api/core";

import { applicationShortcutForKeyEvent } from "../../shared/applicationShortcuts";
import type { RuntimeTabAction, RuntimeTabStripState } from "../../shared/runtimeTabs";

declare global {
  interface Window {
    __rionApplyRuntimeTabState?: (state: RuntimeTabStripState) => void;
    __rionPendingRuntimeTabs?: ProvisionalRuntimeTab[];
    __rionRemoveRuntimeTab?: (tabId: string, nextTabId?: string) => void;
    __rionReserveRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionSetActiveRuntimeTab?: (tabId?: string) => void;
  }
}

type ProvisionalRuntimeTab = {
  id: string;
  name: string;
  type: "role" | "workspace";
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
        audio.ariaLabel = tab.audioMuted
          ? state.language === "zh-TW" ? "分頁已靜音" : state.language === "zh-CN" ? "标签页已静音" : state.language === "ja" ? "タブはミュート中" : "Tab muted"
          : state.language === "zh-TW" ? "正在播放聲音" : state.language === "zh-CN" ? "正在播放声音" : state.language === "ja" ? "音声を再生中" : "Playing audio";
        button.append(audio);
      }
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = "•••";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        dispatch({ type: "openTabMenu", tabId: tab.id });
      });
      button.append(more);
      if (!state.alwaysHideTabCloseButton) {
        const close = document.createElement("span");
        close.className = "close";
        close.textContent = "×";
        close.role = "button";
        close.tabIndex = 0;
        close.ariaLabel = state.language === "zh-TW" ? "停止並關閉分頁" : state.language === "zh-CN"
          ? "停止并关闭标签页" : state.language === "ja" ? "停止してタブを閉じる" : "Stop and close tab";
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          dispatch({ type: "stop", tabId: tab.id });
        });
        close.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            dispatch({ type: "stop", tabId: tab.id });
          }
        });
        button.append(close);
      }
      button.addEventListener("click", () => dispatch({ type: "activate", tabId: tab.id }));
      button.addEventListener("auxclick", (event) => {
        if (event.button === 1) dispatch({ type: "stop", tabId: tab.id });
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        dispatch({ type: "openTabMenu", tabId: tab.id });
      });
      button.addEventListener("dragstart", (event) => {
        button.classList.add("dragging");
        draggingTabId = tab.id;
        dragSessionId = crypto.randomUUID();
        dragCancelled = false;
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        event.dataTransfer?.setData("text/rion-runtime-tab", JSON.stringify({
          sessionId: dragSessionId,
          tabId: tab.id
        }));
        dispatch({
          type: "tabDragStart",
          sessionId: dragSessionId,
          tabId: tab.id,
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
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      button.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const payload = runtimeTabDragPayload(event.dataTransfer);
        if (!payload) return;
        dispatch({
          type: "tabDragDrop",
          sessionId: payload.sessionId,
          windowId: state.windowId,
          beforeTabId: payload.tabId === tab.id ? undefined : tab.id
        });
      });
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
  add.title = state.language === "zh-TW" ? "開啟角色或工作區" : state.language === "zh-CN"
    ? "打开角色或工作区" : state.language === "ja" ? "ロールまたはワークスペースを開く"
      : "Open role or workspace";
  scrollLeftButton.ariaLabel = state.language === "zh-TW" ? "向左捲動分頁" : state.language === "zh-CN"
    ? "向左滚动标签页" : state.language === "ja" ? "タブを左へスクロール" : "Scroll tabs left";
  scrollRightButton.ariaLabel = state.language === "zh-TW" ? "向右捲動分頁" : state.language === "zh-CN"
    ? "向右滚动标签页" : state.language === "ja" ? "タブを右へスクロール" : "Scroll tabs right";
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
window.__rionReserveRuntimeTab = (tab) => {
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
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.role = "button";
    close.tabIndex = 0;
    close.ariaLabel = "Stop and close tab";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      dispatch({ type: "stop", tabId: tab.id });
    });
    button.append(icon, name, close);
    button.addEventListener("click", () => dispatch({ type: "activate", tabId: tab.id }));
    root.append(button);
  }
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
for (const tab of window.__rionPendingRuntimeTabs ?? []) {
  window.__rionReserveRuntimeTab(tab);
}
window.__rionPendingRuntimeTabs = [];
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
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  scrollForDragPoint(event.clientX);
});
root.addEventListener("drop", (event) => {
  event.preventDefault();
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
add.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    dispatch({ type: "openLauncher" });
  }
});
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
