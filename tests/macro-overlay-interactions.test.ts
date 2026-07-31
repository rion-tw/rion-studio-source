// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Macro, MacroRunStatus } from "../src/shared/types";
import { v1Case } from "./helpers/v1Parity";

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
  clearSuppressedShortcut?: (code: string, phase?: "keydown" | "keyup") => void;
  dispose: () => void;
  refresh: () => Promise<void>;
  suppressNextShortcut?: (code: string, phase?: "keydown" | "keyup") => void;
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
  trigger: { code: "F2", ctrl: false, alt: false, shift: false, meta: false },
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "KeyQ" }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const clickMacro: Macro = {
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
    expect(binding).toHaveBeenCalledWith({ type: "game-input-context", active: true });
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "activate"
    )).toHaveLength(0);

    expect(canvas.dispatchEvent(createMouseEvent(window, "pointerdown"))).toBe(true);
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "activate"
    )).toHaveLength(0);
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "game-input-context" && request.active === true
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
    expect(binding).toHaveBeenCalledWith({ type: "game-input-context", active: true });
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
      yPx: 192
    })));
    const copyRequest = binding.mock.calls
      .map(([request]) => request)
      .find((request) => isRecord(request) && request.type === "copy-coordinate");
    expect(copyRequest).not.toHaveProperty("anchor");
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
      expect(markers.map((marker) => [marker.style.left, marker.style.top])).toEqual([
        ["0px", "0px"], ["600px", "0px"], ["1199px", "0px"],
        ["0px", "300px"], ["600px", "300px"], ["1199px", "300px"],
        ["0px", "599px"], ["600px", "599px"], ["1199px", "599px"]
      ]);

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

  it("positions active badges from the shared overlay state", async () => {
    createGameSurface(document);
    const binding = vi.fn(async () => ({
      macroBadgePosition: {
        horizontalAlign: "right",
        horizontalMarginPx: 80,
        topPx: 280
      },
      macros: [assignedMacro],
      statuses: [runningStatus()]
    }));
    const controller = installOverlay(window, binding);

    await controller.refresh();

    const badges = getOverlayRoot(document).querySelector<HTMLElement>(".active-badges");
    expect(badges).not.toBeNull();
    expect(badges).toMatchObject({
      hidden: false
    });
    expect(badges?.style.top).toBe("280px");
    expect(badges?.style.left).toBe("auto");
    expect(badges?.style.right).toBe("80px");
    expect(badges?.style.width).toBe("max-content");
    expect(badges?.style.justifyContent).toBe("flex-end");
    expect(badges?.style.transform).toBe("none");
  });

  it("positions active badges on the left with a px margin", async () => {
    createGameSurface(document);
    const binding = vi.fn(async () => ({
      macroBadgePosition: {
        horizontalAlign: "left",
        horizontalMarginPx: 24,
        topPx: 64
      },
      macros: [assignedMacro],
      statuses: [runningStatus()]
    }));
    const controller = installOverlay(window, binding);

    await controller.refresh();

    const badges = getOverlayRoot(document).querySelector<HTMLElement>(".active-badges");
    expect(badges?.style.top).toBe("64px");
    expect(badges?.style.left).toBe("24px");
    expect(badges?.style.right).toBe("auto");
    expect(badges?.style.width).toBe("max-content");
    expect(badges?.style.justifyContent).toBe("flex-start");
  });

  it("centers active badges in the full viewport and ignores the margin", async () => {
    createGameSurface(document);
    const binding = vi.fn(async () => ({
      macroBadgePosition: {
        horizontalAlign: "center",
        horizontalMarginPx: 128,
        topPx: 192
      },
      macros: [assignedMacro],
      statuses: [runningStatus()]
    }));
    const controller = installOverlay(window, binding);

    await controller.refresh();

    const badges = getOverlayRoot(document).querySelector<HTMLElement>(".active-badges");
    expect(badges?.style.top).toBe("192px");
    expect(badges?.style.left).toBe("0px");
    expect(badges?.style.right).toBe("0px");
    expect(badges?.style.width).toBe("100vw");
    expect(badges?.style.justifyContent).toBe("center");
  });

  it("renders running click coordinates, merges duplicates, and flashes the clicked marker", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    let statuses: MacroRunStatus[] = [];
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ macros: [clickMacro], statuses }));
      const controller = installOverlay(window, binding);
      await controller.refresh();

      statuses = [{
        roleId: "role-1",
        macroId: clickMacro.id,
        state: "running",
        startedAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z"
      }];
      await controller.refresh();

      const root = getOverlayRoot(document);
      const layer = root.querySelector<HTMLElement>(".click-marker-layer");
      if (!layer) throw new Error("Expected click marker layer.");
      expect(layer.hidden).toBe(false);
      expect(layer.style.pointerEvents).toBe("");
      expect(layer.querySelectorAll(".click-marker")).toHaveLength(2);
      expect(layer.querySelector(".click-connector-svg")).toBeNull();
      expect(layer.querySelectorAll(".click-connector")).toHaveLength(0);
      expect(root.querySelector<HTMLElement>('[data-marker-key="250:400"]')?.style.getPropertyValue("--click-marker-x"))
        .toBe("250px");
      expect(root.querySelector<HTMLElement>('[data-marker-key="976:768"]')?.style.getPropertyValue("--click-marker-y"))
        .toBe("768px");

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
      window.dispatchEvent(new Event("resize"));
      expect(root.querySelector<HTMLElement>('[data-marker-key="300:300"]')).not.toBeNull();
      expect(root.querySelector<HTMLElement>('[data-marker-key="1176:568"]')).not.toBeNull();

      statuses = [{
        ...statuses[0],
        lastClick: { sequence: 1, stepId: "click-duplicate" },
        updatedAt: "2026-07-20T00:00:01.000Z"
      }];
      await controller.refresh();
      const duplicateMarker = root.querySelector<HTMLElement>('[data-marker-key="300:300"]');
      expect(duplicateMarker?.classList.contains("is-click-flash")).toBe(true);
      const duplicateConnector = layer.querySelector<SVGLineElement>(".click-connector");
      expect(root.querySelector<SVGSVGElement>(".click-connector-svg")?.getAttribute("viewBox"))
        .toBe("0 0 1200 600");
      expect(duplicateConnector?.getAttribute("x1")).toBe("0");
      expect(duplicateConnector?.getAttribute("y1")).toBe("0");
      expect(duplicateConnector?.getAttribute("x2")).toBe("300");
      expect(duplicateConnector?.getAttribute("y2")).toBe("300");
      await controller.refresh();
      const refreshedDuplicateMarker = root.querySelector<HTMLElement>('[data-marker-key="300:300"]');
      expect(refreshedDuplicateMarker?.classList.contains("is-click-flash"))
        .toBe(true);
      refreshedDuplicateMarker?.dispatchEvent(new Event("animationend", { bubbles: true }));
      expect(refreshedDuplicateMarker?.classList.contains("is-click-flash")).toBe(false);

      statuses = [{
        ...statuses[0],
        lastClick: { sequence: 2, stepId: "click-bottom-right" },
        updatedAt: "2026-07-20T00:00:02.000Z"
      }];
      await controller.refresh();
      expect(root.querySelector<HTMLElement>('[data-marker-key="1176:568"]')?.classList.contains("is-click-flash"))
        .toBe(true);
      const bottomRightConnector = layer.querySelector<SVGLineElement>(".click-connector");
      expect(bottomRightConnector?.getAttribute("x1")).toBe("1199");
      expect(bottomRightConnector?.getAttribute("y1")).toBe("599");
      expect(bottomRightConnector?.getAttribute("x2")).toBe("1176");
      expect(bottomRightConnector?.getAttribute("y2")).toBe("568");

      statuses = [];
      await controller.refresh();
      expect(layer.hidden).toBe(false);
      expect(layer.querySelectorAll(".click-marker")).toHaveLength(2);
      expect(layer.querySelectorAll(".click-connector")).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 190));
      expect(layer.hidden).toBe(true);
      expect(layer.querySelectorAll(".click-marker")).toHaveLength(0);
      expect(layer.querySelector(".click-connector-svg")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

  it("renders one connector per flashing click step and skips zero-length connectors", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const lineMacros: Macro[] = [
      {
        ...assignedMacro,
        id: "center-line",
        steps: [{
          anchor: "center",
          id: "center-offset",
          type: "click",
          xPercent: 10,
          yPercent: -10
        }]
      },
      {
        ...assignedMacro,
        id: "top-line",
        steps: [{
          anchor: "top-left",
          id: "top-offset",
          type: "click",
          xPercent: 20,
          yPercent: 20
        }]
      },
      {
        ...assignedMacro,
        id: "zero-line",
        steps: [{
          anchor: "center",
          id: "center-zero",
          type: "click",
          xPercent: 0,
          yPercent: 0
        }]
      }
    ];
    let statuses: Array<Record<string, unknown>> = [];
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ macros: lineMacros, statuses }));
      const controller = installOverlay(window, binding);
      await controller.refresh();

      statuses = [
        runningStatus({
          macroId: "center-line",
          lastClick: { sequence: 1, stepId: "center-offset" }
        }),
        runningStatus({
          macroId: "top-line",
          lastClick: { sequence: 1, stepId: "top-offset" }
        }),
        runningStatus({
          macroId: "zero-line",
          lastClick: { sequence: 1, stepId: "center-zero" }
        })
      ];
      await controller.refresh();

      const lines = [...getOverlayRoot(document)
        .querySelector<HTMLElement>(".click-marker-layer")
        ?.querySelectorAll<SVGLineElement>(".click-connector") ?? []];
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => [
        line.getAttribute("x1"),
        line.getAttribute("y1"),
        line.getAttribute("x2"),
        line.getAttribute("y2")
      ])).toEqual([
        ["500", "400", "600", "320"],
        ["0", "0", "200", "160"]
      ]);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

  it("opens the app from Ctrl+Shift+M and consumes the shortcut", async () => {
    createGameSurface(document);
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const pageKeyDown = vi.fn();
    document.addEventListener("keydown", pageKeyDown);
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyM",
      key: "M",
      ctrlKey: true,
      shiftKey: true
    });

    expect(document.dispatchEvent(event)).toBe(false);
    document.removeEventListener("keydown", pageKeyDown);

    expect(event.defaultPrevented).toBe(true);
    expect(pageKeyDown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "open" }));
  });

  it("keeps the trigger node stable across polling refreshes", async () => {
    createGameSurface(document);
    let statuses: Array<Record<string, unknown>> = [];
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const trigger = getOverlayRoot(document).querySelector(".trigger");

    await controller.refresh();
    statuses = [runningStatus()];
    await controller.refresh();

    const root = getOverlayRoot(document);
    expect(root.querySelector(".trigger")).toBe(trigger);
    expect(trigger?.isConnected).toBe(true);
    expect(root.querySelector(".active-badge")?.firstElementChild?.className)
      .toBe("active-badge-shortcut");
    expect(root.querySelector(".active-badge-name")?.textContent).toBe(assignedMacro.name);
  });

  it("formats short and modified shortcut chips", async () => {
    createGameSurface(document);
    let macro = { ...assignedMacro, trigger: { ...assignedMacro.trigger!, code: "KeyQ" } };
    const binding = vi.fn(async () => ({
      macros: [macro],
      statuses: [runningStatus()]
    }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const root = getOverlayRoot(document);

    expect(root.querySelector(".active-badge-shortcut")?.textContent).toBe("Q");

    macro = { ...assignedMacro, trigger: { ...assignedMacro.trigger!, code: "F2" } };
    await controller.refresh();
    expect(root.querySelector(".active-badge-shortcut")?.textContent).toBe("F2");

    macro = {
      ...assignedMacro,
      trigger: { ...assignedMacro.trigger!, code: "KeyQ", ctrl: true }
    };
    await controller.refresh();
    expect(root.querySelector(".active-badge-shortcut")?.textContent).toBe("Ctrl+Q");
  });

  it("omits the shortcut chip and balances badge padding when no shortcut is assigned", async () => {
    createGameSurface(document);
    const shortcutlessMacro = { ...assignedMacro, name: "Manual macro" };
    delete shortcutlessMacro.trigger;
    const binding = vi.fn(async () => ({
      macros: [shortcutlessMacro],
      statuses: [runningStatus()]
    }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    const root = getOverlayRoot(document);
    const badge = root.querySelector(".active-badge");
    expect(badge?.classList.contains("is-shortcutless")).toBe(true);
    expect(badge?.querySelector(".active-badge-shortcut")).toBeNull();
    expect(badge?.querySelector(".active-badge-name")?.textContent).toBe(shortcutlessMacro.name);
    expect(badge?.textContent).not.toContain("No shortcut");
  });

  it("replays the badge border animation when a loop iteration advances", async () => {
    createGameSurface(document);
    let statuses: Array<Record<string, unknown>> = [runningStatus()];
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    const firstBadge = getOverlayRoot(document).querySelector(".active-badge");
    expect(firstBadge?.getAttribute("data-iteration")).toBe("0");
    expect(firstBadge?.classList.contains("is-iteration-flash")).toBe(false);

    statuses = [{
      ...runningStatus(),
      iteration: 1,
      updatedAt: "2026-07-10T00:00:00.250Z"
    }];
    await controller.refresh();

    const nextBadge = getOverlayRoot(document).querySelector(".active-badge");
    expect(nextBadge).not.toBe(firstBadge);
    expect(nextBadge?.getAttribute("data-iteration")).toBe("1");
    expect(nextBadge?.getAttribute("style")).toContain("--active-badge-flash-duration:80ms");
    expect(nextBadge?.classList.contains("is-iteration-flash")).toBe(true);

    await controller.refresh();
    expect(getOverlayRoot(document).querySelector(".active-badge")).toBe(nextBadge);
  });

  it("does not poll for reconciliation while an event-driven refresh is pending", async () => {
    vi.useFakeTimers();
    createGameSurface(document);
    const firstResponse = createDeferred<unknown>();
    const binding = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValue({ macros: [assignedMacro], statuses: [] });

    installOverlay(window, binding);
    expect(binding).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(binding).toHaveBeenCalledTimes(1);

    firstResponse.resolve({ macros: [assignedMacro], statuses: [] });
    await vi.advanceTimersByTimeAsync(0);
    v1Case("overlay-ebc04483a160", () => {
      expect(binding).toHaveBeenCalledTimes(1);
    });
  });

  it("starts and stops macros from their in-game shortcuts while updating the badge", async () => {
    createGameSurface(document);
    let statuses: Array<Record<string, unknown>> = [];
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "toggle") {
        statuses = statuses.length === 0 ? [runningStatus()] : [];
      }
      return { macros: [assignedMacro], statuses };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id }));
    await vi.waitFor(() => {
      expect(getOverlayRoot(document).querySelector(".active-badge-name")?.textContent).toBe(assignedMacro.name);
    });

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() =>
      expect(binding.mock.calls.filter(([request]) =>
        isRecord(request) && request.type === "toggle"
      )).toHaveLength(2)
    );
    await v1Case("overlay-26bea50b5338", async () => {
      await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".active-badge")).toBeNull());
      expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id });
    });
  });

  it("queues dense toggle intents instead of dropping a shortcut while the prior toggle is pending", async () => {
    createGameSurface(document);
    const firstToggle = createDeferred<unknown>();
    let toggleCount = 0;
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "toggle") {
        toggleCount += 1;
        if (toggleCount === 1) return firstToggle.promise;
        return { macros: [assignedMacro], statuses: [] };
      }
      return { macros: [assignedMacro], statuses: [] };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(toggleCount).toBe(1));

    firstToggle.resolve({ macros: [assignedMacro], statuses: [runningStatus()] });
    await vi.waitFor(() => expect(toggleCount).toBe(2));
    expect(binding.mock.calls.filter(([request]) =>
      isRecord(request) && request.type === "toggle"
    )).toHaveLength(2);
  });

  it("lets unmatched physical key events pass through without macro actions", async () => {
    const { canvas } = createGameSurface(document);
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const pageKeyDown = vi.fn();
    const pageKeyUp = vi.fn();
    document.addEventListener("keydown", pageKeyDown);
    document.addEventListener("keyup", pageKeyUp);

    const keyDown = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyQ",
      key: "q"
    });
    const repeatedKeyDown = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyQ",
      key: "q",
      repeat: true
    });
    const keyUp = new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "KeyQ",
      key: "q"
    });

    expect(canvas.dispatchEvent(keyDown)).toBe(true);
    expect(canvas.dispatchEvent(repeatedKeyDown)).toBe(true);
    expect(canvas.dispatchEvent(keyUp)).toBe(true);

    document.removeEventListener("keydown", pageKeyDown);
    document.removeEventListener("keyup", pageKeyUp);
    expect(keyDown.defaultPrevented).toBe(false);
    expect(repeatedKeyDown.defaultPrevented).toBe(false);
    expect(keyUp.defaultPrevented).toBe(false);
    expect(pageKeyDown).toHaveBeenCalledTimes(2);
    expect(pageKeyUp).toHaveBeenCalledOnce();
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({
      type: expect.stringMatching(/^(?:start|stop|press|release)$/)
    }));
  });

  it("prevents browser defaults on a focused game canvas without hiding key events from the game", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
    installOverlay(window, binding);
    const pageKeyDown = vi.fn();
    const pageKeyUp = vi.fn();
    document.addEventListener("keydown", pageKeyDown);
    document.addEventListener("keyup", pageKeyUp);

    const protectedInputs = [
      { code: "Tab", key: "Tab" },
      { code: "Tab", key: "Tab", repeat: true },
      { code: "Tab", key: "Tab", shiftKey: true },
      { code: "Space", key: " " },
      { code: "ArrowDown", key: "ArrowDown" },
      { code: "PageDown", key: "PageDown" },
      { code: "Home", key: "Home" },
      { code: "Backspace", key: "Backspace" },
      { altKey: true, code: "ArrowLeft", key: "ArrowLeft" }
    ];

    for (const input of protectedInputs) {
      const event = new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...input
      });
      expect(canvas.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }

    const keyUp = new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      key: "Tab"
    });
    expect(canvas.dispatchEvent(keyUp)).toBe(true);

    document.removeEventListener("keydown", pageKeyDown);
    document.removeEventListener("keyup", pageKeyUp);
    expect(document.activeElement).toBe(canvas);
    expect(pageKeyDown).toHaveBeenCalledTimes(protectedInputs.length);
    expect(pageKeyUp).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "game-input-context",
      active: true
    }));
  });

  it("leaves editable controls and operating-system switch shortcuts untouched", async () => {
    const { canvas } = createGameSurface(document);
    const input = document.createElement("input");
    document.body.append(input);
    const binding = vi.fn(async () => ({ macros: [], statuses: [] }));
    installOverlay(window, binding);

    input.focus();
    const editableTab = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      key: "Tab"
    });
    expect(input.dispatchEvent(editableTab)).toBe(true);
    expect(editableTab.defaultPrevented).toBe(false);

    canvas.tabIndex = -1;
    canvas.focus();
    for (const modifiers of [{ metaKey: true }, { altKey: true }]) {
      const systemTab = new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Tab",
        key: "Tab",
        ...modifiers
      });
      expect(canvas.dispatchEvent(systemTab)).toBe(true);
      expect(systemTab.defaultPrevented).toBe(false);
    }
    const systemSpace = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
      key: " ",
      metaKey: true
    });
    expect(canvas.dispatchEvent(systemSpace)).toBe(true);
    expect(systemSpace.defaultPrevented).toBe(false);

    const windowsSystemShortcut = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Home",
      key: "Home",
      metaKey: true
    });
    expect(canvas.dispatchEvent(windowsSystemShortcut)).toBe(true);
    expect(windowsSystemShortcut.defaultPrevented).toBe(false);

    input.focus();
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "game-input-context",
      active: false
    }));
  });

  it("blocks macOS browser navigation while preserving system desktop shortcuts", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    installOverlay(window, vi.fn(async () => ({ macros: [], statuses: [] })));
    const pageKeyDown = vi.fn();
    canvas.addEventListener("keydown", pageKeyDown);

    for (const input of [
      { code: "ArrowLeft", key: "ArrowLeft", metaKey: true },
      { code: "BracketLeft", key: "[", metaKey: true },
      { code: "ArrowRight", key: "ArrowRight", altKey: true },
      { code: "BrowserBack", key: "BrowserBack" }
    ]) {
      const event = new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...input
      });
      expect(canvas.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }

    const systemDesktopShortcut = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "ArrowLeft",
      ctrlKey: true,
      key: "ArrowLeft"
    });
    expect(canvas.dispatchEvent(systemDesktopShortcut)).toBe(true);
    expect(systemDesktopShortcut.defaultPrevented).toBe(false);
    expect(pageKeyDown).toHaveBeenCalledTimes(5);
  });

  it("keeps modified wheel input in the game canvas without affecting editable controls", () => {
    const { canvas } = createGameSurface(document);
    const input = document.createElement("input");
    document.body.append(input);
    canvas.tabIndex = -1;
    canvas.focus();
    installOverlay(window, vi.fn(async () => ({ macros: [], statuses: [] })));
    const canvasWheel = vi.fn();
    canvas.addEventListener("wheel", canvasWheel);

    const gameWheel = new window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 10
    });
    expect(canvas.dispatchEvent(gameWheel)).toBe(false);
    expect(gameWheel.defaultPrevented).toBe(true);
    expect(canvasWheel).toHaveBeenCalledOnce();

    input.focus();
    const editableWheel = new window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 10
    });
    expect(input.dispatchEvent(editableWheel)).toBe(true);
    expect(editableWheel.defaultPrevented).toBe(false);
  });

  it("does not run legacy macros that use reserved browser zoom shortcuts", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const legacyZoomMacro: Macro = {
      ...assignedMacro,
      trigger: { code: "Equal", ctrl: true, alt: false, shift: true, meta: false }
    };
    const binding = vi.fn(async () => ({ macros: [legacyZoomMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Equal",
      ctrlKey: true,
      key: "+",
      shiftKey: true
    });

    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: legacyZoomMacro.id });
  });

  it("leaves reserved runtime tab switching shortcuts to the browser", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const legacyTabMacro: Macro = {
      ...assignedMacro,
      trigger: { code: "Tab", ctrl: true, alt: false, shift: true, meta: false }
    };
    const binding = vi.fn(async () => ({ macros: [legacyTabMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      ctrlKey: true,
      key: "Tab",
      shiftKey: true
    });

    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: legacyTabMacro.id });
  });

  it("preserves Flyff text input focus and ignores keyboard events forwarded to the canvas", async () => {
    const { canvas } = createGameSurface(document);
    const input = document.createElement("input");
    input.id = "text_input";
    input.type = "text";
    document.body.append(input);
    const binding = vi.fn(async (request: unknown) => ({
      macros: [assignedMacro],
      statuses: isRecord(request) && request.type === "start" ? [runningStatus()] : []
    }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const canvasKeyDown = vi.fn();
    canvas.addEventListener("keydown", canvasKeyDown);
    const forwardedEvents: KeyboardEvent[] = [];
    input.addEventListener("keydown", (event) => {
      const forwarded = new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: event.code,
        ctrlKey: event.ctrlKey,
        isComposing: event.isComposing,
        key: event.key
      });
      forwardedEvents.push(forwarded);
      canvas.dispatchEvent(forwarded);
    });

    canvas.dispatchEvent(createMouseEvent(window, "pointerdown"));
    input.focus();
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "game-input-context",
      active: false
    }));

    const inputs = [
      { code: "KeyA", key: "a" },
      { code: "Digit1", key: "1" },
      { code: "Backspace", key: "Backspace" },
      { code: "Delete", key: "Delete" },
      { code: "ArrowLeft", key: "ArrowLeft" },
      { code: "Enter", key: "Enter" },
      { code: "F2", key: "F2" },
      { code: "KeyA", isComposing: true, key: "Process" }
    ];
    const originalEvents = inputs.map((init) => new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init
    }));
    originalEvents.forEach((event) => expect(input.dispatchEvent(event)).toBe(true));

    expect(document.activeElement).toBe(input);
    expect(originalEvents.every((event) => !event.defaultPrevented)).toBe(true);
    expect(forwardedEvents).toHaveLength(inputs.length);
    expect(forwardedEvents.every((event) => !event.defaultPrevented)).toBe(true);
    expect(canvasKeyDown).toHaveBeenCalledTimes(inputs.length);
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id });
  });

  it("pairs while-held shortcuts with one press and release while consuming auto-repeat", async () => {
    createGameSurface(document);
    const heldMacro: Macro = {
      ...assignedMacro,
      activationMode: "while_held",
      steps: [{ id: "step-1", type: "key", code: "F3", action: "hold_until_stop" }]
    };
    let isHeld = false;
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "press") isHeld = true;
      if (isRecord(request) && request.type === "release") isHeld = false;
      return {
        macros: [heldMacro],
        statuses: isHeld ? [runningStatus()] : []
      };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    const repeated = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2",
      repeat: true
    });
    expect(document.dispatchEvent(repeated)).toBe(false);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "press",
      macroId: heldMacro.id,
      pressId: expect.any(String)
    })));
    expect(getOverlayRoot(document).querySelector(".active-badge-shortcut")?.textContent)
      .toBe("F2");
    expect(getOverlayRoot(document).querySelector(".active-badge-behavior")?.textContent)
      .toContain("Tap or hold · Hold");
    expect(binding.mock.calls.filter(([request]) => isRecord(request) && request.type === "press")).toHaveLength(1);

    const pressRequest = binding.mock.calls
      .map(([request]) => request)
      .find((request) => isRecord(request) && request.type === "press") as Record<string, unknown>;
    const keyUp = new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    expect(document.dispatchEvent(keyUp)).toBe(false);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "release",
      macroId: heldMacro.id,
      pressId: pressRequest.pressId,
      releaseMode: "complete_first_iteration"
    }));
  });

  it("does not release a physical held shortcut for a suppressed synthetic keyup", async () => {
    createGameSurface(document);
    const heldMacro: Macro = { ...assignedMacro, activationMode: "while_held" };
    const binding = vi.fn(async () => ({ macros: [heldMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "press",
      macroId: heldMacro.id
    })));

    controller.suppressNextShortcut?.("F2", "keyup");
    document.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));
    await Promise.resolve();
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "release" }));

    document.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      macroId: heldMacro.id
    })));
  });

  it("releases a while-held shortcut when the source window loses focus", async () => {
    createGameSurface(document);
    const heldMacro: Macro = { ...assignedMacro, activationMode: "while_held" };
    const binding = vi.fn(async (_request: unknown) => ({ macros: [heldMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({ type: "press" })));
    window.dispatchEvent(new window.Event("blur"));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      macroId: heldMacro.id,
      releaseMode: "immediate"
    })));
  });

  it("matches release by physical code after modifiers are released", async () => {
    createGameSurface(document);
    const heldMacro: Macro = {
      ...assignedMacro,
      activationMode: "while_held",
      trigger: { ...assignedMacro.trigger!, ctrl: true }
    };
    const binding = vi.fn(async () => ({ macros: [heldMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    document.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2",
      ctrlKey: true
    }));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({ type: "press" })));
    document.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2",
      ctrlKey: false
    }));

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      macroId: heldMacro.id,
      releaseMode: "complete_first_iteration"
    })));
  });

  it("releases a while-held shortcut when the page becomes hidden or the overlay is disposed", async () => {
    createGameSurface(document);
    const heldMacro: Macro = { ...assignedMacro, activationMode: "while_held" };
    const binding = vi.fn(async (_request: unknown) => ({ macros: [heldMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({ type: "press" })));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new window.Event("visibilitychange"));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      releaseMode: "immediate"
    })));

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "press"
    )).toHaveLength(2));
    controller.dispose();
    await vi.waitFor(() => expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "release"
    )).toHaveLength(2));
    expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "release"
    ).every(([request]) => (request as Record<string, unknown>).releaseMode === "immediate")).toBe(true);
  });

  it("starts a macro even when the game already prevented the shortcut event", async () => {
    createGameSurface(document);
    const binding = vi.fn(async (request: unknown) => ({
      macros: [assignedMacro],
      statuses: isRecord(request) && request.type === "start" ? [runningStatus()] : []
    }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    event.preventDefault();

    document.dispatchEvent(event);

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id }));
  });

  it("captures macro shortcuts before game document handlers", async () => {
    createGameSurface(document);
    const gameKeyDown = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    document.addEventListener("keydown", gameKeyDown, true);
    const binding = vi.fn(async (request: unknown) => ({
      macros: [assignedMacro],
      statuses: isRecord(request) && request.type === "start" ? [runningStatus()] : []
    }));
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");

    document.removeEventListener("keydown", gameKeyDown, true);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id }));
    expect(gameKeyDown).not.toHaveBeenCalled();
  });

  it("does not let a stale editable active element block a canvas shortcut", async () => {
    const { canvas } = createGameSurface(document);
    const staleInput = document.createElement("input");
    document.body.append(staleInput);
    staleInput.focus();
    const binding = vi.fn(async (request: unknown) => ({
      macros: [assignedMacro],
      statuses: isRecord(request) && request.type === "start" ? [runningStatus()] : []
    }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });

    canvas.dispatchEvent(createMouseEvent(window, "pointerdown"));
    expect(document.activeElement).toBe(staleInput);
    canvas.dispatchEvent(event);

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id }));
  });

  it("lets disabled macro shortcuts reach the game", async () => {
    createGameSurface(document);
    const disabledMacro = { ...assignedMacro, enabled: false };
    const binding = vi.fn(async () => ({ macros: [disabledMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const pageKeyDown = vi.fn();
    document.addEventListener("keydown", pageKeyDown);
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });

    expect(document.dispatchEvent(event)).toBe(true);
    document.removeEventListener("keydown", pageKeyDown);

    expect(event.defaultPrevented).toBe(false);
    expect(pageKeyDown).toHaveBeenCalledOnce();
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "toggle" }));
  });

  it("disposes a detached overlay and stops its polling intervals", async () => {
    vi.useFakeTimers();
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ detached: true, macros: [], statuses: [] }));

      installOverlay(window, binding);
      await vi.advanceTimersByTimeAsync(0);

      expect(document.getElementById("rion-studio-macro-overlay-v60")).toBeNull();
      expect((window as OverlayTestWindow).__rionStudioMacroOverlay).toBeUndefined();
      const requestCountAfterDispose = binding.mock.calls.length;

      await vi.advanceTimersByTimeAsync(3_000);
      expect(binding).toHaveBeenCalledTimes(requestCountAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});

function installOverlay(
  targetWindow: Window,
  binding: (request: unknown) => Promise<unknown> = async () => ({ macros: [], statuses: [] })
): OverlayController {
  const overlayWindow = targetWindow as OverlayTestWindow;
  Object.defineProperty(overlayWindow, "rionStudioMacroOverlay", {
    configurable: true,
    value: binding
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

function dispatchShortcut(targetWindow: Window, code: string, key: string): void {
  const KeyboardEventConstructor = (targetWindow as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  targetWindow.document.dispatchEvent(new KeyboardEventConstructor("keydown", {
    bubbles: true,
    cancelable: true,
    code,
    key
  }));
}

function runningStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
