import { describe, expect, it, vi } from "vitest";

import { ElectronAutomationTarget } from "../src/main/browser/ElectronAutomationTarget";

describe("ElectronAutomationTarget", () => {
  it("prepares the game canvas without stealing native focus before dispatching a key", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.dispatchKey("F2");

    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('largest("canvas")'));
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
