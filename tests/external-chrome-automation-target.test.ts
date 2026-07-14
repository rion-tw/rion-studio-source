import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  connectExternalChromeAutomation,
  ExternalChromeAutomationTarget,
  getCdpKeyDescriptor
} from "../src/main/browser/ExternalChromeAutomationTarget";
import type {
  CdpEventClientLike,
  CdpNotification
} from "../src/main/system-browser/SystemChromeLauncher";

describe("ExternalChromeAutomationTarget", () => {
  it("gives page discovery a full timeout after a slow DevTools port startup", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-external-chrome-automation-"));
    const harness = createHarness();
    let now = 0;
    let wrotePort = false;
    const fetchTargets = vi.fn(async () => ({
      ok: true,
      json: async () => now >= 10_500
        ? [{
            id: "target-1",
            type: "page",
            url: "https://example.com/play",
            webSocketDebuggerUrl: "ws://devtools/page-1"
          }]
        : []
    }));

    const target = await connectExternalChromeAutomation(userDataDir, "https://example.com/play", {
      createClient: () => harness.client,
      fetch: fetchTargets,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (!wrotePort && now >= 9_500) {
          wrotePort = true;
          await writeFile(join(userDataDir, "DevToolsActivePort"), "9222\n/devtools/browser/test\n");
        }
      }
    });

    expect(target).toBeInstanceOf(ExternalChromeAutomationTarget);
    expect(now).toBe(10_500);
    expect(fetchTargets).toHaveBeenCalledTimes(3);
  });

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

  it("registers request handling before enabling CDN interception and then reloads without cache", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);

    await target.initialize({ cdnCompatibilityEnabled: true });

    expect(harness.onNotification).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith(
      "Fetch.enable",
      expect.objectContaining({
        patterns: expect.arrayContaining([
          { requestStage: "Request", urlPattern: "https://www.google.com/*" }
        ])
      })
    );
    expect(harness.send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
    expect(harness.onNotification.mock.invocationCallOrder[0]).toBeLessThan(
      harness.send.mock.invocationCallOrder[
        harness.send.mock.calls.findIndex(([method]) => method === "Fetch.enable")
      ]
    );
    expect(harness.send.mock.invocationCallOrder[
      harness.send.mock.calls.findIndex(([method]) => method === "Fetch.enable")
    ]).toBeLessThan(
      harness.send.mock.invocationCallOrder[
        harness.send.mock.calls.findIndex(([method]) => method === "Page.reload")
      ]
    );
  });

  it("rewrites matching paused requests and continues unmatched requests unchanged", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize({ cdnCompatibilityEnabled: true });

    harness.notify({
      method: "Fetch.requestPaused",
      params: {
        frameId: "child-frame",
        request: { url: "https://fonts.gstatic.com/s/roboto/v1/font.woff2" },
        requestId: "request-1",
        resourceType: "Font"
      }
    });
    harness.notify({
      method: "Fetch.requestPaused",
      params: {
        frameId: "child-frame",
        request: { url: "https://www.google.com/search?q=flyff" },
        requestId: "request-2",
        resourceType: "XHR"
      }
    });

    await vi.waitFor(() => {
      expect(harness.send).toHaveBeenCalledWith("Fetch.continueRequest", {
        requestId: "request-1",
        url: "https://fonts.gstatic.cn/s/roboto/v1/font.woff2"
      });
      expect(harness.send).toHaveBeenCalledWith("Fetch.continueRequest", {
        requestId: "request-2"
      });
    });
    expect(harness.send.mock.calls.filter(
      ([method, params]) => method === "Fetch.continueRequest" && params?.requestId === "request-1"
    )).toHaveLength(1);
    expect(harness.send.mock.calls.filter(
      ([method, params]) => method === "Fetch.continueRequest" && params?.requestId === "request-2"
    )).toHaveLength(1);
  });

  it("keeps main-frame documents original while rewriting matching subframe documents", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize({ cdnCompatibilityEnabled: true });
    const url = "https://www.google.com/recaptcha/api2/anchor?k=test";

    harness.notify({
      method: "Fetch.requestPaused",
      params: {
        frameId: "main-frame",
        request: { url },
        requestId: "main-document",
        resourceType: "Document"
      }
    });
    harness.notify({
      method: "Fetch.requestPaused",
      params: {
        frameId: "child-frame",
        request: { url },
        requestId: "sub-document",
        resourceType: "Document"
      }
    });

    await vi.waitFor(() => {
      expect(harness.send).toHaveBeenCalledWith("Fetch.continueRequest", {
        requestId: "main-document"
      });
      expect(harness.send).toHaveBeenCalledWith("Fetch.continueRequest", {
        requestId: "sub-document",
        url: "https://www.recaptcha.net/recaptcha/api2/anchor?k=test"
      });
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

  it("restores and applies exact browser window bounds through CDP", async () => {
    const harness = createHarness();
    harness.send.mockImplementation(async (method: string) => {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 42, bounds: { windowState: "maximized" } };
      }
      return {};
    });
    const target = new ExternalChromeAutomationTarget(harness.client);

    await target.setWindowBounds({ x: 2000, y: 40, width: 800, height: 900 });

    expect(
      harness.send.mock.calls.filter(([method]) => method.startsWith("Browser."))
    ).toEqual([
      ["Browser.getWindowForTarget"],
      ["Browser.setWindowBounds", { windowId: 42, bounds: { windowState: "normal" } }],
      [
        "Browser.setWindowBounds",
        {
          windowId: 42,
          bounds: { left: 2000, top: 40, width: 800, height: 900 }
        }
      ]
    ]);
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
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame" } } };
    }
    return method === "Runtime.evaluate" ? { result: { value: true } } : {};
  });
  const onNotification = vi.fn((listener: (notification: CdpNotification) => void) => {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  });
  const client: CdpEventClientLike = {
    close: vi.fn(),
    onDisconnect: vi.fn(() => () => undefined),
    onNotification,
    send: send as CdpEventClientLike["send"]
  };
  return {
    client,
    notify: (notification: CdpNotification) => notificationListeners.forEach((listener) => listener(notification)),
    onNotification,
    send
  };
}
