import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { desktopE2eSpecForPhase } from "../e2e/desktop/phaseSpecs";
import {
  chromiumRecoveryParityPhaseDependencies,
  chromiumRecoveryParityPhaseNamespaces,
  isChromiumRecoveryParityPhase
} from "../scripts/desktopE2eChromiumRecoveryParityEvidence.mjs";
import { isExpectedDesktopE2eForcedTermination } from
  "../scripts/desktopE2eForcedTermination.mjs";

const mixedPhases = [
  "chromium-mixed-recovery-seed",
  "chromium-mixed-recovery-force",
  "chromium-mixed-recovery-restore"
] as const;
const windowPhases = [
  "chromium-window-recovery-seed",
  "chromium-window-recovery-force",
  "chromium-window-recovery-restore-force",
  "chromium-window-recovery-discard",
  "chromium-window-recovery-final-show"
] as const;

describe("Chromium recovery parity replacement source", () => {
  it("routes every standalone phase to its cohesive shared-platform spec", () => {
    for (const phase of mixedPhases) {
      expect(desktopE2eSpecForPhase(phase))
        .toBe("e2e/desktop/specs/chromium-mixed-recovery.e2e.ts");
      expect(isChromiumRecoveryParityPhase(phase)).toBe(true);
    }
    for (const phase of windowPhases) {
      expect(desktopE2eSpecForPhase(phase))
        .toBe("e2e/desktop/specs/chromium-window-recovery-ui.e2e.ts");
      expect(isChromiumRecoveryParityPhase(phase)).toBe(true);
    }
    expect(chromiumRecoveryParityPhaseDependencies).toContainEqual([
      "chromium-mixed-recovery-restore",
      ["chromium-mixed-recovery-seed", "chromium-mixed-recovery-force"]
    ]);
    expect(chromiumRecoveryParityPhaseDependencies.at(-1)).toEqual([
      "chromium-window-recovery-final-show",
      windowPhases.slice(0, 4)
    ]);
    expect(chromiumRecoveryParityPhaseNamespaces.filter(([, namespace]) =>
      namespace === "chromium-mixed-recovery-lifecycle")).toHaveLength(3);
    expect(chromiumRecoveryParityPhaseNamespaces.filter(([, namespace]) =>
      namespace === "chromium-window-recovery-lifecycle")).toHaveLength(5);
  });

  it("uses visible Show, Restore, Discard, and retained native-tab actions", async () => {
    const [mixed, windows] = await Promise.all([
      readFile("e2e/desktop/specs/chromium-mixed-recovery.e2e.ts", "utf8"),
      readFile("e2e/desktop/specs/chromium-window-recovery-ui.e2e.ts", "utf8")
    ]);
    for (const source of [mixed, windows]) {
      expect(source).toContain("button[aria-label='Show']");
      expect(source).toContain("button=Restore session");
      expect(source).toContain("clickVisibleRuntimeTab");
      expect(source).toContain("forceTerminateProcessTree");
      expect(source).toContain("electronDesktopE2eGameWindowRuntime");
      expect(source).not.toContain("runtimeUiAction(");
    }
    expect(windows).toContain("button=Discard");
    expect(mixed).toContain("electronDesktopE2eWorkspaceWebRuntime");
    expect(mixed).toContain("Chromium Mixed Recovery Web");
    expect(windows).toContain("CHROMIUM-MACOS-APPKIT-WINDOW-RECOVERY-UI-022");
    expect(windows).toContain("CHROMIUM-WINDOWS-WINDOW-RECOVERY-UI-022");
    expect(windows).toContain("waitForSavedRoleTopology(roles, targets)");
    expect(windows).toContain(
      "Saved multi-window recovery topology did not commit"
    );
  });

  it("classifies only exact process-killing phases as expected termination", () => {
    for (const phase of [
      "chromium-mixed-recovery-force",
      "chromium-window-recovery-force",
      "chromium-window-recovery-restore-force"
    ]) expect(isExpectedDesktopE2eForcedTermination(phase)).toBe(true);
    for (const phase of [
      "chromium-mixed-recovery-seed",
      "chromium-mixed-recovery-restore",
      "chromium-window-recovery-discard",
      "chromium-window-recovery-final-show"
    ]) expect(isExpectedDesktopE2eForcedTermination(phase)).toBe(false);
  });

  it("fails closed on exact schema-v2, in-progress, Session, and AppKit evidence", async () => {
    const evidence = await readFile(
      "scripts/desktopE2eChromiumRecoveryParityEvidence.mjs",
      "utf8"
    );
    expect(evidence).toContain("session?.schemaVersion === 2");
    expect(evidence).toContain("session.restoreInProgressWindowIds, []");
    expect(evidence).toContain("session.liveWindowIds");
    expect(evidence).toContain("runtime.appKitIdentity?.logicalWindowId");
    expect(evidence).toContain('web.web?.contentSession === "global-web-persistent"');
    expect(evidence).toContain('web.web?.chromeShellSession === "rion-web-chrome-shell:memory"');
    expect(evidence).toContain("roleTab.latestSessionEnsure.chromiumPathSha256 !==");
    expect(evidence).toContain("gameWindow.currentRuntime.coreTabIds");
  });

  it("registers paired macOS AppKit and Windows exact replacements", async () => {
    const manifest = JSON.parse(await readFile("docs/e2e-coverage.json", "utf8")) as {
      journeys: Array<{
        coverageGroup?: string;
        id: string;
        phases?: string[];
        platforms?: string[];
        replaces?: string[];
        spec?: string;
      }>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    for (const [group, replaced, phases, spec] of [
      [
        "chromium-v23-mixed-runtime-recovery",
        "RUNTIME-MIXED-RECOVERY-011",
        mixedPhases,
        "e2e/desktop/specs/chromium-mixed-recovery.e2e.ts"
      ],
      [
        "chromium-v23-window-recovery-ui",
        "WINDOW-RECOVERY-UI-007",
        windowPhases,
        "e2e/desktop/specs/chromium-window-recovery-ui.e2e.ts"
      ]
    ] as const) {
      const pair = manifest.journeys.filter((journey) => journey.coverageGroup === group);
      expect(pair).toHaveLength(2);
      expect(pair.map(({ platforms }) => platforms)).toEqual([["macos"], ["windows"]]);
      for (const journey of pair) {
        expect(journey.replaces).toEqual([replaced]);
        expect(journey.phases).toEqual(phases);
        expect(journey.spec).toBe(spec);
      }
      for (const profile of ["chromium-macos-appkit-smoke", "chromium-windows-smoke"]) {
        expect(manifest.profiles[profile]!.phases).toEqual(expect.arrayContaining([...phases]));
        expect(manifest.profiles[profile]!.specs).toContain(spec);
      }
    }
  });
});
