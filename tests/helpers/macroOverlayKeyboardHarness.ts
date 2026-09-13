// @vitest-environment jsdom

import { readSourceTreeSync as readFileSync } from "./readSourceTree";

import { afterEach, beforeEach, expect, vi } from "vitest";

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

export interface OverlayController {
  clearSuppressedShortcut: (dispatchId: string, committed?: boolean) => boolean;
  completeMacroModifierTransition: (dispatchId: string, committed: boolean) => boolean;
  dispose: () => void;
  physicalModifierCodes: () => string[];
  prepareMacroModifierTransition: (
    dispatchId: string,
    code: string,
    phase: "rawKeyDown" | "keyUp"
  ) => "dispatch" | "adoptPhysical" | "releaseOwnership" | null;
  refresh: () => Promise<void>;
  releaseForwardedMacroKey: (code: string) => boolean;
  suppressNextModifierProjection: (dispatchId: string, code: string) => boolean;
  suppressNextShortcut: (
    dispatchId: string,
    code: string,
    phase?: "keydown" | "keyup"
  ) => boolean;
  suppressShortcutSequence: (
    dispatchId: string,
    code: string,
    phases: readonly ("keydown" | "keyup")[],
    repeat?: boolean,
    modifierProjectionCodes?: readonly string[],
    deliveryOwner?: { ownerId: string; requestId: string; inputEpoch: number; surfaceGeneration: number }
  ) => boolean;
}

export interface OverlayTestWindow extends Window {
  __rionStudioMacroOverlay?: OverlayController;
  rionStudioMacroOverlay?: OverlayBinding;
  __rionTestCoordinateMeasurementModuleImporter?: (url: string) => Promise<unknown>;
}

export interface OverlayBinding {
  (request: unknown): Promise<unknown>;
  inputContextLost?: (request: {
    reason: "blur" | "hidden";
    revision: number;
  }) => Promise<unknown>;
  managedShortcutKeyPhase?: (request: ManagedShortcutKeyPhase) => Promise<unknown>;
  macroKeyObserved?: (observation: MacroKeyObservation) => Promise<unknown>;
  shortcutLifecycle?: (event: {
    code: string;
    macroId: string;
    phase: "physical-keydown-managed" | "managed-keydown-acknowledged"
      | "managed-keyup-acknowledged" | "macro-dispatched";
  }) => Promise<unknown>;
}

export interface ManagedShortcutKeyPhase {
  code: string;
  macroId: string;
  modifierCodes: string[];
  phase: "keyDown" | "keyUp";
  shortcutCycleId: string;
}

export interface MacroKeyObservation {
  altKey?: boolean;
  code: string;
  ctrlKey?: boolean;
  dispatchId: string;
  metaKey?: boolean;
  modifierProjection?: true;
  phase: "keydown" | "keyup";
  shiftKey?: boolean;
}

let testDispatchSequence = 0;

export function armShortcut(
  controller: OverlayController,
  code: string,
  phase: "keydown" | "keyup" = "keydown"
): string {
  const dispatchId = `test-dispatch-${++testDispatchSequence}`;
  expect(controller.suppressNextShortcut(dispatchId, code, phase)).toBe(true);
  return dispatchId;
}

export function armModifierProjection(controller: OverlayController, code: string): string {
  const dispatchId = `test-dispatch-${++testDispatchSequence}`;
  expect(controller.suppressNextModifierProjection(dispatchId, code)).toBe(true);
  return dispatchId;
}

export function installMacroOverlayTestLifecycle(): void {
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

}

export function installOverlay(
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

export function createEditableControls(): Array<[string, HTMLElement]> {
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

export function keyEvent(
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
