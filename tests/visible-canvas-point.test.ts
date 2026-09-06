// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleCanvasPoint } from "../e2e/desktop/support/visible-canvas-point";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe.each(["macos", "windows"] as const)("visible canvas input on %s", () => {
  function fixture() {
    const canvas = document.createElement("canvas");
    canvas.id = "game-input-canvas";
    document.body.append(canvas);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: -100, top: -50, right: 2000, bottom: 2000
    } as DOMRect);
    const hitTest = vi.fn<(x: number, y: number) => Element | null>();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true, value: hitTest
    });
    return { canvas, hitTest };
  }

  it("selects an exposed canvas point inside the viewport around obstructing controls", () => {
    const { canvas, hitTest } = fixture();
    const control = document.createElement("button");
    hitTest.mockImplementation((x, y) =>
      x > window.innerWidth / 2 && y < window.innerHeight / 2 ? canvas : control
    );
    const point = visibleCanvasPoint();
    expect(point.x).toBeGreaterThan(window.innerWidth / 2);
    expect(point.x).toBeLessThan(window.innerWidth);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThan(window.innerHeight);
    expect(document.elementFromPoint(point.x, point.y)).toBe(canvas);
    expect(document.activeElement).not.toBe(canvas);
  });

  it("rejects an obscured canvas without focusing or clicking through the cover", () => {
    const { canvas, hitTest } = fixture();
    hitTest.mockReturnValue(document.body);
    const focus = vi.spyOn(canvas, "focus");
    const click = vi.spyOn(canvas, "click");
    expect(visibleCanvasPoint).toThrow("no exposed click point");
    expect(focus).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("rejects an offscreen canvas before hit testing", () => {
    const { canvas, hitTest } = fixture();
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue({
      left: -200, right: -100, top: 0, bottom: 100
    } as DOMRect);
    expect(visibleCanvasPoint).toThrow("no exposed click point");
    expect(hitTest).not.toHaveBeenCalled();
  });

  it("rejects a missing canvas", () => {
    expect(visibleCanvasPoint).toThrow("canvas is unavailable");
  });
});
