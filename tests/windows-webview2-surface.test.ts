import { describe, expect, it, vi } from "vitest";

import {
  createWindowsWebView2SurfaceFactory,
  getWindowsWebView2SessionStore,
  type WindowsWebView2NativeAddon
} from "../src/main/browser/WindowsWebView2Surface";

function nativeAddon() {
  let callback: ((event: unknown) => void) | undefined;
  const addon: WindowsWebView2NativeAddon = {
    callWebView2DevToolsMethod: vi.fn(),
    clearWebView2Data: vi.fn(),
    createWebView2Surface: vi.fn((_handle, _options, listener) => {
      callback = listener;
      return 52;
    }),
    destroyWebView2Surface: vi.fn(),
    evaluateWebView2: vi.fn(),
    focusWebView2: vi.fn(),
    getWebView2Cookies: vi.fn(),
    loadWebView2URL: vi.fn(),
    protocolVersion: 1,
    setWebView2AudioMuted: vi.fn(() => true),
    setWebView2Bounds: vi.fn(),
    setWebView2Cookies: vi.fn(),
    setWebView2Visible: vi.fn(),
    setWebView2Zoom: vi.fn()
  };
  return { addon, emit: (event: unknown) => callback?.(event) };
}

describe("WindowsWebView2Surface", () => {
  it("adapts WebView2 lifecycle, CDP, cookies, storage, and presentation", async () => {
    const native = nativeAddon();
    const handle = Buffer.alloc(8);
    const surface = createWindowsWebView2SurfaceFactory(native.addon)(
      { getNativeWindowHandle: () => handle } as never,
      { userDataFolder: "C:\\Rion\\roles\\role-1\\browser\\webview2" }
    );
    const lifecycle = vi.fn();
    surface.onLifecycleEvent(lifecycle);

    const navigation = surface.loadUrl("https://example.test/game");
    native.emit({ type: "navigationCompleted", url: "https://example.test/game" });
    await navigation;

    const evaluation = surface.evaluate<{ ready: boolean }>("({ ready: true })");
    const evaluationRequest = vi.mocked(native.addon.evaluateWebView2).mock.calls[0]?.[1];
    native.emit({
      type: "evaluationCompleted",
      requestId: evaluationRequest,
      valueJson: "{\"ready\":true}"
    });
    await expect(evaluation).resolves.toEqual({ ready: true });

    const cdp = surface.callDevToolsProtocolMethod<{ result: number }>(
      "Runtime.evaluate",
      { expression: "1 + 1" }
    );
    const cdpRequest = vi.mocked(native.addon.callWebView2DevToolsMethod).mock.calls[0]?.[1];
    native.emit({
      type: "devToolsCompleted",
      requestId: cdpRequest,
      valueJson: "{\"result\":2}"
    });
    await expect(cdp).resolves.toEqual({ result: 2 });

    const store = getWindowsWebView2SessionStore(surface);
    const reading = store.getCookies();
    const readRequest = vi.mocked(native.addon.getWebView2Cookies).mock.calls[0]?.[1];
    native.emit({
      type: "cookiesRead",
      requestId: readRequest,
      cookiesJson: "[{\"name\":\"sid\",\"value\":\"secret\",\"url\":\"https://example.test/\"}]"
    });
    await expect(reading).resolves.toHaveLength(1);
    const writing = store.setCookies([
      { name: "sid", value: "secret", url: "https://example.test/" }
    ]);
    const writeRequest = vi.mocked(native.addon.setWebView2Cookies).mock.calls[0]?.[1];
    native.emit({ type: "cookiesWritten", requestId: writeRequest, count: 1 });
    await expect(writing).resolves.toBe(1);

    await surface.setBounds({ x: 2, y: 3, width: 640, height: 480 });
    await surface.setVisible(true);
    await surface.setZoomFactor(1.25);
    await surface.setAudioMuted(true);
    await surface.focus();
    expect(native.addon.setWebView2Bounds).toHaveBeenCalledWith(
      52,
      { x: 2, y: 3, width: 640, height: 480 }
    );
    expect(lifecycle).toHaveBeenCalledWith({
      type: "navigationCompleted",
      url: "https://example.test/game"
    });

    await surface.destroy();
    await surface.destroy();
    expect(native.addon.destroyWebView2Surface).toHaveBeenCalledOnce();
  });

  it("rejects a native protocol mismatch and reports missing mute support", async () => {
    expect(() => createWindowsWebView2SurfaceFactory({
      protocolVersion: 2
    } as never)).toThrow("expected 1");

    const native = nativeAddon();
    vi.mocked(native.addon.setWebView2AudioMuted).mockReturnValue(false);
    const surface = createWindowsWebView2SurfaceFactory(native.addon)(
      { getNativeWindowHandle: () => Buffer.alloc(8) } as never,
      { userDataFolder: "C:\\Rion\\role-1" }
    );
    await expect(surface.setAudioMuted(true)).rejects.toMatchObject({
      code: "WEBVIEW2_MUTE_UNSUPPORTED"
    });
  });

  it("does not treat a native cookie read failure as an empty authenticated session", async () => {
    const native = nativeAddon();
    const surface = createWindowsWebView2SurfaceFactory(native.addon)(
      { getNativeWindowHandle: () => Buffer.alloc(8) } as never,
      { userDataFolder: "C:\\Rion\\role-1" }
    );
    const reading = getWindowsWebView2SessionStore(surface).getCookies();
    const requestId = vi.mocked(native.addon.getWebView2Cookies).mock.calls[0]?.[1];

    native.emit({
      type: "cookiesRead",
      requestId,
      cookiesJson: "[]",
      error: "WebView2 cookie manager failed."
    });

    await expect(reading).rejects.toMatchObject({
      code: "WEBVIEW2_OPERATION_FAILED"
    });
  });
});
