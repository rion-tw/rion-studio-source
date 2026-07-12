import { describe, expect, it } from "vitest";

import {
  extractDominantColorFromImageData,
  getReadableTextColor,
  type ImageDataLike
} from "../src/shared/roleCoverColor";

describe("role cover color helpers", () => {
  it("extracts the color from a single-color image", () => {
    expect(extractDominantColorFromImageData(imageDataFromPixels([[30, 136, 229, 255]]))).toBe("#1E88E5");
  });

  it("chooses the main color bucket from a mixed image", () => {
    expect(
      extractDominantColorFromImageData(
        imageDataFromPixels([
          [40, 120, 220, 255],
          [41, 121, 221, 255],
          [39, 119, 219, 255],
          [40, 120, 220, 255],
          [42, 122, 222, 255],
          [240, 64, 64, 255],
          [241, 65, 65, 255],
          [239, 63, 63, 255]
        ])
      )
    ).toBe("#2878DC");
  });

  it("prefers a vivid representative color over a larger neutral area", () => {
    expect(
      extractDominantColorFromImageData(
        imageDataFromPixels([
          [160, 160, 160, 255],
          [162, 162, 162, 255],
          [158, 158, 158, 255],
          [161, 161, 161, 255],
          [159, 159, 159, 255],
          [160, 160, 160, 255],
          [162, 162, 162, 255],
          [158, 158, 158, 255],
          [240, 64, 64, 255],
          [241, 65, 65, 255],
          [239, 63, 63, 255]
        ])
      )
    ).toBe("#F14141");
  });

  it("returns undefined for empty or transparent image data", () => {
    expect(extractDominantColorFromImageData({ width: 0, height: 0, data: new Uint8ClampedArray() })).toBeUndefined();
    expect(extractDominantColorFromImageData(imageDataFromPixels([[255, 0, 0, 0]]))).toBeUndefined();
  });

  it("chooses readable foreground colors for dark and light backgrounds", () => {
    expect(getReadableTextColor("#111111")).toBe("#FFFFFF");
    expect(getReadableTextColor("#F6D365")).toBe("#111111");
  });
});

function imageDataFromPixels(pixels: number[][]): ImageDataLike {
  return {
    width: pixels.length,
    height: 1,
    data: Uint8ClampedArray.from(pixels.flat())
  };
}
