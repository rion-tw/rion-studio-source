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
  let url = "";
  let history: string[] = [];
  let index = 0;
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
      canGoBack: vi.fn(() => index > 0),
      canGoForward: vi.fn(() => index < history.length - 1),
      getActiveIndex: () => index,
      getEntryAtIndex: (at: number) => history[at] ? { url: history[at] } : null,
      goBack: vi.fn(),
      goForward: vi.fn()
    },
    on: vi.fn((name: string, listener: (...args: never[]) => void) => {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
    }),
    removeListener: (name: string, listener: (...args: never[]) => void) => {
      listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== listener));
    },
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
      history = [];
      index = 0;
      windowOpenHandler = null;
      listeners.clear();
    },
    setUrl(next: string) { url = next; },
    setHistory(entries: string[], active: number) { history = entries; index = active; url = entries[active]; },
    move(active: number) { index = active; url = history[active]; },
    session: {
      webRequest: {
        onBeforeRequest: vi.fn((
          _filter: unknown,
          handler: typeof requestHandler
        ) => { requestHandler = handler; })
      }
    },
    visible: vi.fn()
  };
});

vi.mock("electron", () => ({
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
    once: vi.fn(),
    removeListener: vi.fn()
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

  it("queues native detail navigation after the native callback unwinds", async () => {
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
    expect(native.contents.loadURL).toHaveBeenCalledTimes(2);
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

  it("follows same-document navigation from search autocomplete", async () => {
    const publish = vi.fn();
    const host = new ExtensionStoreHost(owner, publish);
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const url = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    native.setUrl(url);
    native.emit("did-navigate-in-page");
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ url, extensionId }));
    expect(native.contents.loadURL).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("denies an exact detail popup and loads it through the same lane", async () => {
    const window = owner();
    const host = new ExtensionStoreHost(() => window, vi.fn());
    host.request({ action: "show", bounds, language: "en" });
    await loaded(1);
    const url = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    expect(native.open(openDetails(url))).toEqual({ action: "deny" });
    await loaded(2);
    expect(host.snapshot()).toMatchObject({ url, extensionId });
    native.setHistory(["https://chromewebstore.google.com/category/extensions", url], 1);
    expect(host.snapshot()).toMatchObject({ canGoBack: true, canGoForward: false });
    host.dispose();
  });

  it("keeps rapid Back, Forward and Reload ordered and loading until each document completes", async () => {
    const window = owner();
    const host = new ExtensionStoreHost(() => window, vi.fn());
    host.request({ action: "show", bounds });
    await loaded(1);
    const entries = ["https://chromewebstore.google.com/search?q=one", `https://chromewebstore.google.com/detail/fixture/${extensionId}`];
    native.setHistory(entries, 1);
    const complete = () => {
      const url = native.contents.getURL();
      native.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
      native.emit("did-navigate", {}, url);
      native.emit("did-finish-load");
    };
    host.request({ action: "back" });
    host.request({ action: "forward" });
    host.request({ action: "reload" });
    await vi.waitFor(() => expect(native.contents.navigationHistory.goBack).toHaveBeenCalledOnce());
    expect(native.contents.navigationHistory.goForward).not.toHaveBeenCalled();
    native.move(0);
    native.emit("did-navigate-in-page", {}, entries[0], true);
    expect(host.snapshot().loading).toBe(true);
    await vi.waitFor(() => expect(native.contents.reload).toHaveBeenCalledTimes(1));
    complete();
    await vi.waitFor(() => expect(native.contents.navigationHistory.goForward).toHaveBeenCalledOnce());
    native.move(1);
    complete(); // Full-document Forward requires no repair reload.
    await vi.waitFor(() => expect(native.contents.reload).toHaveBeenCalledTimes(2));
    expect(host.snapshot().loading).toBe(true);
    complete();
    await vi.waitFor(() => expect(host.snapshot().loading).toBe(false));
    host.dispose();
  });

  it("cancels active and queued history work when a page navigation supersedes it", async () => {
    const window = owner();
    const diagnostics: ExtensionStoreNavigationDiagnostic[] = [];
    const host = new ExtensionStoreHost(() => window, vi.fn(), diagnosticLogger(diagnostics));
    host.request({ action: "show", bounds });
    await loaded(1);
    native.setHistory(["https://chromewebstore.google.com/search?q=one", "https://chromewebstore.google.com/category/extensions"], 1);
    host.request({ action: "back" });
    host.request({ action: "forward" });
    await vi.waitFor(() => expect(native.contents.navigationHistory.goBack).toHaveBeenCalledOnce());
    native.move(0);
    native.emit("did-navigate-in-page", {}, native.contents.getURL(), true);
    const url = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;
    native.emit("will-navigate", { isMainFrame: true, preventDefault: vi.fn(), url });
    await loaded(2);
    expect(native.contents.reload).not.toHaveBeenCalled();
    expect(native.contents.navigationHistory.goForward).not.toHaveBeenCalled();
    expect(diagnostics.filter(record => record.phase === "cancelled").map(record => record.source)).toEqual(["back", "forward"]);
    expect(host.snapshot()).toMatchObject({ loading: false, failed: false, url });
    host.dispose();
  });

  it.each(["dispose", "destroyed"])("retires active history work on %s without stale completion", async retirement => {
    const window = owner();
    const publish = vi.fn();
    const host = new ExtensionStoreHost(() => window, publish);
    host.request({ action: "show", bounds });
    await loaded(1);
    native.setHistory(["https://chromewebstore.google.com/search?q=one", "https://chromewebstore.google.com/category/extensions"], 1);
    host.request({ action: "back" });
    await vi.waitFor(() => expect(native.contents.navigationHistory.goBack).toHaveBeenCalledOnce());
    native.move(0);
    native.emit("did-navigate-in-page", {}, native.contents.getURL(), true);
    if (retirement === "dispose") host.dispose();
    else {
      native.contents.close();
      native.emit("destroyed");
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false }));
    }
    publish.mockClear();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(native.contents.reload).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(host.snapshot().loading).toBe(false);
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
      search,
      detail
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

  it("ignores lifecycle callbacks after its exact view retires", async () => {
    const publish = vi.fn();
    const host = new ExtensionStoreHost(owner, publish);
    host.request({ action: "show", bounds });
    await loaded(1);
    host.dispose();
    publish.mockClear();
    native.emit("render-process-gone");
    native.emit("did-fail-load", {}, -2, "failed", "", true);
    native.emit("dom-ready");
    expect(host.snapshot().failed).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(native.contents.insertCSS).not.toHaveBeenCalled();
  });

  it("cancels queued work from a disposed view generation", async () => {
    const diagnostics: ExtensionStoreNavigationDiagnostic[] = [];
    const host = new ExtensionStoreHost(owner, vi.fn(), diagnosticLogger(diagnostics));
    host.request({ action: "show", bounds, language: "en" });
    host.dispose();
    await vi.waitFor(() => expect(diagnostics).toContainEqual(expect.objectContaining({
      phase: "cancelled",
      source: "initial"
    })));
    expect(native.contents.loadURL).not.toHaveBeenCalled();
  });
});
