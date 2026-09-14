import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  analyzeContext,
  formatContextReport,
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
    expect(report.e2e.candidateJourneys).toContain("CHROMIUM-MACOS-APPKIT-SETTINGS-PERSIST-006");
    expect(report.platforms.local).toContain("macos");
    expect(report.platforms.pending).toContain("windows");
  });

  it("routes shared contracts across TypeScript and Rust validation", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: ["src/shared/api.ts"],
      changeKind: "compile-only",
      hostPlatform: "win32"
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
      "CHROMIUM-MACOS-APPKIT-MACRO-INPUT-RECOVERY-011",
      "CHROMIUM-MACOS-APPKIT-MIXED-RECOVERY-021"
    ]));
    expect(new Set(report.requiredChecks).size).toBe(report.requiredChecks.length);
  });

  it("keeps documentation-only work out of product journeys", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: ["docs/design-system.md"],
      changeKind: "internal-only",
      hostPlatform: "darwin"
    });

    expect(report.areas.map((area) => area.id)).toEqual(["documentation"]);
    expect(report.requiredChecks).toEqual([
      "pnpm run check:docs", "pnpm run check:ai-context", "git diff --check"
    ]);
    expect(report.e2e.candidateJourneys).toEqual([]);
    expect(report.e2e.omissionReason).toBe("internal-only");
  });

  it("routes release workflows to release and CI guidance", async () => {
    const report = await analyzeContext({
      root: repositoryRoot,
      contextMap: await loadContextMap(repositoryRoot),
      paths: [".github/workflows/release.yml"],
      changeKind: "compile-only",
      hostPlatform: "win32"
    });

    expect(report.areas.map((area) => area.id)).toEqual(expect.arrayContaining([
      "updater-release",
      "build-ci"
    ]));
    expect(report.canonicalDocs).toContain("docs/updater-transaction-contract.md");
    expect(report.contextFiles).toContain(".agents/context/release.md");
    expect(report.platforms.required).toEqual(expect.arrayContaining(["linux", "macos", "windows"]));
  });

  it.each(["darwin", "win32"] as const)("preserves mixed task gates on %s", async (hostPlatform) => {
    const report = await analyzeContext({
      root: repositoryRoot,
      paths: ["docs/ai-development.md", "scripts/aiContext.mjs", "src/shared/api.ts",
        "src/electron/main/chromiumRuntimeBootstrap.ts"],
      changeKind: "user-visible",
      hostPlatform
    });
    expect(report.requiredChecks).toEqual(expect.arrayContaining([
      "pnpm exec vitest run tests/ai-context-router.test.ts tests/documentation-structure.test.ts tests/release-workflows.test.ts",
      "pnpm run check:hygiene", "pnpm run lint", "pnpm run test",
      "pnpm run lint:rust", "pnpm run test:rust", "pnpm run build"
    ]));
    expect(new Set(report.requiredChecks).size).toBe(report.requiredChecks.length);
    expect(report.platforms.pending).toContain(hostPlatform === "darwin" ? "windows" : "macos");
    expect(report.e2e.candidateJourneys.length).toBeGreaterThan(0);
  });

  it("adds focused checks for AI instructions without full tooling gates", async () => {
    const report = await analyzeContext({
      root: repositoryRoot, paths: ["AGENTS.md", ".agents/context-map.json"],
      changeKind: "internal-only", hostPlatform: "darwin"
    });
    expect(report.requiredChecks).toContain(
      "pnpm exec vitest run tests/ai-context-router.test.ts tests/documentation-structure.test.ts tests/release-workflows.test.ts"
    );
    expect(report.requiredChecks).not.toContain("pnpm run test");
    expect(report.platforms.required).toEqual(["portable"]);
  });

  it("loads specialized context only for release or desktop E2E work", async () => {
    const base = { root: repositoryRoot, changeKind: "internal-only", hostPlatform: "win32" as const };
    const tooling = await analyzeContext({ ...base, intents: ["tooling"] });
    expect(tooling.contextFiles).not.toContain(".agents/context/release.md");
    expect(tooling.canonicalDocs).toEqual([]);
    expect(tooling.requiredChecks).toEqual([
      "pnpm run check:hygiene", "pnpm run lint", "pnpm run test"
    ]);
    const e2e = await analyzeContext({ ...base, intents: ["desktop-e2e"] });
    expect(e2e.canonicalDocs).toContain("docs/e2e-strategy.md");
    expect(e2e.requiredChecks).toContain("pnpm run test:e2e:desktop:full");
  });

  it("keeps executable policy registries out of the plain documentation shortcut", async () => {
    const report = await analyzeContext({
      root: repositoryRoot, paths: ["docs/event-topology-exceptions.json"],
      changeKind: "internal-only", hostPlatform: "win32"
    });
    expect(report.requiredChecks).toContain("pnpm run check:hygiene");
    expect(report.requiredChecks).toContain("pnpm run test");
  });

  it("summarizes reasons without losing validation, platform, or journey output", async () => {
    const report = await analyzeContext({
      root: repositoryRoot, intents: ["native"],
      paths: ["src/electron/main/chromiumRuntimeBootstrap.ts", "crates/rion-node/src/lib.rs"],
      changeKind: "user-visible", hostPlatform: "darwin"
    });
    const before = JSON.stringify(report);
    const compact = formatContextReport(report);
    const verbose = formatContextReport(report, { verbose: true });
    expect(compact).toContain("intent:native (+2 more; --verbose)");
    expect(compact).not.toContain("path:src/electron");
    for (const reason of report.areas.flatMap((area) => area.reasons)) expect(verbose).toContain(reason);
    for (const value of [...report.fastChecks, ...report.requiredChecks,
      ...report.platforms.local, ...report.platforms.pending, ...report.e2e.candidateJourneys]) {
      expect(compact).toContain(value);
      expect(verbose).toContain(value);
    }
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(verbose));
    expect(JSON.stringify(report)).toBe(before);
  });

  it("accepts --verbose and keeps CLI JSON complete and independent of text formatting", () => {
    const args = ["scripts/aiContext.mjs", "--intent", "renderer", "--paths",
      "src/renderer", "--change-kind", "internal-only"];
    const run = (...flags: string[]) => execFileSync(process.execPath, [...args, ...flags], {
      cwd: repositoryRoot, encoding: "utf8"
    });
    const report = JSON.parse(run("--json"));
    expect(report.areas[0].reasons).toEqual(["intent:renderer", "path:src/renderer"]);
    expect(JSON.parse(run("--json", "--verbose"))).toEqual(report);
    expect(run("--verbose")).toBe(formatContextReport(report, { verbose: true }));
    expect(run()).toBe(formatContextReport(report));
    expect(Object.keys(report)).toEqual([
      "changeKind", "paths", "areas", "contextFiles", "canonicalDocs", "risks",
      "fastChecks", "requiredChecks", "platforms", "e2e"
    ]);
  });

  it("fails closed for unknown intents and unclassified routed paths", async () => {
    const contextMap = await loadContextMap(repositoryRoot);
    await expect(analyzeContext({ root: repositoryRoot, contextMap, intents: ["missing"], hostPlatform: "darwin" }))
      .rejects.toThrow("unknown intent missing");
    await expect(analyzeContext({ root: repositoryRoot, contextMap, paths: ["src/unknown/file.ts"], hostPlatform: "win32" }))
      .rejects.toThrow("unclassified repository path");
  });

  it("matches a directory against a recursive glob and validates the live map", async () => {
    expect(matchesGlob("src/renderer/src/features/settings", "src/renderer/**")).toBe(true);
    expect(matchesGlob("src/renderer/src/features/settings", "src/renderer/src/features/settings/**"))
      .toBe(true);
    await expect(validateAiContext(resolve(repositoryRoot))).resolves.toEqual([]);
  });
});
