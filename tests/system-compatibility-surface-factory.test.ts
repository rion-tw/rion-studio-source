import { join, resolve } from "node:path";

import type { BaseWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import { createSystemCompatibilitySurfaceFactory } from "../src/main/browser/SystemCompatibilitySurfaceFactory";
import type {
  WindowsWebView2SurfaceFactory,
  WindowsWebView2SurfacePort
} from "../src/main/browser/WindowsWebView2Surface";
import type { WebSurfacePort } from "../src/main/browser/ports/WebSurfacePort";

const surface = {} as WebSurfacePort;
const windowsSurface = {
  ...surface,
  callDevToolsProtocolMethod: vi.fn(async () => undefined)
} as WindowsWebView2SurfacePort;
const window = {} as BaseWindow;

describe("System compatibility surface factory", () => {
  it("uses a unique WKWebsiteDataStore and forwards the proxy on macOS", () => {
    const createMacSurface = vi.fn(() => surface);
    const factory = createSystemCompatibilitySurfaceFactory({
      createMacSurface,
      platform: "darwin",
      userDataDir: resolve("fixture-user-data")
    });

    expect(factory(window, "run-1", { proxyServer: "http://proxy.example:8080" }))
      .toEqual({ surface });
    expect(createMacSurface).toHaveBeenCalledWith(window, {
      dataStoreIdentifier: expect.stringMatching(
        /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
      ),
      proxyServer: "http://proxy.example:8080"
    });
  });

  it("uses a unique compatibility UDF and forwards WebView2 arguments on Windows", async () => {
    const userDataDir = resolve("fixture-user-data");
    const createWindowsSurface = vi.fn((
      _window: BaseWindow,
      _options: Parameters<WindowsWebView2SurfaceFactory>[1]
    ) => windowsSurface);
    const factory = createSystemCompatibilitySurfaceFactory({
      createWindowsSurface,
      platform: "win32",
      userDataDir
    });

    const created = factory(window, "run-1", {
      additionalBrowserArguments: "--use-angle=vulkan",
      proxyServer: "http://proxy.example:8080"
    });

    expect(created.surface).toBe(windowsSurface);
    expect(createWindowsSurface).toHaveBeenCalledWith(window, {
      additionalBrowserArguments: "--use-angle=vulkan",
      proxyServer: "http://proxy.example:8080",
      userDataFolder: expect.stringMatching(/webview2$/)
    });
    const folder = createWindowsSurface.mock.calls[0]![1].userDataFolder;
    expect(folder.startsWith(join(userDataDir, "compatibility"))).toBe(true);
    await expect(created.cleanup?.()).resolves.toBeUndefined();
  });

  it("fails closed when the current platform adapter is unavailable", () => {
    const factory = createSystemCompatibilitySurfaceFactory({
      platform: "win32",
      userDataDir: resolve("fixture-user-data")
    });

    expect(() => factory(window, "run-1", {})).toThrowError(
      expect.objectContaining({ code: "SYSTEM_RUNTIME_UNAVAILABLE" })
    );
  });
});
