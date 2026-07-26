// @vitest-environment jsdom

import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

type OverlayRequest = { type: string; macroId?: string; [key: string]: unknown };

afterEach(() => {
  (window as unknown as { __rionStudioMacroOverlay?: { dispose(): void } })
    .__rionStudioMacroOverlay?.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shell-neutral macro overlay runtime", () => {
  it("preserves coordinate, shortcut, held-release, canvas, editable, and dense queue behavior", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const macros = [{
      activationMode: "toggle",
      enabled: true,
      id: "toggle",
      name: "Toggle",
      steps: [],
      trigger: { alt: false, code: "KeyA", ctrl: false, meta: false, shift: false }
    }, {
      activationMode: "while_held",
      enabled: true,
      id: "held",
      name: "Held",
      steps: [],
      trigger: { alt: false, code: "KeyH", ctrl: false, meta: false, shift: false }
    }];
    const requests: OverlayRequest[] = [];
    let activeActions = 0;
    let maximumActiveActions = 0;
    const binding = vi.fn(async (request: OverlayRequest) => {
      requests.push(request);
      if (["toggle", "press", "release"].includes(request.type)) {
        activeActions += 1;
        maximumActiveActions = Math.max(maximumActiveActions, activeActions);
        await Promise.resolve();
        activeActions -= 1;
      }
      return {
        language: "zh-TW",
        macroBadgePosition: { horizontalAlign: "center", horizontalMarginPx: 8, topPx: 128 },
        macros,
        statuses: []
      };
    });
    (window as unknown as Record<string, unknown>).rionStudioMacroOverlay = binding;

    const [runtimeSource, guardSource] = await Promise.all([
      readFile("src/shared/browser-overlay/macroOverlayRuntime.js", "utf8"),
      readFile("src/shared/browser-overlay/macroOverlayShortcutGuard.js", "utf8")
    ]);
    const source = runtimeSource
      .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__"), guardSource.trim())
      .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_CSS__"), JSON.stringify(""));
    (0, eval)(source);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "list" }));

    const host = document.querySelector<HTMLElement>("#rion-studio-macro-overlay-v56");
    const root = host?.shadowRoot;
    expect(root).toBeTruthy();

    root?.querySelector<HTMLElement>(".trigger")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    root?.querySelector<HTMLElement>(".action-menu-item")?.click();
    const picker = root?.querySelector<HTMLElement>(".coordinate-picker");
    expect(picker?.hidden).toBe(false);
    picker?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 150
    }));
    await vi.waitFor(() => expect(requests.some((request) =>
      request.type === "copy-coordinate" && request.xPx === 200 && request.yPx === 150 &&
      request.xPercent === 25 && request.yPercent === 25
    )).toBe(true));

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyA",
      key: "a"
    }));
    expect(requests.filter((request) => request.type === "toggle")).toHaveLength(0);

    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    const arrow = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "ArrowLeft",
      key: "ArrowLeft"
    });
    canvas.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyH",
      key: "h"
    }));
    window.dispatchEvent(new Event("blur"));
    await vi.waitFor(() => expect(requests.some((request) =>
      request.type === "release" && request.macroId === "held" &&
      request.releaseMode === "immediate"
    )).toBe(true));

    canvas.blur();
    for (let index = 0; index < 20; index += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyA",
        key: "a"
      }));
    }
    await vi.waitFor(() => expect(
      requests.filter((request) => request.type === "toggle" && request.macroId === "toggle")
    ).toHaveLength(20));
    expect(maximumActiveActions).toBe(1);

    const runtimeShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      ctrlKey: true,
      key: "Tab"
    });
    window.dispatchEvent(runtimeShortcut);
    expect(runtimeShortcut.defaultPrevented).toBe(false);
  });
});
