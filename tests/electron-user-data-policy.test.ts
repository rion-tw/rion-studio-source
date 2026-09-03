import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { preserveWebDriverUserDataDirectory } from
  "../src/electron/main/electronUserDataPolicy";

describe("Electron user-data policy", () => {
  it("launches non-packaged WebDriver Chromium with the same isolated user-data directory as Core", async () => {
    const config = await readFile("e2e/desktop/wdio.electron.conf.ts", "utf8");
    const nonPackagedApplication = config.slice(config.indexOf(": {\n      appArgs"));

    expect(config).toContain("const userDataDir = packaged");
    expect(nonPackagedApplication).toContain("appArgs: [`--user-data-dir=${userDataDir}`]");
    expect(nonPackagedApplication).toContain("appEntryPoint: entryPoint");
  });

  it("does not send DELETE to an Electron session after the app-owned clean close", async () => {
    const config = await readFile("e2e/desktop/wdio.electron.conf.ts", "utf8");
    const closeSubmission = config.indexOf("await requestElectronDesktopE2eClose()");
    const overrideAdapter = config.indexOf("const overwriteProtocolCommand");
    const sessionDetach = config.indexOf(
      'overwriteProtocolCommand("deleteSession", async () => undefined)'
    );

    expect(overrideAdapter).toBeGreaterThan(0);
    expect(sessionDetach).toBeGreaterThan(overrideAdapter);
    expect(closeSubmission).toBeGreaterThan(sessionDetach);
    expect(config).toContain("Electron has already completed its authoritative final flush");
  });

  it.each([
    "chromium-v23-macos-appkit",
    "chromium-v23-windows"
  ])("preserves the WebDriver path only for exact Chromium E2E target %s", (runtimeTarget) => {
    expect(preserveWebDriverUserDataDirectory({
      driverUserDataSwitchPresent: true,
      packaged: false,
      runtimeTarget
    })).toBe(true);
  });

  it("never lets a packaged app or unrecognized environment override product user-data ownership", () => {
    expect(preserveWebDriverUserDataDirectory({
      driverUserDataSwitchPresent: true,
      packaged: true,
      runtimeTarget: "chromium-v23-macos-appkit"
    })).toBe(false);
    expect(preserveWebDriverUserDataDirectory({
      driverUserDataSwitchPresent: true,
      packaged: false,
      runtimeTarget: "chromium-v99-untrusted"
    })).toBe(false);
    expect(preserveWebDriverUserDataDirectory({
      driverUserDataSwitchPresent: false,
      packaged: false,
      runtimeTarget: "chromium-v23-windows"
    })).toBe(false);
  });
});
