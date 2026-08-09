const WINDOW_DRAG_THRESHOLD_PX = 4;

type WindowDragGestureOptions = {
  canStart: (event: MouseEvent) => boolean;
  onStart: () => void;
  target: HTMLElement;
};

export function installWindowDragGesture({
  canStart,
  onStart,
  target
}: WindowDragGestureOptions): void {
  let pending: { clientX: number; clientY: number } | undefined;

  const clearPending = (): void => {
    pending = undefined;
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("mouseup", clearPending, true);
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!pending) return;
    if ((event.buttons & 1) === 0) {
      clearPending();
      return;
    }
    if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY)
      < WINDOW_DRAG_THRESHOLD_PX) return;
    event.preventDefault();
    clearPending();
    onStart();
  };

  target.addEventListener("mousedown", (event) => {
    clearPending();
    if (!canStart(event)) return;
    pending = { clientX: event.clientX, clientY: event.clientY };
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseup", clearPending, true);
  });
}
