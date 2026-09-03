import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { browser } from "@wdio/globals";
import { desktopE2eSpecForPhase } from "./phaseSpecs";
import { primaryAppWindowHandle } from "./support/window-target";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the desktop E2E WDIO config`);
  return value;
}

const artifactDir = required("RION_STUDIO_E2E_ARTIFACT_DIR");
const userDataDir = required("RION_STUDIO_USER_DATA_DIR");
const token = required("RION_STUDIO_E2E_SESSION_TOKEN");
await mkdir(resolve(artifactDir, "screenshots"), { recursive: true });

const phase = required("RION_STUDIO_E2E_PHASE");
const spec = desktopE2eSpecForPhase(phase);

export const config = {
  runner: "local",
  specs: [resolve(spec)],
  maxInstances: 1,
  capabilities: [{
    browserName: "tauri",
    "tauri:options": {
      application: required("RION_STUDIO_E2E_APP_BINARY")
    }
  }],
  services: [["@wdio/tauri-service", {
    backendLogLevel: "debug",
    captureBackendLogs: true,
    captureFrontendLogs: true,
    commandTimeout: 60_000,
    driverProvider: "embedded",
    env: {
      RION_STUDIO_E2E_SESSION_TOKEN: token,
      RION_STUDIO_USER_DATA_DIR: userDataDir,
      RUST_BACKTRACE: "1"
    },
    logDir: resolve(artifactDir, "app-logs"),
    startTimeout: 90_000,
    statusPollTimeout: 5_000
  }]],
  framework: "mocha",
  reporters: [["spec", { addConsoleLogs: true }]],
  outputDir: resolve(artifactDir, "wdio"),
  logLevel: "info",
  bail: 1,
  connectionRetryCount: 0,
  connectionRetryTimeout: 70_000,
  waitforTimeout: 10_000,
  mochaOpts: {
    timeout: 8 * 60_000
  },
  before: async (): Promise<void> => {
    await browser.setTimeout({ script: 55_000 });
    const handles = await browser.getWindowHandles();
    await browser.switchToWindow(primaryAppWindowHandle(handles));
  },
  afterTest: async (
    test: { title: string },
    _context: unknown,
    result: { passed: boolean }
  ): Promise<void> => {
    if (result.passed) return;
    const safeTitle = test.title.replaceAll(/[^a-z0-9]+/giu, "-").replaceAll(/^-|-$/gu, "");
    await browser.saveScreenshot(resolve(artifactDir, "screenshots", `${safeTitle}.png`));
  }
};
