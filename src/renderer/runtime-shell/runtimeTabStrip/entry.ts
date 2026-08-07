// Focused implementation extracted from runtimeTabStrip.ts.
import { invoke } from "@tauri-apps/api/core";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { applicationShortcutForKeyEvent } from "../../../shared/applicationShortcuts";

import type { RuntimeTabStripState } from "../../../shared/runtimeTabs";

import type { RuntimeTabChromeProjectionRecord } from "../../../shared/generated";

import { runtimeTabStripLabels } from "../../src/i18n";

import {
  OVERFLOW_EPSILON,
  add,
  audioSignatureByButton,
  commitRuntimeTabReorder,
  createAudioIndicator,
  createCloseControl,
  createLucideSvg,
  createTabIcon,
  dispatch,
  iconSignatureByButton,
  installTabButtonInteractions,
  logicalRuntimeTabOrder,
  reportRuntimeTabSortFailure,
  root,
  runtimeState,
  scrollLeftButton,
  scrollRightButton,
  syncCloseControlState,
  windowCloseButton,
  windowControls,
  windowDragRegion,
  windowIdentity,
  windowMaximizeButton,
  windowMinimizeButton,
  windowName,
  workspaceTemplateByTabId
} from "../runtimeTabStrip";

import type { RuntimeTabModel } from "../runtimeTabStrip";

import { animateReorderedTabs, optimisticallyActivateTab } from "./drag";

import {
  installRuntimeTabSorting,
  type RuntimeTabSortingController
} from "./localSorting";

import {
  acknowledgeChromeProjection,
  announceChromeReady,
  stateFromChromeProjection
} from "./chromeProjection";

let localTabSorting: RuntimeTabSortingController | undefined;

function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

function createTabButton(tabId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  button.dataset.tabId = tabId;
  button.draggable = false;
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
  button.draggable = false;
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
  authoritative = false
): void {
  const revision = ++runtimeState.renderRevision;
  const previousScrollLeft = root.scrollLeft;
  const labels = runtimeTabStripLabels(state.language);
  runtimeState.current = state;
  document.documentElement.lang = state.language;
  document.documentElement.dataset.theme = state.resolvedTheme;
  document.documentElement.style.colorScheme = state.resolvedTheme;
  document.body.dataset.toolbarVisible = String(state.toolbarVisible);
  document.body.dataset.windowFullscreen = String(state.windowFullscreen);
  document.body.dataset.windowMaximized = String(state.windowMaximized);
  windowName.textContent = state.windowName;
  windowName.title = state.windowName;
  windowIdentity.title = state.windowName;
  windowControls.ariaLabel = labels.windowControls;
  windowMinimizeButton.ariaLabel = labels.minimizeWindow;
  windowMinimizeButton.title = labels.minimizeWindow;
  const maximizeLabel = state.windowFullscreen || state.windowMaximized
    ? labels.restoreWindow
    : labels.maximizeWindow;
  windowMaximizeButton.ariaLabel = maximizeLabel;
  windowMaximizeButton.title = maximizeLabel;
  windowCloseButton.ariaLabel = labels.closeWindow;
  windowCloseButton.title = labels.closeWindow;
  const visibleTabs = state.tabs
    .filter((tab) => tab.windowId === state.windowId && !tab.hidden);
  for (const tab of visibleTabs) {
    const workspaceTemplate = state.tabWorkspaceTemplates[tab.id];
    if (workspaceTemplate) workspaceTemplateByTabId.set(tab.id, workspaceTemplate);
  }
  const snapshotActiveTabId = visibleTabs.find((tab) => tab.active)?.id;
  const desiredOrder = visibleTabs.map((tab) => tab.id);
  const deferAuthoritativeOrder = authoritative
    ? localTabSorting?.observeAuthoritativeOrder(desiredOrder, snapshotActiveTabId) ?? false
    : localTabSorting?.deferMutationOrder() ?? false;
  if (authoritative && !localTabSorting?.ownsVisibleOrder()) {
    runtimeState.optimisticActiveTabId = undefined;
  }
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
    deferAuthoritativeOrder
  );
  localTabSorting?.syncAvailability();
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
    || projection.projectionRevision < runtimeState.projectionRevision
    || projection.topologyRevision < runtimeState.topologyRevision) return;
  runtimeState.projectionRevision = projection.projectionRevision;
  runtimeState.topologyRevision = projection.topologyRevision;
  runtimeState.chromeHydrated = true;
  render(stateFromChromeProjection(projection), true);
  const observedOrder = logicalRuntimeTabOrder();
  const observedActiveTabId = exactActiveRuntimeTabId();
  const projectionMatchesObserved = ordersEqual(observedOrder, projection.tabOrder)
    && observedActiveTabId === projection.activeTabId;
  if (!localTabSorting?.ownsVisibleOrder()) {
    if (projection.activeTabId) optimisticallyActivateTab(projection.activeTabId);
    else window.__rionSetActiveRuntimeTab?.();
  }
  const acknowledgementStatus = localTabSorting?.ownsVisibleOrder() && !projectionMatchesObserved
    ? "superseded"
    : undefined;

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

  // WebView2's native host is revealed from this acknowledgement. Two animation frames ensure
  // both the authoritative projection and any queued launch reservation have crossed a paint
  // boundary before Windows composites the window for the first time.
  afterNextPaint(() => {
    acknowledgeChromeProjection(
      projection,
      runtimeState.rendererInstanceId,
      tabElements(),
      observedOrder,
      acknowledgementStatus,
      observedActiveTabId ?? null
    );
  });
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
  deferOrder = false
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
  }

  const desiredOrder = tabs.map((tab) => tab.id);
  if (!deferOrder) applyRuntimeTabOrder(desiredOrder, false);
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

export function installRuntimeTabStrip(): void {
  localTabSorting = installRuntimeTabSorting(root, {
    activateTab: (tabId) => dispatch({ type: "activate", tabId }),
    applyOrder: applyRuntimeTabOrder,
    commit: ({ beforeTabId, tabId }) => commitRuntimeTabReorder(tabId, beforeTabId),
    currentActiveTabId: () => exactActiveRuntimeTabId() ?? runtimeState.activeTabId,
    isWindowFullscreen: () => Boolean(runtimeState.current?.windowFullscreen),
    reportFailure: reportRuntimeTabSortFailure,
    restoreActiveTab: (tabId) => {
      if (tabId) dispatch({ type: "activate", tabId });
      else window.__rionSetActiveRuntimeTab?.();
    },
    scheduleOverflowUpdate: scheduleScrollControlsUpdate,
    startWindowDrag: () => dispatch({ type: "startWindowDrag" }),
    tabIds: logicalRuntimeTabOrder
  });

  window.__rionApplyRuntimeTabChromeMutation = (revision, mutation) => {
    if (!window.__rionRuntimeTabChromeReady || !runtimeState.chromeHydrated) {
      window.__rionPendingRuntimeTabChromeMutations ??= [];
      window.__rionPendingRuntimeTabChromeMutations.push({ mutation, revision });
      return;
    }
    mutation();
    afterNextPaint(() => {
      void invoke("rion_runtime_tab_action", {
        action: { type: "presentationApplied", revision }
      }).catch(() => undefined);
    });
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
    }
    localTabSorting?.syncAvailability();
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
    workspaceTemplateByTabId.delete(tabId);
    if (nextTabId) optimisticallyActivateTab(nextTabId);
    else {
      runtimeState.activeTabId = undefined;
      runtimeState.optimisticActiveTabId = undefined;
    }
    localTabSorting?.syncAvailability();
    scheduleScrollControlsUpdate();
  };

  window.__rionReorderRuntimeTabs = (tabIds) => {
    if (localTabSorting?.deferMutationOrder()) return;
    applyRuntimeTabOrder(tabIds, false);
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

  const handleWindowDragMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || runtimeState.current?.windowFullscreen) return;
    event.preventDefault();
    if (event.detail === 1) {
      dispatch({ type: "startWindowDrag" });
    } else if (event.detail === 2) {
      dispatch({ type: "windowControl", control: "zoom" });
    }
  };
  windowIdentity.addEventListener("mousedown", handleWindowDragMouseDown);
  windowDragRegion.addEventListener("mousedown", handleWindowDragMouseDown);
  windowMinimizeButton.addEventListener("click", () => {
    dispatch({ type: "windowControl", control: "minimize" });
  });
  windowMaximizeButton.addEventListener("click", () => {
    dispatch({
      type: "windowControl",
      control: runtimeState.current?.windowFullscreen ? "toggleFullscreen" : "zoom"
    });
  });
  windowCloseButton.addEventListener("click", () => {
    dispatch({ type: "windowControl", control: "close" });
  });

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

  localTabSorting.syncAvailability();
  void runtimeState.current;
}
