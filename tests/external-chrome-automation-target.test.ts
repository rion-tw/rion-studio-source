import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  connectExternalChromeAutomation,
  createPageZoomSource,
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
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining("document.activeElement === target") })
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

  it("reports page focus through a one-shot binding listener", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    const listener = vi.fn();
    await target.initialize();
    target.onFocus(listener);
    await vi.waitFor(() => {
      expect(harness.send).toHaveBeenCalledWith("Runtime.addBinding", {
        name: "rionStudioWindowFocus"
      });
    });

    harness.notify({
      method: "Runtime.bindingCalled",
      params: { name: "rionStudioWindowFocus", payload: "focused" }
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(
      "Page.addScriptToEvaluateOnNewDocument",
      expect.objectContaining({ source: expect.stringContaining('addEventListener("focus"') })
    );
  });

  it("applies CPU slowdown to the page and attached iframe targets only", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    harness.notify({
      method: "Target.attachedToTarget",
      params: { sessionId: "iframe-session", targetInfo: { type: "iframe" } }
    });
    harness.notify({
      method: "Target.attachedToTarget",
      params: { sessionId: "worker-session", targetInfo: { type: "service_worker" } }
    });
    await target.setCpuThrottleRate(4);

    expect(harness.send).toHaveBeenCalledWith("Emulation.setCPUThrottlingRate", { rate: 4 });
    expect(harness.send).toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      { rate: 4 },
      undefined,
      "iframe-session"
    );
    expect(harness.send).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything(),
      undefined,
      "worker-session"
    );

    await target.releaseThrottle();
    expect(harness.send).toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      { rate: 1 },
      undefined,
      "iframe-session"
    );
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

  it("serializes concurrent clicks into complete press and release pairs", async () => {
    const harness = createHarness();
    const firstPress = createDeferred<void>();
    harness.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { clientWidth: 100, clientHeight: 100 } };
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed" && params.x === 10) {
        await firstPress.promise;
      }
      return method === "Runtime.evaluate" ? { result: { value: true } } : {};
    });
    const target = new ExternalChromeAutomationTarget(harness.client);

    const first = target.dispatchClick(10, 10);
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 10, y: 10 })
    ));
    const second = target.dispatchClick(90, 90);
    await Promise.resolve();
    expect(harness.send).not.toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 90, y: 90 })
    );

    firstPress.resolve(undefined);
    await Promise.all([first, second]);
    expect(
      harness.send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => [params?.type, params?.x, params?.y])
    ).toEqual([
      ["mousePressed", 10, 10],
      ["mouseReleased", 10, 10],
      ["mousePressed", 90, 90],
      ["mouseReleased", 90, 90]
    ]);
  });

  it("retries key release when the first keyUp request fails", async () => {
    const harness = createHarness();
    let keyUpCalls = 0;
    harness.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyUp") {
        keyUpCalls += 1;
        if (keyUpCalls === 1) {
          throw new Error("keyUp timed out");
        }
      }
      return method === "Runtime.evaluate" ? { result: { value: true } } : {};
    });
    const target = new ExternalChromeAutomationTarget(harness.client);

    await expect(target.dispatchKey("F2")).rejects.toThrow("keyUp timed out");
    expect(keyUpCalls).toBe(2);
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

    await target.setWindowBounds({ x: -1280, y: -120, width: 800, height: 900 });

    expect(
      harness.send.mock.calls.filter(([method]) => method.startsWith("Browser."))
    ).toEqual([
      ["Browser.getWindowForTarget"],
      ["Browser.setWindowBounds", { windowId: 42, bounds: { windowState: "normal" } }],
      [
        "Browser.setWindowBounds",
        {
          windowId: 42,
          bounds: { left: -1280, top: -120, width: 800, height: 900 }
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

  it("applies, replaces, and resets workspace zoom for current and future top-level documents", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    await target.setZoomFactor(0.75);

    const firstSource = createPageZoomSource(0.75);
    expect(firstSource).toContain("if (window.top !== window) return");
    expect(firstSource).toContain('root.style.setProperty("zoom", String(0.75), "important")');
    expect(harness.send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: firstSource
    });
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: firstSource })
    );

    await target.setZoomFactor(0.9);

    expect(harness.send).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "zoom-script-1"
    });
    expect(harness.send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: createPageZoomSource(0.9)
    });

    await target.setZoomFactor(1);

    const resetSource = createPageZoomSource(1);
    expect(harness.send).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "zoom-script-2"
    });
    expect(resetSource).toContain("delete root[stateKey]");
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: resetSource })
    );
  });

  it("maps function and unknown physical codes safely", () => {
    expect(getCdpKeyDescriptor("F2")).toMatchObject({ code: "F2", key: "F2", windowsVirtualKeyCode: 113 });
    expect(getCdpKeyDescriptor("Minus")).toMatchObject({ code: "Minus", key: "-", windowsVirtualKeyCode: 189 });
    expect(getCdpKeyDescriptor("Custom1")).toMatchObject({ code: "Custom1", key: "Custom1" });
  });
});

function createHarness() {
  const notificationListeners = new Set<(notification: CdpNotification) => void>();
  let zoomScriptCount = 0;
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame" } } };
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      zoomScriptCount += 1;
      return { identifier: `zoom-script-${zoomScriptCount}` };
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
