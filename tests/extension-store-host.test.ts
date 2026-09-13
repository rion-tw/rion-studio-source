import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  ExtensionStoreHost,
  type ExtensionStoreNavigationDiagnostic
} from "../src/electron/main/extensionStoreHost";

const extensionId = "a".repeat(32);
const native = vi.hoisted(() => {
  let destroyed = false;
  let requestHandler: ((
    details: Record<string, unknown>,
    callback: (response: Record<string, unknown>) => void
  ) => void) | null = null;
  const ipcListeners = new Set<(
    event: { sender: unknown },
    value: unknown
  ) => void>();
  let url = "";
  let windowOpenHandler: ((details: Record<string, unknown>) => unknown) | null = null;
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const contents = {
    id: 73,
    close: vi.fn(() => { destroyed = true; }),
    getURL: vi.fn(() => url),
    insertCSS: vi.fn(async () => "css-key"),
    isDestroyed: vi.fn(() => destroyed),
    isLoadingMainFrame: vi.fn(() => false),
    loadURL: vi.fn(async (next: string) => { url = next; }),
    navigationHistory: {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn()
    },
    on: vi.fn((name: string, listener: (...args: never[]) => void) => {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
    }),
    reload: vi.fn(),
    setWindowOpenHandler: vi.fn((handler: typeof windowOpenHandler) => {
      windowOpenHandler = handler;
    })
  };
  return {
    contents,
    emit(name: string, ...args: unknown[]) {
      for (const listener of listeners.get(name) ?? []) {
        listener(...args as never[]);
      }
    },
    open(details: Record<string, unknown>) {
      if (!windowOpenHandler) throw new Error("window handler missing");
      return windowOpenHandler(details);
    },
    navigate(value: unknown, sender?: unknown) {
      for (const listener of ipcListeners) {
        listener({ sender: sender ?? contents }, value);
      }
    },
    request(details: Record<string, unknown>) {
      if (!requestHandler) throw new Error("request handler missing");
      const callback = vi.fn();
      requestHandler(details, callback);
      return callback;
    },
    reset() {
      destroyed = false;
      requestHandler = null;
      url = "";
      windowOpenHandler = null;
      listeners.clear();
      ipcListeners.clear();
    },
    setUrl(next: string) { url = next; },
    session: {
      webRequest: {
        onBeforeRequest: vi.fn((
          _filter: unknown,
          handler: typeof requestHandler
        ) => { requestHandler = handler; })
      }
    },
    ipcMain: {
      on: vi.fn((_channel: string, listener: (
        event: { sender: unknown },
        value: unknown
      ) => void) => { ipcListeners.add(listener); }),
      removeListener: vi.fn((_channel: string, listener: (
        event: { sender: unknown },
        value: unknown
      ) => void) => { ipcListeners.delete(listener); })
    },
    visible: vi.fn()
  };
});

vi.mock("electron", () => ({
  ipcMain: native.ipcMain,
  WebContentsView: class {
    webContents = native.contents;
    setVisible = native.visible;
    setBounds = vi.fn();
  },
  session: { fromPartition: vi.fn(() => native.session) }
}));
vi.mock("../src/electron/main/chromiumSecurityPolicy", () => ({
  installChromiumSessionSecurityPolicy: vi.fn()
}));

function owner(): BrowserWindow {
  return {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentSize: () => [960, 640],
    isDestroyed: () => false,
    once: vi.fn()
  } as unknown as BrowserWindow;
}

function openDetails(url: string, postBody?: object): Record<string, unknown> {
  return {
    disposition: "foreground-tab",
    features: "",
    frameName: "",
    postBody,
    referrer: { policy: "default", url: "" },
    url
  };
}

async function loaded(count: number): Promise<void> {
  await vi.waitFor(() => expect(native.contents.loadURL).toHaveBeenCalledTimes(count));
}

function diagnosticLogger(records: ExtensionStoreNavigationDiagnostic[]) {
  return {
    extensionDiagnostic: vi.fn((
      _level: string,
      _event: string,
      _message: string,
      record: Readonly<Record<string, unknown>>
    ) => { records.push(record as unknown as ExtensionStoreNavigationDiagnostic); })
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.reset();
});

describe.each(["darwin", "win32"])("store locale (%s)", () => {
  it("initializes in the app language and only reloads when that language changes", async () => {
    const window = owner();
    const host = new ExtensionStoreHost(() => window, vi.fn());
    const bounds = { x: 0, y: 0, width: 600, height: 400 };
    host.request({ action: "show", bounds, language: "zh-TW" });
    await loaded(1);
    expect(native.contents.loadURL).toHaveBeenLastCalledWith(
      "https://chromewebstore.google.com/category/extensions?hl=zh-TW"
    );
    host.request({ action: "hide" });
    host.request({ action: "show", bounds, language: "zh-TW" });
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    native.setUrl(
      "https://chromewebstore.google.com/detail/fixture?source=app&hl=zh-TW"
    );
    host.request({ action: "show", bounds, language: "zh-CN" });
    await loaded(2);
    expect(native.contents.loadURL).toHaveBeenLastCalledWith(
      "https://chromewebstore.google.com/detail/fixture?source=app&hl=zh"
    );
    host.request({ action: "show", bounds, language: "zh-CN" });
    expect(native.contents.loadURL).toHaveBeenCalledTimes(2);
    host.dispose();
  });
});

describe("serialized Chrome Web Store navigation", () => {
  const bounds = { x: 0, y: 0, width: 600, height: 400 };

  it("cancels native detail navigation and selects its exact ID without loading it", async () => {
    const diagnostics: ExtensionStoreNavigationDiagnostic[] = [];
    const host = new ExtensionStoreHost(owner, vi.fn(), diagnosticLogger(diagnostics));
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const event = {
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: `https://chromewebstore.google.com/detail/fixture/${extensionId}`
    };
    native.emit("will-navigate", event, event.url, false, true, 0, 0);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(host.snapshot().extensionId).toBe(extensionId));
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    expect(host.snapshot().url).toBe(event.url);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      classification: "detail",
      phase: "completed",
      source: "document",
      webContentsId: 73
    }));
    expect(diagnostics.every((record) => !("url" in record))).toBe(true);
    host.dispose();
  });

  it("routes a preload-captured detail click without admitting page SPA navigation", async () => {
    const host = new ExtensionStoreHost(owner, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const url = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    native.navigate({ url });
    await vi.waitFor(() => expect(host.snapshot().extensionId).toBe(extensionId));
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);

    native.navigate({ url: "https://example.test/detail/fixture" });
    native.navigate({ url }, {});
    await Promise.resolve();
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(native.ipcMain.removeListener).toHaveBeenCalledOnce();
  });

  it("denies an exact detail popup and routes it through the same lane", async () => {
    const host = new ExtensionStoreHost(owner, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const url = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    expect(native.open(openDetails(url))).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(host.snapshot().extensionId).toBe(extensionId));
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("keeps selected detail back and forward state without loading the unsafe page", async () => {
    const window = owner();
    const host = new ExtensionStoreHost(() => window, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const url = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    native.navigate({ url });
    await vi.waitFor(() => expect(host.snapshot().extensionId).toBe(extensionId));

    expect(host.request({ action: "back" })).toMatchObject({
      extensionId: null,
      canGoForward: true
    });
    expect(host.request({ action: "forward" })).toMatchObject({
      extensionId,
      url
    });
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("serializes accepted page navigations without recursive loadURL calls", async () => {
    const host = new ExtensionStoreHost(owner, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    let release!: () => void;
    native.contents.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const search = "https://chromewebstore.google.com/search/adblock";
    const detail = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    native.emit("will-navigate", {
      isMainFrame: true, preventDefault: vi.fn(), url: search
    }, search, false, true, 0, 0);
    native.emit("will-navigate", {
      isMainFrame: true, preventDefault: vi.fn(), url: detail
    }, detail, false, true, 0, 0);
    await loaded(2);
    expect(native.contents.loadURL).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(host.snapshot().extensionId).toBe(extensionId));
    expect(native.contents.loadURL.mock.calls.map(([url]) => url)).toEqual([
      "https://chromewebstore.google.com/category/extensions?hl=en",
      search
    ]);
    host.dispose();
  });

  it.each([
    ["cross-origin", "https://example.test/detail/fixture"],
    ["malformed", "not a url"]
  ])("blocks a %s main-frame navigation without throwing", async (_kind, url) => {
    const host = new ExtensionStoreHost(owner, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const event = { isMainFrame: true, preventDefault: vi.fn(), url };
    expect(() => native.emit("will-navigate", event, url, false, true, 0, 0))
      .not.toThrow();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("rejects POST and non-detail popups", async () => {
    const host = new ExtensionStoreHost(owner, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const detail = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    expect(native.open(openDetails(detail, { data: [] }))).toEqual({ action: "deny" });
    expect(native.open(openDetails(
      "https://chromewebstore.google.com/category/extensions"
    ))).toEqual({ action: "deny" });
    expect(native.request({
      method: "POST",
      resourceType: "mainFrame",
      url: detail
    })).toHaveBeenCalledWith({ cancel: true });
    await Promise.resolve();
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("cancels queued work from a disposed view generation", async () => {
    const diagnostics: ExtensionStoreNavigationDiagnostic[] = [];
    const host = new ExtensionStoreHost(owner, vi.fn(), diagnosticLogger(diagnostics));
    host.request({ action: "show", bounds, language: "en" });
    host.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(native.contents.loadURL).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      phase: "cancelled",
      source: "initial"
    }));
  });
});
