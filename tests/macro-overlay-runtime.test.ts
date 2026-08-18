// @vitest-environment jsdom

import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { afterEach, describe, expect, it, vi } from "vitest";

type OverlayRequest = { type: string; macroId?: string; [key: string]: unknown };
type OverlayController = { dispose(): void; refresh(): Promise<void> };
type OverlayStatus = {
  iteration: number;
  lastClick?: { sequence: number; stepId: string };
  macroId: string;
  roleId: string;
  startedAt: string;
  state: string;
  updatedAt: string;
};

async function overlayRuntimeSource() {
  const [runtimeSource, guardSource, coordinateMeasurementModuleSource] = await Promise.all([
    readFile("src/shared/browser-overlay/macroOverlayRuntime.js", "utf8"),
    readFile("src/shared/browser-overlay/macroOverlayShortcutGuard.js", "utf8"),
    readFile("src/shared/browser-overlay/macroCoordinateMeasurement.js", "utf8")
  ]);
  return runtimeSource
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__"), guardSource.trim())
    .replace(
      JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__"),
      "() => true"
    )
    .replace(
      JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_BINDING__"),
      "window.rionStudioMacroOverlay"
    )
    .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_CSS__"), JSON.stringify(""))
    .replace(
      JSON.stringify("__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE__"),
      JSON.stringify(coordinateMeasurementModuleSource)
    )
    .replace(
      JSON.stringify("__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER__"),
      "window.__rionTestCoordinateMeasurementModuleImporter"
    );
}

function overlayController() {
  return (window as unknown as { __rionStudioMacroOverlay: OverlayController })
    .__rionStudioMacroOverlay;
}

afterEach(() => {
  (window as unknown as { __rionStudioMacroOverlay?: { dispose(): void } })
    .__rionStudioMacroOverlay?.dispose();
  delete (window as unknown as Record<string, unknown>).__rionTestCoordinateMeasurementModuleImporter;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function installCoordinateModuleUrl() {
  const source = await readFile("src/shared/browser-overlay/macroCoordinateMeasurement.js", "utf8");
  Object.defineProperty(window.URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)
  });
  Object.defineProperty(window.URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window, "__rionTestCoordinateMeasurementModuleImporter", {
    configurable: true,
    value: (url: string) => import(url)
  });
}

describe("shell-neutral macro overlay runtime", () => {
  it("applies resolved themes to the isolated host and preserves the current theme on invalid input", async () => {
    let resolvedTheme = "dark";
    const binding = vi.fn(async () => ({
      macroBadgePosition: { horizontalAlign: "center", horizontalMarginPx: 8, topPx: 128 },
      macros: [],
      resolvedTheme,
      statuses: []
    }));
    (window as unknown as Record<string, unknown>).rionStudioMacroOverlay = binding;

    (0, eval)(await overlayRuntimeSource());
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "list" }));

    const host = document.querySelector<HTMLElement>("#rion-studio-macro-overlay-v60");
    expect(host?.dataset.theme).toBe("dark");
    expect(host?.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(host?.style.getPropertyPriority("color-scheme")).toBe("important");

    resolvedTheme = "light";
    await overlayController().refresh();
    expect(host?.dataset.theme).toBe("light");
    expect(host?.style.getPropertyValue("color-scheme")).toBe("light");

    resolvedTheme = "unsupported";
    await overlayController().refresh();
    expect(host?.dataset.theme).toBe("light");
    expect(host?.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("preserves coordinate, shortcut, held-release, canvas, editable, and dense queue behavior", async () => {
    await installCoordinateModuleUrl();
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
    let activeToggleActions = 0;
    let maximumActiveToggleActions = 0;
    const binding = vi.fn(async (request: OverlayRequest) => {
      requests.push(request);
      if (request.type === "coordinate-context") {
        return { appliedPageZoom: 1, surfaceGeneration: 4, topologyRevision: 9 };
      }
      if (request.type === "toggle") {
        activeToggleActions += 1;
        maximumActiveToggleActions = Math.max(
          maximumActiveToggleActions,
          activeToggleActions
        );
        await Promise.resolve();
        activeToggleActions -= 1;
      }
      return {
        language: "zh-TW",
        macroBadgePosition: { horizontalAlign: "center", horizontalMarginPx: 8, topPx: 128 },
        macros,
        statuses: []
      };
    });
    (window as unknown as Record<string, unknown>).rionStudioMacroOverlay = binding;

    (0, eval)(await overlayRuntimeSource());
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "list" }));

    const host = document.querySelector<HTMLElement>("#rion-studio-macro-overlay-v60");
    const root = host?.shadowRoot;
    expect(root).toBeTruthy();

    root?.querySelector<HTMLElement>(".trigger")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    root?.querySelector<HTMLElement>(".action-menu-item")?.click();
    await vi.waitFor(() => expect(root?.querySelector(".coordinate-picker")).not.toBeNull());
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
      request.xReferencePx === 200 && request.yReferencePx === 150 &&
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
      for (const type of ["keydown", "keyup"]) {
        window.dispatchEvent(new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          code: "KeyA",
          key: "a"
        }));
      }
    }
    await vi.waitFor(() => expect(
      requests.filter((request) => request.type === "toggle" && request.macroId === "toggle")
    ).toHaveLength(20));
    expect(maximumActiveToggleActions).toBe(1);

    const runtimeShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      ctrlKey: true,
      key: "Tab"
    });
    window.dispatchEvent(runtimeShortcut);
    expect(runtimeShortcut.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(requests).toContainEqual({
      type: "runtime-tab-shortcut",
      direction: "next",
      modifierCodes: ["ControlLeft"]
    }));
  });

  it("replays changed iterations and refreshes completion, click, locale, position, and open state", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });

    const macro = {
      activationMode: "toggle",
      enabled: true,
      id: "loop",
      name: "Loop",
      repeat: { intervalMs: 250, type: "loop" },
      steps: [{
        anchor: "top-left",
        id: "click-1",
        type: "click",
        unit: "percent",
        xPercent: 25,
        yPercent: 50
      }],
      trigger: { alt: false, code: "KeyL", ctrl: true, meta: false, shift: false }
    };
    const startedAt = "2026-07-27T00:00:00.000Z";
    let presentation: {
      language: string;
      macroBadgePosition: {
        horizontalAlign: string;
        horizontalMarginPx: number;
        topPx: number;
      };
      macros: Array<Record<string, unknown>>;
      statuses: OverlayStatus[];
    } = {
      language: "en",
      macroBadgePosition: { horizontalAlign: "left", horizontalMarginPx: 8, topPx: 128 },
      macros: [macro],
      statuses: [{
        iteration: 0,
        macroId: macro.id,
        roleId: "role-a",
        startedAt,
        state: "running",
        updatedAt: startedAt
      }]
    };
    const requests: OverlayRequest[] = [];
    const binding = vi.fn(async (request: OverlayRequest) => {
      requests.push(request);
      return presentation;
    });
    const timing = vi.fn(async () => undefined);
    Object.assign(binding, { macroBadgeTiming: timing });
    (window as unknown as Record<string, unknown>).rionStudioMacroOverlay = binding;

    (0, eval)(await overlayRuntimeSource());
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "list" }));

    const root = document
      .querySelector<HTMLElement>("#rion-studio-macro-overlay-v60")
      ?.shadowRoot;
    expect(root).toBeTruthy();
    const activeBadges = root?.querySelector<HTMLElement>(".active-badges");
    const initialBadge = root?.querySelector<HTMLElement>(".active-badge");
    expect(initialBadge?.dataset.iteration).toBe("0");
    expect(initialBadge?.classList.contains("is-iteration-flash")).toBe(false);

    presentation = {
      ...presentation,
      statuses: [{
        iteration: 1,
        macroId: macro.id,
        roleId: "role-a",
        startedAt,
        state: "running",
        updatedAt: "2026-07-27T00:00:00.250Z"
      }]
    };
    await overlayController().refresh();
    const changedBadge = root?.querySelector<HTMLElement>(".active-badge");
    expect(changedBadge).not.toBe(initialBadge);
    expect(changedBadge?.dataset.iteration).toBe("1");
    expect(changedBadge?.classList.contains("is-iteration-flash")).toBe(true);
    await vi.waitFor(() => expect(timing).toHaveBeenCalledWith(expect.objectContaining({
      iteration: 1,
      macroId: macro.id,
      phase: "webviewResponse",
      startedAt
    })));

    const animationStart = new Event("animationstart", { bubbles: true });
    Object.defineProperties(animationStart, {
      animationName: { value: "active-badge-border-flash" },
      elapsedTime: { value: 0 },
      pseudoElement: { value: "::after" }
    });
    changedBadge?.dispatchEvent(animationStart);
    await vi.waitFor(() => expect(timing).toHaveBeenCalledWith(expect.objectContaining({
      iteration: 1,
      macroId: macro.id,
      phase: "animationStart",
      startedAt
    })));

    await overlayController().refresh();
    expect(root?.querySelector(".active-badge")).toBe(changedBadge);

    presentation = { ...presentation, statuses: [] };
    await overlayController().refresh();
    expect(root?.querySelector(".active-badge")).toBeNull();
    expect(activeBadges?.hidden).toBe(true);

    presentation = {
      language: "zh-TW",
      macroBadgePosition: { horizontalAlign: "right", horizontalMarginPx: 16, topPx: 64 },
      macros: [{ ...macro, name: "點擊循環" }],
      statuses: [{
        iteration: 0,
        lastClick: { sequence: 1, stepId: "click-1" },
        macroId: macro.id,
        roleId: "role-a",
        startedAt: "2026-07-27T00:00:01.000Z",
        state: "running",
        updatedAt: "2026-07-27T00:00:01.000Z"
      }]
    };
    await overlayController().refresh();
    expect(activeBadges?.style.top).toBe("64px");
    expect(activeBadges?.style.left).toBe("auto");
    expect(activeBadges?.style.right).toBe("16px");
    expect(root?.querySelector(".active-badge-name")?.textContent).toBe("點擊循環");
    expect(root?.querySelector(".click-marker")?.classList.contains("is-click-flash")).toBe(true);
    expect(root?.querySelector(".trigger")?.getAttribute("title"))
      .toBe("開啟 Rion Studio 巨集 (Ctrl+Shift+M)");

    root?.querySelector<HTMLElement>(".trigger")?.click();
    await vi.waitFor(() => expect(requests.some((request) => request.type === "open")).toBe(true));
  });
});
