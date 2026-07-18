import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("dispatches physical key events without scanning or focusing the page", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    await target.dispatchKey("KeyQ");

    expect(harness.send).not.toHaveBeenCalledWith("Page.bringToFront");
    const evaluatedSources = harness.send.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => String(params?.expression));
    expect(evaluatedSources.join("\n")).not.toContain('querySelectorAll("canvas, iframe")');
    expect(evaluatedSources.join("\n")).not.toContain("document.activeElement");
    expect(evaluatedSources.join("\n")).not.toContain(".focus(");
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

  it("records browser, lifecycle, CDP health, and disconnect diagnostics", async () => {
    const harness = createHarness();
    const onDiagnostic = vi.fn();
    const target = new ExternalChromeAutomationTarget(harness.client, "win32", onDiagnostic);
    await target.initialize();

    expect(onDiagnostic).toHaveBeenCalledWith({
      type: "browser_version",
      details: expect.objectContaining({ product: "Chrome/596.36" })
    });
    harness.notify({
      method: "Runtime.bindingCalled",
      params: {
        name: "rionStudioExternalDiagnostics",
        payload: JSON.stringify({
          event: "visibilitychange",
          hidden: true,
          visibilityState: "hidden",
          wasDiscarded: false,
          webglRenderer: "ANGLE (NVIDIA)"
        })
      }
    });
    expect(onDiagnostic).toHaveBeenCalledWith({
      type: "page_lifecycle",
      details: expect.objectContaining({
        event: "visibilitychange",
        hidden: true,
        webglRenderer: "ANGLE (NVIDIA)"
      })
    });

    harness.send.mockRejectedValueOnce(new Error("Chrome DevTools request timed out: Runtime.evaluate"));
    await expect(target.evaluate("1 + 1")).rejects.toThrow("timed out");
    expect(onDiagnostic).toHaveBeenCalledWith({
      type: "cdp_evaluate_failed",
      details: expect.objectContaining({ consecutiveFailures: 1 })
    });
    harness.disconnect();
    expect(onDiagnostic).toHaveBeenCalledWith({
      type: "disconnect",
      details: expect.objectContaining({ consecutiveEvaluateFailures: 1 })
    });
  });

  it("dispatches a key combination atomically with CDP modifier state", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client, "win32");

    await target.dispatchKey({ code: "KeyK", modifiers: ["shift", "ctrl"] });

    expect(harness.send.mock.calls
      .filter(([method]) => method === "Input.dispatchKeyEvent")
      .map(([, params]) => params)
    ).toEqual([
      { type: "rawKeyDown", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17, location: 1, modifiers: 2 },
      { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, location: 1, modifiers: 10 },
      { type: "rawKeyDown", code: "KeyK", key: "K", windowsVirtualKeyCode: 75, modifiers: 10 },
      { type: "keyUp", code: "KeyK", key: "K", windowsVirtualKeyCode: 75, modifiers: 10 },
      { type: "keyUp", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, location: 1, modifiers: 2 },
      { type: "keyUp", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17, location: 1 }
    ]);
  });

  it.each([
    ["darwin", "MetaLeft", 4],
    ["win32", "ControlLeft", 2]
  ] as const)("resolves Primary explicitly on %s", async (platform, code, modifiers) => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client, platform);

    await target.dispatchKey({ code: "KeyA", modifiers: ["primary"] });

    expect(harness.send).toHaveBeenCalledWith("Input.dispatchKeyEvent", expect.objectContaining({
      type: "rawKeyDown",
      code,
      modifiers
    }));
  });

  it("reference-counts modifiers shared by held combinations", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client, "win32");
    const first = { code: "KeyK", modifiers: ["ctrl" as const] };
    const second = { code: "KeyL", modifiers: ["ctrl" as const] };

    await target.holdKey(first, "owner-1");
    await target.holdKey(second, "owner-2");
    await target.releaseKey(first, "owner-1");
    await target.releaseKey(second, "owner-2");

    expect(harness.send.mock.calls
      .filter(([method]) => method === "Input.dispatchKeyEvent")
      .map(([, params]) => [params?.type, params?.code])
    ).toEqual([
      ["rawKeyDown", "ControlLeft"],
      ["rawKeyDown", "KeyK"],
      ["rawKeyDown", "KeyL"],
      ["keyUp", "KeyK"],
      ["keyUp", "KeyL"],
      ["keyUp", "ControlLeft"]
    ]);
  });

  it("rolls back an entire held combination when its post-input delay is cancelled", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    const controller = new AbortController();

    const hold = target.holdKey(
      { code: "KeyW", modifiers: ["shift"] },
      "owner",
      { postDelayMs: 100, signal: controller.signal }
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(hold).rejects.toThrow();
    expect(harness.send.mock.calls
      .filter(([method]) => method === "Input.dispatchKeyEvent")
      .map(([, params]) => [params?.type, params?.code])
    ).toEqual([
      ["rawKeyDown", "ShiftLeft"],
      ["rawKeyDown", "KeyW"],
      ["keyUp", "KeyW"],
      ["keyUp", "ShiftLeft"]
    ]);
  });

  it("holds keys and keeps the post-input delay inside the shared CDP queue", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);

    const key = target.dispatchKey("F2", { holdMs: 20, postDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      harness.send.mock.calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, params]) => params?.type)
    ).toEqual(["rawKeyDown"]);

    const click = target.dispatchClick(50, 50);
    await vi.advanceTimersByTimeAsync(19);
    expect(harness.send).not.toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed" })
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp" })
    );
    await vi.advanceTimersByTimeAsync(9);
    expect(harness.send).not.toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed" })
    );
    await vi.advanceTimersByTimeAsync(1);

    await Promise.all([key, click]);
    expect(harness.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed" })
    );
  });

  it("reference-counts held CDP keys and taps without releasing an active hold", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);

    await target.holdKey("KeyW", "owner-1");
    await target.holdKey("KeyW", "owner-2");
    await target.releaseKey("KeyW", "owner-1");
    await target.dispatchKey("KeyW");
    await target.releaseKey("KeyW", "owner-2");

    expect(harness.send.mock.calls
      .filter(([method]) => method === "Input.dispatchKeyEvent")
      .map(([, params]) => params)
    ).toEqual([
      { type: "rawKeyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 },
      { type: "rawKeyDown", autoRepeat: true, code: "KeyW", key: "w", windowsVirtualKeyCode: 87 },
      { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }
    ]);
  });

  it("releases a hold whose keyDown finishes after cancellation", async () => {
    const harness = createHarness();
    const rawKeyDown = createDeferred<unknown>();
    harness.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchKeyEvent" && params?.type === "rawKeyDown") {
        return rawKeyDown.promise;
      }
      return method === "Runtime.evaluate" ? { result: { value: true } } : {};
    });
    const target = new ExternalChromeAutomationTarget(harness.client);
    const controller = new AbortController();

    const hold = target.holdKey("KeyW", "owner-1", { signal: controller.signal });
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "rawKeyDown" })
    ));
    controller.abort();
    rawKeyDown.resolve({});

    await expect(hold).rejects.toThrow();
    expect(harness.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }
    );
  });

  it("releases a held CDP key when the dispatch is aborted", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    const controller = new AbortController();

    const dispatch = target.dispatchKey("F2", {
      holdMs: 100,
      postDelayMs: 10,
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(dispatch).rejects.toThrow();
    expect(
      harness.send.mock.calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, params]) => params?.type)
    ).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("never scans or focuses the page during repeated high-frequency input", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    for (let index = 0; index < 50; index += 1) {
      await target.dispatchKey("Digit1");
      await target.dispatchClick(50, 50);
    }

    const evaluatedSources = harness.send.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => String(params?.expression))
      .join("\n");
    expect(evaluatedSources).not.toContain('querySelectorAll("canvas, iframe")');
    expect(evaluatedSources).not.toContain("document.activeElement");
    expect(evaluatedSources).not.toContain(".focus(");
    expect(harness.send).not.toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send.mock.calls.filter(([method]) => method === "Input.dispatchKeyEvent")).toHaveLength(100);
    expect(harness.send.mock.calls.filter(([method]) => method === "Input.dispatchMouseEvent")).toHaveLength(100);
  });

  it("focuses the page without installing Rion CPU or window-focus tracking", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();
    await target.focus();

    expect(harness.send).toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send).not.toHaveBeenCalledWith("Target.setAutoAttach", expect.anything());
    expect(harness.send).not.toHaveBeenCalledWith(
      "Runtime.addBinding",
      { name: "rionStudioWindowFocus" }
    );
    expect(harness.send.mock.calls.some(([method]) => method === "Emulation.setCPUThrottlingRate")).toBe(false);
  });

  it("reports main-frame navigation so held shortcut leases can be released", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    const listener = vi.fn();
    target.onNavigation(listener);
    await target.initialize();

    harness.notify({
      method: "Page.frameNavigated",
      params: { frame: { id: "main", url: "https://example.com/next" } }
    });
    harness.notify({
      method: "Page.frameNavigated",
      params: { frame: { id: "child", parentId: "main", url: "https://example.com/frame" } }
    });

    expect(listener).toHaveBeenCalledOnce();
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

  it("keeps held-key release inside the CDP input queue", async () => {
    const harness = createHarness();
    const f2KeyDown = createDeferred<void>();
    harness.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (
        method === "Input.dispatchKeyEvent" &&
        params?.type === "rawKeyDown" &&
        params.code === "F2"
      ) {
        await f2KeyDown.promise;
      }
      return method === "Runtime.evaluate" ? { result: { value: true } } : {};
    });
    const target = new ExternalChromeAutomationTarget(harness.client);

    await target.holdKey("KeyW", "owner");
    const key = target.dispatchKey("F2");
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "rawKeyDown", code: "F2" })
    ));
    const release = target.releaseKey("KeyW", "owner");
    await Promise.resolve();
    expect(harness.send).not.toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp", code: "KeyW" })
    );

    f2KeyDown.resolve(undefined);
    await Promise.all([key, release]);
    expect(harness.send.mock.calls
      .filter(([method]) => method === "Input.dispatchKeyEvent")
      .map(([, params]) => [params?.type, params?.code])
    ).toEqual([
      ["rawKeyDown", "KeyW"],
      ["rawKeyDown", "F2"],
      ["keyUp", "F2"],
      ["keyUp", "KeyW"]
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
        expression: expect.stringContaining('suppressNextShortcut?.("F2", "keydown")')
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

  it("ensures the page input target without bringing external Chrome to front", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    await expect(target.ensureInputFocus()).resolves.toBe(true);

    expect(harness.send).not.toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringMatching(
          /querySelectorAll\("canvas, iframe"\)[\s\S]*\(false \? document\.body : null\)/
        )
      })
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

  it("focuses physically clicked canvases while suppressing macro click focus repair", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();
    await target.installMacroOverlay("window.overlayInstalled = true", vi.fn());

    expect(harness.send).toHaveBeenCalledWith(
      "Page.addScriptToEvaluateOnNewDocument",
      expect.objectContaining({
        source: expect.stringMatching(
          /addEventListener\("pointerdown"[\s\S]*event\.composedPath\(\)[\s\S]*HTMLCanvasElement/
        )
      })
    );

    harness.send.mockClear();
    await target.dispatchClick(50, 50);

    const evaluatedSources = harness.send.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => String(params?.expression));
    expect(evaluatedSources).toEqual([
      expect.stringContaining("setSuppressed?.(true)"),
      expect.stringContaining("setSuppressed?.(false)")
    ]);
    expect(evaluatedSources.join("\n")).not.toContain(".focus(");
    expect(harness.send).not.toHaveBeenCalledWith("Page.bringToFront");
    expect(harness.send.mock.calls.filter(([method]) => method === "Input.dispatchMouseEvent")).toHaveLength(2);
  });

  it("does not inject CSS workspace zoom into external Chrome documents", async () => {
    const harness = createHarness();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();

    const installedSources = harness.send.mock.calls
      .filter(([method]) => method === "Page.addScriptToEvaluateOnNewDocument")
      .map(([, params]) => String(params?.source))
      .join("\n");
    expect(installedSources).not.toContain("WorkspaceZoom");
    expect(installedSources).not.toContain('style.setProperty("zoom"');
    expect(installedSources).not.toContain("visualViewport?.width");
  });

  it("maps function and unknown physical codes safely", () => {
    expect(getCdpKeyDescriptor("F2")).toMatchObject({ code: "F2", key: "F2", windowsVirtualKeyCode: 113 });
    expect(getCdpKeyDescriptor("Minus")).toMatchObject({ code: "Minus", key: "-", windowsVirtualKeyCode: 189 });
    expect(getCdpKeyDescriptor("Slash", 8)).toMatchObject({ code: "Slash", key: "?", windowsVirtualKeyCode: 191 });
    expect(getCdpKeyDescriptor("Custom1")).toMatchObject({ code: "Custom1", key: "Custom1" });
  });
});

function createHarness() {
  const notificationListeners = new Set<(notification: CdpNotification) => void>();
  const disconnectListeners = new Set<() => void>();
  let zoomScriptCount = 0;
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame" } } };
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      zoomScriptCount += 1;
      return { identifier: `zoom-script-${zoomScriptCount}` };
    }
    if (method === "Browser.getVersion") {
      return { product: "Chrome/596.36", protocolVersion: "1.3" };
    }
    return method === "Runtime.evaluate" ? { result: { value: true } } : {};
  });
  const onNotification = vi.fn((listener: (notification: CdpNotification) => void) => {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  });
  const client: CdpEventClientLike = {
    close: vi.fn(),
    onDisconnect: vi.fn((listener: () => void) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    }),
    onNotification,
    send: send as CdpEventClientLike["send"]
  };
  return {
    client,
    disconnect: () => disconnectListeners.forEach((listener) => listener()),
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
