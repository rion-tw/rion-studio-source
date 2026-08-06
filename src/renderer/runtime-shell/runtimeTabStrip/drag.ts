import {
  add,
  reorderAnimationFrameByElement,
  root,
  runtimeState,
  scrollRightButton,
  syncCloseControlState,
  workspaceTemplateByTabId
} from "../runtimeTabStrip";
import { ensureTabVisible, scheduleScrollControlsUpdate, tabElements } from "./entry";

export function animateReorderedTabs(previousRects: Map<Element, DOMRect>): void {
  if (typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layoutChildren = Array.from(root.children) as HTMLElement[];
  for (const child of layoutChildren) {
    const previous = previousRects.get(child);
    if (!previous) continue;
    const next = child.getBoundingClientRect();
    animateHorizontalReorder(child, previous.left - next.left);
  }

  const lastLayoutChild = layoutChildren.at(-1);
  const previousLast = lastLayoutChild ? previousRects.get(lastLayoutChild) : undefined;
  const nextLast = lastLayoutChild?.getBoundingClientRect();
  const previousAdd = previousRects.get(add);
  const nextAdd = add.getBoundingClientRect();
  const addDeltaX = scrollRightButton.hidden && previousLast && nextLast
    ? previousLast.left - nextLast.left
    : previousAdd ? previousAdd.left - nextAdd.left : 0;
  animateHorizontalReorder(add, addDeltaX);
}

function animateHorizontalReorder(element: HTMLElement, deltaX: number): void {
  if (Math.abs(deltaX) < 0.5) return;
  const pendingFrame = reorderAnimationFrameByElement.get(element);
  if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  element.style.transition = "none";
  element.style.transform = `translateX(${deltaX}px)`;
  const frame = requestAnimationFrame(() => {
    reorderAnimationFrameByElement.delete(element);
    element.style.transition = "transform 120ms ease-out";
    element.style.transform = "";
  });
  reorderAnimationFrameByElement.set(element, frame);
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
