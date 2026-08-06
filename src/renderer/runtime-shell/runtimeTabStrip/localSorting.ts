import Sortable, { type SortableEvent } from "sortablejs";

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

    const finalOrder = callbacks.tabIds();
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

  root.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || callbacks.tabIds().length !== 1
      || callbacks.isWindowFullscreen()) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".close")) return;
    const tab = target.closest<HTMLButtonElement>("button.tab");
    if (!tab || !root.contains(tab)) return;
    event.preventDefault();
    callbacks.startWindowDrag();
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
