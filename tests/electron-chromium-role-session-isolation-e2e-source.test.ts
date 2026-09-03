import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Chromium Role Session isolation desktop journey source", () => {
  it("uses visible UI and a real WebDriver page click instead of debug mutation controls", async () => {
    const [spec, roleSurface] = await Promise.all([
      readFile("e2e/desktop/specs/chromium-role-session-isolation.e2e.ts", "utf8"),
      readFile("e2e/desktop/support/electron-role-surface.ts", "utf8")
    ]);

    expect(spec).toContain("clickVisibleElectronRolePageButton");
    expect(spec).toContain('button=New game');
    expect(spec).toContain('button=New game window');
    expect(spec).toContain('"Add role"');
    expect(spec).toContain('normalize-space(.)="Open in…"');
    expect(spec).toContain("restoreGameWindowThroughVisibleUi");
    expect(spec).toContain('button[aria-label=\'Show\']');
    expect(spec).toContain('"Stop and close window"');
    expect(spec).toContain('"Clear saved data"');
    expect(spec).not.toContain("runtimeUiAction");
    expect(spec).not.toMatch(
      /rendererCall\("(?:createGame|createRole|createLaunchWorkspace|launchWorkspace|stopLaunchWorkspace|clearRoleBrowserData)"/u
    );
    expect(roleSurface).toContain("browser.switchToWindow(handle)");
    expect(roleSurface).toContain('await $("#qa-target")');
    expect(roleSurface).toContain("await button.click()");
    expect(roleSurface).not.toContain("rionStudioDesktopE2e");
  });

  it("keeps evidence read-only, exact, and current-runtime aware", async () => {
    const [bridge, e2eMain, productionMain, productionPreload] = await Promise.all([
      readFile("src/electron/e2e/desktopE2eBridge.ts", "utf8"),
      readFile("src/electron/e2e/index.ts", "utf8"),
      readFile("src/electron/main/index.ts", "utf8"),
      readFile("src/electron/preload/index.ts", "utf8")
    ]);

    expect(bridge).toContain('action: "roleSessionRuntime"');
    expect(bridge).toContain("session.sessionStoragePath !== session.chromiumUserDataDir");
    expect(bridge).toContain(
      "runtime.appKitIdentity.logicalWindowId !== runtime.windowId"
    );
    expect(bridge).not.toContain(
      "runtime.appKitIdentity.launchGeneration !== runtime.attemptGeneration"
    );
    expect(e2eMain).toContain("originalEnsure.call(this, roleId, rolePaths)");
    expect(e2eMain).not.toContain("sessions.ensure(");
    expect(e2eMain).toContain(
      "if (!observedRoleIds.has(roleId)) roleRuntimeObservations.set(roleId, null)"
    );
    expect(e2eMain).toContain("const presented = window.activeTabId === role.tabId");
    expect(e2eMain).toContain("focused: window.focused && presented");
    expect(e2eMain).toContain("visible: window.visible && presented");
    expect(productionMain).not.toContain("roleSessionRuntime");
    expect(productionPreload).not.toContain("roleSessionRuntime");
  });

  it("routes one shared two-phase spec into both isolated Chromium profiles", async () => {
    const [phaseSpecs, runner, manifestSource] = await Promise.all([
      readFile("e2e/desktop/phaseSpecs.ts", "utf8"),
      readFile("scripts/runDesktopE2e.mjs", "utf8"),
      readFile("docs/e2e-coverage.json", "utf8")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<{ coverageGroup?: string; platforms: string[]; replaces?: string[] }>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    expect(phaseSpecs.match(/chromium-role-session-isolation-(?:seed|restart)/gu))
      .toHaveLength(2);
    expect(runner).toContain(
      '["chromium-role-session-isolation-restart", ["chromium-role-session-isolation-seed"]]'
    );
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup === "chromium-v23-role-session-isolation"
    );
    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([["macos"], ["windows"]]);
    expect(journeys.every((journey) =>
      journey.replaces?.includes("ROLE-SESSION-ISOLATION-003")
    )).toBe(true);
    for (const profileName of [
      "chromium-macos-appkit-smoke",
      "chromium-windows-smoke"
    ]) {
      expect(manifest.profiles[profileName].phases).toEqual(expect.arrayContaining([
        "chromium-role-session-isolation-seed",
        "chromium-role-session-isolation-restart"
      ]));
      expect(manifest.profiles[profileName].specs).toContain(
        "e2e/desktop/specs/chromium-role-session-isolation.e2e.ts"
      );
    }
  });
});
