import { describe, expect, it } from "vitest";
import type { ChromiumRoleSurfaceBounds } from "../src/electron/main/chromiumRoleSurfacePorts";
import { WindowsRuntimeRestoredGeometry } from "../src/electron/main/windowsRuntimeRestoredGeometry";

const normal = { x: 32, y: 40, width: 960, height: 640 };
const fullscreenRaw = { x: 31, y: 40, width: 962, height: 641 };
const unwitnessed = { code: "ELECTRON_RUNTIME_HOST_FULLSCREEN_GEOMETRY_UNWITNESSED" };
const invalidBounds = { code: "ELECTRON_RUNTIME_HOST_BOUNDS_INVALID" };

describe("Windows native restore geometry through owned fullscreen", () => {
  it("retains semantic normal geometry across three fullscreen cycles and saved-content recreation", () => {
    const geometry = new WindowsRuntimeRestoredGeometry(normal);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(geometry.read(normal, false)).toEqual(normal);
      geometry.captureBeforeFullscreen(normal, false);
      expect(geometry.read(fullscreenRaw, true)).toEqual(normal);
      expect(geometry.read(fullscreenRaw, true)).toEqual(normal);
      expect(geometry.read(normal, false)).toEqual(normal);
    }
    const saved = geometry.read(normal, false);
    const recreated = new WindowsRuntimeRestoredGeometry(saved);
    recreated.captureBeforeFullscreen(saved, false);
    expect(recreated.read(fullscreenRaw, true)).toEqual(normal);
    expect(recreated.read(normal, false)).toEqual(normal);
  });

  it("refreshes actual native normal geometry on exit and captures a subsequent resize before reentry", () => {
    const geometry = new WindowsRuntimeRestoredGeometry(normal);
    geometry.captureBeforeFullscreen(normal, false);
    expect(geometry.read(fullscreenRaw, true)).toEqual(normal);
    const exited = { x: -1000, y: 80, width: 1000, height: 700 };
    expect(geometry.read(exited, false)).toEqual(exited);
    expect(() => geometry.read(fullscreenRaw, true)).toThrow(expect.objectContaining(unwitnessed));
    const resized = { x: -1200, y: 60, width: 1200, height: 800 };
    geometry.captureBeforeFullscreen(resized, false);
    expect(geometry.read({ x: -1201, y: 60, width: 1202, height: 801 }, true)).toEqual(resized);
    expect(geometry.read(resized, false)).toEqual(resized);
  });

  it("leaves maximized raw normal readback unchanged and captures it before fullscreen from maximize", () => {
    const geometry = new WindowsRuntimeRestoredGeometry(normal);
    const maximizedRaw = { x: 48, y: 64, width: 1000, height: 720 };
    expect(geometry.read(maximizedRaw, false)).toEqual(maximizedRaw);
    geometry.captureBeforeFullscreen(maximizedRaw, false);
    expect(geometry.read({ x: 47, y: 64, width: 1002, height: 721 }, true)).toEqual(maximizedRaw);
    expect(geometry.read(maximizedRaw, false)).toEqual(maximizedRaw);
  });

  it("requires a new owned capture for an initial or later unowned fullscreen observation", () => {
    const geometry = new WindowsRuntimeRestoredGeometry(normal);
    expect(() => geometry.read(fullscreenRaw, true)).toThrow(expect.objectContaining(unwitnessed));
    geometry.captureBeforeFullscreen(normal, false);
    expect(() => geometry.captureBeforeFullscreen(fullscreenRaw, true))
      .toThrow(expect.objectContaining(unwitnessed));
    expect(geometry.read(fullscreenRaw, true)).toEqual(normal);
    geometry.read(normal, false);
    expect(() => geometry.read(fullscreenRaw, true)).toThrow(expect.objectContaining(unwitnessed));
  });

  it("copies only immutable rectangle data and leaves prior receipts stable after native refresh", () => {
    const seed = { ...normal, nativeHostId: 7 };
    const geometry = new WindowsRuntimeRestoredGeometry(seed);
    const native = { ...normal, nativeHostId: 8 };
    geometry.captureBeforeFullscreen(native, false);
    native.x = 200;
    seed.width = 2000;
    const receipt = geometry.read(fullscreenRaw, true);
    expect(receipt).toEqual(normal);
    expect(Object.keys(receipt)).toEqual(["x", "y", "width", "height"]);
    expect(Object.isFrozen(receipt)).toBe(true);
    const freshNative = { x: 400, y: 100, width: 1280, height: 720 };
    const fresh = geometry.read(freshNative, false);
    freshNative.height = 900;
    expect(fresh).toEqual({ x: 400, y: 100, width: 1280, height: 720 });
    expect(Object.isFrozen(fresh)).toBe(true);
    expect(receipt).toEqual(normal);
  });

  it.each([
    { ...normal, x: Number.NaN },
    { ...normal, y: Number.POSITIVE_INFINITY },
    { ...normal, width: 960.5 },
    { ...normal, height: 640.5 },
    { ...normal, width: 639 },
    { ...normal, height: 479 },
    { ...normal, x: Number.MAX_SAFE_INTEGER },
    { ...normal, y: Number.MAX_SAFE_INTEGER },
    null,
    undefined
  ])("rejects malformed or undersized native rectangles without corrupting an existing witness: %j", value => {
    const bounds = value as ChromiumRoleSurfaceBounds;
    expect(() => new WindowsRuntimeRestoredGeometry(bounds)).toThrow(expect.objectContaining(invalidBounds));
    const geometry = new WindowsRuntimeRestoredGeometry(normal);
    geometry.captureBeforeFullscreen(normal, false);
    expect(() => geometry.captureBeforeFullscreen(bounds, false)).toThrow(expect.objectContaining(invalidBounds));
    expect(() => geometry.read(bounds, false)).toThrow(expect.objectContaining(invalidBounds));
    expect(() => geometry.read(bounds, true)).toThrow(expect.objectContaining(invalidBounds));
    expect(geometry.read(fullscreenRaw, true)).toEqual(normal);
  });

  it("accepts exact minimum native geometry and negative display coordinates", () => {
    const minimum = { x: -640, y: -480, width: 640, height: 480 };
    const geometry = new WindowsRuntimeRestoredGeometry(minimum);
    geometry.captureBeforeFullscreen(minimum, false);
    expect(geometry.read({ x: -641, y: -480, width: 642, height: 481 }, true)).toEqual(minimum);
    expect(geometry.read(minimum, false)).toEqual(minimum);
  });
});
