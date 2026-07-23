// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MACRO_OVERLAY_SCRIPT } from "../src/main/macros/MacroOverlayInjector";
import type { Macro, MacroRunStatus } from "../src/shared/types";

interface OverlayController {
  clearSuppressedShortcut?: (code: string, phase?: "keydown" | "keyup") => void;
  dispose: () => void;
  refresh: () => Promise<void>;
  suppressNextShortcut?: (code: string, phase?: "keydown" | "keyup") => void;
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
  });

  afterEach(() => {
    const overlayWindow = window as OverlayTestWindow;
    overlayWindow.__rionStudioMacroOverlay?.dispose();
    delete overlayWindow.__rionStudioMacroOverlay;
    delete overlayWindow.rionStudioMacroOverlay;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("leaves game pointer events and focus untouched", () => {
    const { button, canvas } = createGameSurface(document);
    const binding = vi.fn(async () => ({ macros: [], statuses: [] }));
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

    const canvasPointerDown = createMouseEvent(window, "pointerdown");
    expect(canvas.dispatchEvent(canvasPointerDown)).toBe(true);
    expect(canvasPointerDown.defaultPrevented).toBe(false);
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
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = -1;
    canvas.focus();
    const binding = vi.fn(async (request: unknown) => ({
      macros: [assignedMacro],
      statuses: [],
      ...(isRecord(request) && request.type === "copy-coordinate" ? { copied: true } : {})
    }));
    installOverlay(window, binding);
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".trigger")).not.toBeNull());

    const root = getOverlayRoot(document);
    const trigger = root.querySelector<HTMLButtonElement>(".trigger");
    const menu = root.querySelector<HTMLElement>(".action-menu");
    const measureAction = root.querySelector<HTMLButtonElement>(".action-menu-item");
    if (!trigger || !menu || !measureAction) throw new Error("Expected coordinate menu controls.");

    expect(menu.hidden).toBe(true);
    trigger.dispatchEvent(createMouseEvent(window, "pointerenter"));
    expect(menu.hidden).toBe(false);
    expect(measureAction.textContent).toContain("Measure coordinates");

    measureAction.dispatchEvent(createMouseEvent(window, "click"));
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    const readout = root.querySelector<HTMLElement>(".coordinate-readout");
    if (!picker || !readout) throw new Error("Expected coordinate picker.");
    expect(picker.hidden).toBe(false);

    const move = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 256,
      clientY: 192
    });
    expect(picker.dispatchEvent(move)).toBe(false);
    expect(readout.textContent).toContain("X: 256px");
    expect(readout.textContent).toContain("Y: 192px");

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
    await vi.waitFor(() => expect(picker.hidden).toBe(true));
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
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    if (!picker) throw new Error("Expected coordinate picker.");

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
    expect(picker.hidden).toBe(true);
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

      statuses = [];
      await controller.refresh();
      expect(layer.hidden).toBe(false);
      expect(layer.querySelectorAll(".click-marker")).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 190));
      expect(layer.hidden).toBe(true);
      expect(layer.querySelectorAll(".click-marker")).toHaveLength(0);
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

  it("coalesces low-frequency reconciliation and runs only one trailing request", async () => {
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
    expect(binding).toHaveBeenCalledTimes(2);
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
    expect(binding).not.toHaveBeenCalledWith({ type: "start", macroId: legacyZoomMacro.id });
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
    expect(binding).not.toHaveBeenCalledWith({ type: "start", macroId: legacyTabMacro.id });
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
    expect(binding).not.toHaveBeenCalledWith({ type: "start", macroId: assignedMacro.id });
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

    canvas.dispatchEvent(createMouseEvent(window, "pointerdown"));
    expect(document.activeElement).toBe(staleInput);
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

      expect(document.getElementById("rion-studio-macro-overlay-v56")).toBeNull();
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
  const root = ownerDocument.getElementById("rion-studio-macro-overlay-v56")?.shadowRoot;
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
