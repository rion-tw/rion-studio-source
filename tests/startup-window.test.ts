import { describe, expect, it, vi } from "vitest";

import {
  buildStartupPage,
  createStartupPageUrl,
  loadRendererPage,
  loadWindowAndReveal,
  runStartupSequence,
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
    expect(html).toContain("Loading role workspace");
    expect(html).toContain("startup-spinner");
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

describe("runStartupSequence", () => {
  it("loads the renderer only after initialization completes", async () => {
    const order: string[] = [];
    const onError = vi.fn();

    const result = await runStartupSequence({
      showStartup: async () => {
        order.push("startup");
        return true;
      },
      initialize: async () => {
        order.push("initialize");
      },
      isWindowAvailable: () => true,
      loadRenderer: async ({ revealWhenReady }) => {
        order.push(`renderer:${String(revealWhenReady)}`);
      },
      showFailure: vi.fn(),
      onError
    });

    expect(result).toBe("ready");
    expect(order).toEqual(["startup", "initialize", "renderer:false"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reveals the renderer when the startup page could not be shown", async () => {
    const phases: string[] = [];

    const result = await runStartupSequence({
      showStartup: async () => {
        throw new Error("startup load failed");
      },
      initialize: () => undefined,
      isWindowAvailable: () => true,
      loadRenderer: async ({ revealWhenReady }) => {
        expect(revealWhenReady).toBe(true);
      },
      showFailure: vi.fn(),
      onError: (phase) => phases.push(phase)
    });

    expect(result).toBe("ready");
    expect(phases).toEqual(["startup"]);
  });

  it("shows the failure page when initialization fails", async () => {
    const showFailure = vi.fn(async () => undefined);
    const onError = vi.fn();

    const result = await runStartupSequence({
      showStartup: async () => true,
      initialize: () => {
        throw new Error("initialization failed");
      },
      isWindowAvailable: () => true,
      loadRenderer: vi.fn(),
      showFailure,
      onError
    });

    expect(result).toBe("failed");
    expect(onError).toHaveBeenCalledWith("initialize", expect.any(Error));
    expect(showFailure).toHaveBeenCalledOnce();
  });

  it("finishes initialization without loading the renderer after the window closes", async () => {
    const initialize = vi.fn();
    const loadRenderer = vi.fn();

    const result = await runStartupSequence({
      showStartup: async () => false,
      initialize,
      isWindowAvailable: () => false,
      loadRenderer,
      showFailure: vi.fn(),
      onError: vi.fn()
    });

    expect(result).toBe("closed");
    expect(initialize).toHaveBeenCalledOnce();
    expect(loadRenderer).not.toHaveBeenCalled();
  });
});
