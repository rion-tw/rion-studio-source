import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("Chromium application-recovery exact replacement", () => {
  it("uses visible creation/restore and exact-PID force termination", async () => {
    const [spec, processSupport] = await Promise.all([
      source("e2e/desktop/specs/chromium-app-recovery.e2e.ts"),
      source("e2e/desktop/support/process.ts")
    ]);

    for (const marker of [
      "[journey:CHROMIUM-MACOS-APPKIT-APP-RECOVERY-015]",
      "[journey:CHROMIUM-WINDOWS-APP-RECOVERY-015]",
      "button=New game",
      "clickWorkspaceCreateAction()",
      "button=New game window",
      "button[aria-label='Show']",
      "button=Restore session",
      "clickVisibleElectronRolePageButton",
      "isTrusted: true",
      "probe.processId",
      "forceTerminateProcessTree(processId)",
      "electronDesktopE2eRoleSessionRuntime",
      "electronDesktopE2eGameWindowRuntime",
      "appKitIdentity"
    ]) {
      expect(spec).toContain(marker);
    }
    for (const forbidden of [
      'rendererCall("createGame"',
      'rendererCall("createRole"',
      'rendererCall("createLaunchWorkspace"',
      'rendererCall("createGameWindow"',
      'rendererCall("launchWorkspace"',
      'rendererCall("restoreSavedGameWindows"'
    ]) {
      expect(spec).not.toContain(forbidden);
    }
    expect(processSupport).toContain("Refusing to terminate invalid desktop E2E PID");
    expect(processSupport).toContain('taskkill.exe", ["/PID", String(pid), "/T", "/F"]');
    expect(processSupport).toContain('executeFile("/bin/kill", ["-KILL", String(pid)])');
  });

  it("pairs exact AppKit and Windows replacement verdicts", async () => {
    const manifest = JSON.parse(await source("docs/e2e-coverage.json")) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    const journeys = manifest.journeys.filter(
      ({ coverageGroup }) => coverageGroup === "chromium-v23-application-recovery"
    );
    expect(journeys).toHaveLength(2);
    expect(journeys.map(({ platforms }) => platforms)).toEqual([["macos"], ["windows"]]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["APP-RECOVERY-001"]);
      expect(journey.feature).toBe("app-shell");
      expect(journey.priority).toBe("P1");
      expect(journey.kind).toBe("native");
      expect(journey.risk).toBe("native");
      expect(journey.outcomes).toEqual(["failure", "restart"]);
      expect(journey.phases).toEqual([
        "chromium-app-recovery-seed",
        "chromium-app-recovery-force",
        "chromium-app-recovery-restore"
      ]);
    }
    for (const profile of [
      manifest.profiles["chromium-macos-appkit-smoke"],
      manifest.profiles["chromium-windows-smoke"]
    ]) {
      expect(profile.phases).toEqual(expect.arrayContaining([
        "chromium-app-recovery-seed",
        "chromium-app-recovery-force",
        "chromium-app-recovery-restore"
      ]));
      expect(profile.specs).toContain(
        "e2e/desktop/specs/chromium-app-recovery.e2e.ts"
      );
    }
  });

  it("locks the standalone namespace and exact SQLite/native evidence gates", async () => {
    const [runner, journeyEvidence, evidence, forced, bridge, driver, phases] = await Promise.all([
      source("scripts/runDesktopE2e.mjs"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumAppRecoveryEvidence.mjs"),
      source("scripts/desktopE2eForcedTermination.mjs"),
      source("src/electron/e2e/desktopE2eBridge.ts"),
      source("e2e/desktop/support/electron-driver.ts"),
      source("e2e/desktop/phaseSpecs.ts")
    ]);
    expect(runner).toContain("chromiumJourneyPhaseDependencies");
    expect(runner).toContain("chromiumJourneyPhaseNamespaces");
    expect(journeyEvidence).toContain("chromiumAppRecoveryPhaseDependencies");
    expect(journeyEvidence).toContain("chromiumAppRecoveryPhaseNamespaces");
    expect(runner).toContain("desktopE2eForcedTerminationEnvironment(phase)");
    expect(runner).toContain("&& !forcedTermination");
    expect(forced).toContain('"chromium-app-recovery-force"');
    expect(forced).toContain('RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT: "1"');
    expect(forced).toContain("process.kill(marker.pid, 0)");
    expect(evidence.match(/chromium-app-recovery-lifecycle/gu)).toHaveLength(3);
    expect(evidence).toContain('phase !== "chromium-app-recovery-force"');
    expect(evidence).toContain("sameValue(session.liveWindowIds, [lifecycle.windowId])");
    expect(evidence).toContain("role.currentRuntime.appKitIdentity?.logicalWindowId");
    expect(evidence).toContain("sameValue(nativeWindow.nativeTabIds, [lifecycle.tabId])");
    expect(bridge).toContain("processId: number;");
    expect(bridge).toContain("processId: input.processId");
    expect(driver).toContain("processId: number;");
    expect(phases).toContain('"chromium-app-recovery-seed"');
    expect(phases).toContain('"chromium-app-recovery-force"');
    expect(phases).toContain('"chromium-app-recovery-restore"');
  });
});
