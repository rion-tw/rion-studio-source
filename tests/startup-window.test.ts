import { describe, expect, it, vi } from "vitest";

import {
  buildStartupPage,
  createStartupPageUrl,
  loadRendererPage,
  loadWindowAndReveal,
  RendererReadyCancelledError,
  RendererReadyGate,
  RendererReadyTimeoutError,
  swapPreparedWindows,
  waitForPreparedRenderer,
  type RevealableWindow
} from "../src/main/startup/startupWindow";

class FakeWindow implements RevealableWindow {
  destroyed = false;
  readonly focus = vi.fn();
  readonly loadURL = vi.fn(async (_url: string) => undefined);
  readonly show = vi.fn();
  private readonly listeners = new Map<"closed" | "ready-to-show", Set<() => void>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: "closed" | "ready-to-show", listener: () => void): this {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: "closed" | "ready-to-show", listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: "closed" | "ready-to-show"): void {
    const listeners = [...(this.listeners.get(event) ?? [])];
    this.listeners.delete(event);
    listeners.forEach((listener) => listener());
  }
}

describe("startup page", () => {
  it("renders the selected theme and loading state", () => {
    const html = buildStartupPage({ theme: "dark" });

    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('aria-label="Loading Rion Studio"');
    expect(html).toContain("startup-spinner");
    expect(html).not.toContain('<section class="startup-card">');
    expect(html).toContain('aria-busy="true"');
  });

  it("renders a non-animated failure state", () => {
    const html = buildStartupPage({ state: "failed", theme: "light" });

    expect(html).toContain("Unable to start Rion Studio");
    expect(html).toContain("startup-error-mark");
    expect(html).not.toContain('<div class="startup-spinner"');
    expect(html).toContain('role="alert"');
  });

  it("escapes an icon URL before placing it in markup", () => {
    const unsafeIcon = 'data:image/png;base64,abc"><script>alert(1)</script>';
    const html = buildStartupPage({ iconDataUrl: unsafeIcon, theme: "light" });

    expect(html).toContain("abc&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("creates a self-contained encoded data URL", () => {
    const url = createStartupPageUrl({ theme: "light" });
    const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

    expect(url).toMatch(/^data:text\/html;charset=UTF-8,/);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Rion Studio");
  });
});

describe("loadWindowAndReveal", () => {
  it("keeps the window hidden until its first frame is ready", async () => {
    const window = new FakeWindow();
    const resultPromise = loadWindowAndReveal(window, () => window.loadURL("data:text/html,startup"));

    await Promise.resolve();
    expect(window.loadURL).toHaveBeenCalledWith("data:text/html,startup");
    expect(window.show).not.toHaveBeenCalled();

    window.emit("ready-to-show");

    await expect(resultPromise).resolves.toBe(true);
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("does not load or show a window that is already destroyed", async () => {
    const window = new FakeWindow();
    window.destroyed = true;

    await expect(loadWindowAndReveal(window, () => window.loadURL("data:text/html,startup"))).resolves.toBe(false);
    expect(window.loadURL).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
  });
});

describe("waitForPreparedRenderer", () => {
  it("waits for both the native first frame and the renderer readiness signal", async () => {
    const window = new FakeWindow();
    let resolveRenderer: (state: "ready") => void = () => undefined;
    const rendererReady = new Promise<"ready">((resolve) => {
      resolveRenderer = resolve;
    });
    let settled = false;
    const preparation = waitForPreparedRenderer(
      window,
      () => window.loadURL("http://renderer.test"),
      rendererReady
    ).then((state) => {
      settled = true;
      return state;
    });

    window.emit("ready-to-show");
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRenderer("ready");
    await expect(preparation).resolves.toBe("ready");
  });
});

describe("loadRendererPage", () => {
  it("loads the development renderer URL when provided", async () => {
    const window = {
      loadFile: vi.fn(async (_path: string) => undefined),
      loadURL: vi.fn(async (_url: string) => undefined)
    };

    await loadRendererPage(window, "http://127.0.0.1:5173", "/app/renderer/index.html");

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
    expect(window.loadFile).not.toHaveBeenCalled();
  });

  it("loads the packaged renderer HTML when no development URL exists", async () => {
    const window = {
      loadFile: vi.fn(async (_path: string) => undefined),
      loadURL: vi.fn(async (_url: string) => undefined)
    };

    await loadRendererPage(window, undefined, "/app/renderer/index.html");

    expect(window.loadFile).toHaveBeenCalledWith("/app/renderer/index.html");
    expect(window.loadURL).not.toHaveBeenCalled();
  });
});

describe("RendererReadyGate", () => {
  it("resolves only the matching renderer readiness signal", async () => {
    const gate = new RendererReadyGate();
    const readiness = gate.wait(42, 1_000);

    expect(gate.notify(7, "ready")).toBe(false);
    expect(gate.notify(42, "failed")).toBe(true);
    await expect(readiness).resolves.toBe("failed");
  });

  it("times out when the renderer never reports readiness", async () => {
    vi.useFakeTimers();
    const gate = new RendererReadyGate();
    const assertion = expect(gate.wait(42, 1_000)).rejects.toBeInstanceOf(RendererReadyTimeoutError);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    vi.useRealTimers();
  });

  it("rejects a readiness wait when its renderer is cancelled", async () => {
    const gate = new RendererReadyGate();
    const readiness = gate.wait(42, 1_000);

    expect(gate.cancel(42)).toBe(true);
    await expect(readiness).rejects.toBeInstanceOf(RendererReadyCancelledError);
  });
});

describe("swapPreparedWindows", () => {
  it("shows the prepared renderer before closing the startup window", () => {
    const order: string[] = [];
    const bounds = { height: 900, width: 1440, x: 20, y: 30 };
    const startup = {
      close: vi.fn(() => order.push("startup:close")),
      focus: vi.fn(),
      getBounds: vi.fn(() => bounds),
      isDestroyed: vi.fn(() => false),
      setBounds: vi.fn(),
      show: vi.fn()
    };
    const renderer = {
      close: vi.fn(),
      focus: vi.fn(() => order.push("renderer:focus")),
      getBounds: vi.fn(() => bounds),
      isDestroyed: vi.fn(() => false),
      setBounds: vi.fn((_bounds, _animate) => order.push("renderer:bounds")),
      show: vi.fn(() => order.push("renderer:show"))
    };

    expect(swapPreparedWindows(startup, renderer)).toBe(true);
    expect(renderer.setBounds).toHaveBeenCalledWith(bounds, false);
    expect(order).toEqual(["renderer:bounds", "renderer:show", "renderer:focus", "startup:close"]);
  });

  it("does not swap when either window was destroyed", () => {
    const window = {
      close: vi.fn(),
      focus: vi.fn(),
      getBounds: vi.fn(() => ({ height: 900, width: 1440, x: 0, y: 0 })),
      isDestroyed: vi.fn(() => true),
      setBounds: vi.fn(),
      show: vi.fn()
    };

    expect(swapPreparedWindows(window, window)).toBe(false);
    expect(window.show).not.toHaveBeenCalled();
  });
});
