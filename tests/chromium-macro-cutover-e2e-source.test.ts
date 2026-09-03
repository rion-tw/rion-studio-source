import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chromiumMacroCutoverPhaseDependencies,
  chromiumMacroCutoverPhaseNamespaces,
  chromiumMacroCutoverReplacementPlan,
  validateChromiumMacroCutoverSqliteEvidence
} from "../scripts/desktopE2eChromiumMacroCutoverEvidence.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

const sourceIds = [
  "MACRO-INPUT-RECOVERY-011",
  "MACRO-MIDDLE-BUTTON-013",
  "MACRO-MODIFIER-CONTINUITY-008",
  "MACRO-MULTIROLE-005",
  "MACRO-OWNERSHIP-TRANSFER-010",
  "MACRO-SHORTCUT-REENTRY-007",
  "MACRO-TERMINAL-CLEANUP-006",
  "ROLE-KEY-BLUR-004"
] as const;

describe("Chromium Macro paired cutover E2E source", () => {
  it("preserves the eight v22 native contracts as separate paired verdicts", async () => {
    const manifest = JSON.parse(await source("docs/e2e-coverage.json")) as {
      journeys: Array<Record<string, unknown>>;
    };
    expect(chromiumMacroCutoverReplacementPlan).toHaveLength(16);
    for (const sourceId of sourceIds) {
      const retained = manifest.journeys.find((journey) => journey.id === sourceId);
      const replacements = chromiumMacroCutoverReplacementPlan.filter(
        (journey) => journey.replaces[0] === sourceId
      );
      expect(replacements.map((journey) => journey.platform)).toEqual([
        "macos",
        "windows"
      ]);
      for (const replacement of replacements) {
        const claimed = manifest.journeys.find(
          (journey) => journey.id === replacement.id
        );
        expect(replacement).toMatchObject({
          feature: retained?.feature,
          kind: retained?.kind,
          outcomes: retained?.outcomes,
          priority: retained?.priority,
          risk: retained?.risk
        });
        expect(claimed).toMatchObject({
          feature: replacement.feature,
          id: replacement.id,
          kind: replacement.kind,
          outcomes: replacement.outcomes,
          phases: replacement.phases,
          platforms: [replacement.platform],
          priority: replacement.priority,
          replaces: replacement.replaces,
          risk: replacement.risk,
          spec: "e2e/desktop/specs/chromium-macro-cutover.e2e.ts",
          status: "automated"
        });
      }
    }
    expect(chromiumMacroCutoverReplacementPlan.some((journey) =>
      journey.replaces.includes("MACRO-BACKGROUND-TAB-004")
    )).toBe(false);
  });

  it("uses visible managed Role/native controls and read-only exact evidence", async () => {
    const [support, keyboard, recovery, topology, cleanup, driver, evidence] =
      await Promise.all([
        source("e2e/desktop/specs/chromium-macro-cutover-support.ts"),
        source("e2e/desktop/specs/chromium-macro-cutover-keyboard.ts"),
        source("e2e/desktop/specs/chromium-macro-cutover-input-recovery.ts"),
        source("e2e/desktop/specs/chromium-macro-cutover-topology.ts"),
        source("e2e/desktop/specs/chromium-macro-cutover-cleanup.ts"),
        source("e2e/desktop/support/electron-role-surface.ts"),
        source("scripts/desktopE2eChromiumMacroCutoverEvidence.mjs")
      ]);
    const combined = [support, keyboard, recovery, topology, cleanup].join("\n");
    for (const marker of [
      "button[aria-label='Start']",
      "button[aria-label='Stop']",
      "clickVisibleRuntimeTab",
      "closeVisibleRuntimeTab",
      "closeVisibleRuntimeWindow",
      "claimVisibleElectronRolePlaceholder",
      "waitForChromiumMacroRoleReady",
      "quitChromiumApplicationVisible",
      "clickVisibleElectronRolePageButton",
      "clickVisibleElectronPageElementWithPointer",
      "clickMacosVisibleRoleControl",
      "completeVisibleElectronRoleVerification",
      "submitElectronRoleKeyPhases",
      "submitElectronRoleMiddleButtonPhase",
      "electronDesktopE2eTrustedInputRuntime",
      "confirmedInputNeutrality",
      'repeat: { intervalMs: 250, type: "loop" }',
      "appkit-chromium",
      "bundled-chromium"
    ]) {
      expect([combined, driver].join("\n")).toContain(marker);
    }
    for (const forbidden of [
      'rendererCall("launchRole"',
      'rendererCall("startMacro"',
      'rendererCall("stopMacro"',
      "electronDesktopE2eInput",
      "browser.pause(",
      "setTimeout("
    ]) {
      expect(combined).not.toContain(forbidden);
    }
    for (const displayFingerprintField of [
      "label: display.label",
      "bounds: display.bounds",
      "resolution: display.resolution",
      "scaleFactor: display.scaleFactor",
      "isPrimary: display.isPrimary",
      "isInternal: display.isInternal"
    ]) {
      expect(support).toContain(displayFingerprintField);
    }
    expect(evidence).toContain("chromium-windows-trusted-input-physical");
    expect(evidence).toContain(
      'candidateEvidence === "foreground-and-hidden-product-path"'
    );
    expect(evidence).toContain("foregroundProbe?.parentWasForeground === true");
    expect(evidence).toContain("hiddenProbe?.surfaceVisible === false");
    expect(evidence).toContain("trustedDom(evidence.hiddenKeyDom)");
    expect(evidence).toContain('"appkit-chromium"');
  });

  it("keeps restart phases in exact standalone namespaces", () => {
    expect(chromiumMacroCutoverPhaseDependencies).toEqual([
      [
        "chromium-macro-cutover-terminal-cleanup-restart",
        ["chromium-macro-cutover-terminal-cleanup-seed"]
      ],
      [
        "chromium-macro-cutover-topology-restart",
        ["chromium-macro-cutover-topology-seed"]
      ]
    ]);
    expect(chromiumMacroCutoverPhaseNamespaces).toEqual(expect.arrayContaining([
      [
        "chromium-macro-cutover-terminal-cleanup-seed",
        "chromium-macro-cutover-terminal-cleanup"
      ],
      [
        "chromium-macro-cutover-terminal-cleanup-restart",
        "chromium-macro-cutover-terminal-cleanup"
      ],
      ["chromium-macro-cutover-topology-seed", "chromium-macro-cutover-topology"],
      ["chromium-macro-cutover-topology-restart", "chromium-macro-cutover-topology"]
    ]));
  });

  it("wires every phase without replacing the Workspace cutover aggregation", async () => {
    const [phaseSpecs, aggregation] = await Promise.all([
      source("e2e/desktop/phaseSpecs.ts"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs")
    ]);
    for (const phase of [
      "chromium-macro-cutover-input-recovery",
      "chromium-macro-cutover-keyboard",
      "chromium-macro-cutover-terminal-cleanup-restart",
      "chromium-macro-cutover-terminal-cleanup-seed",
      "chromium-macro-cutover-topology-restart",
      "chromium-macro-cutover-topology-seed"
    ]) {
      expect(phaseSpecs).toContain(`"${phase}"`);
    }
    for (const marker of [
      "chromiumMacroCutoverPhaseDependencies",
      "chromiumMacroCutoverPhaseNamespaces",
      "validateChromiumMacroCutoverRuntimeEvidence(input)",
      "isChromiumMacroCutoverPhase(phase)",
      "validateChromiumMacroCutoverSqliteEvidence(input)",
      "chromiumWorkspaceCutoverPhaseDependencies",
      "chromiumWorkspaceCutoverPhaseNamespaces",
      "validateChromiumWorkspaceCutoverRuntimeEvidence(input)",
      "isChromiumWorkspaceCutoverPhase(phase)",
      "validateChromiumWorkspaceCutoverSqliteEvidence("
    ]) {
      expect(aggregation).toContain(marker);
    }
  });

  it("fails closed on exact persisted recovery, keyboard, topology, and cleanup cohorts", () => {
    const setting = [{ key: "runtimeRestoreSession", payload: { cleanExit: true } }];
    const base = { gameWindows: [], games: [], roles: [], macros: [], workspaces: [] };
    expect(validateChromiumMacroCutoverSqliteEvidence({
      entities: {
        ...base,
        roles: [{ id: "r1", name: "Chromium Macro Input Recovery Role" }],
        macros: [{
          id: "m1",
          name: "Chromium Macro Input Recovery",
          payload: { repeat: { intervalMs: 0, type: "loop" }, roleIds: ["r1"] }
        }]
      },
      phase: "chromium-macro-cutover-input-recovery",
      settings: setting
    })).toEqual({ cleanExit: true, phase: "chromium-macro-cutover-input-recovery" });
    expect(validateChromiumMacroCutoverSqliteEvidence({
      entities: {
        ...base,
        macros: [
          {
            id: "shortcut",
            name: "Chromium Shortcut Reentry",
            payload: { trigger: { code: "Digit2" } }
          },
          {
            id: "continuity",
            name: "Chromium Modifier Continuity",
            payload: { trigger: { code: "Digit5" } }
          },
          {
            id: "middle",
            name: "Chromium Middle Held",
            payload: { trigger: { button: "middle" } }
          },
          {
            id: "buttons",
            name: "Chromium Three Button Output",
            payload: {
              steps: [
                { id: "left", type: "click" },
                { button: "middle", id: "middle", type: "click" },
                { button: "right", id: "right", type: "click" }
              ]
            }
          }
        ]
      },
      phase: "chromium-macro-cutover-keyboard",
      settings: setting
    })).toEqual({ cleanExit: true, phase: "chromium-macro-cutover-keyboard" });
    expect(() => validateChromiumMacroCutoverSqliteEvidence({
      entities: base,
      phase: "chromium-macro-cutover-input-recovery",
      settings: setting
    })).toThrow("exact Role/Macro pair is absent");
  });
});
