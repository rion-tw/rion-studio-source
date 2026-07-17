import { describe, expect, it, vi } from "vitest";

import { configureSingleInstanceLifecycle } from "../src/main/window/singleInstanceLifecycle";

describe("single instance lifecycle", () => {
  it("registers one handler that shows the primary instance after a second launch", () => {
    let secondInstanceListener: (() => void) | undefined;
    const onSecondInstance = vi.fn((listener: () => void) => {
      secondInstanceListener = listener;
    });
    const quitSecondaryInstance = vi.fn();
    const showPrimaryInstance = vi.fn();

    const isPrimaryInstance = configureSingleInstanceLifecycle({
      onSecondInstance,
      quitSecondaryInstance,
      requestLock: () => true,
      showPrimaryInstance
    });

    expect(isPrimaryInstance).toBe(true);
    expect(onSecondInstance).toHaveBeenCalledOnce();
    expect(quitSecondaryInstance).not.toHaveBeenCalled();

    secondInstanceListener?.();

    expect(showPrimaryInstance).toHaveBeenCalledOnce();
  });

  it("quits a secondary instance without registering a handler", () => {
    const onSecondInstance = vi.fn();
    const quitSecondaryInstance = vi.fn();
    const showPrimaryInstance = vi.fn();

    const isPrimaryInstance = configureSingleInstanceLifecycle({
      onSecondInstance,
      quitSecondaryInstance,
      requestLock: () => false,
      showPrimaryInstance
    });

    expect(isPrimaryInstance).toBe(false);
    expect(quitSecondaryInstance).toHaveBeenCalledOnce();
    expect(onSecondInstance).not.toHaveBeenCalled();
    expect(showPrimaryInstance).not.toHaveBeenCalled();
  });
});
