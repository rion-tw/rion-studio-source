import { describe, expect, it } from "vitest";

import {
  convertMacroCoordinateToOffset,
  findNearestMacroClickAnchor,
  formatMacroCoordinateClipboard,
  parseMacroCoordinateClipboard,
  resolveMacroClickOffset
} from "../src/shared/macroCoordinates";
import { v1Case } from "./helpers/v1Parity";

describe("macro coordinate clipboard format", () => {
  it("formats px and percent values with two decimal percent precision", () => {
    v1Case("overlay-cf546fd8cd7b", () => {
      expect(formatMacroCoordinateClipboard({
        xPercent: 12.345,
        xPx: 123,
        yPercent: 56.789,
        yPx: 456
      })).toBe("X: 123px (12.35%), Y: 456px (56.79%)");
    });
  });

  it("includes viewport metadata when available", () => {
    expect(formatMacroCoordinateClipboard({
      viewportHeightPx: 768,
      viewportWidthPx: 1024,
      xPercent: 12.345,
      xPx: 123,
      yPercent: 56.789,
      yPx: 456
    })).toBe("X: 123px (12.35%), Y: 456px (56.79%), Anchor: center-left, Viewport: 1024x768px");
  });

  it("parses the copied format and rounds values to macro precision", () => {
    expect(parseMacroCoordinateClipboard("X: 123px (12.345%), Y: 456px (56.789%)")).toEqual({
      xPercent: 12.35,
      xPx: 123,
      yPercent: 56.79,
      yPx: 456
    });
  });

  it("parses viewport metadata for anchored pixel pastes", () => {
    expect(parseMacroCoordinateClipboard(
      "X: 100px (9.77%), Y: 700px (91.15%), Viewport: 1024x768px"
    )).toEqual({
      viewportHeightPx: 768,
      viewportWidthPx: 1024,
      xPercent: 9.77,
      xPx: 100,
      yPercent: 91.15,
      yPx: 700
    });
  });

  it("parses an explicit anchor from the new clipboard format", () => {
    expect(parseMacroCoordinateClipboard(
      "X: 100px (9.77%), Y: 700px (91.15%), Anchor: bottom-right, Viewport: 1024x768px"
    )).toEqual({
      anchor: "bottom-right",
      viewportHeightPx: 768,
      viewportWidthPx: 1024,
      xPercent: 9.77,
      xPx: 100,
      yPercent: 91.15,
      yPx: 700
    });
  });

  it.each([
    ["top-left", 0, 0],
    ["top-center", 500, 0],
    ["top-right", 1000, 0],
    ["center-left", 0, 400],
    ["center", 500, 400],
    ["center-right", 1000, 400],
    ["bottom-left", 0, 800],
    ["bottom-center", 500, 800],
    ["bottom-right", 1000, 800]
  ] as const)("finds the nearest %s anchor in CSS pixels", (anchor, xPx, yPx) => {
    expect(findNearestMacroClickAnchor({
      viewportHeightPx: 800,
      viewportWidthPx: 1000,
      xPx,
      yPx
    })).toBe(anchor);
  });

  it("uses the fixed anchor order to break equal-distance ties", () => {
    expect(findNearestMacroClickAnchor({
      viewportHeightPx: 800,
      viewportWidthPx: 1000,
      xPx: 250,
      yPx: 0
    })).toBe("top-left");
  });

  it("converts measured absolute coordinates into anchor offsets", () => {
    const measurement = {
      viewportHeightPx: 768,
      viewportWidthPx: 1024,
      xPercent: 9.77,
      xPx: 100,
      yPercent: 91.15,
      yPx: 700
    };

    expect(convertMacroCoordinateToOffset(measurement, "bottom-right", "px"))
      .toEqual({ x: -924, y: -68 });
    expect(convertMacroCoordinateToOffset(measurement, "bottom-right", "percent"))
      .toEqual({ x: -90.23, y: -8.85 });
    expect(convertMacroCoordinateToOffset({ ...measurement, viewportHeightPx: undefined, viewportWidthPx: undefined }, "bottom-right", "px"))
      .toBeUndefined();
  });

  it.each([
    ["top-left", 12, 34, 12, 34],
    ["top-center", 12, 34, 62, 34],
    ["top-right", -12, 34, 88, 34],
    ["center-left", 12, -16, 12, 34],
    ["center", 12, -16, 62, 34],
    ["center-right", -12, -16, 88, 34],
    ["bottom-left", 12, -16, 12, 84],
    ["bottom-center", 12, -16, 62, 84],
    ["bottom-right", -12, -16, 88, 84]
  ] as const)("resolves %s percent offsets against the viewport", (anchor, x, y, expectedX, expectedY) => {
    expect(resolveMacroClickOffset({ anchor, unit: "percent", x, y }, { width: 1000, height: 800 }))
      .toEqual({ x: expectedX, y: expectedY });
  });

  it("resolves pixel offsets from the current viewport", () => {
    expect(resolveMacroClickOffset(
      { anchor: "bottom-right", unit: "px", x: -24, y: -32 },
      { width: 1024, height: 768 }
    )).toEqual({ x: 1000, y: 736 });
  });

  it.each([
    "",
    "X: 123px, Y: 456px",
    "X: 123px (10%), Y: 456px (50%), Viewport: 100x100px",
    "X: 123px (10%), Y: 456px (50%), Anchor: invalid, Viewport: 1000x1000px",
    "X: -1px (0%), Y: 456px (50%)",
    "X: 123px (101%), Y: 456px (50%)"
  ])("rejects malformed clipboard text %j", (value) => {
    expect(parseMacroCoordinateClipboard(value)).toBeUndefined();
  });
});
