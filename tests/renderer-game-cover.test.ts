// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  calculateGameCoverCrop,
  createGameCoverImageDataUrl
} from "../src/renderer/src/features/games/gameCover";

describe("game cover crop", () => {
  it("center-crops wide and tall sources to 16:9", () => {
    expect(calculateGameCoverCrop(1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    });
    const wideCrop = calculateGameCoverCrop(2000, 1000);
    expect(wideCrop.x).toBeCloseTo(111.1111);
    expect(wideCrop.y).toBe(0);
    expect(wideCrop.width).toBeCloseTo(1777.7778);
    expect(wideCrop.height).toBe(1000);
    expect(calculateGameCoverCrop(1000, 1000)).toEqual({
      x: 0,
      y: 218.75,
      width: 1000,
      height: 562.5
    });
  });

  it("rejects empty or invalid source dimensions", () => {
    expect(() => calculateGameCoverCrop(0, 1080)).toThrow("Unable to process game cover.");
    expect(() => calculateGameCoverCrop(Number.NaN, 1080)).toThrow("Unable to process game cover.");
  });

  it("rejects unsupported or oversized source files before decoding", async () => {
    await expect(createGameCoverImageDataUrl(new File(["text"], "cover.txt", { type: "text/plain" })))
      .rejects.toThrow("Game cover must be a PNG, JPEG, WebP, or GIF image up to 8 MB.");
    await expect(createGameCoverImageDataUrl(new File(
      [new Uint8Array(8_000_001)],
      "cover.png",
      { type: "image/png" }
    ))).rejects.toThrow("Game cover must be a PNG, JPEG, WebP, or GIF image up to 8 MB.");
  });
});
