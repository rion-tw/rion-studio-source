import { describe, expect, it, vi } from "vitest";

import {
  createWindowsWebView2SurfaceFactory,
  type WindowsWebView2NativeAddon
} from "../src/main/browser/WindowsWebView2Surface";

function nativeAddon() {
  let callback: ((event: unknown) => void) | undefined;
  const addon: WindowsWebView2NativeAddon = {
    addWebView2DocumentStartScript: vi.fn(),
    callWebView2DevToolsMethod: vi.fn(),
    clearWebView2Data: vi.fn(),
    createWebView2Surface: vi.fn((_handle, _options, listener) => {
      callback = listener;
      return 52;
    }),
    destroyWebView2Surface: vi.fn(),
    evaluateWebView2: vi.fn(),
    focusWebView2: vi.fn(),
    loadWebView2URL: vi.fn(),
    protocolVersion: 9,
    setWebView2AudioMuted: vi.fn(() => true),
    setWebView2Bounds: vi.fn(),
    setWebView2Visible: vi.fn(),
    setWebView2Zoom: vi.fn()
  };
  return { addon, emit: (event: unknown) => callback?.(event) };
}

describe("WindowsWebView2Surface", () => {
  it("adapts WebView2 lifecycle, CDP, storage, and presentation", async () => {
    const native = nativeAddon();
    const handle = Buffer.alloc(8);
    const surface = createWindowsWebView2SurfaceFactory(native.addon)(
      { getNativeWindowHandle: () => handle } as never,
      { userDataFolder: "C:\\Rion\\roles\\role-1\\browser\\webview2" }
    );
    const lifecycle = vi.fn();
    surface.onLifecycleEvent(lifecycle);

    const documentStart = surface.addDocumentStartScript("window.__rionStart = true;");
    const documentStartRequest =
      vi.mocked(native.addon.addWebView2DocumentStartScript).mock.calls[0]?.[1];
    native.emit({
      type: "documentStartScriptAdded",
      requestId: documentStartRequest
    });
    await documentStart;

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

    await surface.setBounds({ x: 2, y: 3, width: 640, height: 480 });
    await surface.setVisible(true);
    await surface.setZoomFactor(1.25);
    await surface.setAudioMuted(true);
    await surface.focus();
    expect(native.addon.createWebView2Surface).toHaveBeenCalledWith(
      handle,
      {
        additionalBrowserArguments: "",
        proxyServer: "",
        userDataFolder: "C:\\Rion\\roles\\role-1\\browser\\webview2"
      },
      expect.any(Function)
    );
    expect(native.addon.addWebView2DocumentStartScript).toHaveBeenCalledWith(
      52,
      documentStartRequest,
      "window.__rionStart = true;"
    );
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
      protocolVersion: 5
    } as never)).toThrow("expected 9");

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

});
