import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExternalChromeWindowBoundsAdapter } from "../src/main/browser/WindowsExternalChromeWindowBoundsAdapter";
import type { PixelBounds } from "../src/shared/types";

const electronMocks = vi.hoisted(() => ({ dipToScreenRect: vi.fn() }));

vi.mock("electron", () => ({
  screen: { dipToScreenRect: electronMocks.dipToScreenRect }
}));

const targetBounds: PixelBounds = { x: -1920, y: 0, width: 1920, height: 1040 };

describe("WindowsExternalChromeWindowBoundsAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not create an adapter outside Windows", () => {
    expect(createExternalChromeWindowBoundsAdapter({ platform: "darwin" })).toBeUndefined();
  });

  it("requires the Rust platform implementation on Windows", () => {
    expect(() => createExternalChromeWindowBoundsAdapter({ platform: "win32" })).toThrow(
      "Rust Windows frame adapter is unavailable"
    );
  });

  it("converts the complete DIP rectangle through Electron", () => {
    const dipBounds = { x: -1536, y: 12, width: 1536, height: 832 };
    const dipToScreenRect = vi.fn(() => targetBounds);
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      dipToScreenRect,
      nativeAlignVisibleBounds: vi.fn(async ({ physicalBounds }) => physicalBounds)
    });

    expect(adapter?.dipToPhysicalBounds(dipBounds)).toEqual(targetBounds);
    expect(dipToScreenRect).toHaveBeenCalledWith(null, dipBounds);
  });

  it("delegates alignment to windows-rs and verifies the result", async () => {
    const nativeAlignVisibleBounds = vi.fn(async () => targetBounds);
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      dipToScreenRect: (_window, bounds) => bounds,
      nativeAlignVisibleBounds
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 4321, physicalBounds: targetBounds })
    ).resolves.toBeUndefined();
    expect(nativeAlignVisibleBounds).toHaveBeenCalledWith({
      browserProcessId: 4321,
      physicalBounds: targetBounds
    });
  });

  it("rejects a native result that does not match the requested visible frame", async () => {
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      dipToScreenRect: (_window, bounds) => bounds,
      nativeAlignVisibleBounds: vi.fn(async () => ({ ...targetBounds, width: 1919 }))
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds })
    ).rejects.toThrow("did not align");
  });

  it("validates inputs before entering native code", async () => {
    const nativeAlignVisibleBounds = vi.fn(async () => targetBounds);
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      dipToScreenRect: (_window, bounds) => bounds,
      nativeAlignVisibleBounds
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 0, physicalBounds: targetBounds })
    ).rejects.toThrow("positive uint32");
    await expect(
      adapter?.alignVisibleBounds({
        browserProcessId: 12,
        physicalBounds: { ...targetBounds, width: 0 }
      })
    ).rejects.toThrow("invalid physicalBounds bounds");
    expect(nativeAlignVisibleBounds).not.toHaveBeenCalled();
  });
});
