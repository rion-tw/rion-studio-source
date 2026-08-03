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

function keyEvent(type: "keydown" | "keyup", code: string, key: string): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code,
    composed: true,
    key
  });
}
