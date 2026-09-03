import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { desktopE2eSpecForPhase } from "../e2e/desktop/phaseSpecs";
import {
  aggregateDesktopE2eJourneyVerdicts,
  journeysForDesktopE2eProfile,
  resolveDesktopE2eProfile,
  type DesktopE2eManifest,
  type DesktopE2ePhaseResult
} from "../scripts/desktopE2eManifest.mjs";

const fixtureManifest: DesktopE2eManifest = {
  profiles: {
    smoke: { phases: ["seed", "restart"], specs: ["smoke.ts"] },
    full: { extends: "smoke", phases: ["full"], specs: ["full.ts"] },
    extended: { extends: "full", phases: ["native"], specs: ["native.ts"] }
  },
  journeys: [
    {
      id: "SMOKE-RESTART",
      phases: ["seed", "restart"],
      profile: "smoke",
      status: "automated"
    },
    { id: "FULL-FAILURE", phases: ["full"], profile: "full", status: "automated" },
    { id: "NATIVE", phases: ["native"], profile: "extended", status: "automated" },
    { id: "PLANNED", profile: "extended", status: "planned" }
  ]
};

function verdicts(results: DesktopE2ePhaseResult[]) {
  return aggregateDesktopE2eJourneyVerdicts(fixtureManifest, "extended", results);
}

describe("desktop E2E manifest resolution", () => {
  it("routes every shared Chromium app CRUD phase to one cohesive spec", () => {
    for (const phase of [
      "chromium-app-crud-mutations",
      "chromium-app-crud-cleanup",
      "chromium-app-crud-final-restart"
    ]) {
      expect(desktopE2eSpecForPhase(phase))
        .toBe("e2e/desktop/specs/chromium-app-crud.e2e.ts");
    }
  });

  it("routes the shared Chromium system-settings phase to its visible-UI spec", () => {
    expect(desktopE2eSpecForPhase("chromium-system-settings"))
      .toBe("e2e/desktop/specs/chromium-system-settings.e2e.ts");
  });

  it("routes both Chromium Game Window continuity phases to one visible-UI spec", () => {
    for (const phase of [
      "chromium-game-window-ui-seed",
      "chromium-game-window-ui-restart"
    ]) {
      expect(desktopE2eSpecForPhase(phase))
        .toBe("e2e/desktop/specs/chromium-game-window-ui.e2e.ts");
    }
  });

  it("routes both Chromium Workspace Web continuity phases to one visible-UI spec", () => {
    for (const phase of [
      "chromium-workspace-web-slot-seed",
      "chromium-workspace-web-slot-restart"
    ]) {
      expect(desktopE2eSpecForPhase(phase))
        .toBe("e2e/desktop/specs/chromium-workspace-web-slot.e2e.ts");
    }
  });

  it("inherits every lower profile phase, spec, and automated journey", async () => {
    expect(resolveDesktopE2eProfile(fixtureManifest, "extended")).toEqual({
      names: ["smoke", "full", "extended"],
      phases: ["seed", "restart", "full", "native"],
      specs: ["smoke.ts", "full.ts", "native.ts"]
    });
    expect(journeysForDesktopE2eProfile(fixtureManifest, "extended").map(({ id }) => id))
      .toEqual(["SMOKE-RESTART", "FULL-FAILURE", "NATIVE"]);

    const repositoryManifest = JSON.parse(
      await readFile("docs/e2e-coverage.json", "utf8")
    ) as DesktopE2eManifest;
    const extended = resolveDesktopE2eProfile(repositoryManifest, "extended");
    expect(extended.phases).toHaveLength(33);
    expect(extended.phases).toEqual(expect.arrayContaining([
      "p1-macro-standby-recovery",
      "extended-native"
    ]));
    expect(journeysForDesktopE2eProfile(repositoryManifest, "extended")).toHaveLength(40);

    for (const profileName of [
      "chromium-macos-appkit-smoke",
      "chromium-windows-smoke"
    ]) {
      const chromium = resolveDesktopE2eProfile(repositoryManifest, profileName);
      expect(chromium.phases).toEqual(expect.arrayContaining([
        "chromium-app-crud-mutations",
        "chromium-app-crud-cleanup",
        "chromium-app-crud-final-restart",
        "chromium-game-window-ui-seed",
        "chromium-game-window-ui-restart",
        "chromium-workspace-web-slot-seed",
        "chromium-workspace-web-slot-restart",
        "chromium-system-settings",
        "chromium-role-session-isolation-seed",
        "chromium-role-session-isolation-restart",
        "chromium-role-session-reset-seed",
        "chromium-role-session-reset-restart"
      ]));
      expect(chromium.specs).toContain(
        "e2e/desktop/specs/chromium-app-crud.e2e.ts"
      );
      expect(chromium.specs).toContain(
        "e2e/desktop/specs/chromium-system-settings.e2e.ts"
      );
      expect(chromium.specs).toContain(
        "e2e/desktop/specs/chromium-game-window-ui.e2e.ts"
      );
      expect(chromium.specs).toContain(
        "e2e/desktop/specs/chromium-workspace-web-slot.e2e.ts"
      );
      expect(chromium.specs).toContain(
        "e2e/desktop/specs/chromium-role-session-isolation.e2e.ts"
      );
      expect(chromium.specs).toContain(
        "e2e/desktop/specs/chromium-role-session-reset.e2e.ts"
      );
    }
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-role-explicit-reset"
    )).toHaveLength(2);
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-app-full-crud"
    )).toHaveLength(2);
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-app-crud-reorder"
    )).toHaveLength(2);
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-system-settings"
    )).toHaveLength(2);
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-role-session-isolation"
    )).toHaveLength(2);
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-game-window-ui"
    )).toHaveLength(2);
    expect(repositoryManifest.journeys?.filter(
      (journey) => (journey as { coverageGroup?: string }).coverageGroup
        === "chromium-v23-workspace-web-slot"
    )).toHaveLength(2);
  });

  it("rejects unknown parents and inheritance cycles", () => {
    expect(() => resolveDesktopE2eProfile({
      profiles: { full: { extends: "missing", phases: [], specs: [] } }
    }, "full")).toThrow(/Unknown desktop E2E profile: missing/u);
    expect(() => resolveDesktopE2eProfile({
      profiles: {
        full: { extends: "extended", phases: [], specs: [] },
        extended: { extends: "full", phases: [], specs: [] }
      }
    }, "full")).toThrow(/inheritance cycle/u);
  });
});

describe("desktop E2E journey verdict aggregation", () => {
  it("does not pass a multi-phase journey from partial evidence", () => {
    expect(verdicts([{ phase: "seed", status: "PASS" }])).toContainEqual({
      id: "SMOKE-RESTART",
      phases: ["seed", "restart"],
      status: "NOT_RUN"
    });
  });

  it("accepts expected process termination as successful phase evidence", () => {
    expect(verdicts([
      { phase: "seed", status: "PASS" },
      { phase: "restart", status: "EXPECTED_FORCE_TERMINATION" }
    ])).toContainEqual({
      id: "SMOKE-RESTART",
      phases: ["seed", "restart"],
      status: "PASS"
    });
  });

  it("keeps failure and blocked outcomes distinct from missing evidence", () => {
    const aggregated = verdicts([
      { phase: "seed", status: "PASS" },
      { phase: "restart", status: "PASS" },
      { phase: "full", status: "FAIL" },
      { phase: "native", status: "BLOCKED" }
    ]);
    expect(aggregated).toEqual([
      { id: "SMOKE-RESTART", phases: ["seed", "restart"], status: "PASS" },
      { id: "FULL-FAILURE", phases: ["full"], status: "FAIL" },
      { id: "NATIVE", phases: ["native"], status: "BLOCKED" }
    ]);
  });
});
