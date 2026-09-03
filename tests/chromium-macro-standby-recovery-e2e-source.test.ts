import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { desktopE2eSpecForPhase } from "../e2e/desktop/phaseSpecs";
import {
  chromiumMacroStandbyPhaseDependencies,
  chromiumMacroStandbyPhaseNamespaces,
  isChromiumMacroStandbyPhase,
  validateChromiumMacroStandbyRuntimeEvidence,
  validateChromiumMacroStandbySqliteEvidence
} from "../scripts/desktopE2eChromiumMacroStandbyEvidence.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("Chromium Macro standby recovery exact replacement source", () => {
  it("routes one standalone phase through its own durable namespace", () => {
    expect(desktopE2eSpecForPhase("chromium-macro-standby-recovery")).toBe(
      "e2e/desktop/specs/chromium-macro-standby-recovery.e2e.ts"
    );
    expect(isChromiumMacroStandbyPhase("chromium-macro-standby-recovery")).toBe(true);
    expect(isChromiumMacroStandbyPhase("p1-macro-standby-recovery")).toBe(false);
    expect(chromiumMacroStandbyPhaseDependencies).toEqual([]);
    expect(chromiumMacroStandbyPhaseNamespaces).toEqual([[
      "chromium-macro-standby-recovery",
      "chromium-macro-standby-recovery"
    ]]);
  });

  it("joins OS and controlled power signals to one exact serialized terminal lane", async () => {
    const [controller, bridge, entry, spec] = await Promise.all([
      source("src/electron/main/applicationLifecycleController.ts"),
      source("src/electron/e2e/desktopE2eBridge.ts"),
      source("src/electron/e2e/index.ts"),
      source("e2e/desktop/specs/chromium-macro-standby-recovery.e2e.ts")
    ]);

    for (const marker of [
      "signal(event: ElectronApplicationPowerEvent)",
      "#requestTransition(event === \"suspend\")",
      "this.#lane",
      "applyRuntimeSuspended(suspended)",
      "#observePowerSignal",
      "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED"
    ]) expect(controller).toContain(marker);
    expect(controller).not.toMatch(/setTimeout|setInterval/u);

    for (const marker of [
      'action: "applicationLifecycleSignal"',
      'action: "trustedInputRuntime"',
      "input.isPackaged()",
      "authorizeSenderUrl",
      "authenticate(request.token",
      "parseApplicationLifecycleSignalReceipt",
      "parseTrustedInputObservations"
    ]) expect(bridge).toContain(marker);
    expect(entry).toContain("installElectronDesktopE2eApplicationLifecycleObserver");
    expect(entry).toContain("installElectronDesktopE2eTrustedInputObserver");
    expect(entry).toContain("await lifecycle.signal(event)");
    expect(entry).toContain("await originalExecute.call(this, request)");

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-MACRO-STANDBY-RECOVERY-023",
      "CHROMIUM-WINDOWS-MACRO-STANDBY-RECOVERY-023",
      'button[aria-label=\'Start\']',
      'button[aria-label=\'Stop\']',
      'electronDesktopE2eApplicationLifecycleSignal("suspend")',
      'electronDesktopE2eApplicationLifecycleSignal("resume")',
      "suspendCleanup.receipt.confirmedInputNeutrality",
      "waitForEnabled({ reverse: true",
      "event.code === input.code && event.isTrusted === true",
      "secondHold.request.requestId",
      "clickVisibleRuntimeTab",
      "appKitIdentity",
      "topology.surfaces.filter"
    ]) expect(spec).toContain(marker);
    for (const forbidden of [
      'rendererCall("startMacro"',
      'rendererCall("stopMacro"',
      "applicationLifecycleSignal(true)",
      "setTimeout(",
      "setInterval("
    ]) expect(spec).not.toContain(forbidden);
  });

  it("pairs AppKit and Windows native replacement verdicts and phase routing", async () => {
    const [coverageSource, phaseSpecs, journeyEvidence, evidence] = await Promise.all([
      source("docs/e2e-coverage.json"),
      source("e2e/desktop/phaseSpecs.ts"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumMacroStandbyEvidence.mjs")
    ]);
    const manifest = JSON.parse(coverageSource) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    const journeys = manifest.journeys.filter((journey) =>
      journey.coverageGroup === "chromium-v23-macro-standby-recovery");
    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["MACRO-STANDBY-RECOVERY-012"]);
      expect(journey.priority).toBe("P1");
      expect(journey.feature).toBe("macros");
      expect(journey.kind).toBe("native");
      expect(journey.risk).toBe("native");
      expect(journey.outcomes).toEqual(["success", "failure"]);
      expect(journey.phases).toEqual(["chromium-macro-standby-recovery"]);
      expect(journey.spec).toBe(
        "e2e/desktop/specs/chromium-macro-standby-recovery.e2e.ts"
      );
    }
    for (const profile of [
      manifest.profiles["chromium-macos-appkit-smoke"],
      manifest.profiles["chromium-windows-smoke"]
    ]) {
      expect(profile.phases).toContain("chromium-macro-standby-recovery");
      expect(profile.specs).toContain(
        "e2e/desktop/specs/chromium-macro-standby-recovery.e2e.ts"
      );
    }
    expect(phaseSpecs).toContain('"chromium-macro-standby-recovery"');
    expect(journeyEvidence).toContain("validateChromiumMacroStandbyRuntimeEvidence");
    expect(journeyEvidence).toContain("validateChromiumMacroStandbySqliteEvidence");
    expect(evidence).toContain('"chromium-macro-standby-recovery"');
    expect(evidence).toContain("confirmedInputNeutrality === true");
    expect(evidence).toContain("inputEpoch > evidence.firstHold.request.inputEpoch");
    expect(evidence).toContain('expectedHost = platform === "macos"');
    expect(evidence).toContain("restoreSession?.schemaVersion === 2");
  });

  it("accepts only exact lifecycle, trusted-input, AppKit, and SQLite evidence", async () => {
    const roleAId = "11111111-1111-4111-8111-111111111111";
    const roleBId = "22222222-2222-4222-8222-222222222222";
    const windowId = "33333333-3333-4333-8333-333333333333";
    const tabA = "44444444-4444-4444-8444-444444444444";
    const tabB = "55555555-5555-4555-8555-555555555555";
    const lifecycle = (state: "active" | "suspended", epoch: number, revision: number) => ({
      capturedAt: `2026-08-31T00:00:0${revision}.000Z`,
      lifecycleEpoch: epoch,
      platform: "macos",
      reason: state,
      revision,
      state
    });
    const input = (
      sequence: number,
      intent: "cleanup" | "normal",
      phase: "hold" | "release",
      epoch: number,
      ownerId: string
    ) => ({
      receipt: {
        completedAtMs: sequence * 10 + 1,
        confirmedInputNeutrality: phase === "release",
        errorCode: null,
        errorMessage: null,
        inputEpoch: epoch,
        requestId: `request-${sequence}`,
        roleId: roleAId,
        status: "applied",
        surfaceGeneration: 1
      },
      request: {
        action: {
          code: "KeyS",
          key: "s",
          modifiers: [],
          ownerId,
          phase,
          suppressOverlayShortcut: true,
          type: "key"
        },
        deadlineMs: sequence * 10 + 5,
        inputEpoch: epoch,
        intent,
        origin: "macro",
        requestId: `request-${sequence}`,
        roleId: roleAId,
        scheduledAtMs: sequence * 10
      },
      sequence
    });
    const suspend = {
      before: lifecycle("active", 1, 1),
      event: "suspend",
      terminal: lifecycle("suspended", 2, 3)
    };
    const resume = {
      before: suspend.terminal,
      event: "resume",
      terminal: lifecycle("active", 3, 5)
    };
    const appKitIdentity = {
      launchGeneration: "66666666-6666-4666-8666-666666666666",
      logicalWindowId: windowId,
      nativeGeneration: 1
    };
    const evidence = {
      firstHold: input(1, "normal", "hold", 1, "run-1"),
      gameId: "77777777-7777-4777-8777-777777777777",
      gameWindowId: windowId,
      gameWindowRuntime: { currentRuntime: {
        appKitIdentity,
        hostKind: "appkit-chromium",
        parentNativeHostId: 10,
        windowId
      } },
      macroId: "88888888-8888-4888-8888-888888888888",
      platform: "macos",
      probe: { platform: "macos" },
      resume,
      roleAId,
      roleBId,
      roleRuntime: { currentRuntime: {
        appKitIdentity,
        hostKind: "appkit-chromium",
        tabId: tabA,
        windowId
      } },
      secondHold: input(3, "normal", "hold", 2, "run-2"),
      stopCleanup: input(4, "cleanup", "release", 2, "run-2"),
      suspend,
      suspendCleanup: input(2, "cleanup", "release", 2, "run-1"),
      tabA,
      tabB,
      topology: {
        hostKind: "appkit",
        surfaces: [
          { tabId: tabA, visible: false },
          { tabId: tabB, visible: true }
        ],
        tabIds: [tabA, tabB]
      }
    };
    const directory = await mkdtemp(resolve(tmpdir(), "rion-standby-evidence-"));
    try {
      await writeFile(resolve(
        directory,
        "chromium-macro-standby-recovery-evidence.json"
      ), JSON.stringify(evidence));
      await expect(validateChromiumMacroStandbyRuntimeEvidence({
        phase: "chromium-macro-standby-recovery",
        phaseDirectory: directory,
        platform: "macos"
      })).resolves.toMatchObject({ hostKind: "appkit-chromium", roleIds: [roleAId, roleBId] });

      const entities = {
        games: [{ id: evidence.gameId, name: "Chromium Standby Recovery Game" }],
        gameWindows: [{ id: windowId, name: "Window", payload: {
          tabs: [
            { id: tabA, sourceId: roleAId, tabType: "role" },
            { id: tabB, sourceId: roleBId, tabType: "role" }
          ]
        } }],
        macros: [{ id: evidence.macroId, name: "Chromium Standby Recovery Macro",
          payload: { activationMode: "toggle", enabled: true, repeat: { type: "once" },
            roleIds: [roleAId], steps: [{ action: "hold_until_stop", code: "KeyS",
              id: "chromium-standby-held-key", type: "key" }] } }],
        roles: [
          { id: roleAId, name: "Chromium Standby Recovery Role A",
            payload: { gameId: evidence.gameId } },
          { id: roleBId, name: "Chromium Standby Recovery Role B",
            payload: { gameId: evidence.gameId } }
        ],
        workspaces: []
      };
      expect(validateChromiumMacroStandbySqliteEvidence({
        entities,
        phase: "chromium-macro-standby-recovery",
        phaseDirectory: directory,
        settings: [{ key: "runtimeRestoreSession", payload: {
          cleanExit: true,
          schemaVersion: 2
        } }]
      })).toMatchObject({ cleanExit: true, windowId });
      expect(() => validateChromiumMacroStandbySqliteEvidence({
        entities,
        phase: "chromium-macro-standby-recovery",
        phaseDirectory: directory,
        settings: [{ key: "runtimeRestoreSession", payload: {
          cleanExit: false,
          schemaVersion: 2
        } }]
      })).toThrow("final clean schema-v2 lifecycle journal is missing");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
