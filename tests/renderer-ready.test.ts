import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleAfterTwoAnimationFrames } from "../src/renderer/src/app/rendererReady";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleAfterTwoAnimationFrames", () => {
  it("runs the callback only after two animation frames", () => {
    const frames: FrameRequestCallback[] = [];
    const callback = vi.fn();
    let nextHandle = 0;
    const requestFrame = vi.fn((frame: FrameRequestCallback) => {
      frames.push(frame);
      nextHandle += 1;
      return nextHandle;
    });

    scheduleAfterTwoAnimationFrames(callback, requestFrame, vi.fn());

    expect(callback).not.toHaveBeenCalled();
    frames.shift()?.(0);
    expect(callback).not.toHaveBeenCalled();
    frames.shift()?.(16);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cancels both scheduled frames without running the callback", () => {
    const frames: FrameRequestCallback[] = [];
    const callback = vi.fn();
    const cancelFrame = vi.fn();
    let nextHandle = 0;
    const requestFrame = vi.fn((frame: FrameRequestCallback) => {
      frames.push(frame);
      nextHandle += 1;
      return nextHandle;
    });
    const cancel = scheduleAfterTwoAnimationFrames(callback, requestFrame, cancelFrame);

    frames.shift()?.(0);
    cancel();
    frames.shift()?.(16);

    expect(callback).not.toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(cancelFrame).toHaveBeenCalledWith(2);
  });
});
