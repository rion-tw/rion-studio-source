// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MACRO_OVERLAY_SCRIPT } from "../src/main/macros/MacroOverlayInjector";
import type { Macro } from "../src/shared/types";

interface OverlayController {
  dispose: () => void;
  refresh: () => Promise<void>;
}

interface OverlayTestWindow extends Window {
  __rionStudioMacroOverlay?: OverlayController;
  rionStudioMacroOverlay?: (request: unknown) => Promise<unknown>;
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

describe("macro overlay interactions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    const overlayWindow = window as OverlayTestWindow;
    overlayWindow.__rionStudioMacroOverlay?.dispose();
    delete overlayWindow.__rionStudioMacroOverlay;
    delete overlayWindow.rionStudioMacroOverlay;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("leaves game pointer events and focus untouched", () => {
    const { button, canvas } = createGameSurface(document);
    installOverlay(window);
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
  });

  it("opens the app once from a physical trigger click without rendering an action menu", async () => {
    createGameSurface(document);
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
    trigger.dispatchEvent(createMouseEvent(window, "pointerup"));
    const click = createMouseEvent(window, "click");
    expect(trigger.dispatchEvent(click)).toBe(false);
    document.removeEventListener("pointerdown", pagePointerDown);

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(pagePointerDown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "open" }));
    expect(binding.mock.calls.filter(([request]) => isRecord(request) && request.type === "open")).toHaveLength(1);
    expect(root.querySelector(".panel")).toBeNull();
    expect(root.querySelector(".macro-row")).toBeNull();
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
    expect(root.querySelector(".active-badge-name")?.textContent).toBe(assignedMacro.name);
  });

  it("starts and stops macros from their in-game shortcuts while updating the badge", async () => {
    createGameSurface(document);
    let statuses: Array<Record<string, unknown>> = [];
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "start") statuses = [runningStatus()];
      if (isRecord(request) && request.type === "stop") statuses = [];
      return { macros: [assignedMacro], statuses };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "start", macroId: assignedMacro.id }));
    await vi.waitFor(() => {
      expect(getOverlayRoot(document).querySelector(".active-badge-name")?.textContent).toBe(assignedMacro.name);
    });

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "stop", macroId: assignedMacro.id }));
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".active-badge")).toBeNull());
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

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "start", macroId: assignedMacro.id }));
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
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "start", macroId: assignedMacro.id }));
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

    canvas.dispatchEvent(event);

    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "start", macroId: assignedMacro.id }));
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
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));
  });

  it("disposes a detached overlay and stops its polling intervals", async () => {
    vi.useFakeTimers();
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ detached: true, macros: [], statuses: [] }));

      installOverlay(window, binding);
      await vi.advanceTimersByTimeAsync(0);

      expect(document.getElementById("rion-studio-macro-overlay-v29")).toBeNull();
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

function createMouseEvent(targetWindow: Window, type: string): MouseEvent {
  const MouseEventConstructor = (targetWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  return new MouseEventConstructor(type, {
    bubbles: true,
    cancelable: true,
    composed: true
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

function runningStatus(): Record<string, unknown> {
  return {
    roleId: "role-1",
    macroId: assignedMacro.id,
    state: "running",
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function getOverlayRoot(ownerDocument: Document): ShadowRoot {
  const root = ownerDocument.getElementById("rion-studio-macro-overlay-v29")?.shadowRoot;
  if (!root) throw new Error("Expected the macro overlay shadow root.");
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
