import { describe, expect, it, vi } from "vitest";

import {
  handoffElectronStartupQuitFence,
  installElectronStartupQuitFence,
  type ElectronStartupQuitEventPort
} from "../src/electron/main/electronStartupQuitFence";

describe("Electron startup quit fence", () => {
  it("intercepts repeated quit requests idempotently until lifecycle handoff", () => {
    let listener: ((event: ElectronStartupQuitEventPort) => void) | null = null;
    const app = {
      on: vi.fn((_event, next) => { listener = next; }),
      removeListener: vi.fn((_event, current) => {
        if (listener === current) listener = null;
      })
    };
    const fence = installElectronStartupQuitFence(app);
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    listener!(first);
    const reason = fence.signal.reason;
    listener!(second);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(fence.signal.aborted).toBe(true);
    expect(fence.signal.reason).toBe(reason);
    expect(reason).toBe("application-before-quit");

    fence.release();
    fence.release();
    expect(app.removeListener).toHaveBeenCalledOnce();
    expect(listener).toBeNull();
  });

  it("hands off without aborting when normal lifecycle becomes authoritative", () => {
    let listener: ((event: ElectronStartupQuitEventPort) => void) | null = null;
    const app = {
      on: vi.fn((_event, next) => { listener = next; }),
      removeListener: vi.fn((_event, current) => {
        if (listener === current) listener = null;
      })
    };
    const fence = installElectronStartupQuitFence(app);

    fence.release();

    expect(fence.signal.aborted).toBe(false);
    expect(listener).toBeNull();
  });

  it("rejects handoff after an intercepted quit instead of swallowing the request", () => {
    let listener: ((event: ElectronStartupQuitEventPort) => void) | null = null;
    const app = {
      on: vi.fn((_event, next) => { listener = next; }),
      removeListener: vi.fn((_event, current) => {
        if (listener === current) listener = null;
      })
    };
    const fence = installElectronStartupQuitFence(app);
    const installLifecycleListener = vi.fn();

    listener!({ preventDefault: vi.fn() });

    expect(() => handoffElectronStartupQuitFence(
      fence,
      installLifecycleListener
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_STARTUP_QUIT_REQUESTED"
    }));
    expect(installLifecycleListener).not.toHaveBeenCalled();
    expect(app.removeListener).not.toHaveBeenCalled();

    fence.release();
    expect(app.removeListener).toHaveBeenCalledOnce();
  });

  it("installs normal lifecycle authority before releasing the startup fence", () => {
    const order: string[] = [];
    const app = {
      on: vi.fn(),
      removeListener: vi.fn(() => { order.push("startup-release"); })
    };
    const fence = installElectronStartupQuitFence(app);

    handoffElectronStartupQuitFence(fence, () => {
      order.push("lifecycle-listener-installed");
    });

    expect(order).toEqual([
      "lifecycle-listener-installed",
      "startup-release"
    ]);
  });
});
