// @vitest-environment jsdom

import { readSourceTreeSync as readFileSync } from "./helpers/readSourceTree";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Macro, MacroRunStatus } from "../src/shared/types";

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

it("shows controller-role running badges without exposing execution-role click markers", async () => {
    createGameSurface(document);
    const controllerStatus = runningStatus({
      macroId: clickMacro.id,
      lastClick: { sequence: 1, stepId: "click-first" }
    });
    const state = {
      macros: [clickMacro],
      shortcutMacroIds: [clickMacro.id],
      shortcutStatuses: [controllerStatus],
      statuses: []
    };
    const binding = vi.fn(async (_request: unknown) => state);
    const controller = installOverlay(window, binding);

    await controller.refresh();

    const root = getOverlayRoot(document);
    expect(root.querySelector(".active-badge-name")?.textContent).toBe(clickMacro.name);
    expect(root.querySelector(".active-badge-shortcut")?.textContent).toBe("F2");
    expect(root.querySelectorAll(".click-marker")).toHaveLength(0);

    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "toggle",
      macroId: clickMacro.id
    }));
  });

it("keeps local execution status visible while passing an unavailable shortcut to the game", async () => {
    createGameSurface(document);
    const state = {
      macros: [clickMacro],
      shortcutMacroIds: [],
      shortcutStatuses: [],
      statuses: [runningStatus({
        macroId: clickMacro.id,
        lastClick: { sequence: 1, stepId: "click-first" }
      })]
    };
    const binding = vi.fn(async (_request: unknown) => state);
    const controller = installOverlay(window, binding);

    await controller.refresh();

    const root = getOverlayRoot(document);
    expect(root.querySelector(".active-badge-name")?.textContent).toBe(clickMacro.name);
    expect(root.querySelector(".active-badge-shortcut")).toBeNull();
    expect(root.querySelectorAll(".click-marker")).toHaveLength(2);

    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "F2",
      key: "F2"
    });
    expect(document.dispatchEvent(event)).toBe(true);
    expect(binding.mock.calls.some(([request]) =>
      isRecord(request) && request.type === "toggle"
    )).toBe(false);
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

it("independently hides overlay visuals while preserving macro shortcuts", async () => {
    createGameSurface(document);
    let macroOverlay = {
      showClickMarkers: true,
      showRunningBadges: true,
      showToolButton: true
    };
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "coordinate-context") {
        return { appliedPageZoom: 1, surfaceGeneration: 1, topologyRevision: 1 };
      }
      return {
        macroBadgePosition: { horizontalAlign: "center", horizontalMarginPx: 8, topPx: 128 },
        macroOverlay,
        macros: [clickMacro],
        statuses: [runningStatus({ macroId: clickMacro.id })]
      };
    });
    const controller = installOverlay(window, binding);
    await controller.refresh();

    const root = getOverlayRoot(document);
    expect(root.querySelector<HTMLElement>(".trigger")?.hidden).toBe(false);
    expect(root.querySelector(".active-badge")).not.toBeNull();
    expect(root.querySelector(".click-marker")).not.toBeNull();

    root.querySelector<HTMLElement>(".trigger")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    root.querySelector<HTMLElement>(".action-menu-item")?.click();
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());

    macroOverlay = {
      showClickMarkers: true,
      showRunningBadges: true,
      showToolButton: false
    };
    await controller.refresh();

    expect(root.querySelector<HTMLElement>(".trigger")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".action-menu")?.hidden).toBe(true);
    expect(root.querySelector(".coordinate-picker")).toBeNull();
    expect(root.querySelector(".active-badge")).not.toBeNull();
    expect(root.querySelector(".click-marker")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyM",
      key: "M",
      ctrlKey: true,
      shiftKey: true
    }));
    dispatchShortcut(window, "F2", "F2");
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({ type: "open" }));
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith({
      type: "toggle",
      macroId: clickMacro.id
    }));

    macroOverlay = {
      showClickMarkers: true,
      showRunningBadges: false,
      showToolButton: true
    };
    await controller.refresh();
    expect(root.querySelector<HTMLElement>(".trigger")?.hidden).toBe(false);
    expect(root.querySelector(".active-badge")).toBeNull();
    expect(root.querySelector(".click-marker")).not.toBeNull();

    macroOverlay = {
      showClickMarkers: false,
      showRunningBadges: true,
      showToolButton: true
    };
    await controller.refresh();
    expect(root.querySelector<HTMLElement>(".trigger")?.hidden).toBe(false);
    expect(root.querySelector(".active-badge")).not.toBeNull();
    expect(root.querySelector(".click-marker")).toBeNull();

    root.querySelector<HTMLElement>(".trigger")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    root.querySelector<HTMLElement>(".action-menu-item")?.click();
    await vi.waitFor(() => expect(root.querySelector(".coordinate-picker")).not.toBeNull());

    macroOverlay = {
      showClickMarkers: true,
      showRunningBadges: true,
      showToolButton: true
    };
    await controller.refresh();
    expect(root.querySelector(".coordinate-picker")).not.toBeNull();
    expect(root.querySelector(".click-marker")).not.toBeNull();
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
    expect(binding).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(binding).toHaveBeenCalledTimes(2);

    firstResponse.resolve({ macros: [assignedMacro], statuses: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(binding).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(getOverlayRoot(document).querySelector(".active-badge")).toBeNull());
    expect(binding).toHaveBeenCalledWith({ type: "toggle", macroId: assignedMacro.id });
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
    await vi.waitFor(() => expect(binding).toHaveBeenCalledWith(expect.objectContaining({
      type: "game-input-context",
      target: "game"
    })));
  });

it("reports a focused iframe as embedded input context and resumes only after Canvas focus", async () => {
    const { canvas } = createGameSurface(document);
    canvas.tabIndex = 0;
    const iframe = document.createElement("iframe");
    iframe.tabIndex = 0;
    document.body.append(iframe);
    Object.defineProperty(window, "__rionStudioDocumentInstanceId", {
      configurable: true,
      value: "document-iframe-test"
    });
    const requests: Array<Record<string, unknown>> = [];
    const binding = vi.fn(async (request: unknown) => {
      if (isRecord(request) && request.type === "game-input-context") requests.push(request);
      return { macros: [assignedMacro], statuses: [] };
    });
    installOverlay(window, binding);

    await Promise.resolve();
    expect(requests.some((request) => request.target === "embedded-frame")).toBe(false);

    iframe.focus();
    await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({
      documentInstanceId: "document-iframe-test",
      target: "embedded-frame",
      type: "game-input-context"
    }));
    const embeddedRevision = Number(requests.at(-1)?.revision);

    canvas.focus();
    await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({
      documentInstanceId: "document-iframe-test",
      target: "game",
      type: "game-input-context"
    }));
    expect(Number(requests.at(-1)?.revision)).toBeGreaterThan(embeddedRevision);
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

function _createMouseEvent(
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
  for (const type of ["keydown", "keyup"]) {
    targetWindow.document.dispatchEvent(new KeyboardEventConstructor(type, {
      bubbles: true,
      cancelable: true,
      code,
      key
    }));
  }
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
