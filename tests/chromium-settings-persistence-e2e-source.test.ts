import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("Chromium Settings persistence exact replacement source", () => {
  it("uses visible Preferences, Interface, Role, and Macro actions", async () => {
    const spec = await source("e2e/desktop/specs/chromium-settings-persistence.e2e.ts");

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-SETTINGS-PERSIST-006",
      "CHROMIUM-WINDOWS-SETTINGS-PERSIST-006",
      'button=Light',
      "Always hide tab close buttons",
      "Restore Game Windows on startup",
      "Show macro tools button",
      "Show running macro badges",
      "Show macro click markers",
      "button[aria-label='Open']",
      "button[aria-label='Start']",
      "button[aria-label='Stop']",
      "makeMacroExecutionPortable",
      "[role='option']=Delay",
      'input[aria-label=\'Delay\']',
      "electronDesktopE2eRoleSessionRuntime",
      'hostKind: expectedHostKind()',
      "chromium-settings-persistence-restart"
    ]) {
      expect(spec).toContain(marker);
    }
    for (const forbiddenMutation of [
      'rendererCall("updateRuntimeWindowPreferences"',
      'rendererCall("patchGameBrowserSettings"',
      'rendererCall("launchRole"',
      'rendererCall("startMacro"',
      'rendererCall("stopMacro"'
    ]) {
      expect(spec).not.toContain(forbiddenMutation);
    }
  });

  it("moves Settings ownership out of the entity journey into paired exact verdicts", async () => {
    const [entitySpec, manifestSource] = await Promise.all([
      source("e2e/desktop/specs/chromium-entity-persistence.e2e.ts"),
      source("docs/e2e-coverage.json")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
    };
    const journeys = manifest.journeys.filter((journey) =>
      journey.coverageGroup === "chromium-v23-settings-persistence"
    );

    expect(entitySpec).not.toContain("SETTINGS-PERSIST-006");
    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["SETTINGS-PERSIST-001"]);
      expect(journey.priority).toBe("P0");
      expect(journey.outcomes).toEqual(["success", "restart"]);
      expect(journey.phases).toEqual([
        "chromium-settings-persistence-seed",
        "chromium-settings-persistence-restart"
      ]);
      expect(journey.spec).toBe(
        "e2e/desktop/specs/chromium-settings-persistence.e2e.ts"
      );
    }
  });

  it("binds restart and exact persisted evidence to the shared entity namespace", async () => {
    const [runner, journeyEvidence, evidence] = await Promise.all([
      source("scripts/runDesktopE2e.mjs"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumSettingsPersistenceEvidence.mjs")
    ]);

    expect(runner).toContain("chromiumJourneyPhaseDependencies");
    expect(runner).toContain("chromiumJourneyPhaseNamespaces");
    expect(journeyEvidence).toContain("chromiumSettingsPersistencePhaseDependencies");
    expect(journeyEvidence).toContain("chromiumSettingsPersistencePhaseNamespaces");
    expect(journeyEvidence).toContain("isChromiumSettingsPersistencePhase(phase)");
    expect(evidence).toContain('"chromium-entity-persistence-lifecycle"');
    expect(evidence).toContain('"chromium-entity-persistence-restart"');
    expect(evidence).toContain("alwaysHideTabCloseButton === true");
    expect(evidence).toContain("restoreGameWindowsOnStartup === true");
    expect(evidence).toContain("showToolButton === false");
    expect(evidence).toContain("restoreSession?.cleanExit === true");
    expect(evidence).toContain('steps[0]?.type === "delay"');
  });
});
