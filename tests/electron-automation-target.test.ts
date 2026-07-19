import { afterEach, describe, expect, it, vi } from "vitest";

import { ElectronAutomationTarget } from "../src/main/browser/ElectronAutomationTarget";

describe("ElectronAutomationTarget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches a key without scanning or focusing the game DOM", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.dispatchKey("F2");

    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.frame.executeJavaScript.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('largest("canvas")'),
        expect.stringContaining("document.activeElement"),
        expect.stringContaining(".focus(")
      ])
    );
    expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('suppressNextShortcut?.("F2", "keydown")')
    );
    expect(harness.webContents.sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: "rawKeyDown",
      keyCode: "F2"
    });
    expect(harness.webContents.sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: "keyUp",
      keyCode: "F2"
    });
  });

  it("dispatches a key combination atomically with modifier state", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(
      harness.view as never,
      harness.webContents as never,
      "win32"
    );

    await target.dispatchKey({ code: "KeyK", modifiers: ["shift", "ctrl"] });

    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "Control", modifiers: ["control"] }],
      [{ type: "rawKeyDown", keyCode: "Shift", modifiers: ["control", "shift"] }],
      [{ type: "rawKeyDown", keyCode: "K", modifiers: ["control", "shift"] }],
      [{ type: "keyUp", keyCode: "K", modifiers: ["control", "shift"] }],
      [{ type: "keyUp", keyCode: "Shift", modifiers: ["control"] }],
      [{ type: "keyUp", keyCode: "Control" }]
    ]);
  });

  it.each([
    ["darwin", "Meta"],
    ["win32", "Control"]
  ] as const)("resolves Primary explicitly on %s", async (platform, keyCode) => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(
      harness.view as never,
      harness.webContents as never,
      platform
    );

    await target.dispatchKey({ code: "KeyA", modifiers: ["primary"] });

    expect(harness.webContents.sendInputEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "rawKeyDown",
      keyCode
    }));
  });

  it("reference-counts modifiers shared by held combinations", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(
      harness.view as never,
      harness.webContents as never,
      "win32"
    );
    const first = { code: "KeyK", modifiers: ["ctrl" as const] };
    const second = { code: "KeyL", modifiers: ["ctrl" as const] };

    await target.holdKey(first, "owner-1");
    await target.holdKey(second, "owner-2");
    await target.releaseKey(first, "owner-1");
    await target.releaseKey(second, "owner-2");

    expect(harness.webContents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "rawKeyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "rawKeyDown", keyCode: "K", modifiers: ["control"] },
      { type: "rawKeyDown", keyCode: "L", modifiers: ["control"] },
      { type: "keyUp", keyCode: "K", modifiers: ["control"] },
      { type: "keyUp", keyCode: "L", modifiers: ["control"] },
      { type: "keyUp", keyCode: "Control" }
    ]);
  });

  it("rolls back an entire held combination when its post-input delay is cancelled", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);
    const controller = new AbortController();

    const hold = target.holdKey(
      { code: "KeyW", modifiers: ["shift"] },
      "owner",
      { postDelayMs: 100, signal: controller.signal }
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(hold).rejects.toThrow();
    expect(harness.webContents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "rawKeyDown", keyCode: "Shift", modifiers: ["shift"] },
      { type: "rawKeyDown", keyCode: "W", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "W", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "Shift" }
    ]);
  });

  it("converts percentage clicks using the current embedded view bounds", async () => {
    const harness = createHarness({ width: 800, height: 600 });
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.dispatchClick(25, 75);

    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.frame.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.webContents.sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      x: 200,
      y: 450
    });
    expect(harness.webContents.sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: 200,
      y: 450
    });
  });

  it("holds keys and keeps the post-input delay inside the shared target queue", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    const key = target.dispatchKey("F2", { holdMs: 20, postDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "F2" }]
    ]);

    const click = target.dispatchClick(50, 50);
    await vi.advanceTimersByTimeAsync(19);
    expect(harness.webContents.sendInputEvent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.webContents.sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: "keyUp",
      keyCode: "F2"
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(harness.webContents.sendInputEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await Promise.all([key, click]);
    expect(harness.webContents.sendInputEvent).toHaveBeenCalledTimes(4);
  });

  it("releases a held key when the dispatch is aborted", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);
    const controller = new AbortController();

    const dispatch = target.dispatchKey("F2", {
      holdMs: 100,
      postDelayMs: 10,
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(dispatch).rejects.toThrow();
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "F2" }],
      [{ type: "keyUp", keyCode: "F2" }]
    ]);
  });

  it("never scans or focuses the page during repeated high-frequency input", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    for (let index = 0; index < 50; index += 1) {
      await target.dispatchKey("Digit1");
      await target.dispatchClick(50, 50);
    }

    const executedSources = harness.frame.executeJavaScript.mock.calls.flat().join("\n");
    expect(executedSources).not.toContain('largest("canvas")');
    expect(executedSources).not.toContain("document.activeElement");
    expect(executedSources).not.toContain(".focus(");
    expect(harness.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.webContents.sendInputEvent).toHaveBeenCalledTimes(200);
  });

  it("serializes concurrent macro key dispatches for the same browser target", async () => {
    const harness = createHarness();
    let releaseFirstSuppression!: () => void;
    const firstSuppression = new Promise<void>((resolve) => {
      releaseFirstSuppression = resolve;
    });
    harness.frame.executeJavaScript.mockImplementation((source: string) => {
      if (source.includes('suppressNextShortcut?.("F2", "keydown")')) {
        return firstSuppression;
      }
      return Promise.resolve(source.includes('largest("canvas")') ? "canvas" : undefined);
    });
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    const first = target.dispatchKey("F2");
    await vi.waitFor(() => {
      expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('suppressNextShortcut?.("F2", "keydown")')
      );
    });
    const second = target.dispatchKey("F3");
    await Promise.resolve();
    expect(harness.frame.executeJavaScript).not.toHaveBeenCalledWith(
      expect.stringContaining('suppressNextShortcut?.("F3", "keydown")')
    );

    releaseFirstSuppression();
    await Promise.all([first, second]);
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "F2" }],
      [{ type: "keyUp", keyCode: "F2" }],
      [{ type: "rawKeyDown", keyCode: "F3" }],
      [{ type: "keyUp", keyCode: "F3" }]
    ]);
  });

  it("reference-counts held keys and preserves the hold when the same key is tapped", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.holdKey("KeyW", "owner-1");
    await target.holdKey("KeyW", "owner-2");
    await target.releaseKey("KeyW", "owner-1");
    await target.dispatchKey("KeyW");
    await target.releaseKey("KeyW", "owner-2");

    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "W" }],
      [{ type: "rawKeyDown", keyCode: "W", isAutoRepeat: true }],
      [{ type: "keyUp", keyCode: "W" }]
    ]);
  });

  it("serializes key and click input through the same target queue", async () => {
    const harness = createHarness();
    let releaseSuppression!: () => void;
    const suppression = new Promise<void>((resolve) => {
      releaseSuppression = resolve;
    });
    harness.frame.executeJavaScript.mockImplementation((source: string) =>
      source.includes('suppressNextShortcut?.("F2", "keydown")')
        ? suppression
        : Promise.resolve(source.includes('largest("canvas")') ? "canvas" : undefined)
    );
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    const key = target.dispatchKey("F2");
    await vi.waitFor(() => expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('suppressNextShortcut?.("F2", "keydown")')
    ));
    const click = target.dispatchClick(20, 30);
    await Promise.resolve();
    expect(harness.webContents.sendInputEvent).not.toHaveBeenCalled();

    releaseSuppression();
    await Promise.all([key, click]);
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "F2" }],
      [{ type: "keyUp", keyCode: "F2" }],
      [{ type: "mouseDown", button: "left", clickCount: 1, x: 256, y: 216 }],
      [{ type: "mouseUp", button: "left", clickCount: 1, x: 256, y: 216 }]
    ]);
  });

  it("keeps held-key release inside the target input queue", async () => {
    const harness = createHarness();
    let releaseSuppression!: () => void;
    const suppression = new Promise<void>((resolve) => {
      releaseSuppression = resolve;
    });
    harness.frame.executeJavaScript.mockImplementation((source: string) =>
      source.includes('suppressNextShortcut?.("F2", "keydown")')
        ? suppression
        : Promise.resolve(undefined)
    );
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.holdKey("KeyW", "owner");
    const key = target.dispatchKey("F2");
    await vi.waitFor(() => expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('suppressNextShortcut?.("F2", "keydown")')
    ));
    const release = target.releaseKey("KeyW", "owner");
    await Promise.resolve();
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "W" }]
    ]);

    releaseSuppression();
    await Promise.all([key, release]);
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "W" }],
      [{ type: "rawKeyDown", keyCode: "F2" }],
      [{ type: "keyUp", keyCode: "F2" }],
      [{ type: "keyUp", keyCode: "W" }]
    ]);
  });

  it("releases native key and mouse state after a partial dispatch failure", async () => {
    const keyHarness = createHarness();
    keyHarness.webContents.sendInputEvent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("key up failed");
      })
      .mockImplementation(() => undefined);
    const keyTarget = new ElectronAutomationTarget(keyHarness.view as never, keyHarness.webContents as never);

    await expect(keyTarget.dispatchKey("F2")).rejects.toThrow("key up failed");
    expect(keyHarness.webContents.sendInputEvent).toHaveBeenNthCalledWith(3, {
      type: "keyUp",
      keyCode: "F2"
    });

    const clickHarness = createHarness();
    clickHarness.webContents.sendInputEvent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("mouse up failed");
      })
      .mockImplementation(() => undefined);
    const clickTarget = new ElectronAutomationTarget(clickHarness.view as never, clickHarness.webContents as never);

    await expect(clickTarget.dispatchClick(25, 75)).rejects.toThrow("mouse up failed");
    expect(clickHarness.webContents.sendInputEvent).toHaveBeenNthCalledWith(3, {
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: 320,
      y: 540
    });
  });

  it("uses native focus only when focus is explicitly requested", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.focus();

    expect(harness.webContents.focus).toHaveBeenCalledTimes(1);
    expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('largest("canvas")'));
  });

  it("ensures the page input target without focusing the native view", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await expect(target.ensureInputFocus()).resolves.toBe(true);

    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('largest("canvas")'));
  });

  it("checks the top-level canvas before scanning embedded frames", async () => {
    const harness = createHarness();
    harness.webContents.executeJavaScript.mockResolvedValue("canvas");
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await expect(target.ensureInputFocus()).resolves.toBe(true);

    expect(harness.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(harness.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('largest("canvas")')
    );
    expect(harness.frame.executeJavaScript).not.toHaveBeenCalled();
  });

  it("does not install physical click focus repair or focus during macro clicks", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    expect(harness.webContents.on).not.toHaveBeenCalled();

    await target.dispatchClick(25, 75);

    expect(harness.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it("does not prepare or dispatch input after the target is destroyed", async () => {
    const harness = createHarness();
    harness.webContents.isDestroyed.mockReturnValue(true);
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.dispatchKey("F2");
    await target.dispatchClick(25, 75);

    expect(harness.frame.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.webContents.sendInputEvent).not.toHaveBeenCalled();
  });
});

function createHarness(bounds: { width: number; height: number } = { width: 1280, height: 720 }) {
  const frame = {
    executeJavaScript: vi.fn().mockResolvedValue("canvas")
  };
  const webContents = {
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    mainFrame: { framesInSubtree: [frame] },
    on: vi.fn(),
    sendInputEvent: vi.fn()
  };
  const view = {
    getBounds: vi.fn(() => ({ x: 200, y: 100, ...bounds }))
  };

  return {
    frame,
    view,
    webContents
  };
}
