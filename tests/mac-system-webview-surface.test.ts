import { describe, expect, it, vi } from "vitest";

import {
  createMacSystemWebViewSurfaceFactory,
  type MacSystemWebViewNativeAddon
} from "../src/main/browser/MacSystemWebViewSurface";

function nativeAddon() {
  let callback: ((event: unknown) => void) | undefined;
  const addon: MacSystemWebViewNativeAddon = {
    addSystemWebViewDocumentStartScript: vi.fn(),
    clearSystemWebViewData: vi.fn(),
    createSystemWebView: vi.fn((_handle, _options, listener) => {
      callback = listener;
      return 41;
    }),
    destroySystemWebView: vi.fn(),
    evaluateSystemWebView: vi.fn(),
    focusSystemWebView: vi.fn(),
    loadSystemWebViewURL: vi.fn(),
    protocolVersion: 11,
    setSystemWebViewAudioMuted: vi.fn(() => true),
    setSystemWebViewBounds: vi.fn(),
    setSystemWebViewVisible: vi.fn(),
    setSystemWebViewZoom: vi.fn()
  };
  return { addon, emit: (event: unknown) => callback?.(event) };
}

describe("MacSystemWebViewSurface", () => {
  it("adapts WKWebView lifecycle, evaluation, storage, and presentation", async () => {
    const native = nativeAddon();
    const handle = Buffer.alloc(8);
    const surface = createMacSystemWebViewSurfaceFactory(native.addon)(
      { getNativeWindowHandle: () => handle } as never,
      { dataStoreIdentifier: "0c0d1969-d51b-8576-8d79-0c64291ca837" }
    );
    const lifecycle = vi.fn();
    surface.onLifecycleEvent(lifecycle);

    const documentStart = surface.addDocumentStartScript("window.__rionStart = true;");
    const documentStartRequest =
      vi.mocked(native.addon.addSystemWebViewDocumentStartScript).mock.calls[0]?.[1];
    native.emit({
      type: "documentStartScriptAdded",
      requestId: documentStartRequest
    });
    await documentStart;

    const navigation = surface.loadUrl("https://example.test/game");
    native.emit({ type: "navigationCompleted", url: "https://example.test/game" });
    await navigation;

    const evaluation = surface.evaluate<{ ok: boolean }>("({ ok: true })");
    const evaluationRequest = vi.mocked(native.addon.evaluateSystemWebView).mock.calls[0]?.[1];
    native.emit({
      type: "evaluationCompleted",
      requestId: evaluationRequest,
      valueJson: "{\"ok\":true}"
    });
    await expect(evaluation).resolves.toEqual({ ok: true });

    const clearing = surface.clearStorage(["cookies", "localstorage"]);
    const clearRequest = vi.mocked(native.addon.clearSystemWebViewData).mock.calls[0]?.[1];
    native.emit({ type: "websiteDataCleared", requestId: clearRequest });
    await clearing;
    native.emit({ type: "audioChanged", audible: true });
    native.emit({ type: "popupCreated", url: "https://example.test/popup" });
    native.emit({ type: "popupClosed", url: "https://example.test/popup" });

    await surface.setBounds({ x: 1, y: 2, width: 300, height: 200 });
    await surface.setVisible(true);
    await surface.setZoomFactor(1.25);
    await surface.setAudioMuted(true);
    await surface.focus();

    expect(native.addon.createSystemWebView).toHaveBeenCalledWith(
      handle,
      {
        dataStoreIdentifier: "0c0d1969-d51b-8576-8d79-0c64291ca837",
        proxyServer: ""
      },
      expect.any(Function)
    );
    expect(native.addon.addSystemWebViewDocumentStartScript).toHaveBeenCalledWith(
      41,
      documentStartRequest,
      "window.__rionStart = true;"
    );
    expect(lifecycle).toHaveBeenCalledWith({
      type: "navigationCompleted",
      url: "https://example.test/game"
    });
    expect(lifecycle).toHaveBeenCalledWith({ type: "audioChanged", audible: true });
    expect(lifecycle).toHaveBeenCalledWith({
      type: "popupCreated",
      url: "https://example.test/popup"
    });
    expect(lifecycle).toHaveBeenCalledWith({
      type: "popupClosed",
      url: "https://example.test/popup"
    });
    expect(native.addon.setSystemWebViewBounds).toHaveBeenCalledWith(
      41,
      { x: 1, y: 2, width: 300, height: 200 }
    );

    await surface.destroy();
    await surface.destroy();
    expect(native.addon.destroySystemWebView).toHaveBeenCalledOnce();
  });

  it("turns missing mute SPI and native errors into explicit capability failures", async () => {
    const native = nativeAddon();
    vi.mocked(native.addon.setSystemWebViewAudioMuted).mockReturnValue(false);
    const surface = createMacSystemWebViewSurfaceFactory(native.addon)(
      { getNativeWindowHandle: () => Buffer.alloc(8) } as never,
      { dataStoreIdentifier: "0c0d1969-d51b-8576-8d79-0c64291ca837" }
    );

    await expect(surface.setAudioMuted(true)).rejects.toMatchObject({
      code: "SYSTEM_WEBVIEW_MUTE_UNSUPPORTED"
    });
    const evaluation = surface.evaluate("throw new Error('fixture')");
    const requestId = vi.mocked(native.addon.evaluateSystemWebView).mock.calls[0]?.[1];
    native.emit({
      type: "evaluationCompleted",
      requestId,
      error: "fixture error"
    });
    await expect(evaluation).rejects.toMatchObject({
      code: "SYSTEM_WEBVIEW_OPERATION_FAILED"
    });
  });

  it("rejects an incompatible native protocol", () => {
    expect(() => createMacSystemWebViewSurfaceFactory({
      protocolVersion: 8
    } as never)).toThrow("expected 11");
  });
});
