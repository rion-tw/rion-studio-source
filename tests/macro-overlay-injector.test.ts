// @vitest-environment jsdom

import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

type OverlayRequest = { macroId?: string; pressId?: string; type: string };
type OverlayController = {
  dispose(): void;
  refresh(): Promise<void>;
};

const macro = {
  activationMode: "toggle",
  enabled: true,
  id: "macro-1",
  name: "Regression macro",
  steps: [],
  trigger: { alt: false, code: "F2", ctrl: false, meta: false, shift: false }
};

afterEach(() => {
  overlayController()?.dispose();
  delete (window as unknown as Record<string, unknown>).rionStudioMacroOverlay;
  delete (window as unknown as Record<string, unknown>).__rionTestOverlayBinding;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.body.replaceChildren();
  document.documentElement.lang = "";
  vi.restoreAllMocks();
});

describe("Tauri macro overlay injector", () => {
  it("assembles executable native bridge, raw runtime, shortcut guard, and presentation styles", async () => {
    const sources = await overlaySources();
    const assembled = assembleRuntime(sources);

    expect(() => new Function(sources.bridge)).not.toThrow();
    expect(() => new Function(assembled)).not.toThrow();
    expect(assembled).not.toContain("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__");
    expect(assembled).not.toContain("__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__");
    expect(assembled).not.toContain("__RION_STUDIO_MACRO_OVERLAY_BINDING__");
    expect(assembled).not.toContain("__RION_STUDIO_MACRO_OVERLAY_CAPABILITY__");
    expect(assembled).not.toContain("__RION_STUDIO_MACRO_OVERLAY_CSS__");
    expect(assembled).toContain("event.isTrusted === true");
    expect(assembled).not.toContain("setInterval");
  });

  it("keeps game overlay flashes on compositor-friendly properties", async () => {
    const { css } = await overlaySources();

    expect(css).toMatch(/\.click-marker\.is-click-flash\{[^}]*will-change:transform,opacity,filter;/);
    expect(css).toMatch(/\.click-connector-svg\{[^}]*pointer-events:none;/);
    expect(css).toMatch(/\.click-connector\{[^}]*stroke-dasharray:5 5;/);
    expect(css).toMatch(/\.active-badge::after\{[^}]*opacity:0/);
    expect(css).toMatch(/\.active-badge\.is-iteration-flash::after\{[^}]*transform:translateZ\(0\);will-change:opacity;/);
    expect(css).toContain("var(--active-badge-flash-duration,120ms) ease-out var(--active-badge-flash-delay,0ms) 1 both");
    expect(css).toContain("@media (prefers-reduced-motion:reduce){.active-badge.is-iteration-flash::after{animation:none;will-change:auto;}}");
  });

  it("keeps shortcut chips padded and shortcutless badges balanced", async () => {
    const { css } = await overlaySources();

    expect(css).toMatch(/\.active-badge\{[^}]*padding:var\(--space-1\) var\(--space-2\) var\(--space-1\) var\(--space-1\);/);
    expect(css).toMatch(/\.active-badge\.is-shortcutless\{padding-left:var\(--space-2\);\}/);
    expect(css).toMatch(/\.active-badge-shortcut\{[^}]*border-radius:var\(--radius-pill\);/);
    expect(css).toMatch(/\.active-badge-shortcut\{[^}]*min-height:var\(--space-4\);min-width:var\(--space-4\);padding:0 var\(--space-1\);/);
  });

  it("provides light and dark liquid-glass badge materials with an opaque accessibility fallback", async () => {
    const { css } = await overlaySources();

    expect(css).toContain(':host([data-theme="light"])');
    expect(css).toContain(':host([data-theme="dark"])');
    expect(css).toMatch(/\.active-badge\{[^}]*backdrop-filter:blur\(var\(--blur-popover\)\) saturate\(1\.65\);/);
    expect(css).toMatch(/\.active-badge\{[^}]*radial-gradient\([^}]*var\(--macro-badge-surface\)/);
    expect(css).toMatch(/\.active-badge\{[^}]*box-shadow:inset 0 1px 0 var\(--macro-badge-highlight\)[^}]*var\(--macro-badge-depth-shadow\)/);
    expect(css).toMatch(/:host\(\[data-theme="light"\]\)\{[^}]*--macro-badge-highlight:hsl\(var\(--media-white\)\/\.18\)/);
    expect(css).toMatch(/:host\(\[data-theme="light"\]\)\{[^}]*--macro-badge-depth-shadow:0 2px 8px var\(--macro-badge-shadow\)/);
    expect(css).toMatch(/:host\(\[data-theme="dark"\]\)\{[^}]*--macro-badge-highlight:hsl\(var\(--media-white\)\/\.1\)/);
    expect(css).toMatch(/:host\(\[data-theme="dark"\]\)\{[^}]*--macro-badge-depth-shadow:0 2px 8px var\(--macro-badge-shadow\)/);
    expect(css).toContain(".active-badge{background:var(--macro-badge-solid);}");
    expect(css).toContain(".active-badge-shortcut{background:var(--macro-badge-shortcut-solid);}");
  });

  it("installs once per System WebView document and reinstalls after navigation", async () => {
    const sources = await overlaySources();
    const invoke = vi.fn(async (_command: string, _argumentsRecord: unknown) => ({}));
    installTauriInternals(invoke);

    (0, eval)(assembleRuntime(sources));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const first = overlayController();
    expect(first).toBeDefined();

    (0, eval)(assembleRuntime(sources));
    expect(overlayController()).toBe(first);

    first?.dispose();
    (0, eval)(assembleRuntime(sources));
    expect(overlayController()).toBeDefined();
    expect(overlayController()).not.toBe(first);

    expect((window as unknown as Record<string, unknown>).rionStudioMacroOverlay).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__rionStudioNativeOverlayBridge)
      .toBeUndefined();
  });

  it("forwards a raw embedded request to the typed Tauri overlay command", async () => {
    const { bridge } = await overlaySources();
    const invoke = vi.fn(async () => ({ language: "zh-TW", macros: [], statuses: [] }));
    installTauriInternals(invoke);
    const binding = nativeBinding(bridge, "test-capability");
    await expect(binding({ macroId: "macro-1", type: "toggle" })).resolves.toEqual(
      expect.objectContaining({ language: "zh-TW" })
    );
    expect(invoke).toHaveBeenCalledWith("rion_overlay_request", {
      capability: "test-capability",
      payload: { macroId: "macro-1", type: "toggle" }
    });
  });

  it("fails closed when a page is detached from Tauri IPC", async () => {
    const { bridge } = await overlaySources();
    const binding = nativeBinding(bridge, "test-capability");
    await expect(binding({ type: "list" })).rejects.toThrow(
      "Rion Studio overlay IPC is unavailable"
    );
  });

  it("keeps authenticated role selection outside the page-owned request envelope", async () => {
    const { bridge } = await overlaySources();
    const invoke = vi.fn(async (_command: string, _argumentsRecord: unknown) => ({}));
    installTauriInternals(invoke);
    const binding = nativeBinding(bridge, "test-capability");
    await binding({ type: "list" });

    const [, argumentsRecord] = invoke.mock.calls[0] ?? [];
    expect(argumentsRecord).toEqual({
      capability: "test-capability",
      payload: { type: "list" }
    });
    expect(argumentsRecord).not.toHaveProperty("roleId");
  });

  it("rejects synthetic page events before they can invoke privileged overlay actions", async () => {
    const binding = vi.fn(async () => ({ macros: [macro], statuses: [] }));
    await installOverlay(binding, false);
    binding.mockClear();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));
    overlayRoot()?.querySelector<HTMLElement>(".trigger")?.click();
    await Promise.resolve();

    expect(binding).not.toHaveBeenCalled();
  });

  it("refreshes an installed page through events without a polling interval", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const binding = vi.fn(async () => ({ macros: [], statuses: [] }));
    const controller = await installOverlay(binding);
    binding.mockClear();

    await controller.refresh();

    expect(binding).toHaveBeenCalledOnce();
    expect(binding).toHaveBeenCalledWith({ type: "list" });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("coalesces dense embedded refreshes into one trailing refresh", async () => {
    const first = deferred<unknown>();
    const binding = vi.fn()
      .mockResolvedValueOnce({ macros: [], statuses: [] })
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ macros: [], statuses: [] });
    const controller = await installOverlay(binding);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledTimes(1));

    const pending = controller.refresh();
    void controller.refresh();
    void controller.refresh();
    expect(binding).toHaveBeenCalledTimes(2);
    first.resolve({ macros: [], statuses: [] });
    await pending;
    await vi.waitFor(() => expect(binding).toHaveBeenCalledTimes(3));
  });

  it("releases held input when a System WebView navigates or closes", async () => {
    const heldMacro = { ...macro, activationMode: "while_held" };
    const requests: OverlayRequest[] = [];
    const binding = vi.fn(async (request: OverlayRequest) => {
      requests.push(request);
      return { macros: [heldMacro], statuses: [] };
    });
    await installOverlay(binding);

    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));
    await vi.waitFor(() => expect(requests.some((request) => request.type === "press")).toBe(true));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(requests.some((request) =>
      request.type === "release" &&
      (request as OverlayRequest & { releaseMode?: string }).releaseMode === "immediate"
    )).toBe(true));
  });

  it("forwards overlay language from Rust presentation refreshes", async () => {
    document.documentElement.lang = "en";
    const binding = vi.fn(async () => ({ language: "ja", macros: [], statuses: [] }));
    const controller = await installOverlay(binding);

    await controller.refresh();

    expect(overlayRoot()?.querySelector(".trigger")?.getAttribute("title"))
      .toBe("Rion Studio マクロを開く (Ctrl+Shift+M)");
  });

  it("disposes page-owned state and rejects late refresh work", async () => {
    const binding = vi.fn(async () => ({ macros: [], statuses: [] }));
    const controller = await installOverlay(binding);
    const requestCount = binding.mock.calls.length;

    controller.dispose();
    await controller.refresh();

    expect(document.querySelector("#rion-studio-macro-overlay-v59")).toBeNull();
    expect(binding).toHaveBeenCalledTimes(requestCount);
  });

  it("ignores editable and IME events but permits game-surface shortcuts", async () => {
    const { guard } = await overlaySources();
    const shouldIgnore = new Function(`return ${guard}`)() as (
      event: Record<string, unknown>,
      active?: unknown,
      designMode?: string
    ) => boolean;
    const input = document.createElement("input");
    const canvas = document.createElement("canvas");
    const event = {
      composedPath: () => [input],
      defaultPrevented: false,
      isComposing: false,
      key: "a",
      keyCode: 65,
      target: input
    };

    expect(shouldIgnore(event, input)).toBe(true);
    expect(shouldIgnore({ ...event, composedPath: () => [canvas], isComposing: true }, canvas))
      .toBe(true);
    expect(shouldIgnore({ ...event, composedPath: () => [canvas], target: canvas }, canvas))
      .toBe(false);
  });
});

async function overlaySources() {
  const [bridge, runtime, guard, css] = await Promise.all([
    readFile("src/shared/browser-overlay/macroOverlayNativeBridge.js", "utf8"),
    readFile("src/shared/browser-overlay/macroOverlayRuntime.js", "utf8"),
    readFile("src/shared/browser-overlay/macroOverlayShortcutGuard.js", "utf8"),
    readFile("src/shared/browser-overlay/macroOverlay.css", "utf8")
  ]);
  return { bridge, css, guard, runtime };
}

function assembleRuntime(
  sources: Awaited<ReturnType<typeof overlaySources>>,
  options: { bindingSource?: string; trustSyntheticEvents?: boolean } = {}
) {
  const bindingSource = options.bindingSource ?? nativeBindingSource(sources.bridge, "test-capability");
  const trustedEventGuard = options.trustSyntheticEvents === true
    ? "() => true"
    : "(event) => event.isTrusted === true";
  return sources.runtime
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__"), sources.guard.trim())
    .replace(
      JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__"),
      trustedEventGuard
    )
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_BINDING__"), bindingSource)
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_CSS__"), JSON.stringify(sources.css));
}

async function installOverlay(
  binding: (request: OverlayRequest) => Promise<unknown>,
  trustSyntheticEvents = true
): Promise<OverlayController> {
  const sources = await overlaySources();
  Object.defineProperty(window, "__rionTestOverlayBinding", {
    configurable: true,
    value: binding
  });
  (0, eval)(assembleRuntime(sources, {
    bindingSource: "globalThis.__rionTestOverlayBinding",
    trustSyntheticEvents
  }));
  await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "list" }));
  const controller = overlayController();
  if (!controller) throw new Error("Expected an installed macro overlay controller.");
  return controller;
}

function nativeBinding(
  bridge: string,
  capability: string
): (request: OverlayRequest) => Promise<unknown> {
  return new Function(`return ${nativeBindingSource(bridge, capability)}`)() as (
    request: OverlayRequest
  ) => Promise<unknown>;
}

function nativeBindingSource(bridge: string, capability: string) {
  return bridge.replace(
    JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_CAPABILITY__"),
    JSON.stringify(capability)
  ).trim();
}

function installTauriInternals(invoke: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke }
  });
}

function overlayController(): OverlayController | undefined {
  return (window as unknown as { __rionStudioMacroOverlay?: OverlayController })
    .__rionStudioMacroOverlay;
}

function overlayRoot(): ShadowRoot | undefined {
  return document.querySelector<HTMLElement>("#rion-studio-macro-overlay-v59")
    ?.shadowRoot ?? undefined;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
