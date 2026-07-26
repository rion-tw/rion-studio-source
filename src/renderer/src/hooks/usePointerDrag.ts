import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

const DRAG_THRESHOLD_PX = 4;
const AUTO_SCROLL_EDGE_PX = 40;
const AUTO_SCROLL_MAX_PX = 18;
const CLICK_SUPPRESSION_MS = 250;

interface PointerDragCandidate<TPayload> {
  active: boolean;
  cleanup: () => void;
  currentX: number;
  currentY: number;
  payload: TPayload;
  pointerId: number;
  source: HTMLElement;
  startX: number;
  startY: number;
  targetId: string | null;
}

interface PointerDragSnapshot<TPayload> {
  payload: TPayload;
  targetId: string | null;
}

interface UsePointerDragOptions<TPayload> {
  disabled?: boolean;
  getScrollContainer?: (
    payload: TPayload,
    clientX: number,
    clientY: number
  ) => HTMLElement | null;
  getTargetId: (clientX: number, clientY: number) => string | null;
  onDragEnd?: (payload: TPayload, cancelled: boolean) => void;
  onDragStart?: (payload: TPayload) => void;
  onDrop: (payload: TPayload, targetId: string) => void;
}

export interface PointerDragController<TPayload> {
  activePayload: TPayload | null;
  cancel: () => void;
  isDragging: boolean;
  start: (event: ReactPointerEvent<HTMLElement>, payload: TPayload) => void;
  targetId: string | null;
}

export function getPointerDragTargetId(
  clientX: number,
  clientY: number,
  attribute: string
): string | null {
  const element = document.elementFromPoint?.(clientX, clientY);
  return element?.closest<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute) ?? null;
}

export function usePointerDrag<TPayload>({
  disabled = false,
  getScrollContainer,
  getTargetId,
  onDragEnd,
  onDragStart,
  onDrop
}: UsePointerDragOptions<TPayload>): PointerDragController<TPayload> {
  const [snapshot, setSnapshot] = useState<PointerDragSnapshot<TPayload> | null>(null);
  const candidateRef = useRef<PointerDragCandidate<TPayload> | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const disabledRef = useRef(disabled);
  const getScrollContainerRef = useRef(getScrollContainer);
  const getTargetIdRef = useRef(getTargetId);
  const onDragEndRef = useRef(onDragEnd);
  const onDragStartRef = useRef(onDragStart);
  const onDropRef = useRef(onDrop);

  disabledRef.current = disabled;
  getScrollContainerRef.current = getScrollContainer;
  getTargetIdRef.current = getTargetId;
  onDragEndRef.current = onDragEnd;
  onDragStartRef.current = onDragStart;
  onDropRef.current = onDrop;

  const stopAutoScroll = useCallback((): void => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const updateTarget = useCallback((candidate: PointerDragCandidate<TPayload>): string | null => {
    const targetId = getTargetIdRef.current(candidate.currentX, candidate.currentY);
    candidate.targetId = targetId;
    setSnapshot((current) => {
      if (current?.payload === candidate.payload && current.targetId === targetId) {
        return current;
      }
      return { payload: candidate.payload, targetId };
    });
    return targetId;
  }, []);

  const suppressNextClick = useCallback((source: HTMLElement): void => {
    const suppress = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.clearTimeout(timeoutId);
    };
    const timeoutId = window.setTimeout(() => {
      source.removeEventListener("click", suppress, true);
    }, CLICK_SUPPRESSION_MS);
    source.addEventListener("click", suppress, { capture: true, once: true });
  }, []);

  const finish = useCallback((cancelled: boolean): void => {
    const candidate = candidateRef.current;
    if (!candidate) {
      return;
    }

    candidateRef.current = null;
    candidate.cleanup();
    stopAutoScroll();
    document.body.classList.remove("pointer-drag-active");

    if (candidate.active) {
      if (!cancelled && candidate.targetId) {
        onDropRef.current(candidate.payload, candidate.targetId);
      }
      suppressNextClick(candidate.source);
      onDragEndRef.current?.(candidate.payload, cancelled);
    }

    setSnapshot(null);
  }, [stopAutoScroll, suppressNextClick]);

  const startAutoScroll = useCallback((): void => {
    stopAutoScroll();
    const tick = (): void => {
      const candidate = candidateRef.current;
      if (!candidate?.active) {
        autoScrollFrameRef.current = null;
        return;
      }
      const scrollContainer = getScrollContainerRef.current?.(
        candidate.payload,
        candidate.currentX,
        candidate.currentY
      );
      if (!scrollContainer) {
        autoScrollFrameRef.current = null;
        return;
      }

      const bounds = scrollContainer.getBoundingClientRect();
      const topDistance = candidate.currentY - bounds.top;
      const bottomDistance = bounds.bottom - candidate.currentY;
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
          updateTarget(candidate);
        }
      }
      autoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };
    autoScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, [stopAutoScroll, updateTarget]);

  const start = useCallback((event: ReactPointerEvent<HTMLElement>, payload: TPayload): void => {
    if (disabledRef.current || event.button !== 0 || event.isPrimary === false) {
      return;
    }

    finish(true);
    const source = event.currentTarget;
    const candidate: PointerDragCandidate<TPayload> = {
      active: false,
      cleanup: () => undefined,
      currentX: event.clientX,
      currentY: event.clientY,
      payload,
      pointerId: event.pointerId,
      source,
      startX: event.clientX,
      startY: event.clientY,
      targetId: null
    };

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== candidate.pointerId || candidateRef.current !== candidate) {
        return;
      }
      candidate.currentX = pointerEvent.clientX;
      candidate.currentY = pointerEvent.clientY;

      if (!candidate.active) {
        const distance = Math.hypot(
          pointerEvent.clientX - candidate.startX,
          pointerEvent.clientY - candidate.startY
        );
        if (distance < DRAG_THRESHOLD_PX) {
          return;
        }
        candidate.active = true;
        document.body.classList.add("pointer-drag-active");
        onDragStartRef.current?.(candidate.payload);
        startAutoScroll();
      }

      pointerEvent.preventDefault();
      updateTarget(candidate);
    };
    const handlePointerUp = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== candidate.pointerId || candidateRef.current !== candidate) {
        return;
      }
      candidate.currentX = pointerEvent.clientX;
      candidate.currentY = pointerEvent.clientY;
      if (candidate.active) {
        pointerEvent.preventDefault();
        updateTarget(candidate);
      }
      finish(false);
    };
    const handleCancel = (): void => finish(true);
    const handleKeyDown = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key !== "Escape" || candidateRef.current !== candidate) {
        return;
      }
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
      finish(true);
    };
    const handleLostPointerCapture = (): void => {
      if (candidateRef.current === candidate) {
        finish(true);
      }
    };

    candidate.cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handleCancel);
      window.removeEventListener("blur", handleCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      source.removeEventListener("lostpointercapture", handleLostPointerCapture);
      if (source.hasPointerCapture?.(candidate.pointerId)) {
        source.releasePointerCapture(candidate.pointerId);
      }
    };

    candidateRef.current = candidate;
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp, { passive: false });
    window.addEventListener("pointercancel", handleCancel);
    window.addEventListener("blur", handleCancel);
    window.addEventListener("keydown", handleKeyDown, true);
    source.addEventListener("lostpointercapture", handleLostPointerCapture);
    source.setPointerCapture?.(candidate.pointerId);
  }, [finish, startAutoScroll, updateTarget]);

  useEffect(() => () => finish(true), [finish]);

  useEffect(() => {
    if (disabled) {
      finish(true);
    }
  }, [disabled, finish]);

  return {
    activePayload: snapshot?.payload ?? null,
    cancel: () => finish(true),
    isDragging: snapshot !== null,
    start,
    targetId: snapshot?.targetId ?? null
  };
}
