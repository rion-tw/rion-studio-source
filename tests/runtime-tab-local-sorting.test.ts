// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import Sortable, { type Options, type SortableEvent } from "sortablejs";

const { createSortable, option } = vi.hoisted(() => ({
  createSortable: vi.fn(),
  option: vi.fn()
}));

let sortableOptions: Options;

vi.mock("sortablejs", () => ({
  default: {
    create: createSortable.mockImplementation((_root: HTMLElement, options: Options) => {
      sortableOptions = options;
      return { option };
    }),
    ghost: null
  }
}));

import {
  installRuntimeTabSorting,
  type RuntimeTabSortCommitStatus
} from "../src/renderer/runtime-shell/runtimeTabStrip/localSorting";

function tab(tabId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tab";
  button.dataset.tabId = tabId;
  return button;
}

function eventFor(item: HTMLElement): SortableEvent {
  return { from: item.parentElement!, item, to: item.parentElement! } as SortableEvent;
}

function pointerUp(clientX: number, clientY: number): void {
  document.dispatchEvent(new MouseEvent("pointerup", { clientX, clientY }));
}

function setup(tabIds = ["tab-1", "tab-2", "tab-3"], fullscreen = false) {
  document.body.innerHTML = '<div id="tabs"></div>';
  const root = document.querySelector<HTMLDivElement>("#tabs")!;
  root.append(...tabIds.map(tab));
  Object.defineProperty(root, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 500, 30)
  });
  let activeTabId: string | undefined = tabIds[0];
  let commitStatus: RuntimeTabSortCommitStatus | undefined = "applied";
  const applyOrder = vi.fn((order: string[]) => {
    const byId = new Map(
      Array.from(root.querySelectorAll<HTMLButtonElement>(".tab"))
        .map((button) => [button.dataset.tabId, button])
    );
    for (const tabId of order) {
      const button = byId.get(tabId);
      if (button) root.append(button);
    }
  });
  const activateTab = vi.fn((tabId: string) => { activeTabId = tabId; });
  const restoreActiveTab = vi.fn((tabId?: string) => { activeTabId = tabId; });
  const commit = vi.fn(async () => commitStatus);
  const reportFailure = vi.fn();
  const scheduleOverflowUpdate = vi.fn();
  const startWindowDrag = vi.fn();
  const controller = installRuntimeTabSorting(root, {
    activateTab,
    applyOrder,
    commit,
    currentActiveTabId: () => activeTabId,
    isWindowFullscreen: () => fullscreen,
    reportFailure,
    restoreActiveTab,
    scheduleOverflowUpdate,
    startWindowDrag,
    tabIds: () => Array.from(root.querySelectorAll<HTMLButtonElement>(".tab"))
      .map((button) => button.dataset.tabId!)
  });
  return {
    activateTab,
    applyOrder,
    commit,
    controller,
    reportFailure,
    restoreActiveTab,
    root,
    scheduleOverflowUpdate,
    setCommitStatus: (status: RuntimeTabSortCommitStatus | undefined) => {
      commitStatus = status;
    },
    startWindowDrag
  };
}

describe("Windows local runtime tab sorting", () => {
  beforeEach(() => {
    createSortable.mockClear();
    option.mockClear();
    Sortable.ghost = null;
  });

  it("forces pointer fallback and locks sorting to the current horizontal strip", () => {
    const { root } = setup();

    expect(createSortable).toHaveBeenCalledWith(root, expect.objectContaining({
      animation: 180,
      bubbleScroll: false,
      dataIdAttr: "data-tab-id",
      direction: "horizontal",
      draggable: "button.tab",
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fallbackOnBody: true,
      fallbackTolerance: 4,
      filter: ".close",
      forceFallback: true,
      preventOnFilter: false,
      revertOnSpill: true,
      scroll: root,
      scrollSensitivity: 36,
      scrollSpeed: 16,
      swapThreshold: 0.65
    }));
    expect(sortableOptions.group).toEqual({
      name: "runtime-tabs-local",
      pull: false,
      put: false
    });
  });

  it("locks the fallback preview to its starting y coordinate", async () => {
    const { root } = setup();
    const dragged = root.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;
    const fallbackGhost = dragged.cloneNode(true) as HTMLButtonElement;
    fallbackGhost.classList.add("runtime-tab-sort-fallback");
    fallbackGhost.style.transform = "matrix(1, 0, 0, 1, 42, 17)";
    document.body.append(fallbackGhost);
    Sortable.ghost = fallbackGhost;

    sortableOptions.onStart?.(eventFor(dragged));
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    await Promise.resolve();

    expect(fallbackGhost.style.transform).toBe("matrix(1, 0, 0, 1, 42, 0)");
    sortableOptions.onEnd?.(eventFor(dragged));
  });

  it("disables sorting for one tab and delegates its primary press to native window dragging", () => {
    const { root, startWindowDrag } = setup(["tab-1"]);
    const onlyTab = root.querySelector<HTMLButtonElement>(".tab")!;

    expect(option).toHaveBeenLastCalledWith("disabled", true);
    onlyTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(startWindowDrag).toHaveBeenCalledOnce();
    expect(root.querySelectorAll(".tab")).toHaveLength(1);

    const close = document.createElement("span");
    close.className = "close";
    onlyTab.append(close);
    close.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    onlyTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 1 }));
    expect(startWindowDrag).toHaveBeenCalledOnce();

  });

  it("enables sorting after a second tab appears and never starts a window drag", () => {
    const { controller, root, startWindowDrag } = setup(["tab-1"]);
    root.append(tab("tab-2"));
    controller.syncAvailability();

    expect(option).toHaveBeenLastCalledWith("disabled", false);
    root.querySelector(".tab")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 })
    );
    expect(startWindowDrag).not.toHaveBeenCalled();
  });

  it("does not start a native window drag from the only tab while fullscreen", () => {
    const { root, startWindowDrag } = setup(["tab-1"], true);

    root.querySelector(".tab")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 })
    );

    expect(startWindowDrag).not.toHaveBeenCalled();
  });

  it("commits the final DOM order exactly once with its next tab as the insertion anchor", async () => {
    const { activateTab, commit, root } = setup();
    const dragged = root.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;

    sortableOptions.onStart?.(eventFor(dragged));
    root.insertBefore(dragged, root.querySelector('[data-tab-id="tab-3"]'));
    pointerUp(250, 15);
    sortableOptions.onEnd?.(eventFor(dragged));
    await Promise.resolve();

    expect(activateTab).toHaveBeenCalledWith("tab-1");
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ beforeTabId: "tab-3", tabId: "tab-1" });
  });

  it("does not commit an unchanged order", async () => {
    const { commit, root } = setup();
    const dragged = root.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;

    sortableOptions.onStart?.(eventFor(dragged));
    pointerUp(20, 15);
    sortableOptions.onEnd?.(eventFor(dragged));
    await Promise.resolve();

    expect(commit).not.toHaveBeenCalled();
  });

  it("restores order and selection when the pointer is released outside the strip", () => {
    const { applyOrder, commit, restoreActiveTab, root } = setup();
    const dragged = root.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;

    sortableOptions.onStart?.(eventFor(dragged));
    root.append(dragged);
    sortableOptions.onSpill?.(eventFor(dragged));
    sortableOptions.onEnd?.(eventFor(dragged));

    expect(applyOrder).toHaveBeenCalledWith(["tab-1", "tab-2", "tab-3"], true);
    expect(restoreActiveTab).toHaveBeenCalledWith("tab-1");
    expect(commit).not.toHaveBeenCalled();
  });

  it("defers stale projections until the committed order is observed", async () => {
    const { controller, root } = setup();
    const dragged = root.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;

    sortableOptions.onStart?.(eventFor(dragged));
    root.append(dragged);
    pointerUp(250, 15);
    sortableOptions.onEnd?.(eventFor(dragged));
    await Promise.resolve();

    expect(controller.observeAuthoritativeOrder(["tab-1", "tab-2", "tab-3"], "tab-1"))
      .toBe(true);
    expect(controller.observeAuthoritativeOrder(["tab-2", "tab-3", "tab-1"], "tab-1"))
      .toBe(false);
    expect(controller.ownsVisibleOrder()).toBe(false);
  });

  it("rolls back to the newest authoritative projection when native commit fails", async () => {
    const { applyOrder, reportFailure, root, setCommitStatus } = setup();
    setCommitStatus("failed");
    const dragged = root.querySelector<HTMLButtonElement>('[data-tab-id="tab-1"]')!;

    sortableOptions.onStart?.(eventFor(dragged));
    root.append(dragged);
    pointerUp(250, 15);
    sortableOptions.onEnd?.(eventFor(dragged));
    await Promise.resolve();
    await Promise.resolve();

    expect(applyOrder).toHaveBeenLastCalledWith(["tab-1", "tab-2", "tab-3"], true);
    expect(reportFailure).toHaveBeenCalledWith("failed");
  });
});
