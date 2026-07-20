import { describe, expect, it } from "vitest";

import {
  formatMacroCoordinateClipboard,
  parseMacroCoordinateClipboard
} from "../src/shared/macroCoordinates";

describe("macro coordinate clipboard format", () => {
  it("formats px and percent values with two decimal percent precision", () => {
    expect(formatMacroCoordinateClipboard({
      xPercent: 12.345,
      xPx: 123,
      yPercent: 56.789,
      yPx: 456
    })).toBe("X: 123px (12.35%), Y: 456px (56.79%)");
  });

  it("parses the copied format and rounds values to macro precision", () => {
    expect(parseMacroCoordinateClipboard("X: 123px (12.345%), Y: 456px (56.789%)")).toEqual({
      xPercent: 12.35,
      xPx: 123,
      yPercent: 56.79,
      yPx: 456
    });
  });

  it.each([
    "",
    "X: 123px, Y: 456px",
    "X: -1px (0%), Y: 456px (50%)",
    "X: 123px (101%), Y: 456px (50%)"
  ])("rejects malformed clipboard text %j", (value) => {
    expect(parseMacroCoordinateClipboard(value)).toBeUndefined();
  });
});
