import { describe, expect, it, vi } from "vitest";

import {
  ExternalChromeAutomationTarget,
  getCdpKeyDescriptor
} from "../src/main/browser/ExternalChromeAutomationTarget";
import type {
  CdpEventClientLike,
  CdpNotification
} from "../src/main/system-browser/SystemChromeLauncher";

describe("ExternalChromeAutomationTarget", () => {
  it("dispatches physical key events without bringing external Chrome to front", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    await target.dispatchKey("KeyQ");

    expect(harness.send).not.toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining('querySelectorAll("canvas, iframe")') })
    );
    expect(harness.send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      code: "KeyQ",
      key: "q",
      windowsVirtualKeyCode: 81
    });
    expect(harness.send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "keyUp",
      code: "KeyQ",
      key: "q",
      windowsVirtualKeyCode: 81
    });
  });

  it("converts percentage clicks using the CSS visual viewport", async () => {
    const harness = createHarness();
    harness.send.mockImplementation(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } };
      }
      return method === "Runtime.evaluate" ? { result: { value: true } } : {};
    });
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    await target.dispatchClick(25, 75);

    expect(harness.send).not.toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      x: 300,
      y: 600
    });
    expect(harness.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x: 300,
      y: 600
    });
  });

  it("suppresses overlay shortcut handling in every live execution context before key dispatch", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();
    harness.notify({ method: "Runtime.executionContextCreated", params: { context: { id: 7 } } });
    harness.notify({ method: "Runtime.executionContextCreated", params: { context: { id: 8 } } });

    await target.dispatchKey("F2");

    for (const contextId of [7, 8]) {
      expect(harness.send).toHaveBeenCalledWith("Runtime.evaluate", {
        contextId,
        expression: expect.stringContaining('suppressNextShortcut?.("F2")')
      });
    }
  });

  it("brings external Chrome to front only when focus is explicitly requested", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    await target.focus();

    expect(harness.send).toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining('querySelectorAll("canvas, iframe")') })
    );
  });

  it("bridges external overlay requests back to the main process", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();
    const handler = vi.fn().mockResolvedValue({ macros: [], statuses: [] });
    await target.installMacroOverlay("window.overlayInstalled = true", handler);

    harness.notify({
      method: "Runtime.bindingCalled",
      params: {
        name: "rionStudioMacroOverlay",
        executionContextId: 7,
        payload: JSON.stringify({ id: 3, request: { type: "list" } })
      }
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ type: "list" }));
    await vi.waitFor(() => {
      expect(harness.send).toHaveBeenCalledWith(
        "Runtime.evaluate",
        expect.objectContaining({ contextId: 7, expression: expect.stringContaining("resolve(3, true") })
      );
    });
  });

  it("maps function and unknown physical codes safely", () => {
    expect(getCdpKeyDescriptor("F2")).toMatchObject({ code: "F2", key: "F2", windowsVirtualKeyCode: 113 });
    expect(getCdpKeyDescriptor("Minus")).toMatchObject({ code: "Minus", key: "-", windowsVirtualKeyCode: 189 });
    expect(getCdpKeyDescriptor("Custom1")).toMatchObject({ code: "Custom1", key: "Custom1" });
  });
});

function createHarness() {
  const notificationListeners = new Set<(notification: CdpNotification) => void>();
  const send = vi.fn(async (method: string) => method === "Runtime.evaluate" ? { result: { value: true } } : {});
  const client: CdpEventClientLike = {
    close: vi.fn(),
    onDisconnect: vi.fn(() => () => undefined),
    onNotification: vi.fn((listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    }),
    send: send as CdpEventClientLike["send"]
  };
  return {
    client,
    notify: (notification: CdpNotification) => notificationListeners.forEach((listener) => listener(notification)),
    send
  };
}
