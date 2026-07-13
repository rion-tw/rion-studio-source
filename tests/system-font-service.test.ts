import { describe, expect, it, vi } from "vitest";

import { normalizeSystemFonts, SystemFontService } from "../src/main/game-browser/SystemFontService";

describe("SystemFontService", () => {
  it("normalizes, dedupes, and sorts font family names", () => {
    expect(normalizeSystemFonts([" Helvetica ", "Arial", "helvetica", "Bad\u0000Font", "Courier New"])).toEqual([
      { family: "Arial", label: "Arial" },
      { family: "Courier New", label: "Courier New" },
      { family: "Helvetica", label: "Helvetica" }
    ]);
  });

  it("falls back to bundled common font families when OS font lookup fails", async () => {
    const service = new SystemFontService({
      execFile: vi.fn().mockRejectedValue(new Error("fc-list unavailable")),
      platform: "linux"
    });

    await expect(service.listFonts()).resolves.toEqual(
      expect.arrayContaining([
        { family: "Arial", label: "Arial" },
        { family: "Noto Sans Math", label: "Noto Sans Math" }
      ])
    );
  });
});
