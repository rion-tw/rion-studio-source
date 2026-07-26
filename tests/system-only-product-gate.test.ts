import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("system-only product gate", () => {
  it("is a required CI and signed-candidate check", async () => {
    const [packageJson, ci, candidate, gate] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/tauri-release-candidate.yml", "utf8"),
      readFile("scripts/verifySystemOnlyProduct.mjs", "utf8")
    ]);

    expect(packageJson).toContain('"verify:system-only": "node scripts/verifySystemOnlyProduct.mjs"');
    expect(ci).toContain("pnpm run verify:system-only");
    expect(candidate).toContain("pnpm run verify:system-only");
    expect(gate).toContain("CdnCompatibilityManager");
    expect(gate).toContain("ExternalChrome");
    expect(gate).toContain("ChromeProfileImport");
    expect(gate).toContain("CoreEffectAction still exposes");
  });
});
