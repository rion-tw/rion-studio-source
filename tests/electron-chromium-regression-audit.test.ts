import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("Electron Chromium regression audit", () => {
  it("classifies every active P0/P1 journey exactly once", async () => {
    const [audit, manifestSource] = await Promise.all([
      readFile(resolve(repositoryRoot, "docs/electron-chromium-regression-audit.md"), "utf8"),
      readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<{ id: string; priority: string }>;
    };
    const expected = manifest.journeys
      .filter((journey) => journey.priority === "P0" || journey.priority === "P1")
      .map((journey) => journey.id)
      .sort();
    const classified = [...audit.matchAll(/^CHROMIUM-[A-Z0-9-]+$/gmu)]
      .map((match) => match[0]!);

    expect(expected).toHaveLength(118);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(expected);
  });

  it("binds the cutover comparison, baseline workflows, and v32 decisions", async () => {
    const audit = await readFile(
      resolve(repositoryRoot, "docs/electron-chromium-regression-audit.md"),
      "utf8"
    );
    for (const marker of [
      "0b6e42f0", "7bec758a", "c80b0c68", "56f94eb6", "8bd2d878",
      "0a1be165", "e6218c55", "34707761268", "34707761617",
      "cutover-regression", "fixed-before-baseline", "verified-parity",
      "test-gap", "legacy-contract", "platform-pending", "cleanup-neutral",
      "Input.dispatchKeyEvent", "Input.dispatchMouseEvent"
    ]) {
      expect(audit).toContain(marker);
    }
  });
});
