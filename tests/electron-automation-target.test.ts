import { describe, expect, it, vi } from "vitest";

import { ElectronAutomationTarget } from "../src/main/browser/ElectronAutomationTarget";

describe("ElectronAutomationTarget", () => {
  it("prepares the game canvas without stealing native focus before dispatching a key", async () => {
    const harness = createHarness();
    const target = new ElectronAutomationTarget(harness.view as never, harness.webContents as never);

    await target.dispatchKey("F2");

    expect(harness.webContents.focus).not.toHaveBeenCalled();
    expect(harness.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('largest("canvas")'));
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
