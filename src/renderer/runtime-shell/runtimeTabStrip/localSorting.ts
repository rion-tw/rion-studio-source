import Sortable, { type SortableEvent } from "sortablejs";

import { installWindowDragGesture } from "./windowDragGesture";

export type RuntimeTabSortCommitStatus =
  | "applied"
  | "superseded"
  | "cancelled"
  | "degraded"
  | "failed"
  | "indeterminate";

type RuntimeTabSortCommit = {
  beforeTabId?: string;
  tabId: string;
};

type RuntimeTabSortCallbacks = {
  activateTab: (tabId: string) => void;
  applyOrder: (tabIds: string[], animate: boolean) => void;
  commit: (intent: RuntimeTabSortCommit) => Promise<RuntimeTabSortCommitStatus | undefined>;
  currentActiveTabId: () => string | undefined;
  isWindowFullscreen: () => boolean;
  reportFailure: (status: RuntimeTabSortCommitStatus | "invokeRejected") => void;
  restoreActiveTab: (tabId: string | undefined) => void;
  scheduleOverflowUpdate: () => void;
  startWindowDrag: () => void;
  tabIds: () => string[];
};

type RuntimeTabSortGesture = {
  originActiveTabId?: string;
  originOrder: string[];
  releasedInside?: boolean;
  sessionId: string;
  tabId: string;
};

type RuntimeTabMouseFallback = {
  originActiveTabId?: string;
  originOrder: string[];
  startX: number;
  startY: number;
  tabId: string;
};

type RuntimeTabSortFence = {
  expectedOrder: string[];
  sessionId: string;
};

export type RuntimeTabSortingController = {
  deferMutationOrder: () => boolean;
  observeAuthoritativeOrder: (tabIds: string[], activeTabId?: string) => boolean;
  ownsVisibleOrder: () => boolean;
  sortable: Sortable;
  syncAvailability: () => void;
};

function ordersEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tabId, index) => tabId === right[index]);
}

function tabIdFromItem(item: HTMLElement): string | undefined {
  return item.dataset.tabId;
}

export function installRuntimeTabSorting(
  root: HTMLElement,
  callbacks: RuntimeTabSortCallbacks
): RuntimeTabSortingController {
  let gesture: RuntimeTabSortGesture | undefined;
  let mouseFallback: RuntimeTabMouseFallback | undefined;
  let fence: RuntimeTabSortFence | undefined;
  let latestAuthoritativeOrder = callbacks.tabIds();
  let latestAuthoritativeActiveTabId = callbacks.currentActiveTabId();

  const restoreAuthoritativeState = (): void => {
    if (latestAuthoritativeOrder.length > 0) {
      callbacks.applyOrder(latestAuthoritativeOrder, true);
    }
    callbacks.restoreActiveTab(latestAuthoritativeActiveTabId);
    callbacks.scheduleOverflowUpdate();
  };

  const recordPointerRelease = (event: PointerEvent): void => {
    if (!gesture) return;
    const bounds = root.getBoundingClientRect();
    gesture.releasedInside = event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom;
  };

  const commitCompletedOrder = (
    completed: Pick<RuntimeTabSortGesture, "originActiveTabId" | "originOrder" | "sessionId" | "tabId">,
    finalOrder: string[]
  ): void => {
    if (ordersEqual(finalOrder, completed.originOrder)) return;
    const tabIndex = finalOrder.indexOf(completed.tabId);
    if (tabIndex < 0) {
      callbacks.applyOrder(completed.originOrder, true);
      callbacks.restoreActiveTab(completed.originActiveTabId);
      return;
    }

    const expectedOrder = [...finalOrder];
    fence = { expectedOrder, sessionId: completed.sessionId };
    const beforeTabId = finalOrder[tabIndex + 1];
    void callbacks.commit({
      ...(beforeTabId ? { beforeTabId } : {}),
      tabId: completed.tabId
    }).then((status) => {
      if (fence?.sessionId !== completed.sessionId) return;
      if (status === "superseded" || status === "cancelled" || status === "failed"
        || status === "indeterminate") {
        fence = undefined;
        restoreAuthoritativeState();
        if (status !== "superseded") callbacks.reportFailure(status);
        return;
      }
      if (ordersEqual(latestAuthoritativeOrder, expectedOrder)) fence = undefined;
    }).catch(() => {
      if (fence?.sessionId !== completed.sessionId) return;
      fence = undefined;
      restoreAuthoritativeState();
      callbacks.reportFailure("invokeRejected");
    });
  };

  const finishGesture = (event: SortableEvent): void => {
    document.removeEventListener("pointerup", recordPointerRelease, true);
    const completed = gesture;
    gesture = undefined;
    root.classList.remove("runtime-tab-sort-active");
    callbacks.scheduleOverflowUpdate();
    if (!completed) return;

    if (completed.releasedInside === false) {
      callbacks.applyOrder(completed.originOrder, true);
      callbacks.restoreActiveTab(completed.originActiveTabId);
      return;
    }

    commitCompletedOrder(completed, callbacks.tabIds());

    void event;
  };

  const sortable = Sortable.create(root, {
    animation: 180,
    bubbleScroll: false,
    chosenClass: "runtime-tab-sort-chosen",
    dataIdAttr: "data-tab-id",
    direction: "horizontal",
    dragClass: "runtime-tab-sort-drag",
    draggable: "button.tab",
    fallbackClass: "runtime-tab-sort-fallback",
    fallbackOnBody: true,
    fallbackTolerance: 4,
    filter: ".close",
    forceFallback: true,
    ghostClass: "runtime-tab-sort-ghost",
    group: { name: "runtime-tabs-local", pull: false, put: false },
    easing: "cubic-bezier(0.2, 0, 0, 1)",
    onEnd: finishGesture,
    onSpill: () => {
      if (gesture) gesture.releasedInside = false;
    },
    onStart: (event) => {
      const tabId = tabIdFromItem(event.item);
      if (!tabId) return;
      gesture = {
        originActiveTabId: callbacks.currentActiveTabId(),
        originOrder: callbacks.tabIds(),
        sessionId: crypto.randomUUID(),
        tabId
      };
      fence = undefined;
      root.classList.add("runtime-tab-sort-active");
      document.addEventListener("pointerup", recordPointerRelease, true);
      callbacks.activateTab(tabId);
      callbacks.scheduleOverflowUpdate();
    },
    preventOnFilter: false,
    revertOnSpill: true,
    scroll: root,
    scrollSensitivity: 36,
    scrollSpeed: 16,
    swapThreshold: 0.65
  });

  const clearMouseFallback = (): void => {
    mouseFallback = undefined;
    document.removeEventListener("mouseup", finishMouseFallback, true);
  };

  function finishMouseFallback(event: MouseEvent): void {
    const pending = mouseFallback;
    if (!pending) return;
    clearMouseFallback();
    if (gesture) return;
    const bounds = root.getBoundingClientRect();
    const releasedInside = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    const moved = Math.max(
      Math.abs(event.clientX - pending.startX),
      Math.abs(event.clientY - pending.startY)
    ) >= 4;
    if (!releasedInside || !moved) return;

    const remainingTabIds = pending.originOrder.filter((tabId) => tabId !== pending.tabId);
    const candidates = Array.from(root.querySelectorAll<HTMLButtonElement>("button.tab"));
    const beforeTabId = remainingTabIds.find((tabId) => {
      const candidate = candidates.find((button) => button.dataset.tabId === tabId);
      if (!candidate) return false;
      const candidateBounds = candidate.getBoundingClientRect();
      return event.clientX < candidateBounds.left + candidateBounds.width / 2;
    });
    const insertionIndex = beforeTabId ? remainingTabIds.indexOf(beforeTabId) : remainingTabIds.length;
    const finalOrder = [...remainingTabIds];
    finalOrder.splice(insertionIndex, 0, pending.tabId);
    if (ordersEqual(finalOrder, pending.originOrder)) return;

    event.preventDefault();
    callbacks.activateTab(pending.tabId);
    callbacks.applyOrder(finalOrder, true);
    callbacks.scheduleOverflowUpdate();
    commitCompletedOrder({
      originActiveTabId: pending.originActiveTabId,
      originOrder: pending.originOrder,
      sessionId: crypto.randomUUID(),
      tabId: pending.tabId
    }, finalOrder);
  }

  root.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || callbacks.tabIds().length <= 1
      || callbacks.isWindowFullscreen()) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".close")) return;
    const tab = target.closest<HTMLButtonElement>("button.tab");
    const tabId = tab?.dataset.tabId;
    if (!tab || !tabId || !root.contains(tab)) return;
    clearMouseFallback();
    mouseFallback = {
      originActiveTabId: callbacks.currentActiveTabId(),
      originOrder: callbacks.tabIds(),
      startX: event.clientX,
      startY: event.clientY,
      tabId
    };
    document.addEventListener("mouseup", finishMouseFallback, true);
  });

  installWindowDragGesture({
    canStart: (event) => {
      if (event.button !== 0 || event.detail !== 1 || callbacks.tabIds().length !== 1
        || callbacks.isWindowFullscreen()) return false;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".close")) return false;
      const tab = target.closest<HTMLButtonElement>("button.tab");
      return Boolean(tab && root.contains(tab));
    },
    onStart: callbacks.startWindowDrag,
    target: root
  });

  const syncAvailability = (): void => {
    sortable.option("disabled", callbacks.tabIds().length <= 1);
  };
  syncAvailability();

  return {
    deferMutationOrder: () => gesture !== undefined || fence !== undefined,
    observeAuthoritativeOrder: (tabIds, activeTabId) => {
      latestAuthoritativeOrder = [...tabIds];
      latestAuthoritativeActiveTabId = activeTabId;
      if (gesture) return true;
      if (!fence) return false;
      if (!ordersEqual(tabIds, fence.expectedOrder)) return true;
      fence = undefined;
      return false;
    },
    ownsVisibleOrder: () => gesture !== undefined || fence !== undefined,
    sortable,
    syncAvailability
  };
}
