import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notifyRendererReadyAfterPaint,
  scheduleAfterTwoAnimationFrames
} from "../src/renderer/src/app/rendererReady";

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

  it("reports renderer readiness after the first committed paint without waiting for app data", async () => {
    const frames: FrameRequestCallback[] = [];
    const notify = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    notifyRendererReadyAfterPaint(
      notify,
      onError,
      (frame) => {
        frames.push(frame);
        return frames.length;
      },
      vi.fn()
    );

    expect(notify).not.toHaveBeenCalled();
    frames.shift()?.(0);
    frames.shift()?.(16);
    await Promise.resolve();

    expect(notify).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces renderer notification failures", async () => {
    const frames: FrameRequestCallback[] = [];
    const error = new Error("native bridge unavailable");
    const onError = vi.fn();

    notifyRendererReadyAfterPaint(
      () => Promise.reject(error),
      onError,
      (frame) => {
        frames.push(frame);
        return frames.length;
      },
      vi.fn()
    );
    frames.shift()?.(0);
    frames.shift()?.(16);
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
