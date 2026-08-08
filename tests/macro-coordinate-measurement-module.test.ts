// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CoordinateController = {
  destroy(): void;
  handleKeyDown(event: KeyboardEvent): boolean;
};

type CoordinateFactory = (options: {
  copyCoordinate: (coordinate: Record<string, unknown>) => Promise<void>;
  getCoordinateContext?: () => Promise<CoordinateContext>;
  getText: () => Record<string, string>;
  initialCoordinateContext?: CoordinateContext;
  isTrustedUserEvent: (event: Event) => boolean;
  onCancel: () => void;
  onComplete: () => void;
  root: ShadowRoot;
}) => CoordinateController;

type CoordinateContext = {
  appliedPageZoom: number;
  surfaceGeneration: number;
  topologyRevision: number;
};

const moduleSource = readFileSync(
  "src/shared/browser-overlay/macroCoordinateMeasurement.js",
  "utf8"
);
const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`;
const text = {
  coordinateAnchor: "Anchor",
  coordinateCopyFailed: "Unable to copy coordinates. Try again.",
  coordinateCopying: "Copying…",
  coordinateMeasureHint: "Click to copy · Esc to cancel"
};

async function loadFactory(): Promise<CoordinateFactory> {
  const measurementModule = await import(moduleUrl) as {
    createMacroCoordinateMeasurement: CoordinateFactory;
  };
  return measurementModule.createMacroCoordinateMeasurement;
}

function createRoot(): ShadowRoot {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host.attachShadow({ mode: "open" });
}

describe("macro coordinate measurement module", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("owns anchor math, RAF-coalesced pointer updates, resize, and idempotent cleanup", async () => {
    let nextFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 7;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const root = createRoot();
    const createMeasurement = await loadFactory();
    const controller = createMeasurement({
      copyCoordinate: vi.fn(async () => undefined),
      getText: () => text,
      isTrustedUserEvent: () => true,
      onCancel: vi.fn(),
      onComplete: vi.fn(),
      root
    });
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    const readout = root.querySelector<HTMLElement>(".coordinate-readout");
    const markers = [...root.querySelectorAll<HTMLElement>(".coordinate-anchor-marker")];
    if (!picker || !readout) throw new Error("Expected a mounted coordinate measurement.");

    expect(readout.textContent).toContain("X: 400px (50%)");
    expect(readout.textContent).toContain("Y: 300px (50%)");
    expect(readout.textContent).toContain("Anchor: center");
    expect(markers).toHaveLength(9);

    picker.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 160,
      clientY: 120
    }));
    picker.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 240,
      clientY: 180
    }));
    expect(requestFrame).toHaveBeenCalledOnce();
    nextFrame?.(0);
    expect(readout.textContent).toContain("X: 240px (30%)");
    expect(readout.textContent).toContain("Y: 180px (30%)");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(readout.textContent).toContain("X: 300px (30%)"));
    expect(readout.textContent).toContain("Y: 150px (30%)");

    picker.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100
    }));
    controller.destroy();
    controller.destroy();
    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(root.querySelector(".coordinate-picker")).toBeNull();
  });

  it("copies a contract-safe coordinate and delegates successful completion", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const root = createRoot();
    const copyCoordinate = vi.fn<(coordinate: Record<string, unknown>) => Promise<void>>(
      async () => undefined
    );
    const onComplete = vi.fn();
    const createMeasurement = await loadFactory();
    const controller = createMeasurement({
      copyCoordinate,
      getText: () => text,
      isTrustedUserEvent: () => true,
      onCancel: vi.fn(),
      onComplete,
      root
    });
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    if (!picker) throw new Error("Expected a mounted coordinate measurement.");

    picker.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 150
    }));

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(copyCoordinate).toHaveBeenCalledWith({
      anchor: "top-left",
      appliedPageZoom: 1,
      referenceViewportHeightPx: 600,
      referenceViewportWidthPx: 800,
      viewportHeightPx: 600,
      viewportWidthPx: 800,
      xPercent: 25,
      xPx: 200,
      xReferencePx: 200,
      yPercent: 25,
      yPx: 150,
      yReferencePx: 150
    });
    controller.destroy();
  });

  it.each([
    [0.75, 1280, 800, 284, 160],
    [1, 960, 600, 213, 120],
    [1.25, 768, 480, 170.4, 96]
  ])("normalizes measured pixels at %s page zoom", async (
    appliedPageZoom,
    viewportWidth,
    viewportHeight,
    clientX,
    clientY
  ) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: viewportHeight });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const context = { appliedPageZoom, surfaceGeneration: 7, topologyRevision: 11 };
    const copyCoordinate = vi.fn(async (_coordinate: Record<string, unknown>) => undefined);
    const createMeasurement = await loadFactory();
    const controller = createMeasurement({
      copyCoordinate,
      getCoordinateContext: async () => context,
      getText: () => text,
      initialCoordinateContext: context,
      isTrustedUserEvent: () => true,
      onCancel: vi.fn(),
      onComplete: vi.fn(),
      root: createRoot()
    });
    const picker = document.querySelector<HTMLElement>("div")?.shadowRoot
      ?.querySelector<HTMLElement>(".coordinate-picker");
    const readout = picker?.querySelector<HTMLElement>(".coordinate-readout");
    if (!picker || !readout) throw new Error("Expected a mounted coordinate measurement.");
    picker.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY
    }));
    expect(readout.textContent).toContain(`X: ${Math.round(clientX)}px`);
    expect(readout.textContent).toContain(`Y: ${Math.round(clientY)}px`);
    expect(readout.textContent).toContain(`Zoom: ${appliedPageZoom * 100}%`);
    if (appliedPageZoom !== 1) {
      expect(readout.textContent).not.toContain("X: 213px");
      expect(readout.textContent).not.toContain("Y: 120px");
    }
    picker.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY
    }));
    await vi.waitFor(() => expect(copyCoordinate).toHaveBeenCalledOnce());
    expect(copyCoordinate).toHaveBeenCalledWith(expect.objectContaining({
      appliedPageZoom,
      referenceViewportHeightPx: 600,
      referenceViewportWidthPx: 960,
      xReferencePx: 213,
      yReferencePx: 120
    }));
    controller.destroy();
  });

  it("keeps failed copies active for retry and delegates Escape cancellation", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = createRoot();
    const copyCoordinate = vi.fn()
      .mockRejectedValueOnce(new Error("clipboard unavailable"))
      .mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const createMeasurement = await loadFactory();
    const controller = createMeasurement({
      copyCoordinate,
      getText: () => text,
      isTrustedUserEvent: () => true,
      onCancel,
      onComplete: vi.fn(),
      root
    });
    const picker = root.querySelector<HTMLElement>(".coordinate-picker");
    const readout = root.querySelector<HTMLElement>(".coordinate-readout");
    if (!picker || !readout) throw new Error("Expected a mounted coordinate measurement.");

    picker.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 128,
      clientY: 96
    }));
    await vi.waitFor(() => expect(readout.dataset.status).toBe("failed"));
    expect(picker.isConnected).toBe(true);

    const escape = new KeyboardEvent("keydown", { cancelable: true, code: "Escape" });
    expect(controller.handleKeyDown(escape)).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    controller.destroy();
  });
});
