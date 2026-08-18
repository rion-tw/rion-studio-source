import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  analyzeContext,
  loadContextMap,
  matchesGlob,
  validateAiContext
} from "../scripts/aiContext.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("AI context router", () => {
  it("routes renderer settings work to design context and settings journeys", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: ["src/renderer/src/features/settings/SettingsRoute.tsx"],
      changeKind: "user-visible",
      hostPlatform: "darwin"
    });

    expect(report.areas.map((area) => area.id)).toEqual(["renderer"]);
    expect(report.canonicalDocs).toContain("docs/design-system.md");
    expect(report.e2e.features).toContain("settings");
    expect(report.e2e.candidateJourneys).toContain("SETTINGS-PERSIST-001");
    expect(report.platforms.local).toContain("macos");
    expect(report.platforms.pending).toContain("windows");
  });

  it("routes shared contracts across TypeScript and Rust validation", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: ["src/shared/api.ts"],
      changeKind: "compile-only"
    });

    expect(report.areas.map((area) => area.id)).toContain("shared-contracts");
    expect(report.canonicalDocs).toContain(
      "docs/contracts/system-runtime/operations-and-receipts.md"
    );
    expect(report.requiredChecks).toContain("pnpm run lint:rust");
    expect(report.e2e.omissionReason).toBe("compile-only");
  });

  it("unions macro, Core, and native runtime obligations", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: [
        "crates/rion-core/src/macro_runtime/section_01_action_timeout.rs",
        "src-tauri/src/system_runtime/section_32_macro_input_recovery.rs"
      ],
      changeKind: "unknown",
      hostPlatform: "darwin"
    });

    expect(report.areas.map((area) => area.id)).toEqual(expect.arrayContaining([
      "core-data",
      "macro-runtime",
      "system-runtime-native"
    ]));
    expect(report.e2e.features).toEqual(expect.arrayContaining(["macros", "game-windows"]));
    expect(report.e2e.candidateJourneys).toEqual(expect.arrayContaining([
      "MACRO-INPUT-RECOVERY-011",
      "RUNTIME-MIXED-RECOVERY-011"
    ]));
    expect(new Set(report.requiredChecks).size).toBe(report.requiredChecks.length);
  });

  it("keeps documentation-only work out of product journeys", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: ["docs/ai-development.md"],
      changeKind: "internal-only"
    });

    expect(report.areas.map((area) => area.id)).toEqual(["documentation"]);
    expect(report.e2e.candidateJourneys).toEqual([]);
    expect(report.e2e.omissionReason).toBe("internal-only");
  });

  it("routes release workflows to release and CI guidance", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: [".github/workflows/release.yml"],
      changeKind: "compile-only"
    });

    expect(report.areas.map((area) => area.id)).toEqual(expect.arrayContaining([
      "updater-release",
      "build-ci"
    ]));
    expect(report.canonicalDocs).toContain("docs/updater-transaction-contract.md");
    expect(report.platforms.required).toEqual(expect.arrayContaining(["linux", "macos", "windows"]));
  });

  it("fails closed for unknown intents and unclassified routed paths", async () => {
    const contextMap = await loadContextMap(repositoryRoot);
    await expect(analyzeContext({ root: repositoryRoot, contextMap, intents: ["missing"] }))
      .rejects.toThrow("unknown intent missing");
    await expect(analyzeContext({ root: repositoryRoot, contextMap, paths: ["src/unknown/file.ts"] }))
      .rejects.toThrow("unclassified repository path");
  });

  it("matches a directory against a recursive glob and validates the live map", async () => {
    expect(matchesGlob("src/renderer/src/features/settings", "src/renderer/**")).toBe(true);
    expect(matchesGlob("src/renderer/src/features/settings", "src/renderer/src/features/settings/**"))
      .toBe(true);
    await expect(validateAiContext(resolve(repositoryRoot))).resolves.toEqual([]);
  });
});
