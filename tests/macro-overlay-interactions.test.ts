// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MACRO_OVERLAY_SCRIPT } from "../src/main/macros/MacroOverlayInjector";
import type { Macro } from "../src/shared/types";

interface OverlayController {
  closePanel: (options?: { focus?: boolean }) => void;
  dispose: () => void;
  refresh: (options?: { renderAfter?: boolean }) => Promise<void>;
  togglePanel: (forceOpen?: boolean) => void;
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

describe("macro overlay pointer interactions", () => {
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

  it("leaves game pointer events and focus untouched while the panel is closed", () => {
    const { button, canvas } = createGameSurface(document);
    installOverlay(window);
    const pagePointerDown = vi.fn();
    let activeElementDuringPointerDown: Element | null = null;
    button.addEventListener("pointerdown", () => {
      activeElementDuringPointerDown = document.activeElement;
    });
    document.addEventListener("pointerdown", pagePointerDown);
    button.focus();

    const event = createPointerDown(window);
    const dispatched = button.dispatchEvent(event);
    document.removeEventListener("pointerdown", pagePointerDown);

    expect(dispatched).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(pagePointerDown).toHaveBeenCalledOnce();
    expect(activeElementDuringPointerDown).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(canvas);
  });

  it("closes an open panel without interrupting the outside game control", () => {
    const { button, canvas } = createGameSurface(document);
    const controller = installOverlay(window);
    const pagePointerDown = vi.fn();
    document.addEventListener("pointerdown", pagePointerDown);
    controller.togglePanel(true);
    expect(getOverlayRoot(document).querySelector(".panel")?.getAttribute("data-open")).toBe("true");
    button.focus();

    const event = createPointerDown(window);
    const dispatched = button.dispatchEvent(event);
    document.removeEventListener("pointerdown", pagePointerDown);

    expect(dispatched).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(pagePointerDown).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(canvas);
    expect(getOverlayRoot(document).querySelector(".panel")?.getAttribute("data-open")).toBe("false");
  });

  it("only asks the top frame to close when a game control is pressed inside an iframe", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const frameWindow = iframe.contentWindow as OverlayTestWindow;
    const frameDocument = iframe.contentDocument;
    if (!frameDocument) {
      throw new Error("Expected an iframe document in the test environment.");
    }

    const { button, canvas } = createGameSurface(frameDocument);
    const messageListener = vi.fn();
    window.addEventListener("message", messageListener);
    const controller = installOverlay(frameWindow);
    button.focus();

    const event = createPointerDown(frameWindow);
    const dispatched = button.dispatchEvent(event);

    expect(dispatched).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(frameDocument.activeElement).toBe(button);
    expect(frameDocument.activeElement).not.toBe(canvas);
    await vi.waitFor(() => {
      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({ data: { source: "rionStudioMacroOverlay", type: "closePanel" } })
      );
    });

    controller.dispose();
    window.removeEventListener("message", messageListener);
  });

  it("still restores the automation target when Escape explicitly closes the panel", () => {
    const { button, canvas } = createGameSurface(document);
    const controller = installOverlay(window);
    controller.togglePanel(true);
    expect(getOverlayRoot(document).querySelector(".panel")?.getAttribute("data-open")).toBe("true");
    button.focus();

    button.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      key: "Escape"
    }));

    expect(document.activeElement).toBe(canvas);
    expect(getOverlayRoot(document).querySelector(".panel")?.getAttribute("data-open")).toBe("false");
  });

  it("continues to isolate overlay controls and consume assigned macro shortcuts", async () => {
    createGameSurface(document);
    const binding = vi.fn(async (request: unknown) => {
      const action = isRecord(request) && typeof request.type === "string" ? request.type : "list";
      return {
        macros: [assignedMacro],
        statuses: action === "start"
          ? [{
              roleId: "role-1",
              macroId: assignedMacro.id,
              state: "running",
              startedAt: "2026-07-10T00:00:00.000Z",
              updatedAt: "2026-07-10T00:00:00.000Z"
            }]
          : []
      };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh({ renderAfter: true });
    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    if (!trigger) {
      throw new Error("Expected the macro overlay trigger.");
    }

    const pagePointerDown = vi.fn();
    document.addEventListener("pointerdown", pagePointerDown);
    const pointerEvent = createPointerDown(window);
    const pointerDispatched = trigger.dispatchEvent(pointerEvent);
    document.removeEventListener("pointerdown", pagePointerDown);

    expect(pointerDispatched).toBe(false);
    expect(pointerEvent.defaultPrevented).toBe(true);
    expect(pagePointerDown).not.toHaveBeenCalled();

    const pageKeyDown = vi.fn();
    document.addEventListener("keydown", pageKeyDown);
    const shortcutEvent = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    const shortcutDispatched = document.dispatchEvent(shortcutEvent);
    document.removeEventListener("keydown", pageKeyDown);

    expect(shortcutDispatched).toBe(false);
    expect(shortcutEvent.defaultPrevented).toBe(true);
    expect(pageKeyDown).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(binding).toHaveBeenCalledWith({ macroId: assignedMacro.id, type: "start" });
    });
  });

  it("disposes a detached overlay and stops its polling intervals", async () => {
    vi.useFakeTimers();
    try {
      createGameSurface(document);
      const binding = vi.fn(async () => ({ detached: true, macros: [], statuses: [] }));

      installOverlay(window, binding);
      await vi.advanceTimersByTimeAsync(0);

      expect(document.getElementById("rion-studio-macro-overlay-v26")).toBeNull();
      expect((window as OverlayTestWindow).__rionStudioMacroOverlay).toBeUndefined();
      const requestCountAfterDispose = binding.mock.calls.length;

      await vi.advanceTimersByTimeAsync(3_000);
      expect(binding).toHaveBeenCalledTimes(requestCountAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts and stops from macro rows without nested controls triggering the row", async () => {
    createGameSurface(document);
    let statuses: Array<Record<string, unknown>> = [];
    const binding = vi.fn(async (request: unknown) => {
      const action = isRecord(request) && typeof request.type === "string" ? request.type : "list";
      if (action === "start") {
        statuses = [{
          roleId: "role-1",
          macroId: assignedMacro.id,
          state: "running",
          startedAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z"
        }];
      } else if (action === "stop") {
        statuses = [];
      }
      return { macros: [assignedMacro], statuses };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh({ renderAfter: true });
    controller.togglePanel(true);
    await controller.refresh({ renderAfter: true });

    let root = getOverlayRoot(document);
    root.querySelector<HTMLButtonElement>(".macro-edit")?.click();
    await vi.waitFor(() => {
      expect(binding).toHaveBeenCalledWith({ macroId: assignedMacro.id, type: "edit" });
    });
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));

    controller.togglePanel(true);
    await controller.refresh({ renderAfter: true });
    root = getOverlayRoot(document);
    root.querySelector<HTMLButtonElement>(".macro-enabled-switch")?.click();
    await vi.waitFor(() => {
      expect(binding).toHaveBeenCalledWith({
        type: "set-enabled",
        macroId: assignedMacro.id,
        enabled: false
      });
    });
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));

    root = getOverlayRoot(document);
    const row = root.querySelector<HTMLElement>(".macro-row");
    if (!row) {
      throw new Error("Expected a macro row.");
    }
    const pagePointerDown = vi.fn();
    document.addEventListener("pointerdown", pagePointerDown);
    const pointerEvent = createPointerDown(window);
    expect(row.dispatchEvent(pointerEvent)).toBe(false);
    document.removeEventListener("pointerdown", pagePointerDown);
    expect(pointerEvent.defaultPrevented).toBe(true);
    expect(pagePointerDown).not.toHaveBeenCalled();

    row.dispatchEvent(createClick(window));
    await vi.waitFor(() => {
      expect(binding).toHaveBeenCalledWith({ macroId: assignedMacro.id, type: "start" });
    });
    expect(root.querySelector(".panel")?.getAttribute("data-open")).toBe("false");

    controller.togglePanel(true);
    await controller.refresh({ renderAfter: true });
    root = getOverlayRoot(document);
    root.querySelector<HTMLElement>(".macro-row")?.dispatchEvent(createClick(window));
    await vi.waitFor(() => {
      expect(binding).toHaveBeenCalledWith({ macroId: assignedMacro.id, type: "stop" });
    });
  });

  it("lets disabled shortcuts reach the game and toggles them from the macro menu", async () => {
    createGameSurface(document);
    let currentMacro = {
      ...assignedMacro,
      enabled: false,
      roleIds: ["role-1", "role-2"],
      roleNames: ["Main", "Support"]
    };
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "set-enabled") {
        currentMacro = { ...currentMacro, enabled: request.enabled === true };
      }
      return { macros: [currentMacro], statuses: [] };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh({ renderAfter: true });

    const pageKeyDown = vi.fn();
    document.addEventListener("keydown", pageKeyDown);
    const shortcutEvent = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    expect(document.dispatchEvent(shortcutEvent)).toBe(true);
    document.removeEventListener("keydown", pageKeyDown);
    expect(shortcutEvent.defaultPrevented).toBe(false);
    expect(pageKeyDown).toHaveBeenCalledOnce();
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));

    controller.togglePanel(true);
    await controller.refresh({ renderAfter: true });
    const root = getOverlayRoot(document);
    const roleCount = root.querySelector<HTMLElement>(".macro-role-count");
    expect(roleCount?.textContent).toBe("2");
    expect(roleCount?.getAttribute("data-tooltip")).toBe("Main, Support");

    root.querySelector<HTMLElement>(".macro-row")?.dispatchEvent(createClick(window));
    expect(binding).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));

    const toggle = root.querySelector<HTMLButtonElement>(".macro-enabled-switch");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await controller.refresh({ renderAfter: true });
    expect(getOverlayRoot(document).querySelector(".macro-enabled-switch")).toBe(toggle);
    expect(toggle?.isConnected).toBe(true);
    toggle?.click();
    await vi.waitFor(() => {
      expect(binding).toHaveBeenCalledWith({
        type: "set-enabled",
        macroId: assignedMacro.id,
        enabled: true
      });
    });
    await vi.waitFor(() => {
      expect(getOverlayRoot(document).querySelector(".macro-enabled-switch")?.getAttribute("aria-checked")).toBe("true");
    });
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
  canvas.getBoundingClientRect = () => ({
    bottom: 480,
    height: 480,
    left: 0,
    right: 640,
    top: 0,
    width: 640,
    x: 0,
    y: 0,
    toJSON: () => ({})
  });
  const button = ownerDocument.createElement("button");
  button.textContent = "Play";
  ownerDocument.body.append(canvas, button);
  return { button, canvas };
}

function createPointerDown(targetWindow: Window): MouseEvent {
  const MouseEventConstructor = (targetWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  return new MouseEventConstructor("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true
  });
}

function createClick(targetWindow: Window): MouseEvent {
  const MouseEventConstructor = (targetWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  return new MouseEventConstructor("click", {
    bubbles: true,
    cancelable: true,
    composed: true
  });
}

function getOverlayRoot(ownerDocument: Document): ShadowRoot {
  const root = ownerDocument.getElementById("rion-studio-macro-overlay-v26")?.shadowRoot;
  if (!root) {
    throw new Error("Expected the macro overlay shadow root.");
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
