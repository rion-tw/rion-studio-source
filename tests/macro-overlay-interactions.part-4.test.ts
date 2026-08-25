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
  clearSuppressedShortcut: (dispatchId: string) => boolean;
  dispose: () => void;
  physicalModifierCodes: () => string[];
  refresh: () => Promise<void>;
  releaseForwardedMacroKey: (code: string) => boolean;
  suppressNextModifierProjection: (dispatchId: string, code: string) => boolean;
  suppressNextShortcut: (
    dispatchId: string,
    code: string,
    phase?: "keydown" | "keyup"
  ) => boolean;
}

interface OverlayTestWindow extends Window {
  __rionStudioMacroOverlay?: OverlayController;
  rionStudioMacroOverlay?: OverlayBinding;
  __rionTestCoordinateMeasurementModuleImporter?: (url: string) => Promise<unknown>;
}

interface OverlayBinding {
  (request: unknown): Promise<unknown>;
  managedShortcutKeyPhase?: (request: ManagedShortcutKeyPhase) => Promise<unknown>;
  macroKeyObserved?: (observation: MacroKeyObservation) => Promise<unknown>;
  physicalKeyCleanup?: (request: {
    codes: string[];
    releaseId: string;
  }) => Promise<unknown>;
  shortcutLifecycle?: (event: {
    code: string;
    macroId: string;
    phase: "physical-keydown-managed" | "chord-released" | "managed-replay-acknowledged"
      | "managed-keydown-acknowledged" | "managed-keyup-acknowledged" | "macro-dispatched";
  }) => Promise<unknown>;
}

interface ManagedShortcutKeyPhase {
  code: string;
  macroId: string;
  modifierCodes: string[];
  phase: "replay" | "keyDown" | "keyUp";
  pressId: string;
}

interface MacroKeyObservation {
  code: string;
  dispatchId: string;
  phase: "keydown" | "keyup";
}

let testDispatchSequence = 0;

function armShortcut(
  controller: OverlayController,
  code: string,
  phase: "keydown" | "keyup" = "keydown"
): string {
  const dispatchId = `test-dispatch-${++testDispatchSequence}`;
  expect(controller.suppressNextShortcut(dispatchId, code, phase)).toBe(true);
  return dispatchId;
}

function armModifierProjection(controller: OverlayController, code: string): string {
  const dispatchId = `test-dispatch-${++testDispatchSequence}`;
  expect(controller.suppressNextModifierProjection(dispatchId, code)).toBe(true);
  return dispatchId;
}

describe("macro overlay native key guard", () => {
  beforeEach(() => {
    testDispatchSequence = 0;
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
      armShortcut(controller, "KeyA");

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

    const dispatchId = armShortcut(controller, "KeyA");
    const mismatch = keyEvent("keydown", "KeyB", "b");
    expect(input.dispatchEvent(mismatch)).toBe(true);
    expect(mismatch.defaultPrevented).toBe(false);

    const armed = keyEvent("keydown", "KeyA", "a");
    expect(input.dispatchEvent(armed)).toBe(false);
    expect(armed.defaultPrevented).toBe(true);
    expect(controller.clearSuppressedShortcut(dispatchId)).toBe(false);
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
      armShortcut(controller, code);
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
    armShortcut(controller, "KeyA");

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
    armShortcut(controller, "KeyA", "keyup");

    const event = keyEvent("keyup", "KeyA", "a");
    expect(input.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(targetListener).toHaveBeenCalledOnce();
    expect(documentListener).toHaveBeenCalledOnce();
  });

  it("suppresses macro shortcut feedback while leaving the game event visible", async () => {
    const binding = vi.fn(async (_request: unknown) => ({
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
    armShortcut(controller, "F2");

    const event = keyEvent("keydown", "F2", "F2");
    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(gameListener).toHaveBeenCalledOnce();
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: "macro-1" });
  });

  it("runs consecutive physical shortcuts once while guarded same-key output cannot reenter", async () => {
    const macros = [
      {
        id: "macro-two",
        enabled: true,
        name: "Shift 2",
        roleIds: ["role-1"],
        shortcutSourceScope: { type: "all_execution_roles" },
        trigger: { code: "Digit2", ctrl: false, alt: false, shift: true, meta: false },
        repeat: { type: "once" },
        steps: []
      },
      {
        id: "macro-three",
        enabled: true,
        name: "Shift 3",
        roleIds: ["role-1"],
        shortcutSourceScope: { type: "all_execution_roles" },
        trigger: { code: "Digit3", ctrl: false, alt: false, shift: true, meta: false },
        repeat: { type: "once" },
        steps: []
      }
    ];
    const actionTimeline: string[] = [];
    const shortcutLifecycle = vi.fn(async (_event: {
      code: string;
      macroId: string;
      phase: "physical-keydown-managed" | "chord-released" | "managed-replay-acknowledged"
        | "macro-dispatched";
    }) => undefined);
    const binding = vi.fn(async (request: unknown) => {
      if (
        typeof request === "object"
        && request !== null
        && (request as { type?: string }).type === "toggle"
      ) {
        actionTimeline.push(`toggle:${String((request as { macroId?: unknown }).macroId)}`);
      }
      return {
        macros,
        shortcutMacroIds: macros.map(({ id }) => id),
        statuses: []
      };
    });
    Object.assign(binding, { shortcutLifecycle });
    const controller = installOverlay(binding as OverlayBinding);
    (binding as OverlayBinding).managedShortcutKeyPhase = vi.fn(async (request) => {
      const dispatch = (type: "keydown" | "keyup", code: string, shiftKey: boolean) => {
        armShortcut(controller, code, type);
        document.dispatchEvent(keyEvent(
          type,
          code,
          code === "ShiftLeft" ? "Shift" : code === "Digit2" ? "@" : "#",
          { shiftKey }
        ));
      };
      if (request.phase === "replay") {
        for (const code of request.modifierCodes) dispatch("keydown", code, true);
        dispatch("keydown", request.code, true);
        dispatch("keyup", request.code, true);
        for (const code of [...request.modifierCodes].reverse()) dispatch("keyup", code, false);
      }
    });
    await controller.refresh();
    const gameEvents: string[] = [];
    const gameHeldCodes = new Set<string>();
    const gameChordActivations: string[] = [];
    document.addEventListener("keydown", (event) => {
      gameEvents.push(`down:${event.code}`);
      actionTimeline.push(`down:${event.code}`);
      gameHeldCodes.add(event.code);
      if (gameHeldCodes.has("ShiftLeft") && gameHeldCodes.has("Digit2")) {
        gameChordActivations.push("Shift+Digit2");
      }
      if (gameHeldCodes.has("ShiftLeft") && gameHeldCodes.has("Digit3")) {
        gameChordActivations.push("Shift+Digit3");
      }
    });
    document.addEventListener("keyup", (event) => {
      gameEvents.push(`up:${event.code}`);
      actionTimeline.push(`up:${event.code}`);
      gameHeldCodes.delete(event.code);
    });

    document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    const physicalTwoDown = keyEvent("keydown", "Digit2", "@", { shiftKey: true });
    expect(document.dispatchEvent(physicalTwoDown)).toBe(false);
    expect(physicalTwoDown.defaultPrevented).toBe(true);
    const physicalTwoUp = keyEvent("keyup", "Digit2", "@", { shiftKey: true });
    expect(document.dispatchEvent(physicalTwoUp)).toBe(false);
    expect(physicalTwoUp.defaultPrevented).toBe(true);
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: "macro-two" });
    document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "toggle",
      macroId: "macro-two"
    }));
    expect(gameChordActivations).toEqual(["Shift+Digit2"]);
    expect([...gameHeldCodes]).toEqual([]);

    document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    expect(gameChordActivations).toEqual(["Shift+Digit2"]);
    expect([...gameHeldCodes]).toEqual([]);

    armShortcut(controller, "Digit2");
    document.dispatchEvent(keyEvent("keydown", "Digit2", "@", { shiftKey: true }));
    armShortcut(controller, "Digit2", "keyup");
    document.dispatchEvent(keyEvent("keyup", "Digit2", "@", { shiftKey: true }));
    document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    const physicalThreeDown = keyEvent("keydown", "Digit3", "#", { shiftKey: true });
    expect(document.dispatchEvent(physicalThreeDown)).toBe(false);
    document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: "macro-three" });
    const physicalThreeUp = keyEvent("keyup", "Digit3", "#", { shiftKey: true });
    expect(document.dispatchEvent(physicalThreeUp)).toBe(false);
    expect(physicalThreeUp.defaultPrevented).toBe(true);
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: "macro-three" });
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "toggle",
      macroId: "macro-three"
    }));

    const toggleIds = binding.mock.calls
      .map(([request]) => request)
      .filter((request): request is Record<string, unknown> =>
        typeof request === "object" && request !== null && "type" in request
        && (request as { type?: string }).type === "toggle"
      )
      .map((request) => request.macroId);
    expect(toggleIds).toEqual(["macro-two", "macro-three"]);
    expect(gameChordActivations).toEqual(["Shift+Digit2", "Shift+Digit3"]);
    expect([...gameHeldCodes]).toEqual([]);
    expect(shortcutLifecycle.mock.calls.map(([event]) => [event.macroId, event.phase])).toEqual([
      ["macro-two", "physical-keydown-managed"],
      ["macro-two", "chord-released"],
      ["macro-two", "managed-replay-acknowledged"],
      ["macro-two", "macro-dispatched"],
      ["macro-three", "physical-keydown-managed"],
      ["macro-three", "chord-released"],
      ["macro-three", "managed-replay-acknowledged"],
      ["macro-three", "macro-dispatched"]
    ]);
    expect(actionTimeline.indexOf("toggle:macro-two")).toBeGreaterThan(
      actionTimeline.indexOf("up:ShiftLeft")
    );
    expect(actionTimeline.indexOf("toggle:macro-three")).toBeGreaterThan(
      actionTimeline.lastIndexOf("up:ShiftLeft")
    );
    expect(gameEvents).toEqual([
      "down:ShiftLeft",
      "up:ShiftLeft",
      "down:ShiftLeft",
      "down:Digit2",
      "up:Digit2",
      "up:ShiftLeft",
      "down:ShiftLeft",
      "up:ShiftLeft",
      "down:Digit2",
      "up:Digit2",
      "down:ShiftLeft",
      "up:ShiftLeft",
      "down:ShiftLeft",
      "down:Digit3",
      "up:Digit3",
      "up:ShiftLeft"
    ]);
    expect(controller.physicalModifierCodes()).toEqual([]);
  });

  it("consumes a matched key repeat without replaying or toggling twice", async () => {
    const macro = {
      id: "macro-two",
      enabled: true,
      name: "Shift 2",
      roleIds: ["role-1"],
      shortcutSourceScope: { type: "all_execution_roles" },
      trigger: { code: "Digit2", ctrl: false, alt: false, shift: true, meta: false },
      repeat: { type: "once" },
      steps: []
    };
    const binding = vi.fn(async (_request: unknown) => ({
      macros: [macro],
      shortcutMacroIds: [macro.id],
      statuses: []
    }));
    const controller = installOverlay(binding);
    await controller.refresh();
    const pageKeyDown = vi.fn();
    document.addEventListener("keydown", pageKeyDown);

    document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    const initial = keyEvent("keydown", "Digit2", "@", { shiftKey: true });
    expect(document.dispatchEvent(initial)).toBe(false);
    expect(initial.defaultPrevented).toBe(true);
    const repeated = keyEvent("keydown", "Digit2", "@", { repeat: true, shiftKey: true });
    expect(document.dispatchEvent(repeated)).toBe(false);
    expect(repeated.defaultPrevented).toBe(true);
    const released = keyEvent("keyup", "Digit2", "@", { shiftKey: true });
    expect(document.dispatchEvent(released)).toBe(false);
    expect(released.defaultPrevented).toBe(true);
    document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "toggle",
      macroId: macro.id
    }));
    expect(pageKeyDown.mock.calls.filter(([event]) => event.code === "Digit2")).toHaveLength(0);
    expect((binding as OverlayBinding).managedShortcutKeyPhase).toHaveBeenCalledOnce();
    expect((binding as OverlayBinding).managedShortcutKeyPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "replay" })
    );
    expect(binding.mock.calls.filter(([request]) =>
      typeof request === "object" && request !== null
      && (request as { type?: string }).type === "toggle"
    )).toHaveLength(1);
  });

  it("fails closed without managed shortcut acknowledgement", async () => {
    const macro = {
      id: "macro-two",
      enabled: true,
      name: "Shift 2",
      roleIds: ["role-1"],
      shortcutSourceScope: { type: "all_execution_roles" },
      trigger: { code: "Digit2", ctrl: false, alt: false, shift: true, meta: false },
      repeat: { type: "once" },
      steps: []
    };
    const binding = vi.fn(async () => ({
      macros: [macro],
      shortcutMacroIds: [macro.id],
      statuses: []
    })) as OverlayBinding;
    const controller = installOverlay(binding);
    delete binding.managedShortcutKeyPhase;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await controller.refresh();

    document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    document.dispatchEvent(keyEvent("keydown", "Digit2", "@", { shiftKey: true }));
    document.dispatchEvent(keyEvent("keyup", "Digit2", "@", { shiftKey: true }));
    document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
      "Unable to replay a managed Rion Studio shortcut.",
      expect.any(Error)
    ));
    expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: macro.id });
    warning.mockRestore();
  });

  it("passes a conflicting physical shortcut through without choosing a macro", async () => {
    const trigger = { code: "Digit2", ctrl: false, alt: false, shift: true, meta: false };
    const macros = ["macro-a", "macro-b"].map((id) => ({
      id,
      enabled: true,
      name: id,
      roleIds: ["role-1"],
      shortcutSourceScope: { type: "all_execution_roles" },
      trigger,
      repeat: { type: "once" },
      steps: []
    }));
    const binding = vi.fn(async () => ({
      macros,
      shortcutMacroIds: macros.map(({ id }) => id),
      statuses: []
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = installOverlay(binding);
    await controller.refresh();
    const pageCodes: string[] = [];
    document.addEventListener("keydown", (event) => pageCodes.push(`down:${event.code}`));
    document.addEventListener("keyup", (event) => pageCodes.push(`up:${event.code}`));

    document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    const mainDown = keyEvent("keydown", "Digit2", "@", { shiftKey: true });
    expect(document.dispatchEvent(mainDown)).toBe(true);
    const mainUp = keyEvent("keyup", "Digit2", "@", { shiftKey: true });
    expect(document.dispatchEvent(mainUp)).toBe(true);
    document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    await Promise.resolve();

    expect(mainDown.defaultPrevented).toBe(false);
    expect(mainUp.defaultPrevented).toBe(false);
    expect(pageCodes).toEqual([
      "down:ShiftLeft",
      "down:Digit2",
      "up:Digit2",
      "up:ShiftLeft"
    ]);
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "toggle" }));
    expect(warning).toHaveBeenCalledWith(
      "Multiple Rion Studio macros use the same shortcut for this role."
    );
    warning.mockRestore();
  });

  it.each(["blur", "pagehide", "hidden", "dispose"] as const)(
    "cancels a partially released toggle shortcut on %s",
    async (terminal) => {
      const macro = {
        id: "macro-two",
        enabled: true,
        name: "Shift 2",
        roleIds: ["role-1"],
        shortcutSourceScope: { type: "all_execution_roles" },
        trigger: { code: "Digit2", ctrl: false, alt: false, shift: true, meta: false },
        repeat: { type: "once" },
        steps: []
      };
      const binding = vi.fn(async () => ({
        macros: [macro],
        shortcutMacroIds: [macro.id],
        statuses: []
      }));
      const controller = installOverlay(binding);
      await controller.refresh();

      document.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
      document.dispatchEvent(keyEvent("keydown", "Digit2", "@", { shiftKey: true }));
      document.dispatchEvent(keyEvent("keyup", "Digit2", "@", { shiftKey: true }));
      expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: macro.id });

      if (terminal === "hidden") {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden"
        });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible"
        });
      } else if (terminal === "dispose") {
        controller.dispose();
      } else {
        window.dispatchEvent(new Event(terminal));
      }
      document.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
      await Promise.resolve();

      expect(binding).not.toHaveBeenCalledWith({ type: "toggle", macroId: macro.id });
    }
  );

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
    armShortcut(controller, "KeyW");
    const original = keyEvent("keydown", "KeyW", "w", {
      ctrlKey: true,
      location: 1
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
    expect(forwarded.repeat).toBe(false);
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
    armShortcut(controller, "KeyA");

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
    armShortcut(controller, "KeyA");

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
    armShortcut(controller, "KeyA");

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
    armShortcut(controller, "KeyW");
    canvas.dispatchEvent(keyEvent("keydown", "KeyW", "w"));
    expect(canvasKeyDown).toHaveBeenCalledOnce();

    input.focus();
    await Promise.resolve();

    expect(document.activeElement).toBe(input);
    expect(canvasKeyDown).toHaveBeenCalledTimes(2);

    secondInput.focus();
    await Promise.resolve();
    expect(canvasKeyDown).toHaveBeenCalledTimes(2);
    armShortcut(controller, "KeyW", "keyup");
    const release = keyEvent("keyup", "KeyW", "w");
    secondInput.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(false);
    expect(canvasKeyUp).toHaveBeenCalledOnce();

    canvas.focus();
    input.focus();
    await Promise.resolve();
    expect(canvasKeyDown).toHaveBeenCalledTimes(2);
  });

  it("keeps an unobserved guard event-bound until exact cancellation", () => {
    const controller = installOverlay();
    const dispatchId = armShortcut(controller, "KeyW");

    expect(controller.suppressNextShortcut("other", "KeyW", "keyup")).toBe(false);
    expect(controller.clearSuppressedShortcut("other")).toBe(false);
    expect(controller.clearSuppressedShortcut(dispatchId)).toBe(true);
    expect(controller.clearSuppressedShortcut(dispatchId)).toBe(false);
    armShortcut(controller, "KeyW", "keyup");
  });

  it("does not reassert a forwarded key after acknowledged macro keyup cleanup", async () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    const input = document.createElement("input");
    document.body.append(canvas, input);
    const canvasKeyDown = vi.fn();
    const canvasKeyUp = vi.fn();
    canvas.addEventListener("keydown", canvasKeyDown);
    canvas.addEventListener("keyup", canvasKeyUp);
    canvas.focus();
    armShortcut(controller, "Digit2");
    canvas.dispatchEvent(keyEvent("keydown", "Digit2", "@", { shiftKey: true }));

    expect(controller.releaseForwardedMacroKey("Digit2")).toBe(true);
    expect(controller.releaseForwardedMacroKey("Digit2")).toBe(false);
    expect(canvasKeyDown).toHaveBeenCalledOnce();
    expect(canvasKeyUp).toHaveBeenCalledOnce();

    input.focus();
    await Promise.resolve();

    expect(document.activeElement).toBe(input);
    expect(canvasKeyDown).toHaveBeenCalledOnce();
    expect(canvasKeyUp).toHaveBeenCalledOnce();
  });

  it("does not arm keyup until the exact trusted keydown is observed", async () => {
    const observed = vi.fn(async (_observation: MacroKeyObservation) => undefined);
    const binding = Object.assign(
      vi.fn(async () => ({ macros: [], statuses: [] })),
      { macroKeyObserved: observed }
    );
    const controller = installOverlay(binding);
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();

    const keyDownDispatchId = armShortcut(controller, "Digit2");
    document.dispatchEvent(keyEvent("keyup", "Digit2", "2"));
    expect(controller.suppressNextShortcut("early-keyup", "Digit2", "keyup")).toBe(false);
    canvas.dispatchEvent(keyEvent("keydown", "Digit2", "@", {
      repeat: true,
      shiftKey: true
    }));
    expect(controller.suppressNextShortcut("after-repeat", "Digit2", "keyup")).toBe(false);

    const keyDownCodes: string[] = [];
    const keyUpCodes: string[] = [];
    canvas.addEventListener("keydown", (event) => keyDownCodes.push(event.code));
    canvas.addEventListener("keyup", (event) => keyUpCodes.push(event.code));

    canvas.dispatchEvent(keyEvent("keydown", "Digit2", "@", { shiftKey: true }));
    await Promise.resolve();
    expect(observed).toHaveBeenCalledWith({
      code: "Digit2",
      dispatchId: keyDownDispatchId,
      phase: "keydown"
    });

    const keyUpDispatchId = armShortcut(controller, "Digit2", "keyup");
    canvas.dispatchEvent(keyEvent("keyup", "Digit2", "2"));
    await Promise.resolve();

    expect(keyDownCodes).toEqual(["Digit2"]);
    expect(keyUpCodes).toEqual(["Digit2"]);
    expect(observed).toHaveBeenLastCalledWith({
      code: "Digit2",
      dispatchId: keyUpDispatchId,
      phase: "keyup"
    });
  });

  it("forces guarded forwarded keys up when the overlay is disposed", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const keyUpCodes: string[] = [];
    canvas.addEventListener("keyup", (event) => keyUpCodes.push(event.code));

    armShortcut(controller, "Digit2");
    canvas.dispatchEvent(keyEvent("keydown", "Digit2", "@", { shiftKey: true }));
    armShortcut(controller, "Digit2", "keyup");
    controller.dispose();

    expect(keyUpCodes).toEqual(["Digit2"]);
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
    armShortcut(controller, "ControlLeft");
    canvas.dispatchEvent(keyEvent("keydown", "ControlLeft", "Control", { ctrlKey: true }));
    armShortcut(controller, "KeyW");
    canvas.dispatchEvent(keyEvent("keydown", "KeyW", "w", { ctrlKey: true }));

    input.focus();
    await Promise.resolve();

    expect(keyDownCodes).toEqual(["ControlLeft", "KeyW", "ControlLeft", "KeyW"]);
    armShortcut(controller, "KeyW", "keyup");
    input.dispatchEvent(keyEvent("keyup", "KeyW", "w", { ctrlKey: true }));
    armShortcut(controller, "ControlLeft", "keyup");
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

  it("keeps physical modifier ownership isolated from guarded macro events", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", {
      repeat: true,
      shiftKey: true
    }));
    expect(controller.physicalModifierCodes()).toEqual(["ShiftLeft"]);

    armShortcut(controller, "ShiftLeft");
    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    armShortcut(controller, "ShiftLeft", "keyup");
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    expect(controller.physicalModifierCodes()).toEqual(["ShiftLeft"]);

    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    expect(controller.physicalModifierCodes()).toEqual([]);
  });

  it("projects a physical modifier wrapped around a macro modifier as one DOM pair", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const events: string[] = [];
    canvas.addEventListener("keydown", (event) => events.push(`down:${event.code}`));
    canvas.addEventListener("keyup", (event) => events.push(`up:${event.code}`));

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    armShortcut(controller, "ShiftLeft");
    const macroDown = keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true });
    expect(canvas.dispatchEvent(macroDown)).toBe(false);
    expect(macroDown.defaultPrevented).toBe(true);
    armShortcut(controller, "ShiftLeft", "keyup");
    const macroUp = keyEvent("keyup", "ShiftLeft", "Shift");
    expect(canvas.dispatchEvent(macroUp)).toBe(false);
    expect(macroUp.defaultPrevented).toBe(true);
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    expect(events).toEqual(["down:ShiftLeft", "up:ShiftLeft"]);
    expect(controller.physicalModifierCodes()).toEqual([]);
  });

  it("keeps a native modifier re-projection out of the page ownership stream", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const events: string[] = [];
    canvas.addEventListener("keydown", (event) => events.push(`down:${event.code}`));
    canvas.addEventListener("keyup", (event) => events.push(`up:${event.code}`));

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    armShortcut(controller, "ShiftLeft");
    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    armShortcut(controller, "ShiftLeft", "keyup");
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    expect(controller.suppressNextModifierProjection("invalid", "Digit2")).toBe(false);
    armModifierProjection(controller, "ShiftLeft");
    const projection = keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true });
    expect(canvas.dispatchEvent(projection)).toBe(true);
    expect(projection.defaultPrevented).toBe(false);
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    expect(events).toEqual(["down:ShiftLeft", "up:ShiftLeft"]);
    expect(controller.physicalModifierCodes()).toEqual([]);
  });

  it("hands aggregate modifier ownership from physical input to a running macro", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const events: string[] = [];
    canvas.addEventListener("keydown", (event) => events.push(`down:${event.code}`));
    canvas.addEventListener("keyup", (event) => events.push(`up:${event.code}`));

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    armShortcut(controller, "ShiftLeft");
    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    const physicalUp = keyEvent("keyup", "ShiftLeft", "Shift");
    expect(canvas.dispatchEvent(physicalUp)).toBe(false);
    expect(physicalUp.defaultPrevented).toBe(true);
    expect(controller.physicalModifierCodes()).toEqual([]);
    armShortcut(controller, "ShiftLeft", "keyup");
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    expect(events).toEqual(["down:ShiftLeft", "up:ShiftLeft"]);
  });

  it("hands aggregate modifier ownership from a running macro to physical input", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const events: string[] = [];
    canvas.addEventListener("keydown", (event) => events.push(`down:${event.code}`));
    canvas.addEventListener("keyup", (event) => events.push(`up:${event.code}`));

    armShortcut(controller, "ShiftLeft");
    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    const physicalDown = keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true });
    expect(canvas.dispatchEvent(physicalDown)).toBe(false);
    expect(physicalDown.defaultPrevented).toBe(true);
    expect(controller.physicalModifierCodes()).toEqual(["ShiftLeft"]);
    armShortcut(controller, "ShiftLeft", "keyup");
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));
    canvas.dispatchEvent(keyEvent("keyup", "ShiftLeft", "Shift"));

    expect(events).toEqual(["down:ShiftLeft", "up:ShiftLeft"]);
    expect(controller.physicalModifierCodes()).toEqual([]);
  });

  it("releases an overlapped modifier once when the overlay is disposed", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const events: string[] = [];
    canvas.addEventListener("keydown", (event) => events.push(`down:${event.code}`));
    canvas.addEventListener("keyup", (event) => events.push(`up:${event.code}`));

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    armShortcut(controller, "ShiftLeft");
    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    controller.dispose();

    expect(events).toEqual(["down:ShiftLeft", "up:ShiftLeft"]);
  });

  it("releases pass-through physical keys to their original target in reverse press order", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const releases: Array<{ code: string; shift: boolean }> = [];
    canvas.addEventListener("keyup", (event) => {
      releases.push({ code: event.code, shift: event.shiftKey });
    });

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "Digit1", "!", { shiftKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "Digit1", "!", { repeat: true, shiftKey: true }));
    window.dispatchEvent(new Event("blur"));

    expect(releases).toEqual([
      { code: "Digit1", shift: true },
      { code: "ShiftLeft", shift: false }
    ]);
    expect(controller.physicalModifierCodes()).toEqual([]);
    window.dispatchEvent(new Event("blur"));
    expect(releases).toHaveLength(2);
  });

  it("submits one native physical cleanup for blur and hidden without synthetic duplicates", async () => {
    const binding = vi.fn(async () => ({ macros: [], statuses: [] })) as OverlayBinding;
    binding.physicalKeyCleanup = vi.fn(async () => undefined);
    const controller = installOverlay(binding);
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const releases: string[] = [];
    canvas.addEventListener("keyup", (event) => releases.push(event.code));

    canvas.dispatchEvent(keyEvent("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "ShiftRight", "Shift", { shiftKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "KeyA", "A", { shiftKey: true }));
    window.dispatchEvent(new Event("blur"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(binding.physicalKeyCleanup).toHaveBeenCalledOnce());
    expect(binding.physicalKeyCleanup).toHaveBeenCalledWith({
      codes: ["KeyA", "ShiftRight", "ShiftLeft"],
      releaseId: expect.any(String)
    });
    expect(releases).toEqual([]);
    expect(controller.physicalModifierCodes()).toEqual([]);
    const lateKeyUp = keyEvent("keyup", "KeyA", "A");
    expect(canvas.dispatchEvent(lateKeyUp)).toBe(false);
    expect(lateKeyUp.defaultPrevented).toBe(true);
    const lateShiftUp = keyEvent("keyup", "ShiftLeft", "Shift");
    expect(canvas.dispatchEvent(lateShiftUp)).toBe(false);
    expect(lateShiftUp.defaultPrevented).toBe(true);
    expect(releases).toEqual([]);
  });

  it("leaves Ctrl+Shift+Tab modifiers to the native handoff exactly once", async () => {
    const binding = vi.fn(async () => ({ macros: [], statuses: [] })) as OverlayBinding;
    binding.physicalKeyCleanup = vi.fn(async (request) => ({
      handoffOwnedCodes: request.codes,
      releasedCodes: []
    }));
    installOverlay(binding);
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const releases: string[] = [];
    canvas.addEventListener("keyup", (event) => releases.push(event.code));

    canvas.dispatchEvent(keyEvent("keydown", "ControlRight", "Control", { ctrlKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "ShiftRight", "Shift", {
      ctrlKey: true,
      shiftKey: true
    }));
    canvas.dispatchEvent(keyEvent("keydown", "Tab", "Tab", {
      ctrlKey: true,
      shiftKey: true
    }));
    window.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => expect(binding.physicalKeyCleanup).toHaveBeenCalledWith({
      codes: ["ShiftRight", "ControlRight"],
      releaseId: expect.any(String)
    }));
    expect(releases).toEqual([]);
    canvas.dispatchEvent(keyEvent("keyup", "ShiftRight", "Shift", { ctrlKey: true }));
    canvas.dispatchEvent(keyEvent("keyup", "ControlRight", "Control"));
    expect(releases).toEqual(["ShiftRight", "ControlRight"]);
  });

  it("falls back to reverse-order synthetic keyup when native cleanup fails", async () => {
    const binding = vi.fn(async () => ({ macros: [], statuses: [] })) as OverlayBinding;
    binding.physicalKeyCleanup = vi.fn(async () => {
      throw new Error("native cleanup failed");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installOverlay(binding);
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const releases: Array<{ code: string; shift: boolean }> = [];
    canvas.addEventListener("keyup", (event) => {
      releases.push({ code: event.code, shift: event.shiftKey });
    });

    canvas.dispatchEvent(keyEvent("keydown", "ShiftRight", "Shift", { shiftKey: true }));
    canvas.dispatchEvent(keyEvent("keydown", "KeyA", "A", { shiftKey: true }));
    window.dispatchEvent(new Event("blur"));

    await vi.waitFor(() => expect(releases).toEqual([
      { code: "KeyA", shift: true },
      { code: "ShiftRight", shift: false }
    ]));
    expect(warning).toHaveBeenCalledWith(
      "Unable to neutralize physical game keys after focus loss.",
      expect.any(Error)
    );
  });

  it("clears pass-through physical keys on hidden, pagehide, and dispose", () => {
    const target = document.createElement("canvas");
    document.body.append(target);
    const releasedCodes: string[] = [];
    target.addEventListener("keyup", (event) => releasedCodes.push(event.code));

    let controller = installOverlay();
    target.dispatchEvent(keyEvent("keydown", "KeyH", "h"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(releasedCodes).toEqual(["KeyH"]);
    visibility.mockRestore();
    controller.dispose();

    controller = installOverlay();
    target.dispatchEvent(keyEvent("keydown", "KeyP", "p"));
    window.dispatchEvent(new Event("pagehide"));
    expect(releasedCodes).toEqual(["KeyH", "KeyP"]);
    controller.dispose();

    controller = installOverlay();
    target.dispatchEvent(keyEvent("keydown", "KeyD", "d"));
    controller.dispose();
    expect(releasedCodes).toEqual(["KeyH", "KeyP", "KeyD"]);
  });
});

function installOverlay(
  binding: OverlayBinding = async () => ({ macros: [], statuses: [] })
): OverlayController {
  const overlayWindow = window as OverlayTestWindow;
  binding.macroKeyObserved ??= vi.fn(async () => undefined);
  binding.managedShortcutKeyPhase ??= vi.fn(async () => undefined);
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
