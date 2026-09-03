import { describe, expect, it } from "vitest";

import {
  enforceChromiumCommandLinePolicy,
  type ChromiumCommandLinePolicyInput
} from "../src/electron/main/chromiumCommandLinePolicy";

const token = "a".repeat(64);

function input(
  switches: readonly string[],
  overrides: Partial<ChromiumCommandLinePolicyInput> = {}
): ChromiumCommandLinePolicyInput {
  return {
    commandLine: {
      hasSwitch: (name) => switches.includes(name)
    },
    desktopE2eEntryAuthorized: false,
    environment: {},
    isPackaged: false,
    platform: "darwin",
    ...overrides
  };
}

describe("Chromium command-line policy", () => {
  it("accepts an ordinary product launch without a debug transport", () => {
    expect(enforceChromiumCommandLinePolicy(input([]))).toBe("not-requested");
  });

  it.each(["remote-debugging-port", "remote-debugging-pipe"])(
    "rejects externally supplied %s in a product launch",
    (name) => {
      expect(() => enforceChromiumCommandLinePolicy(input([name])))
        .toThrow("Chromium remote debugging is unavailable");
    }
  );

  it("requires one exact non-packaged desktop-E2E capability", () => {
    const authorized = input(["remote-debugging-port"], {
      desktopE2eEntryAuthorized: true,
      environment: {
        RION_STUDIO_E2E_ARTIFACT_DIR: "/tmp/rion-e2e/artifacts",
        RION_STUDIO_E2E_RUNTIME_TARGET: "chromium-v23-macos-appkit",
        RION_STUDIO_E2E_SESSION_TOKEN: token,
        RION_STUDIO_USER_DATA_DIR: "/tmp/rion-e2e/user-data"
      }
    });
    expect(enforceChromiumCommandLinePolicy(authorized)).toBe("desktop-e2e");
    expect(() => enforceChromiumCommandLinePolicy({
      ...authorized,
      desktopE2eEntryAuthorized: false
    })).toThrow("Chromium remote debugging is unavailable");
    expect(() => enforceChromiumCommandLinePolicy({
      ...authorized,
      commandLine: { hasSwitch: () => true }
    })).toThrow("Chromium remote debugging is unavailable");
  });

  it("rejects a packaged product even when caller-controlled E2E values look valid", () => {
    const forged = input(["remote-debugging-pipe"], {
      desktopE2eEntryAuthorized: true,
      environment: {
        RION_STUDIO_E2E_ARTIFACT_DIR: "C:\\Rion\\artifacts",
        RION_STUDIO_E2E_CHROMIUM_USER_DATA_DIR: "C:\\Rion\\user-data",
        RION_STUDIO_E2E_PACKAGED: "1",
        RION_STUDIO_E2E_RUNTIME_TARGET: "chromium-v23-windows",
        RION_STUDIO_E2E_SESSION_TOKEN: token
      },
      isPackaged: true,
      platform: "win32"
    });
    expect(() => enforceChromiumCommandLinePolicy(forged))
      .toThrow("Chromium remote debugging is unavailable");
  });
});
