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
  delete (window as unknown as Record<string, unknown>).__rionStudioNativeOverlayBridge;
  delete (window as unknown as Record<string, unknown>).rionStudioMacroOverlay;
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
    expect(assembled).not.toContain("__RION_STUDIO_MACRO_OVERLAY_CSS__");
    expect(assembled).not.toContain("setInterval");
  });

  it("installs once per System WebView document and reinstalls after navigation", async () => {
    const { bridge } = await overlaySources();
    const invoke = vi.fn(async (_command: string, _argumentsRecord: unknown) => ({}));
    installTauriInternals(invoke);

    (0, eval)(bridge);
    const first = (window as unknown as Record<string, unknown>).rionStudioMacroOverlay;
    (0, eval)(bridge);
    expect((window as unknown as Record<string, unknown>).rionStudioMacroOverlay).toBe(first);

    delete (window as unknown as Record<string, unknown>).__rionStudioNativeOverlayBridge;
    delete (window as unknown as Record<string, unknown>).rionStudioMacroOverlay;
    (0, eval)(bridge);
    expect((window as unknown as Record<string, unknown>).rionStudioMacroOverlay).not.toBe(first);
  });

  it("forwards a raw embedded request to the typed Tauri overlay command", async () => {
    const { bridge } = await overlaySources();
    const invoke = vi.fn(async () => ({ language: "zh-TW", macros: [], statuses: [] }));
    installTauriInternals(invoke);
    (0, eval)(bridge);

    const binding = (window as unknown as {
      rionStudioMacroOverlay(request: OverlayRequest): Promise<unknown>;
    }).rionStudioMacroOverlay;
    await expect(binding({ macroId: "macro-1", type: "toggle" })).resolves.toEqual(
      expect.objectContaining({ language: "zh-TW" })
    );
    expect(invoke).toHaveBeenCalledWith("rion_overlay_request", {
      payload: { macroId: "macro-1", type: "toggle" }
    });
  });

  it("fails closed when a page is detached from Tauri IPC", async () => {
    const { bridge } = await overlaySources();
    (0, eval)(bridge);

    const binding = (window as unknown as {
      rionStudioMacroOverlay(request: OverlayRequest): Promise<unknown>;
    }).rionStudioMacroOverlay;
    await expect(binding({ type: "list" })).rejects.toThrow(
      "Rion Studio overlay IPC is unavailable"
    );
  });

  it("keeps authenticated role selection outside the page-owned request envelope", async () => {
    const { bridge } = await overlaySources();
    const invoke = vi.fn(async (_command: string, _argumentsRecord: unknown) => ({}));
    installTauriInternals(invoke);
    (0, eval)(bridge);

    const binding = (window as unknown as {
      rionStudioMacroOverlay(request: OverlayRequest): Promise<unknown>;
    }).rionStudioMacroOverlay;
    await binding({ type: "list" });

    const [, argumentsRecord] = invoke.mock.calls[0] ?? [];
    expect(argumentsRecord).toEqual({ payload: { type: "list" } });
    expect(argumentsRecord).not.toHaveProperty("roleId");
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

    expect(document.querySelector("#rion-studio-macro-overlay-v56")).toBeNull();
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

function assembleRuntime(sources: Awaited<ReturnType<typeof overlaySources>>) {
  return sources.runtime
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__"), sources.guard.trim())
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_CSS__"), JSON.stringify(sources.css));
}

async function installOverlay(
  binding: (request: OverlayRequest) => Promise<unknown>
): Promise<OverlayController> {
  const sources = await overlaySources();
  Object.defineProperty(window, "rionStudioMacroOverlay", {
    configurable: true,
    value: binding
  });
  (0, eval)(assembleRuntime(sources));
  await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "list" }));
  const controller = overlayController();
  if (!controller) throw new Error("Expected an installed macro overlay controller.");
  return controller;
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
  return document.querySelector<HTMLElement>("#rion-studio-macro-overlay-v56")
    ?.shadowRoot ?? undefined;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
