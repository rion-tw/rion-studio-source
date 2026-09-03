import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("Chromium Macro native-effect exact replacement source", () => {
  it("uses visible authoring/start/stop and event-bound trusted fixture evidence", async () => {
    const [spec, fixture] = await Promise.all([
      source("e2e/desktop/specs/chromium-macro-native-effect.e2e.ts"),
      source("scripts/runtimeAuthorityFixtureServer.mjs")
    ]);

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-MACRO-NATIVE-EFFECT-018",
      "CHROMIUM-WINDOWS-MACRO-NATIVE-EFFECT-018",
      "button[aria-label='New macro']",
      'selectOption(0, "Key", "A")',
      'selectOption(2, "Mouse button", "Middle click")',
      'selectOption(3, "Mouse button", "Right click")',
      'button[aria-label=\'Start\']',
      'button[aria-label=\'Stop\']',
      "expectFocusedRoleRuntime",
      "semanticEvents = Promise.all",
      'kind: "auxclick"',
      'kind: "contextmenu"',
      "fixtureEvents",
      "isTrusted: true",
      "buttons: 4",
      "buttons: 2",
      "focused: true",
      "electronDesktopE2eRoleSessionRuntime",
      "appKitIdentity"
    ]) {
      expect(spec).toContain(marker);
    }
    expect(fixture).toContain("button: Number.isInteger(input.button)");
    expect(fixture).toContain("buttons: Number.isInteger(input.buttons)");
    for (const forbiddenAction of [
      'rendererCall("createMacro"',
      'rendererCall("updateMacro"',
      'rendererCall("launchRole"',
      'rendererCall("startMacro"',
      'rendererCall("stopMacro"',
      "focusMainApplicationWindow",
      "electronDesktopE2eInput"
    ]) {
      expect(spec).not.toContain(forbiddenAction);
    }
  });

  it("pairs separate AppKit and Windows foreground-only replacement verdicts", async () => {
    const manifest = JSON.parse(await source("docs/e2e-coverage.json")) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    const journeys = manifest.journeys.filter((journey) =>
      journey.coverageGroup === "chromium-v23-macro-native-effect"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["MACRO-NATIVE-EFFECT-003"]);
      expect(journey.priority).toBe("P0");
      expect(journey.feature).toBe("macros");
      expect(journey.kind).toBe("ui");
      expect(journey.risk).toBe("native");
      expect(journey.outcomes).toEqual(["success", "failure"]);
      expect(journey.phases).toEqual(["chromium-macro-native-effect"]);
      expect(journey.spec).toBe(
        "e2e/desktop/specs/chromium-macro-native-effect.e2e.ts"
      );
    }
    for (const profile of [
      manifest.profiles["chromium-macos-appkit-smoke"],
      manifest.profiles["chromium-windows-smoke"]
    ]) {
      expect(profile?.phases).toContain("chromium-macro-native-effect");
      expect(profile?.specs).toContain(
        "e2e/desktop/specs/chromium-macro-native-effect.e2e.ts"
      );
    }
  });

  it("locks foreground native ABI, ordinary failure, and exact SQLite ownership", async () => {
    const [
      bootstrap,
      contract,
      coordinator,
      adapterTest,
      coreTest,
      physicalProbe,
      runner,
      journeyEvidence,
      evidence,
      phaseSpecs
    ] = await Promise.all([
      source("src/electron/main/chromiumRuntimeBootstrap.ts"),
      source("src/electron/main/windowsChromiumTrustedInputContract.ts"),
      source("src/electron/main/windowsChromiumInputSurfaceAttachmentCoordinator.ts"),
      source("tests/electron-windows-chromium-trusted-input-adapter.test.ts"),
      source("crates/rion-core/src/macro_runtime/tests/behavior_10_trusted_input_recovery_restarts_eligible_roots.rs"),
      source("scripts/electronWindowsChromiumTrustedInputProbe.cjs"),
      source("scripts/runDesktopE2e.mjs"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumMacroNativeEffectEvidence.mjs"),
      source("e2e/desktop/phaseSpecs.ts")
    ]);

    expect(bootstrap).toMatch(
      /trustedInput: "supported",\n\s+backgroundInput: "supported"/u
    );
    expect(contract).toContain("WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION = 3");
    expect(contract).toContain("readonly parentWasForeground: true");
    expect(coordinator).toContain("native.parentWasForeground");
    expect(coordinator).toContain("timer-driven success");
    expect(adapterTest).toContain("accepts exact hidden delivery without changing");
    expect(coreTest).toContain(
      "foreground_required_is_an_ordinary_terminal_failure_without_input_recovery"
    );
    expect(coreTest).toContain("runtime.input_recovery_for_role(\"r1\").unwrap().is_none()");
    expect(physicalProbe).toContain(
      'candidateEvidence: "foreground-and-hidden-product-path"'
    );
    expect(physicalProbe).toContain("receipt.abiVersion !== 3");
    expect(physicalProbe).not.toContain("receipt.abiVersion !== 1");
    expect(physicalProbe).toContain("parentWasForeground");
    expect(runner).toContain("chromiumJourneyPhaseDependencies");
    expect(runner).toContain("chromiumJourneyPhaseNamespaces");
    expect(runner).toMatch(
      /phase === "chromium-macro-native-effect"\s+\? "entity-persistence"/u
    );
    expect(journeyEvidence).toContain("chromiumMacroNativeEffectPhaseDependencies");
    expect(journeyEvidence).toContain("chromiumMacroNativeEffectPhaseNamespaces");
    expect(journeyEvidence).toContain("isChromiumMacroNativeEffectPhase(phase)");
    expect(evidence).toContain('"chromium-entity-persistence-lifecycle"');
    expect(evidence).toContain('steps[0].code === "KeyA"');
    expect(evidence).toContain('[undefined, "middle", "right"]');
    expect(evidence).toContain("restoreSession?.cleanExit === true");
    expect(phaseSpecs).toContain('"chromium-macro-native-effect"');
  });
});
