import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { browser } from "@wdio/globals";

import { desktopE2eSpecForPhase } from "./phaseSpecs";
import { requestElectronDesktopE2eClose } from "./support/electron-driver";
import { electronLauncherWindowHandle } from "./support/window-target";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Electron desktop E2E config`);
  return value;
}

const artifactDir = required("RION_STUDIO_E2E_ARTIFACT_DIR");
const entryPoint = required("RION_STUDIO_E2E_APP_BINARY");
const phase = required("RION_STUDIO_E2E_PHASE");
const packaged = process.env.RION_STUDIO_E2E_PACKAGED === "1";
required("RION_STUDIO_E2E_RUNTIME_TARGET");
required("RION_STUDIO_E2E_SESSION_TOKEN");
const userDataDir = packaged
  ? required("RION_STUDIO_E2E_CHROMIUM_USER_DATA_DIR")
  : required("RION_STUDIO_USER_DATA_DIR");
await mkdir(resolve(artifactDir, "screenshots"), { recursive: true });

const electronApplication = packaged
  ? {
      appArgs: [
        `--user-data-dir=${userDataDir}`,
        "--enable-logging=stderr"
      ],
      appBinaryPath: entryPoint
    }
  : {
      appArgs: [`--user-data-dir=${userDataDir}`],
      appEntryPoint: entryPoint
    };

export const config = {
  runner: "local",
  specs: [resolve(desktopE2eSpecForPhase(phase))],
  maxInstances: 1,
  capabilities: [{
    browserName: "electron",
    "wdio:electronServiceOptions": {
      ...electronApplication,
      captureMainProcessLogs: true,
      captureRendererLogs: true,
      rendererLogLevel: "debug"
    }
  }],
  services: [["electron", {
    captureMainProcessLogs: true,
    captureRendererLogs: true,
    rendererLogLevel: "debug"
  }]],
  framework: "mocha",
  reporters: [["spec", { addConsoleLogs: true }]],
  outputDir: resolve(artifactDir, "wdio"),
  logLevel: packaged ? "debug" : "info",
  bail: 1,
  connectionRetryCount: 0,
  connectionRetryTimeout: 70_000,
  waitforTimeout: 10_000,
  mochaOpts: {
    timeout: 8 * 60_000
  },
  beforeSession: (): void => {
    if (packaged) return;
    // WDIO replays commands registered on this protocol stub onto the concrete
    // browser before the real session is returned to Runner.endSession().
    const overwriteStubCommand = browser.overwriteCommand as unknown as (
      name: string,
      command: (originalCommand: () => Promise<void>) => Promise<void>
    ) => void;
    overwriteStubCommand("deleteSession", async () => undefined);
  },
  before: async (
    _capabilities: unknown,
    _specs: string[],
    runnerBrowser: WebdriverIO.Browser
  ): Promise<void> => {
    await runnerBrowser.setTimeout({ script: 55_000 });
    const puppeteer = await runnerBrowser.getPuppeteer();
    const windows = puppeteer.targets()
      .filter((target) => target.type() === "page")
      .map((target) => ({
        handle: (target as typeof target & { _targetId: string })._targetId,
        url: target.url()
    }));
    const launcherHandle = electronLauncherWindowHandle(windows);
    await runnerBrowser.switchToWindow(launcherHandle);
    runnerBrowser.electron.windowHandle = launcherHandle;
  },
  after: async (): Promise<void> => {
    if (packaged) return;
    if (process.env.RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT === "1") return;
    await requestElectronDesktopE2eClose();
    // Electron has completed its authoritative final flush and now owns shutdown.
    // The protocol-stub override keeps Runner from sending DELETE to an exited app.
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
