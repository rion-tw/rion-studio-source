import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefCallback
} from "react";

const DRAG_THRESHOLD_PX = 4;
const AUTO_SCROLL_EDGE_PX = 40;
const AUTO_SCROLL_MAX_PX = 18;

export interface SelectionRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface MarqueeState {
  additive: boolean;
  baseSelection: Set<string>;
  currentX: number;
  currentY: number;
  hasStarted: boolean;
  pointerId: number;
  startX: number;
  startY: number;
}

interface UseListSelectionOptions {
  orderedIds: string[];
  scrollContainerRef: MutableRefObject<HTMLElement | null>;
}

export function useListSelection({ orderedIds, scrollContainerRef }: UseListSelectionOptions) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const selectedIdsRef = useRef(new Set<string>());
  const orderedIdsRef = useRef(orderedIds);
  const itemElementsRef = useRef(new Map<string, HTMLElement>());
  const anchorIdRef = useRef<string | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);

  orderedIdsRef.current = orderedIds;

  const commitSelection = useCallback((next: Iterable<string>): void => {
    const nextSet = new Set(next);
    selectedIdsRef.current = nextSet;
    setSelectedIds(nextSet);
  }, []);

  const clearSelection = useCallback((): void => {
    anchorIdRef.current = null;
    commitSelection([]);
  }, [commitSelection]);

  const selectAll = useCallback((): void => {
    commitSelection(orderedIdsRef.current);
    anchorIdRef.current = orderedIdsRef.current.at(-1) ?? null;
  }, [commitSelection]);

  useEffect(() => {
    const visibleIds = new Set(orderedIds);
    const nextSelected = [...selectedIdsRef.current].filter((id) => visibleIds.has(id));
    if (nextSelected.length !== selectedIdsRef.current.size) {
      commitSelection(nextSelected);
    }
    if (anchorIdRef.current && !visibleIds.has(anchorIdRef.current)) {
      anchorIdRef.current = null;
    }
  }, [commitSelection, orderedIds]);

  const registerItem = useCallback((id: string): RefCallback<HTMLElement> => {
    return (element) => {
      if (element) {
        itemElementsRef.current.set(id, element);
      } else {
        itemElementsRef.current.delete(id);
      }
    };
  }, []);

  const toggleSelection = useCallback((id: string): void => {
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    anchorIdRef.current = id;
    commitSelection(next);
  }, [commitSelection]);

  const selectRange = useCallback((id: string, additive: boolean): void => {
    const ids = orderedIdsRef.current;
    const targetIndex = ids.indexOf(id);
    const anchorIndex = anchorIdRef.current ? ids.indexOf(anchorIdRef.current) : -1;
    if (targetIndex === -1 || anchorIndex === -1) {
      anchorIdRef.current = id;
      commitSelection(additive ? new Set([...selectedIdsRef.current, id]) : [id]);
      return;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const range = ids.slice(start, end + 1);
    commitSelection(additive ? new Set([...selectedIdsRef.current, ...range]) : range);
  }, [commitSelection]);

  const handleItemClick = useCallback((event: ReactMouseEvent<HTMLElement>, id: string): void => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-selection-control]")) {
      return;
    }

    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      selectRange(id, additive);
      return;
    }
    if (additive) {
      event.preventDefault();
      event.stopPropagation();
      toggleSelection(id);
      return;
    }

    if (isInteractiveTarget(target)) {
      if (selectedIdsRef.current.size > 0) {
        clearSelection();
      }
      return;
    }

    event.preventDefault();
    anchorIdRef.current = id;
    commitSelection([id]);
  }, [clearSelection, commitSelection, selectRange, toggleSelection]);

  const updateMarqueeSelection = useCallback((state: MarqueeState): void => {
    const rect = createSelectionRect(state.startX, state.startY, state.currentX, state.currentY);
    setSelectionRect(rect);
    const hitIds = orderedIdsRef.current.filter((id) => {
      const bounds = itemElementsRef.current.get(id)?.getBoundingClientRect();
      return bounds ? rectanglesIntersect(rect, bounds) : false;
    });
    commitSelection(state.additive ? new Set([...state.baseSelection, ...hitIds]) : hitIds);
  }, [commitSelection]);

  const stopAutoScroll = useCallback((): void => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const finishMarquee = useCallback((cancelled: boolean): void => {
    const state = marqueeRef.current;
    if (!state) {
      return;
    }
    if (cancelled && state.hasStarted) {
      commitSelection(state.baseSelection);
    } else if (state.hasStarted) {
      const selectedInOrder = orderedIdsRef.current.filter((id) => selectedIdsRef.current.has(id));
      anchorIdRef.current = selectedInOrder.at(-1) ?? anchorIdRef.current;
      suppressClickUntilRef.current = Date.now() + 250;
    }
    marqueeRef.current = null;
    setSelectionRect(null);
    document.body.classList.remove("list-marquee-active");
    stopAutoScroll();
  }, [commitSelection, stopAutoScroll]);

  const runAutoScroll = useCallback((): void => {
    stopAutoScroll();
    const tick = (): void => {
      const state = marqueeRef.current;
      const scrollContainer = scrollContainerRef.current;
      if (!state?.hasStarted || !scrollContainer) {
        autoScrollFrameRef.current = null;
        return;
      }

      const bounds = scrollContainer.getBoundingClientRect();
      const topDistance = state.currentY - bounds.top;
      const bottomDistance = bounds.bottom - state.currentY;
      let delta = 0;
      if (topDistance < AUTO_SCROLL_EDGE_PX) {
        delta = -AUTO_SCROLL_MAX_PX * (1 - Math.max(0, topDistance) / AUTO_SCROLL_EDGE_PX);
      } else if (bottomDistance < AUTO_SCROLL_EDGE_PX) {
        delta = AUTO_SCROLL_MAX_PX * (1 - Math.max(0, bottomDistance) / AUTO_SCROLL_EDGE_PX);
      }

      if (delta !== 0) {
        const previousScrollTop = scrollContainer.scrollTop;
        scrollContainer.scrollTop += delta;
        if (scrollContainer.scrollTop !== previousScrollTop) {
          updateMarqueeSelection(state);
        }
      }
      autoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };
    autoScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, [scrollContainerRef, stopAutoScroll, updateMarqueeSelection]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || isInteractiveTarget(event.target as HTMLElement)) {
      return;
    }
    marqueeRef.current = {
      additive: event.metaKey || event.ctrlKey,
      baseSelection: new Set(selectedIdsRef.current),
      currentX: event.clientX,
      currentY: event.clientY,
      hasStarted: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const state = marqueeRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    state.currentX = event.clientX;
    state.currentY = event.clientY;
    if (!state.hasStarted) {
      const distance = Math.hypot(state.currentX - state.startX, state.currentY - state.startY);
      if (distance < DRAG_THRESHOLD_PX) {
        return;
      }
      state.hasStarted = true;
      document.body.classList.add("list-marquee-active");
      runAutoScroll();
    }
    event.preventDefault();
    updateMarqueeSelection(state);
  }, [runAutoScroll, updateMarqueeSelection]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const state = marqueeRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishMarquee(false);
  }, [finishMarquee]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (marqueeRef.current?.pointerId === event.pointerId) {
      finishMarquee(true);
    }
  }, [finishMarquee]);

  const handleCollectionClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>): void => {
    if (Date.now() <= suppressClickUntilRef.current) {
      suppressClickUntilRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement;
    if (!target.closest("[data-selection-id]") && !isInteractiveTarget(target)) {
      clearSelection();
    }
  }, [clearSelection]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || isKeyboardInputTarget(event.target) || document.querySelector("dialog[open]")) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if (event.key === "Escape") {
        if (marqueeRef.current?.hasStarted) {
          event.preventDefault();
          finishMarquee(true);
        } else if (selectedIdsRef.current.size > 0) {
          event.preventDefault();
          clearSelection();
        }
      }
    }

    function handleBlur(): void {
      if (marqueeRef.current?.hasStarted) {
        finishMarquee(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
      finishMarquee(true);
      document.body.classList.remove("list-marquee-active");
    };
  }, [clearSelection, finishMarquee, selectAll]);

  return useMemo(() => ({
    clearSelection,
    collectionProps: {
      onClickCapture: handleCollectionClickCapture,
      onPointerCancel: handlePointerCancel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp
    },
    handleItemClick,
    hasSelection: selectedIds.size > 0,
    isSelected: (id: string) => selectedIds.has(id),
    registerItem,
    selectedIds,
    selectAll,
    selectionRect,
    toggleSelection
  }), [
    clearSelection,
    handleCollectionClickCapture,
    handleItemClick,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    registerItem,
    selectedIds,
    selectAll,
    selectionRect,
    toggleSelection
  ]);
}

function createSelectionRect(startX: number, startY: number, currentX: number, currentY: number): SelectionRect {
  return {
    height: Math.abs(currentY - startY),
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    width: Math.abs(currentX - startX)
  };
}

function rectanglesIntersect(selection: SelectionRect, item: DOMRect): boolean {
  return (
    selection.left <= item.right &&
    selection.left + selection.width >= item.left &&
    selection.top <= item.bottom &&
    selection.top + selection.height >= item.top
  );
}

function isInteractiveTarget(target: HTMLElement): boolean {
  return Boolean(target.closest(
    "button, a, input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-selection-ignore]"
  ));
}

function isKeyboardInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
  ));
}
