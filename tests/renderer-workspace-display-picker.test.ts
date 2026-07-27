import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("generic display inventory", () => {
  it("formats fallback names, resolution, and display badges", async () => {
    const modal = await readFile(
      "src/renderer/src/features/game-windows/GameWindowModal.tsx",
      "utf8"
    );

    expect(modal).toContain("display.label");
    expect(modal).toContain("display.resolution");
    expect(modal).toContain("display.isPrimary");
    expect(modal).not.toContain("occupiedByWorkspace");
  });
});
