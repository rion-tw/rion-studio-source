// @vitest-environment jsdom

import { JSDOM } from "jsdom";
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
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "game-input-context",
      target: "document"
    })));
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

it("routes trusted runtime tab switching shortcuts through the capability bridge", async () => {
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
    const controlDown = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "ControlRight",
      ctrlKey: true,
      key: "Control"
    });
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      ctrlKey: true,
      key: "Tab",
      shiftKey: true
    });

    expect(canvas.dispatchEvent(controlDown)).toBe(true);
    expect(canvas.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(binding).toHaveBeenCalledWith({
      type: "runtime-tab-shortcut",
      direction: "previous",
      modifierCodes: ["ControlRight", "ShiftLeft"]
    });
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: legacyTabMacro.id });
  });

it("does not intercept Alt+Tab", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const binding = vi.fn(async () => ({ macros: [], statuses: [] }));
    installOverlay(window, binding);
    const event = new window.KeyboardEvent("keydown", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      code: "Tab",
      key: "Tab"
    });

    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "runtime-tab-shortcut"
    }));
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
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "game-input-context",
      target: "document"
    })));

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

it("preserves the Flyff caret when unbound Enter starts text editing from the canvas", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = 0;
    const input = document.createElement("input");
    input.id = "text_input";
    input.type = "text";
    input.value = "seed";
    input.hidden = true;
    document.body.append(input);
    const binding = vi.fn(async () => ({ macros: [assignedMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const eventOrder: string[] = [];
    const setSelectionRange = vi.spyOn(input, "setSelectionRange");
    input.addEventListener("focusin", () => eventOrder.push("focusin"));
    const canvasKeyDown = vi.fn((event: KeyboardEvent) => {
      eventOrder.push("keydown");
      if (event.code !== "Enter") return;
      input.hidden = false;
      input.value = "seed";
      input.setSelectionRange(input.value.length, input.value.length);
      eventOrder.push("selection");
      input.focus();
      eventOrder.push("focus-returned");
    });
    canvas.addEventListener("keydown", canvasKeyDown);
    const canvasKeyUp = vi.fn();
    canvas.addEventListener("keyup", canvasKeyUp);
    input.addEventListener("keyup", () => eventOrder.push("keyup"));
    canvas.focus();

    const keyDown = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter"
    });
    expect(canvas.dispatchEvent(keyDown)).toBe(true);
    const keyUp = new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter"
    });
    expect(input.dispatchEvent(keyUp)).toBe(true);
    await Promise.resolve();

    expect(keyDown.defaultPrevented).toBe(false);
    expect(keyUp.defaultPrevented).toBe(false);
    expect(canvasKeyDown).toHaveBeenCalledOnce();
    expect(canvasKeyUp).toHaveBeenCalledOnce();
    expect((canvasKeyUp.mock.calls[0]?.[0] as KeyboardEvent).isTrusted).toBe(false);
    expect(setSelectionRange).toHaveBeenCalledOnce();
    expect(setSelectionRange).toHaveBeenCalledWith(4, 4);
    expect(eventOrder).toEqual([
      "keydown",
      "selection",
      "focusin",
      "focus-returned",
      "keyup"
    ]);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("seed");
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id });
  });

it("records bounded content-free Flyff caret diagnostics in event order", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><canvas id='game'></canvas><input id='text_input' value='seed'></body></html>",
      { runScripts: "outside-only", url: "https://universe.flyff.com/play" }
    );
    const targetWindow = dom.window as unknown as Window;
    const targetDocument = targetWindow.document;
    const canvas = targetDocument.querySelector("canvas")!;
    const input = targetDocument.querySelector<HTMLInputElement>("#text_input")!;
    const binding = vi.fn(async (_request: unknown) => ({ macros: [], statuses: [] }));
    const controller = installOverlay(targetWindow, binding);
    const KeyboardEventConstructor = (targetWindow as unknown as {
      KeyboardEvent: typeof KeyboardEvent;
    }).KeyboardEvent;
    canvas.addEventListener("keydown", (event) => {
      if (event.code !== "Enter") return;
      input.value = "seed";
      input.setSelectionRange(4, 4);
      input.focus();
    });
    canvas.tabIndex = 0;
    canvas.focus();

    canvas.dispatchEvent(new KeyboardEventConstructor("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter"
    }));
    input.dispatchEvent(new KeyboardEventConstructor("keyup", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter"
    }));
    await vi.waitFor(() => expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "flyff-caret-diagnostic"
    )).toHaveLength(8));

    const diagnostics = binding.mock.calls
      .map(([request]) => request)
      .filter((request): request is Record<string, unknown> =>
        isRecord(request) && request.type === "flyff-caret-diagnostic"
      );
    expect(diagnostics.map((request) => request.event)).toEqual([
      "keydown",
      "set-selection-before",
      "set-selection-after",
      "focus-before",
      "keyup",
      "focusin",
      "focus-after",
      "keyup"
    ]);
    expect(diagnostics.map((request) => request.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(diagnostics.find((request) => request.event === "set-selection-after"))
      .toMatchObject({
        requestedEnd: 4,
        requestedStart: 4,
        selectionEnd: 4,
        selectionStart: 4,
        textEditInvocation: 1,
        valueLength: 4
      });
    expect(diagnostics.filter((request) => request.event === "keyup")).toEqual([
      expect.objectContaining({ isTrusted: false }),
      expect.objectContaining({ isTrusted: false })
    ]);
    expect(diagnostics.every((request) =>
      !("value" in request) && !("chatText" in request)
    )).toBe(true);

    controller.dispose();
    dom.window.close();
  });

it("pairs while-held shortcuts with one managed press and release while consuming auto-repeat", async () => {
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
    expect(repeated.defaultPrevented).toBe(true);
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
    expect(keyUp.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "release",
      macroId: heldMacro.id,
      pressId: pressRequest.pressId,
      releaseMode: "complete_first_iteration"
    }));
  });

it("finishes an early keyup only after the while-held press acknowledgement", async () => {
    createGameSurface(document);
    const heldMacro: Macro = { ...assignedMacro, activationMode: "while_held" };
    const requests: string[] = [];
    let resolvePress: ((value: unknown) => void) | undefined;
    const binding = vi.fn((request: unknown) => {
      if (!isRecord(request) || request.type === "list" || request.type === "game-input-context") {
        return Promise.resolve({ macros: [heldMacro], statuses: [] });
      }
      requests.push(String(request.type));
      if (request.type === "press") {
        return new Promise((resolve) => {
          resolvePress = resolve;
        });
      }
      return Promise.resolve({ macros: [heldMacro], statuses: [] });
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(requests).toEqual(["press"]));
    document.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));

    await Promise.resolve();
    expect(requests).toEqual(["press"]);
    resolvePress?.({ macros: [heldMacro], statuses: [runningStatus()] });
    await vi.waitFor(() => expect(requests).toEqual(["press", "release"]));
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      releaseMode: "complete_first_iteration"
    }));
    await vi.waitFor(() => expect(binding.mock.calls.filter(
      ([request]) => isRecord(request) && request.type === "list"
    ).length).toBeGreaterThan(1));
    expect(getOverlayRoot(document).querySelector(".active-badge")).toBeNull();
  });

it("sends immediate blur cleanup before a slow while-held press acknowledgement", async () => {
    createGameSurface(document);
    const heldMacro: Macro = { ...assignedMacro, activationMode: "while_held" };
    const requests: string[] = [];
    let resolvePress: ((value: unknown) => void) | undefined;
    const binding = vi.fn((request: unknown) => {
      if (!isRecord(request) || request.type === "list" || request.type === "game-input-context") {
        return Promise.resolve({ macros: [heldMacro], statuses: [] });
      }
      requests.push(String(request.type));
      if (request.type === "press") {
        return new Promise((resolve) => {
          resolvePress = resolve;
        });
      }
      return Promise.resolve({ macros: [heldMacro], statuses: [] });
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(requests).toEqual(["press"]));
    window.dispatchEvent(new window.Event("blur"));

    await vi.waitFor(() => expect(requests).toEqual(["press", "release"]));
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      releaseMode: "immediate"
    }));
    resolvePress?.({ macros: [heldMacro], statuses: [runningStatus()] });
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

    controller.suppressNextShortcut?.("test-keyup", "F2", "keyup");
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

it("consumes a late physical keyup after blur cleans a while-held shortcut", async () => {
    createGameSurface(document);
    const heldMacro: Macro = { ...assignedMacro, activationMode: "while_held" };
    const binding = vi.fn(async () => ({ macros: [heldMacro], statuses: [] }));
    const controller = installOverlay(window, binding);
    await controller.refresh();
    const pageKeyUp = vi.fn();
    document.addEventListener("keyup", pageKeyUp);

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "press"
    })));
    window.dispatchEvent(new window.Event("blur"));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "release",
      releaseMode: "immediate"
    })));

    const lateKeyUp = new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    expect(document.dispatchEvent(lateKeyUp)).toBe(false);
    expect(lateKeyUp.defaultPrevented).toBe(true);
    expect(pageKeyUp).not.toHaveBeenCalled();
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
    document.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id }));
  });

it("lets game handlers observe macro shortcuts before toggling after keyup", async () => {
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
    Object.assign(binding, {
      managedShortcutKeyPhase: vi.fn(async (request: { code: string; phase: string }) => {
        if (request.phase !== "replay") return;
        expect(controller.suppressNextShortcut?.(
          "managed-game-down",
          request.code,
          "keydown"
        )).toBe(true);
        document.dispatchEvent(new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: request.code,
          key: "F2"
        }));
        expect(controller.suppressNextShortcut?.(
          "managed-game-up",
          request.code,
          "keyup"
        )).toBe(true);
        document.dispatchEvent(new window.KeyboardEvent("keyup", {
          bubbles: true,
          cancelable: true,
          code: request.code,
          key: "F2"
        }));
      })
    });
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    document.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id }));
    expect(gameKeyDown).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", gameKeyDown, true);
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
    canvas.dispatchEvent(new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    }));

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

      expect(document.getElementById("rion-studio-macro-overlay-v61")).toBeNull();
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
  Object.assign(binding, { managedShortcutKeyPhase: async () => undefined });
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
  const root = ownerDocument.getElementById("rion-studio-macro-overlay-v61")?.shadowRoot;
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
