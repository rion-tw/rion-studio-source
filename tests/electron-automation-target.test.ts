import { describe, expect, it, vi } from "vitest";

import { ElectronAutomationTarget } from "../src/main/browser/ElectronAutomationTarget";

describe("ElectronAutomationTarget", () => {
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
      expect.stringContaining('suppressNextShortcut?.("F2")')
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
      if (source.includes('suppressNextShortcut?.("F2")')) {
        return firstSuppression;
      }
      return Promise.resolve(source.includes('largest("canvas")') ? "canvas" : undefined);
    });
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    const first = target.dispatchKey("F2");
    await vi.waitFor(() => {
      expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('suppressNextShortcut?.("F2")')
      );
    });
    const second = target.dispatchKey("F3");
    await Promise.resolve();
    expect(harness.frame.executeJavaScript).not.toHaveBeenCalledWith(
      expect.stringContaining('suppressNextShortcut?.("F3")')
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

  it("serializes key and click input through the same target queue", async () => {
    const harness = createHarness();
    let releaseSuppression!: () => void;
    const suppression = new Promise<void>((resolve) => {
      releaseSuppression = resolve;
    });
    harness.frame.executeJavaScript.mockImplementation((source: string) =>
      source.includes('suppressNextShortcut?.("F2")')
        ? suppression
        : Promise.resolve(source.includes('largest("canvas")') ? "canvas" : undefined)
    );
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    const key = target.dispatchKey("F2");
    await vi.waitFor(() => expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('suppressNextShortcut?.("F2")')
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
    sendInputEvent: vi.fn()
  };
  const view = {
    getBounds: vi.fn(() => ({ x: 200, y: 100, ...bounds }))
  };

  return { frame, view, webContents };
}
