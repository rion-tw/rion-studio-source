import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("Chromium Macro UI exact replacement source", () => {
  it("uses visible authoring, recorder, table, selection, and run controls", async () => {
    const spec = await source("e2e/desktop/specs/chromium-macro-ui.e2e.ts");

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-MACROS-UI-017",
      "CHROMIUM-WINDOWS-MACROS-UI-017",
      "button[aria-label='New macro']",
      "button[aria-label='Record']",
      "Key.Command",
      "Key.Ctrl",
      "Ctrl/Command+K is reserved for Rion Studio Quick Access.",
      "button=Create macro",
      "button=Clear",
      "[role='option']=Delay",
      "exerciseMacroMindMapFocus",
      "samples.length === 12",
      'filter === "none"',
      "data-macro-list-view='grouped'",
      "data-macro-list-view='flat'",
      "button=Select 2",
      "aria-label='2 selected'",
      "aria-label='1 selected'",
      "button[aria-label='Start']",
      "button[aria-label='Stop']",
      "electronDesktopE2eRoleSessionRuntime",
      "appKitIdentity"
    ]) {
      expect(spec).toContain(marker);
    }
    for (const forbiddenMutation of [
      'rendererCall("createMacro"',
      'rendererCall("updateMacro"',
      'rendererCall("launchRole"',
      'rendererCall("startMacro"',
      'rendererCall("stopMacro"'
    ]) {
      expect(spec).not.toContain(forbiddenMutation);
    }
  });

  it("keeps exact, separate macOS AppKit and Windows replacement verdicts", async () => {
    const manifest = JSON.parse(await source("docs/e2e-coverage.json")) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    const journeys = manifest.journeys.filter((journey) =>
      journey.coverageGroup === "chromium-v23-macro-ui"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["MACROS-UI-001"]);
      expect(journey.priority).toBe("P0");
      expect(journey.feature).toBe("macros");
      expect(journey.kind).toBe("ui");
      expect(journey.risk).toBe("native");
      expect(journey.outcomes).toEqual(["success", "failure", "restart"]);
      expect(journey.phases).toEqual([
        "chromium-macro-ui-seed",
        "chromium-macro-ui-restart"
      ]);
      expect(journey.spec).toBe("e2e/desktop/specs/chromium-macro-ui.e2e.ts");
    }
    for (const profile of [
      manifest.profiles["chromium-macos-appkit-smoke"],
      manifest.profiles["chromium-windows-smoke"]
    ]) {
      expect(profile?.phases).toEqual(expect.arrayContaining([
        "chromium-macro-ui-seed",
        "chromium-macro-ui-restart"
      ]));
      expect(profile?.specs).toContain("e2e/desktop/specs/chromium-macro-ui.e2e.ts");
    }
  });

  it("binds focused dependencies, shared lifecycle state, and exact SQLite evidence", async () => {
    const [runner, journeyEvidence, evidence, phaseSpecs] = await Promise.all([
      source("scripts/runDesktopE2e.mjs"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumMacroUiEvidence.mjs"),
      source("e2e/desktop/phaseSpecs.ts")
    ]);

    expect(runner).toContain("chromiumJourneyPhaseDependencies");
    expect(runner).toContain("chromiumJourneyPhaseNamespaces");
    expect(journeyEvidence).toContain("chromiumMacroUiPhaseDependencies");
    expect(journeyEvidence).toContain("chromiumMacroUiPhaseNamespaces");
    expect(journeyEvidence).toContain("isChromiumMacroUiPhase(phase)");
    expect(evidence).toContain('"chromium-entity-persistence-lifecycle"');
    expect(evidence).toContain('"chromium-entity-persistence-restart"');
    expect(evidence).toContain("payload?.trigger === undefined");
    expect(evidence).toContain('payload.steps[0]?.type === "delay"');
    expect(evidence).toContain("payload.steps[0]?.ms === 60_000");
    expect(evidence).toContain("restoreSession?.cleanExit === true");
    expect(phaseSpecs).toContain('"chromium-macro-ui-seed"');
    expect(phaseSpecs).toContain('"chromium-macro-ui-restart"');
  });
});
