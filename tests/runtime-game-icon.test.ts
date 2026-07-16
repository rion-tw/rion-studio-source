import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeGameIconDataUrl,
  getRuntimeGameIconSource
} from "../src/main/games/runtimeGameIcon";

describe("runtime game icons", () => {
  it("prefers a custom game icon and resizes it to the runtime payload size", () => {
    const source = "data:image/webp;base64,Y3VzdG9t";
    const resized = {
      isEmpty: vi.fn(() => false),
      resize: vi.fn(),
      toDataURL: vi.fn(() => "data:image/png;base64,cmVzaXplZA==")
    };
    const original = {
      isEmpty: vi.fn(() => false),
      resize: vi.fn(() => resized),
      toDataURL: vi.fn()
    };
    const createImage = vi.fn(() => original);

    expect(createRuntimeGameIconDataUrl(
      { builtinKey: "flyff-universe", iconImageDataUrl: source },
      createImage
    )).toBe("data:image/png;base64,cmVzaXplZA==");
    expect(createImage).toHaveBeenCalledWith(source);
    expect(original.resize).toHaveBeenCalledWith({ height: 32, quality: "best", width: 32 });
  });

  it("provides distinct inlined assets for both built-in games", () => {
    const flyff = getRuntimeGameIconSource({ builtinKey: "flyff-universe" });
    const feifei = getRuntimeGameIconSource({ builtinKey: "feifei-infinite-universe" });

    expect(flyff).toMatch(/^data:image\/png;base64,/);
    expect(feifei).toMatch(/^data:image\/png;base64,/);
    expect(flyff).not.toBe(feifei);
  });

  it("returns no payload for a missing or invalid game icon", () => {
    const createImage = vi.fn(() => ({
      isEmpty: () => true,
      resize: vi.fn(),
      toDataURL: vi.fn()
    }));

    expect(createRuntimeGameIconDataUrl({}, createImage)).toBeUndefined();
    expect(createImage).not.toHaveBeenCalled();
    expect(createRuntimeGameIconDataUrl(
      { iconImageDataUrl: "data:image/png;base64,aW52YWxpZA==" },
      createImage
    )).toBeUndefined();
  });
});
