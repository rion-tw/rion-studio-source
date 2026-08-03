// @vitest-environment jsdom

import { readSourceTreeSync as readFileSync } from "./helpers/readSourceTree";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  .replace(JSON.stringify("__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__"), "() => true")
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
  dispose: () => void;
  refresh: () => Promise<void>;
  releaseForwardedMacroKey: (code: string) => boolean;
  suppressNextShortcut: (
    code: string,
    phase?: "keydown" | "keyup",
    expiresAt?: number
  ) => boolean;
}

interface OverlayTestWindow extends Window {
  __rionStudioMacroOverlay?: OverlayController;
  rionStudioMacroOverlay?: (request: unknown) => Promise<unknown>;
  __rionTestCoordinateMeasurementModuleImporter?: (url: string) => Promise<unknown>;
}

describe("macro overlay native key guard", () => {
  beforeEach(() => {
    document.body.replaceChildren();
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
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("prevents editable defaults without stopping macro key propagation", () => {
    const controller = installOverlay();
    const controls = createEditableControls();

    for (const [label, control] of controls) {
      control.focus();
      const targetListener = vi.fn();
      const documentListener = vi.fn();
      const beforeInputListener = vi.fn();
      const inputListener = vi.fn();
      control.addEventListener("keydown", targetListener, { once: true });
      control.addEventListener("beforeinput", beforeInputListener, { once: true });
      control.addEventListener("input", inputListener, { once: true });
      document.addEventListener("keydown", documentListener, { once: true });
      expect(controller.suppressNextShortcut("KeyA", "keydown")).toBe(true);

      const event = keyEvent("keydown", "KeyA", "a");
      expect(control.dispatchEvent(event), label).toBe(false);
      expect(event.defaultPrevented, label).toBe(true);
      expect(targetListener).toHaveBeenCalledOnce();
      expect(documentListener).toHaveBeenCalledOnce();
      expect(beforeInputListener).not.toHaveBeenCalled();
      expect(inputListener).not.toHaveBeenCalled();
    }
  });

  it("does not affect unarmed, mismatched, or expired player input", () => {
    const controller = installOverlay();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    const physical = keyEvent("keydown", "KeyA", "a");
    expect(input.dispatchEvent(physical)).toBe(true);
    expect(physical.defaultPrevented).toBe(false);

    expect(controller.suppressNextShortcut("KeyA", "keydown")).toBe(true);
    const mismatch = keyEvent("keydown", "KeyB", "b");
    expect(input.dispatchEvent(mismatch)).toBe(true);
    expect(mismatch.defaultPrevented).toBe(false);

    const armed = keyEvent("keydown", "KeyA", "a");
    expect(input.dispatchEvent(armed)).toBe(false);
    expect(armed.defaultPrevented).toBe(true);
    expect(controller.suppressNextShortcut("KeyA", "keydown", Date.now() - 1)).toBe(false);
  });

  it("prevents text, deletion, newline, and navigation defaults for macro keys", () => {
    const controller = installOverlay();
    const input = document.createElement("textarea");
    input.value = "seed";
    document.body.append(input);
    input.focus();

    for (const [code, key] of [
      ["KeyA", "a"],
      ["Backspace", "Backspace"],
      ["Delete", "Delete"],
      ["Enter", "Enter"],
      ["Space", " "],
      ["ArrowLeft", "ArrowLeft"]
    ]) {
      expect(controller.suppressNextShortcut(code, "keydown")).toBe(true);
      const event = keyEvent("keydown", code, key);
      expect(input.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(input.value).toBe("seed");
    }
  });

  it("keeps a canvas macro key untouched even when document.activeElement is stale", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    const staleInput = document.createElement("input");
    document.body.append(canvas, staleInput);
    staleInput.focus();
    canvas.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    expect(document.activeElement).toBe(staleInput);
    expect(controller.suppressNextShortcut("KeyA", "keydown")).toBe(true);

    const event = keyEvent("keydown", "KeyA", "a");
    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it("always propagates an armed keyup without changing its default state", () => {
    const controller = installOverlay();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const targetListener = vi.fn();
    const documentListener = vi.fn();
    input.addEventListener("keyup", targetListener);
    document.addEventListener("keyup", documentListener);
    expect(controller.suppressNextShortcut("KeyA", "keyup")).toBe(true);

    const event = keyEvent("keyup", "KeyA", "a");
    expect(input.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(targetListener).toHaveBeenCalledOnce();
    expect(documentListener).toHaveBeenCalledOnce();
  });

  it("suppresses macro shortcut feedback while leaving the game event visible", async () => {
    const binding = vi.fn(async () => ({
      macros: [{
        id: "macro-1",
        enabled: true,
        name: "Guard feedback",
        roleIds: ["role-1"],
        trigger: { code: "F2", ctrl: false, alt: false, shift: false, meta: false },
        repeat: { type: "once" },
        steps: []
      }],
      statuses: []
    }));
    const controller = installOverlay(binding);
    await controller.refresh();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const gameListener = vi.fn();
    canvas.addEventListener("keydown", gameListener);
    expect(controller.suppressNextShortcut("F2", "keydown")).toBe(true);

    const event = keyEvent("keydown", "F2", "F2");
    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(gameListener).toHaveBeenCalledOnce();
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: "macro-1" });
  });

  it("forwards an editable macro key only to the remembered canvas target", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    const input = document.createElement("input");
    input.value = "seed";
    document.body.append(canvas, input);
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    input.focus();
    input.setSelectionRange(2, 2);
    const canvasEvents: KeyboardEvent[] = [];
    const documentListener = vi.fn();
    canvas.addEventListener("keydown", (event) => canvasEvents.push(event));
    document.addEventListener("keydown", documentListener);
    expect(controller.suppressNextShortcut("KeyW", "keydown")).toBe(true);
    const original = keyEvent("keydown", "KeyW", "w", {
      ctrlKey: true,
      location: 1,
      repeat: true
    });
    Object.defineProperties(original, {
      charCode: { configurable: true, value: 119 },
      keyCode: { configurable: true, value: 87 },
      which: { configurable: true, value: 87 }
    });

    expect(input.dispatchEvent(original)).toBe(false);

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("seed");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
    expect(original.defaultPrevented).toBe(true);
    expect(documentListener).toHaveBeenCalledOnce();
    expect(documentListener).toHaveBeenCalledWith(original);
    expect(canvasEvents).toHaveLength(1);
    const [forwarded] = canvasEvents;
    expect(forwarded).not.toBe(original);
    expect(forwarded.target).toBe(canvas);
    expect(forwarded.bubbles).toBe(false);
    expect(forwarded.composed).toBe(false);
    expect(forwarded.defaultPrevented).toBe(false);
    expect(forwarded.code).toBe("KeyW");
    expect(forwarded.key).toBe("w");
    expect(forwarded.ctrlKey).toBe(true);
    expect(forwarded.location).toBe(1);
    expect(forwarded.repeat).toBe(true);
    expect(forwarded.keyCode).toBe(87);
    expect(forwarded.which).toBe(87);
    expect(forwarded.charCode).toBe(119);
  });

  it("uses the only canvas in an open shadow root without prior interaction", () => {
    const controller = installOverlay();
    const host = document.createElement("div");
    const canvas = document.createElement("canvas");
    host.attachShadow({ mode: "open" }).append(canvas);
    const input = document.createElement("textarea");
    document.body.append(host, input);
    input.focus();
    const canvasKeyDown = vi.fn();
    canvas.addEventListener("keydown", canvasKeyDown);
    expect(controller.suppressNextShortcut("KeyA", "keydown")).toBe(true);

    input.dispatchEvent(keyEvent("keydown", "KeyA", "a"));

    expect(canvasKeyDown).toHaveBeenCalledOnce();
  });

  it("does not guess a canvas when multiple targets have no interaction history", () => {
    const controller = installOverlay();
    const firstCanvas = document.createElement("canvas");
    const secondCanvas = document.createElement("canvas");
    const input = document.createElement("input");
    document.body.append(firstCanvas, secondCanvas, input);
    input.focus();
    const firstKeyDown = vi.fn();
    const secondKeyDown = vi.fn();
    firstCanvas.addEventListener("keydown", firstKeyDown);
    secondCanvas.addEventListener("keydown", secondKeyDown);
    expect(controller.suppressNextShortcut("KeyA", "keydown")).toBe(true);

    const original = keyEvent("keydown", "KeyA", "a");
    input.dispatchEvent(original);

    expect(original.defaultPrevented).toBe(true);
    expect(firstKeyDown).not.toHaveBeenCalled();
    expect(secondKeyDown).not.toHaveBeenCalled();
  });

  it("replaces a detached remembered canvas with the only connected target", () => {
    const controller = installOverlay();
    const detachedCanvas = document.createElement("canvas");
    const connectedCanvas = document.createElement("canvas");
    const input = document.createElement("input");
    document.body.append(detachedCanvas);
    detachedCanvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    detachedCanvas.remove();
    document.body.append(connectedCanvas, input);
    input.focus();
    const connectedKeyDown = vi.fn();
    connectedCanvas.addEventListener("keydown", connectedKeyDown);
    expect(controller.suppressNextShortcut("KeyA", "keydown")).toBe(true);

    input.dispatchEvent(keyEvent("keydown", "KeyA", "a"));

    expect(connectedKeyDown).toHaveBeenCalledOnce();
  });

  it("reasserts a held macro key after editable focus and routes its release", async () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    const input = document.createElement("input");
    const secondInput = document.createElement("input");
    document.body.append(canvas, input, secondInput);
    const canvasKeyDown = vi.fn();
    const canvasKeyUp = vi.fn();
    canvas.addEventListener("keydown", canvasKeyDown);
    canvas.addEventListener("keyup", canvasKeyUp);
    canvas.focus();
    expect(controller.suppressNextShortcut("KeyW", "keydown")).toBe(true);
    canvas.dispatchEvent(keyEvent("keydown", "KeyW", "w"));
    expect(canvasKeyDown).toHaveBeenCalledOnce();

    input.focus();
    await Promise.resolve();

    expect(document.activeElement).toBe(input);
    expect(canvasKeyDown).toHaveBeenCalledTimes(2);

    secondInput.focus();
    await Promise.resolve();
    expect(canvasKeyDown).toHaveBeenCalledTimes(2);
    expect(controller.suppressNextShortcut("KeyW", "keyup")).toBe(true);
    const release = keyEvent("keyup", "KeyW", "w");
    secondInput.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(false);
    expect(canvasKeyUp).toHaveBeenCalledOnce();

    canvas.focus();
    input.focus();
    await Promise.resolve();
    expect(canvasKeyDown).toHaveBeenCalledTimes(2);
  });

  it("releases a forwarded held key when its armed keyup expires", () => {
    vi.useFakeTimers();
    try {
      const controller = installOverlay();
      const canvas = document.createElement("canvas");
      canvas.tabIndex = 0;
      document.body.append(canvas);
      const canvasKeyUp = vi.fn();
      canvas.addEventListener("keyup", canvasKeyUp);
      canvas.focus();
      expect(controller.suppressNextShortcut("KeyW", "keydown")).toBe(true);
      canvas.dispatchEvent(keyEvent("keydown", "KeyW", "w"));
      expect(controller.suppressNextShortcut("KeyW", "keyup", Date.now() + 20)).toBe(true);

      vi.advanceTimersByTime(21);

      expect(canvasKeyUp).toHaveBeenCalledOnce();
      expect(controller.releaseForwardedMacroKey("KeyW")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reasserts held modifiers before the main key and releases them in native order", async () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    const input = document.createElement("input");
    document.body.append(canvas, input);
    const keyDownCodes: string[] = [];
    const keyUpCodes: string[] = [];
    canvas.addEventListener("keydown", (event) => keyDownCodes.push(event.code));
    canvas.addEventListener("keyup", (event) => keyUpCodes.push(event.code));
    canvas.focus();
    expect(controller.suppressNextShortcut("ControlLeft", "keydown")).toBe(true);
    canvas.dispatchEvent(keyEvent("keydown", "ControlLeft", "Control", { ctrlKey: true }));
    expect(controller.suppressNextShortcut("KeyW", "keydown")).toBe(true);
    canvas.dispatchEvent(keyEvent("keydown", "KeyW", "w", { ctrlKey: true }));

    input.focus();
    await Promise.resolve();

    expect(keyDownCodes).toEqual(["ControlLeft", "KeyW", "ControlLeft", "KeyW"]);
    expect(controller.suppressNextShortcut("KeyW", "keyup")).toBe(true);
    input.dispatchEvent(keyEvent("keyup", "KeyW", "w", { ctrlKey: true }));
    expect(controller.suppressNextShortcut("ControlLeft", "keyup")).toBe(true);
    input.dispatchEvent(keyEvent("keyup", "ControlLeft", "Control"));
    expect(keyUpCodes).toEqual(["KeyW", "ControlLeft"]);
  });

  it("does not forward an unarmed physical key to a unique canvas", () => {
    installOverlay();
    const canvas = document.createElement("canvas");
    const input = document.createElement("input");
    document.body.append(canvas, input);
    input.focus();
    const canvasKeyDown = vi.fn();
    canvas.addEventListener("keydown", canvasKeyDown);

    const physical = keyEvent("keydown", "KeyA", "a");
    input.dispatchEvent(physical);

    expect(physical.defaultPrevented).toBe(false);
    expect(canvasKeyDown).not.toHaveBeenCalled();
  });
});

function installOverlay(
  binding: (request: unknown) => Promise<unknown> = async () => ({ macros: [], statuses: [] })
): OverlayController {
  const overlayWindow = window as OverlayTestWindow;
  Object.defineProperty(overlayWindow, "rionStudioMacroOverlay", {
    configurable: true,
    value: binding
  });
  window.eval(MACRO_OVERLAY_SCRIPT);
  if (!overlayWindow.__rionStudioMacroOverlay) {
    throw new Error("Expected the macro overlay controller to be installed.");
  }
  return overlayWindow.__rionStudioMacroOverlay;
}

function createEditableControls(): Array<[string, HTMLElement]> {
  const input = document.createElement("input");
  const textarea = document.createElement("textarea");
  const select = document.createElement("select");
  select.append(document.createElement("option"));
  const contentEditable = document.createElement("div");
  contentEditable.setAttribute("contenteditable", "true");
  contentEditable.tabIndex = 0;
  const textbox = document.createElement("div");
  textbox.setAttribute("role", "textbox");
  textbox.tabIndex = 0;
  const shadowHost = document.createElement("div");
  const shadowInput = document.createElement("input");
  shadowHost.attachShadow({ mode: "open" }).append(shadowInput);
  document.body.append(input, textarea, select, contentEditable, textbox, shadowHost);
  return [
    ["input", input],
    ["textarea", textarea],
    ["select", select],
    ["contenteditable", contentEditable],
    ["ARIA textbox", textbox],
    ["open Shadow DOM input", shadowInput]
  ];
}

function keyEvent(
  type: "keydown" | "keyup",
  code: string,
  key: string,
  init: KeyboardEventInit = {}
): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code,
    composed: true,
    key,
    ...init
  });
}
