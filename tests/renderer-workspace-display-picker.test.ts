import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("generic display inventory", () => {
  it("formats fallback names, resolution, and display badges", async () => {
    const route = await readFile(
      "src/renderer/src/features/game-windows/GameWindowsRoute.tsx",
      "utf8"
    );

    expect(route).toContain("display.label");
    expect(route).toContain("display.resolution");
    expect(route).toContain("display.isPrimary");
    expect(route).not.toContain("occupiedByWorkspace");
  });
});
