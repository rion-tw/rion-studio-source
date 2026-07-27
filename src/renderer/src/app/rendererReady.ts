type CancelFrame = (handle: number) => void;
type RequestFrame = (callback: FrameRequestCallback) => number;

export function scheduleAfterTwoAnimationFrames(
  callback: () => void,
  requestFrame: RequestFrame = requestAnimationFrame,
  cancelFrame: CancelFrame = cancelAnimationFrame
): () => void {
  let firstFrame = 0;
  let secondFrame = 0;
  let cancelled = false;

  firstFrame = requestFrame(() => {
    if (cancelled) {
      return;
    }

    secondFrame = requestFrame(() => {
      if (!cancelled) {
        callback();
      }
    });
  });

  return () => {
    cancelled = true;
    cancelFrame(firstFrame);
    if (secondFrame !== 0) {
      cancelFrame(secondFrame);
    }
  };
}

export function notifyRendererReadyAfterPaint(
  notify: () => Promise<void>,
  onError: (error: unknown) => void,
  requestFrame: RequestFrame = requestAnimationFrame,
  cancelFrame: CancelFrame = cancelAnimationFrame
): () => void {
  return scheduleAfterTwoAnimationFrames(() => {
    void notify().catch(onError);
  }, requestFrame, cancelFrame);
}
