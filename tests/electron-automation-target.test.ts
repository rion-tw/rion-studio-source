import { EventEmitter } from "node:events";

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
    expect(keyEvents(harness)).toEqual([{
      type: "rawKeyDown",
      code: "F2",
      key: "F2",
      windowsVirtualKeyCode: 113
    }, {
      type: "keyUp",
      code: "F2",
      key: "F2",
      windowsVirtualKeyCode: 113
    }]);
  });

  it("dispatches a key combination atomically with modifier state", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(
      harness.view as never,
      harness.webContents as never,
      "win32"
    );

    await target.dispatchKey({ code: "KeyK", modifiers: ["shift", "ctrl"] });

    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17, location: 1, modifiers: 2 },
      { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, location: 1, modifiers: 10 },
      { type: "rawKeyDown", code: "KeyK", key: "K", windowsVirtualKeyCode: 75, modifiers: 10 },
      { type: "keyUp", code: "KeyK", key: "K", windowsVirtualKeyCode: 75, modifiers: 10 },
      { type: "keyUp", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, location: 1, modifiers: 2 },
      { type: "keyUp", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17, location: 1 }
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

    expect(keyEvents(harness)[0]).toEqual(expect.objectContaining({
      type: "rawKeyDown",
      code: keyCode === "Meta" ? "MetaLeft" : "ControlLeft"
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

    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17, location: 1, modifiers: 2 },
      { type: "rawKeyDown", code: "KeyK", key: "k", windowsVirtualKeyCode: 75, modifiers: 2 },
      { type: "rawKeyDown", code: "KeyL", key: "l", windowsVirtualKeyCode: 76, modifiers: 2 },
      { type: "keyUp", code: "KeyK", key: "k", windowsVirtualKeyCode: 75, modifiers: 2 },
      { type: "keyUp", code: "KeyL", key: "l", windowsVirtualKeyCode: 76, modifiers: 2 },
      { type: "keyUp", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17, location: 1 }
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
    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, location: 1, modifiers: 8 },
      { type: "rawKeyDown", code: "KeyW", key: "W", windowsVirtualKeyCode: 87, modifiers: 8 },
      { type: "keyUp", code: "KeyW", key: "W", windowsVirtualKeyCode: 87, modifiers: 8 },
      { type: "keyUp", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, location: 1 }
    ]);
  });

  it("converts percentage clicks using the current embedded view bounds", async () => {
    const harness = createHarness({ width: 800, height: 600 });
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.dispatchClick(25, 75);

    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.frame.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(mouseEvents(harness)).toEqual([
      {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: 200,
        y: 450
      }, {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        x: 200,
        y: 450
      }
    ]);
  });

  it("holds keys and keeps the post-input delay inside the shared target queue", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    const key = target.dispatchKey("F2", { holdMs: 20, postDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "F2", key: "F2", windowsVirtualKeyCode: 113 }
    ]);

    const click = target.dispatchClick(50, 50);
    await vi.advanceTimersByTimeAsync(19);
    expect(inputEvents(harness)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(keyEvents(harness)[1]).toEqual({
      type: "keyUp",
      code: "F2",
      key: "F2",
      windowsVirtualKeyCode: 113
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(inputEvents(harness)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await Promise.all([key, click]);
    expect(inputEvents(harness)).toHaveLength(4);
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
    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "F2", key: "F2", windowsVirtualKeyCode: 113 },
      { type: "keyUp", code: "F2", key: "F2", windowsVirtualKeyCode: 113 }
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
    expect(inputEvents(harness)).toHaveLength(200);
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
    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "F2", key: "F2", windowsVirtualKeyCode: 113 },
      { type: "keyUp", code: "F2", key: "F2", windowsVirtualKeyCode: 113 },
      { type: "rawKeyDown", code: "F3", key: "F3", windowsVirtualKeyCode: 114 },
      { type: "keyUp", code: "F3", key: "F3", windowsVirtualKeyCode: 114 }
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

    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 },
      { type: "rawKeyDown", autoRepeat: true, code: "KeyW", key: "w", windowsVirtualKeyCode: 87 },
      { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }
    ]);
  });

  it("reasserts a held key after the embedded view loses and regains focus", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.holdKey("Digit1", "owner");
    harness.debugger.sendCommand.mockClear();

    harness.emitWebContents("blur");
    await vi.waitFor(() => expect(keyEvents(harness)).toHaveLength(1));
    expect(keyEvents(harness)[0]).toMatchObject({
      type: "rawKeyDown",
      code: "Digit1",
      key: "1",
      windowsVirtualKeyCode: 49
    });

    harness.debugger.sendCommand.mockClear();
    harness.emitWebContents("focus");
    await vi.waitFor(() => expect(keyEvents(harness)).toHaveLength(1));
    expect(keyEvents(harness)[0]).toMatchObject({
      type: "rawKeyDown",
      code: "Digit1",
      key: "1",
      windowsVirtualKeyCode: 49
    });

    await target.releaseKey("Digit1", "owner");
    expect(keyEvents(harness).at(-1)).toMatchObject({ type: "keyUp", code: "Digit1" });
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
    expect(inputEvents(harness)).toHaveLength(0);

    releaseSuppression();
    await Promise.all([key, click]);
    expect(inputEvents(harness)).toEqual([
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", code: "F2", key: "F2", windowsVirtualKeyCode: 113 }],
      ["Input.dispatchKeyEvent", { type: "keyUp", code: "F2", key: "F2", windowsVirtualKeyCode: 113 }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: 256, y: 216 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: 256, y: 216 }]
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
    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }
    ]);

    releaseSuppression();
    await Promise.all([key, release]);
    expect(keyEvents(harness)).toEqual([
      { type: "rawKeyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 },
      { type: "rawKeyDown", code: "F2", key: "F2", windowsVirtualKeyCode: 113 },
      { type: "keyUp", code: "F2", key: "F2", windowsVirtualKeyCode: 113 },
      { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }
    ]);
  });

  it("releases key and mouse state after a partial dispatch failure", async () => {
    const keyHarness = createHarness();
    let keyUpCalls = 0;
    keyHarness.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyUp") {
        keyUpCalls += 1;
        if (keyUpCalls === 1) throw new Error("key up failed");
      }
      return {};
    });
    const keyTarget = new ElectronAutomationTarget(keyHarness.view as never, keyHarness.webContents as never);

    await expect(keyTarget.dispatchKey("F2")).rejects.toThrow("key up failed");
    expect(keyUpCalls).toBe(2);
    expect(keyHarness.debugger.detach).toHaveBeenCalledOnce();

    const clickHarness = createHarness();
    let mouseReleaseCalls = 0;
    clickHarness.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        mouseReleaseCalls += 1;
        if (mouseReleaseCalls === 1) throw new Error("mouse up failed");
      }
      return method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } }
        : {};
    });
    const clickTarget = new ElectronAutomationTarget(clickHarness.view as never, clickHarness.webContents as never);

    await expect(clickTarget.dispatchClick(25, 75)).rejects.toThrow("mouse up failed");
    expect(mouseReleaseCalls).toBe(2);
    expect(clickHarness.debugger.detach).toHaveBeenCalledOnce();
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

    expect(harness.webContents.on).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(harness.webContents.on).toHaveBeenCalledWith("focus", expect.any(Function));

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
    expect(inputEvents(harness)).toHaveLength(0);
  });
});

function createHarness(bounds: { width: number; height: number } = { width: 1280, height: 720 }) {
  const frame = {
    executeJavaScript: vi.fn().mockResolvedValue("canvas")
  };
  const webContentsEmitter = new EventEmitter();
  const webContentsOn = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    webContentsEmitter.on(event, listener);
    return webContents;
  });
  const webContentsRemoveListener = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    webContentsEmitter.removeListener(event, listener);
    return webContents;
  });
  let debuggerAttached = false;
  const debuggerEmitter = new EventEmitter();
  const debuggerApi = Object.assign(debuggerEmitter, {
    attach: vi.fn(() => {
      debuggerAttached = true;
    }),
    detach: vi.fn(() => {
      debuggerAttached = false;
      debuggerEmitter.emit("detach", {}, "target closed");
    }),
    isAttached: vi.fn(() => debuggerAttached),
    sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>) => method === "Page.getLayoutMetrics"
      ? { cssVisualViewport: { clientWidth: bounds.width, clientHeight: bounds.height } }
      : {})
  });
  const webContents = {
    debugger: debuggerApi,
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    mainFrame: { framesInSubtree: [frame] },
    on: webContentsOn,
    removeListener: webContentsRemoveListener
  };
  const view = {
    getBounds: vi.fn(() => ({ x: 200, y: 100, ...bounds }))
  };

  return {
    debugger: debuggerApi,
    emitWebContents: (event: string) => webContentsEmitter.emit(event),
    frame,
    view,
    webContents
  };
}

type AutomationHarness = ReturnType<typeof createHarness>;

function inputEvents(harness: AutomationHarness): Array<[string, Record<string, unknown>]> {
  return harness.debugger.sendCommand.mock.calls
    .filter(([method]) => typeof method === "string" && method.startsWith("Input."))
    .map(([method, params]) => [method as string, params as Record<string, unknown>]);
}

function keyEvents(harness: AutomationHarness): Array<Record<string, unknown>> {
  return inputEvents(harness)
    .filter(([method]) => method === "Input.dispatchKeyEvent")
    .map(([, params]) => params);
}

function mouseEvents(harness: AutomationHarness): Array<Record<string, unknown>> {
  return inputEvents(harness)
    .filter(([method]) => method === "Input.dispatchMouseEvent")
    .map(([, params]) => params);
}
