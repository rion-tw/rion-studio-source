import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { ExtensionStoreHost } from "../src/electron/main/extensionStoreHost";

const native = vi.hoisted(() => {
  let url = "";
  return {
    visible: vi.fn(),
    contents: {
      getURL: () => url, isDestroyed: () => false, isLoadingMainFrame: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: vi.fn(), setWindowOpenHandler: vi.fn(), close: vi.fn(),
      loadURL: vi.fn(async (next: string) => { url = next; })
    }
  };
});
vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = native.contents;
    setVisible = native.visible;
    setBounds = vi.fn();
  },
  session: { fromPartition: vi.fn(() => ({})) }
}));
vi.mock("../src/electron/main/chromiumSecurityPolicy", () => ({ installChromiumSessionSecurityPolicy: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe.each(["darwin", "win32"])("store locale (%s)", () => {
  it("initializes in the app language and only reloads when that language changes", () => {
    const owner = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, once: vi.fn(), isDestroyed: () => false, getContentSize: () => [960, 640] } as unknown as BrowserWindow;
    const host = new ExtensionStoreHost(() => owner, vi.fn());
    const bounds = { x: 0, y: 0, width: 600, height: 400 };
    host.request({ action: "show", bounds, language: "zh-TW" });
    expect(native.contents.loadURL).toHaveBeenLastCalledWith("https://chromewebstore.google.com/category/extensions?hl=zh-TW");
    host.request({ action: "hide" });
    host.request({ action: "show", bounds, language: "zh-TW" });
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    void native.contents.loadURL("https://chromewebstore.google.com/detail/fixture?source=app&hl=zh-TW");
    host.request({ action: "show", bounds, language: "zh-CN" });
    expect(native.contents.loadURL).toHaveBeenLastCalledWith("https://chromewebstore.google.com/detail/fixture?source=app&hl=zh");
    host.request({ action: "show", bounds, language: "zh-CN" });
    expect(native.contents.loadURL).toHaveBeenCalledTimes(3);
    host.dispose();
  });
});
