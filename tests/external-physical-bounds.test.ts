import { describe, expect, it, vi } from "vitest";

import { resolveExternalPhysicalBounds } from "../src/main/browser/externalPhysicalBounds";
import { v1Case } from "./helpers/v1Parity";

describe("external physical bounds", () => {
  it("keeps non-Windows bounds in DIP space without creating a native path", () => {
    const bounds = { x: -1536, y: 12, width: 1536, height: 832 };
    const dipToScreenRect = vi.fn();

    v1Case("resource-platform-59ec47814379", () => {
      expect(resolveExternalPhysicalBounds("darwin", bounds, dipToScreenRect)).toBe(bounds);
      expect(dipToScreenRect).not.toHaveBeenCalled();
    });
  });

  it("converts the complete Windows DIP rectangle through Electron", () => {
    const dipBounds = { x: -1536, y: 12, width: 1536, height: 832 };
    const physicalBounds = { x: -1920, y: 15, width: 1920, height: 1040 };
    const dipToScreenRect = vi.fn(() => physicalBounds);

    v1Case("resource-platform-17409b3f40dc", () => {
      expect(resolveExternalPhysicalBounds("win32", dipBounds, dipToScreenRect))
        .toEqual(physicalBounds);
      expect(dipToScreenRect).toHaveBeenCalledWith(null, dipBounds);
    });
  });
});
