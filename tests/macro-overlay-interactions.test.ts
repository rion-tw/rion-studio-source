// @vitest-environment jsdom

import { readSourceTreeSync as readFileSync } from "./helpers/readSourceTree";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Macro, MacroRunStatus as _MacroRunStatus } from "../src/shared/types";

const runtimeSource = readFileSync("src/shared/browser-overlay/macroOverlayRuntime.js", "utf8");
const shortcutGuardSource = readFileSync(
  "src/shared/browser-overlay/macroOverlayShortcutGuard.js",
  "utf8"
);
const overlayCss = readFileSync("src/shared/browser-overlay/macroOverlay.css", "utf8");
const coordinateMeasurementModuleSource = readFileSync(
  "src/shared/browser-overlay/macroCoordinateMeasurement.js",
  "utf8"
);
const coordinateMeasurementModuleUrl =
  `data:text/javascript;charset=utf-8,${encodeURIComponent(coordinateMeasurementModuleSource)}`;
const MACRO_OVERLAY_SCRIPT = runtimeSource
  .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__"), shortcutGuardSource.trim())
  .replace(
    JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__"),
    "() => true"
  )
  .replace(
    JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_BINDING__"),
    "window.rionStudioMacroOverlay"
  )
  .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_CSS__"), JSON.stringify(overlayCss))
  .replace(
    JSON.stringify("__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE__"),
    JSON.stringify(coordinateMeasurementModuleSource)
  )
  .replace(
    JSON.stringify("__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER__"),
    "window.__rionTestCoordinateMeasurementModuleImporter"
  );

interface OverlayController {
  clearSuppressedShortcut?: (dispatchId: string) => boolean;
  dispose: () => void;
  refresh: () => Promise<void>;
  suppressNextShortcut?: (
    dispatchId: string,
    code: string,
    phase?: "keydown" | "keyup"
  ) => boolean;
}

interface OverlayTestWindow extends Window {
  __rionStudioMacroOverlay?: OverlayController;
  rionStudioMacroOverlay?: (request: unknown) => Promise<unknown>;
  __rionTestCoordinateMeasurementModuleImporter?: (url: string) => Promise<unknown>;
}

const assignedMacro: Macro = {
  id: "macro-1",
  enabled: true,
  name: "Auto heal",
  roleIds: ["role-1"],
  shortcutSourceScope: { type: "all_execution_roles" as const },
  trigger: { code: "F2", ctrl: false, alt: false, shift: false, meta: false },
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "KeyQ" }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const _clickMacro: Macro = {
  ...assignedMacro,
  id: "click-macro",
  name: "Click targets",
  steps: [
    { id: "click-first", type: "click", xPercent: 25, yPercent: 50 },
    { id: "click-duplicate", type: "click", xPercent: 25, yPercent: 50 },
    { id: "click-bottom-right", type: "click", unit: "px", anchor: "bottom-right", xPx: -24, yPx: -32 }
  ]
};

describe("macro overlay interactions", () => {
beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.lang = "en";
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => coordinateMeasurementModuleUrl)
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    Object.defineProperty(window, "__rionTestCoordinateMeasurementModuleImporter", {
      configurable: true,
      value: (url: string) => import(url)
    });
  });

afterEach(() => {
    const overlayWindow = window as OverlayTestWindow;
    overlayWindow.__rionStudioMacroOverlay?.dispose();
    delete overlayWindow.__rionStudioMacroOverlay;
    delete overlayWindow.rionStudioMacroOverlay;
    delete overlayWindow.__rionTestCoordinateMeasurementModuleImporter;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

it("leaves game pointer events and focus untouched", () => {
    const { button, canvas } = createGameSurface(document);
    const binding = vi.fn(async (_request: unknown) => ({ macros: [], statuses: [] }));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    installOverlay(window, binding);
    const pagePointerDown = vi.fn();
    document.addEventListener("pointerdown", pagePointerDown);
    button.focus();

    const event = createMouseEvent(window, "pointerdown");
    expect(button.dispatchEvent(event)).toBe(true);
    document.removeEventListener("pointerdown", pagePointerDown);

    expect(event.defaultPrevented).toBe(false);
    expect(pagePointerDown).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(canvas);
    expect(binding).not.toHaveBeenCalledWith({ type: "activate" });

    const canvasPointerDown = createMouseEvent(window, "pointerdown");
    expect(canvas.dispatchEvent(canvasPointerDown)).toBe(true);
    expect(canvasPointerDown.defaultPrevented).toBe(false);
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "game-input-context",
      target: "game"
    }));
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "activate"
    )).toHaveLength(0);

    expect(canvas.dispatchEvent(createMouseEvent(window, "pointerdown"))).toBe(true);
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "activate"
    )).toHaveLength(0);
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "game-input-context" && request.target === "game"
    )).toHaveLength(1);
    expect(document.activeElement).toBe(button);
  });

it("does not refocus the WebView when right mouse is pressed while a movement key is held", () => {
    const { canvas } = createGameSurface(document);
    const binding = vi.fn(async (_request: unknown) => ({ macros: [], statuses: [] }));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    installOverlay(window, binding);
    const gameKeyDown = vi.fn();
    const gameKeyUp = vi.fn();
    const gameBlur = vi.fn();
    document.addEventListener("keydown", gameKeyDown);
    document.addEventListener("keyup", gameKeyUp);
    window.addEventListener("blur", gameBlur);

    document.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyW",
      key: "w"
    }));
    const rightPointerDown = createMouseEvent(window, "pointerdown", { button: 2 });
    expect(canvas.dispatchEvent(rightPointerDown)).toBe(true);

    expect(gameKeyDown).toHaveBeenCalledOnce();
    expect(gameKeyUp).not.toHaveBeenCalled();
    expect(gameBlur).not.toHaveBeenCalled();
    expect(rightPointerDown.defaultPrevented).toBe(false);
    expect(binding).not.toHaveBeenCalledWith({ type: "activate" });

    document.removeEventListener("keydown", gameKeyDown);
    document.removeEventListener("keyup", gameKeyUp);
    window.removeEventListener("blur", gameBlur);
  });

it("requests WebView focus once when a pointer event reaches an unfocused document", () => {
    const { canvas } = createGameSurface(document);
    const binding = vi.fn(async (_request: unknown) => ({ macros: [], statuses: [] }));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    installOverlay(window, binding);

    expect(canvas.dispatchEvent(createMouseEvent(window, "pointerdown", { button: 0 }))).toBe(true);

    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "activate"
    )).toHaveLength(1);
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "game-input-context",
      target: "game"
    }));
  });

it("opens the app once from a physical trigger click while keeping the action menu hidden", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const binding = vi.fn(async (_request: unknown) => ({ macros: [assignedMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    if (!trigger) throw new Error("Expected the macro overlay trigger.");

    const pagePointerDown = vi.fn();
    document.addEventListener("pointerdown", pagePointerDown);
    const pointerDown = createMouseEvent(window, "pointerdown");
    expect(trigger.dispatchEvent(pointerDown)).toBe(true);
    const mouseDown = createMouseEvent(window, "mousedown");
    expect(trigger.dispatchEvent(mouseDown)).toBe(false);
    trigger.dispatchEvent(createMouseEvent(window, "pointerup"));
    const click = createMouseEvent(window, "click");
    expect(trigger.dispatchEvent(click)).toBe(false);
    document.removeEventListener("pointerdown", pagePointerDown);

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(canvas);
    expect(pagePointerDown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "open" }));
    expect(binding.mock.calls.filter(([request]) => isRecord(request) && request.type === "open")).toHaveLength(1);
    expect(root.querySelector(".panel")).toBeNull();
    expect(root.querySelector(".macro-row")).toBeNull();
    expect(root.querySelector<HTMLElement>(".action-menu")?.hidden).toBe(true);
  });

it("copies and closes the coordinate picker while the open request remains pending", async () => {
    const openRequest = _createDeferred<unknown>();
    createGameSurface(document);
    const binding = vi.fn((request: unknown) => {
      if (isRecord(request) && request.type === "open") {
        return openRequest.promise;
      }
      return Promise.resolve({
        macros: [assignedMacro],
        statuses: [],
        ...(isRecord(request) && request.type === "copy-coordinate" ? { copied: true } : {})
      });
    });
    installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    const measureAction = root.querySelector<HTMLButtonElement>(".action-menu-item");
    if (!trigger || !measureAction) throw new Error("Expected coordinate menu controls.");

    trigger.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "open" }));
    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());

    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    if (!picker) throw new Error("Expected coordinate picker.");
    picker.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 144,
      clientY: 108
    }));

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "copy-coordinate",
      xPx: 144,
      yPx: 108
    })));
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).toBeNull());
    expect(picker.isConnected).toBe(false);
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "open"
    )).toHaveLength(1);
  });

it("opens the coordinate action on hover and copies a measured viewport point", async () => {
    let nextFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const binding = vi.fn(async (request: unknown) => ({
      macros: [assignedMacro],
      statuses: [],
      ...(isRecord(request) && request.type === "copy-coordinate" ? { copied: true } : {})
    }));
    const controller = installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    const menu = root.querySelector<HTMLElement>(".action-menu");
    const measureAction = root.querySelector<HTMLButtonElement>(".action-menu-item");
    if (!trigger || !menu || !measureAction) throw new Error("Expected coordinate menu controls.");

    expect(menu.hidden).toBe(true);
    expect(root.querySelector(".coordinate-picker")).toBeNull();
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    expect(menu.hidden).toBe(false);
    expect(measureAction.textContent).toContain("Measure coordinates");

    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
    expect(window.URL.createObjectURL).toHaveBeenCalledOnce();
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    const readout = root.querySelector<HTMLElement>(".coordinate-readout");
    if (!picker || !readout) throw new Error("Expected coordinate picker.");
    expect(picker.hidden).toBe(false);
    expect(root.querySelector("style")?.textContent).toContain("touch-action:none");

    const move = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 256,
      clientY: 192
    });
    expect(picker.dispatchEvent(move)).toBe(false);
    const latestMove = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 240
    });
    expect(picker.dispatchEvent(latestMove)).toBe(false);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(readout.textContent).not.toContain("X: 320px");

    nextFrame?.(0);

    expect(readout.textContent).toContain("X: 320px");
    expect(readout.textContent).toContain("Y: 240px");

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 256,
      clientY: 192
    });
    expect(picker.dispatchEvent(click)).toBe(false);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "copy-coordinate",
      xPx: 256,
      xReferencePx: 256,
      yPx: 192,
      yReferencePx: 192
    })));
    const copyRequest = binding.mock.calls
      .map(([request]) => request)
      .find((request) => isRecord(request) && request.type === "copy-coordinate");
    expect(copyRequest).toHaveProperty("anchor", "top-left");
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).toBeNull());
    expect(picker.isConnected).toBe(false);

    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
    const secondPicker = root.querySelector<HTMLElement>(".coordinate-picker");
    expect(secondPicker).not.toBe(picker);
    expect(window.URL.createObjectURL).toHaveBeenCalledOnce();
    document.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      key: "Escape"
    }));
    expect(root.querySelector(".coordinate-picker")).toBeNull();
    controller.dispose();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith(coordinateMeasurementModuleUrl);
  });

it("calculates the nearest measurement anchor and draws its connector in real time", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    let nextFrame: FrameRequestCallback | undefined;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
      installOverlay(window, binding);
      await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

      const root = getOverlayRoot(document);
      root.querySelector<HTMLButtonElement>(".trigger")?.dispatchEvent(
        createMouseEvent(window, "pointerenter")
      );
      root.querySelector<HTMLButtonElement>(".action-menu-item")?.dispatchEvent(
        createMouseEvent(window, "click")
      );
      await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());

      const picker = root.querySelector<HTMLElement>(".coordinate-picker");
      const readout = root.querySelector<HTMLElement>(".coordinate-readout");
      const connectorSvg = root.querySelector<SVGSVGElement>(".coordinate-anchor-connector-svg");
      const connector = root.querySelector<SVGLineElement>(".coordinate-anchor-connector");
      if (!picker || !readout || !connectorSvg || !connector) {
        throw new Error("Expected coordinate measurement connector elements.");
      }
      expect(connectorSvg.hasAttribute("hidden")).toBe(true);

      picker.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: 600,
        clientY: 300
      }));
      nextFrame?.(0);

      expect(readout.textContent).toContain("Anchor: center");
      expect(connectorSvg.hasAttribute("hidden")).toBe(false);
      expect(connector.getAttribute("x1")).toBe("500");
      expect(connector.getAttribute("y1")).toBe("400");
      expect(connector.getAttribute("x2")).toBe("600");
      expect(connector.getAttribute("y2")).toBe("300");

      picker.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      }));
      nextFrame?.(0);

      expect(readout.textContent).toContain("Anchor: top-left");
      expect(connector.getAttribute("x1")).toBe("0");
      expect(connector.getAttribute("y1")).toBe("0");
      expect(connector.getAttribute("x2")).toBe("100");
      expect(connector.getAttribute("y2")).toBe("100");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

it("keeps the coordinate readout inside the viewport near the right and bottom edges", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    let nextFrame: FrameRequestCallback | undefined;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
      installOverlay(window, binding);
      await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

      const root = getOverlayRoot(document);
      root.querySelector<HTMLButtonElement>(".trigger")?.dispatchEvent(
        createMouseEvent(window, "pointerenter")
      );
      root.querySelector<HTMLButtonElement>(".action-menu-item")?.dispatchEvent(
        createMouseEvent(window, "click")
      );
      await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
      const picker = root.querySelector<HTMLElement>(".coordinate-picker");
      const readout = root.querySelector<HTMLElement>(".coordinate-readout");
      if (!picker || !readout) throw new Error("Expected coordinate readout.");
      vi.spyOn(readout, "getBoundingClientRect").mockReturnValue({
        bottom: 0,
        height: 44,
        left: 0,
        right: 460,
        top: 0,
        width: 460,
        x: 0,
        y: 0,
        toJSON: () => ({})
      } as DOMRect);

      picker.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: 980,
        clientY: 780
      }));
      nextFrame?.(0);

      expect(Number.parseFloat(readout.style.left)).toBe(506);
      expect(Number.parseFloat(readout.style.top)).toBe(722);
      expect(Number.parseFloat(readout.style.left) + 460).toBeLessThanOrEqual(992);
      expect(Number.parseFloat(readout.style.top) + 44).toBeLessThanOrEqual(792);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

it("renders nine non-interactive anchor markers and repositions them after resize", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    try {
      createGameSurface(document);
      const binding = vi.fn(async (request: unknown) => ({
        macros: [assignedMacro],
        statuses: [],
        ...(isRecord(request) && request.type === "copy-coordinate" ? { copied: true } : {})
      }));
      installOverlay(window, binding);
      await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

      const root = getOverlayRoot(document);
      root.querySelector<HTMLButtonElement>(".trigger")?.dispatchEvent(
        createMouseEvent(window, "pointerenter")
      );
      root.querySelector<HTMLButtonElement>(".action-menu-item")?.dispatchEvent(
        createMouseEvent(window, "click")
      );
      await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());

      const picker = root.querySelector<HTMLElement>(".coordinate-picker");
      const layer = root.querySelector<HTMLElement>(".coordinate-anchor-layer");
      const markers = [...root.querySelectorAll<HTMLElement>(".coordinate-anchor-marker")];
      if (!picker || !layer) throw new Error("Expected coordinate anchor guides.");

      expect(picker.hidden).toBe(false);
      expect(layer.hidden).toBe(false);
      expect(layer.getAttribute("aria-hidden")).toBe("true");
      expect(markers.map((marker) => marker.dataset.anchor)).toEqual([
        "top-left", "top-center", "top-right",
        "center-left", "center", "center-right",
        "bottom-left", "bottom-center", "bottom-right"
      ]);
      expect(markers.map((marker) => [marker.style.left, marker.style.top])).toEqual([
        ["0px", "0px"], ["500px", "0px"], ["999px", "0px"],
        ["0px", "400px"], ["500px", "400px"], ["999px", "400px"],
        ["0px", "799px"], ["500px", "799px"], ["999px", "799px"]
      ]);

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
      window.dispatchEvent(new Event("resize"));
      await vi.waitFor(() => expect(markers.map((marker) => [marker.style.left, marker.style.top])).toEqual([
        ["0px", "0px"], ["600px", "0px"], ["1199px", "0px"],
        ["0px", "300px"], ["600px", "300px"], ["1199px", "300px"],
        ["0px", "599px"], ["600px", "599px"], ["1199px", "599px"]
      ]));

      markers[4]?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 600,
        clientY: 300
      }));
      await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
        type: "copy-coordinate",
        xPx: 600,
        yPx: 300
      })));
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

it("blocks macro shortcuts while measuring and lets Escape cancel without copying", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 9);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    createGameSurface(document);
    const binding = vi.fn(async (_request: unknown) => ({ macros: [assignedMacro], statuses: [] }));
    installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

    const root = getOverlayRoot(document);
    root.querySelector<HTMLButtonElement>(".trigger")?.dispatchEvent(
      createMouseEvent(window, "pointerenter")
    );
    root.querySelector<HTMLButtonElement>(".action-menu-item")?.dispatchEvent(
      createMouseEvent(window, "click")
    );
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    if (!picker) throw new Error("Expected coordinate picker.");
    picker.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100
    }));

    const shortcut = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    expect(document.dispatchEvent(shortcut)).toBe(false);
    expect(binding.mock.calls.some(([request]) => isRecord(request) && request.type === "start")).toBe(false);

    const escape = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      key: "Escape"
    });
    expect(document.dispatchEvent(escape)).toBe(false);
    expect(root.querySelector(".coordinate-picker")).toBeNull();
    expect(picker.isConnected).toBe(false);
    expect(cancelFrame).toHaveBeenCalledWith(9);
    expect(binding.mock.calls.some(([request]) => isRecord(request) && request.type === "copy-coordinate")).toBe(false);
  });

it("keeps the measurement layer visible when clipboard copying fails", async () => {
    createGameSurface(document);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "copy-coordinate") {
        throw new Error("clipboard unavailable");
      }
      return { macros: [assignedMacro], statuses: [] };
    });
    installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

    const root = getOverlayRoot(document);
    root.querySelector<HTMLButtonElement>(".trigger")?.dispatchEvent(
      createMouseEvent(window, "pointerenter")
    );
    root.querySelector<HTMLButtonElement>(".action-menu-item")?.dispatchEvent(
      createMouseEvent(window, "click")
    );
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    const readout = root.querySelector<HTMLElement>(".coordinate-readout");
    if (!picker || !readout) throw new Error("Expected coordinate picker.");

    picker.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 128,
      clientY: 96
    }));
    picker.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 128,
      clientY: 96
    }));

    await vi.waitFor(() => expect(readout.dataset.status).toBe("failed"));
    expect(picker.hidden).toBe(false);
  });

it("cleans up a failed lazy import and retries from the coordinate action", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("module blocked"))
      .mockImplementation((url: string) => import(url));
    Object.defineProperty(window, "__rionTestCoordinateMeasurementModuleImporter", {
      configurable: true,
      value: importer
    });
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());
    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    const measureAction = root.querySelector<HTMLButtonElement>(".action-menu-item");
    if (!trigger || !measureAction) throw new Error("Expected coordinate menu controls.");

    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(window.URL.revokeObjectURL).toHaveBeenCalledOnce());
    expect(root.querySelector(".coordinate-picker")).toBeNull();

    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>(".action-menu")?.hidden).toBe(false));
    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
    expect(importer).toHaveBeenCalledTimes(2);
    expect(window.URL.createObjectURL).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

it("rejects a late module result after Escape cancels a pending measurement", async () => {
    let resolveImport: ((value: unknown) => void) | undefined;
    const pendingImport = new Promise<unknown>((resolve) => {
      resolveImport = resolve;
    });
    const importer = vi.fn(() => pendingImport);
    Object.defineProperty(window, "__rionTestCoordinateMeasurementModuleImporter", {
      configurable: true,
      value: importer
    });
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());
    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    const measureAction = root.querySelector<HTMLButtonElement>(".action-menu-item");
    if (!trigger || !measureAction) throw new Error("Expected coordinate menu controls.");

    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    const escape = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      key: "Escape"
    });
    expect(document.dispatchEvent(escape)).toBe(false);
    resolveImport?.(await import(coordinateMeasurementModuleUrl));
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector(".coordinate-picker")).toBeNull();

    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());
    expect(importer).toHaveBeenCalledOnce();
    expect(window.URL.createObjectURL).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

function installOverlay(
  targetWindow: Window,
  binding: (request: unknown) => Promise<unknown> = async () => ({ macros: [], statuses: [] })
): OverlayController {
  const overlayWindow = targetWindow as OverlayTestWindow;
  const overlayBinding = Object.assign(
    async (request: unknown) => isRecord(request) && request.type === "coordinate-context"
      ? { appliedPageZoom: 1, surfaceGeneration: 3, topologyRevision: 5 }
      : binding(request),
    { managedShortcutKeyPhase: async () => undefined }
  );
  Object.defineProperty(overlayWindow, "rionStudioMacroOverlay", {
    configurable: true,
    value: overlayBinding
  });
  (targetWindow as unknown as { eval: (source: string) => unknown }).eval(MACRO_OVERLAY_SCRIPT);
  if (!overlayWindow.__rionStudioMacroOverlay) {
    throw new Error("Expected the macro overlay controller to be installed.");
  }
  return overlayWindow.__rionStudioMacroOverlay;
}

function createGameSurface(ownerDocument: Document): { button: HTMLButtonElement; canvas: HTMLCanvasElement } {
  const canvas = ownerDocument.createElement("canvas");
  const button = ownerDocument.createElement("button");
  button.textContent = "Play";
  ownerDocument.body.append(canvas, button);
  return { button, canvas };
}

function createMouseEvent(
  targetWindow: Window,
  type: string,
  init: MouseEventInit = {}
): MouseEvent {
  const MouseEventConstructor = (targetWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  return new MouseEventConstructor(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init
  });
}

function _dispatchShortcut(targetWindow: Window, code: string, key: string): void {
  const KeyboardEventConstructor = (targetWindow as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  targetWindow.document.dispatchEvent(new KeyboardEventConstructor("keydown", {
    bubbles: true,
    cancelable: true,
    code,
    key
  }));
}

function _runningStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roleId: "role-1",
    macroId: assignedMacro.id,
    state: "running",
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}

function getOverlayRoot(ownerDocument: Document): ShadowRoot {
  const root = ownerDocument.getElementById("rion-studio-macro-overlay-v60")?.shadowRoot;
  if (!root) throw new Error("Expected the macro overlay shadow root.");
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function _createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
