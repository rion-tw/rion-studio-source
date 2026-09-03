import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopE2eRuntimeTarget } from
  "../scripts/desktopE2eRuntimeTarget.mjs";

const root = resolve("/workspace/rion");
const manifest = {
  profiles: {
    compatibility: { runtimeTarget: "tauri-v22" },
    macosChromium: { runtimeTarget: "chromium-v23-macos-appkit" },
    windowsChromium: { runtimeTarget: "chromium-v23-windows" }
  },
  runtimeTargets: {
    "tauri-v22": {
      driver: "tauri",
      platforms: ["macos", "windows"]
    },
    "chromium-v23-macos-appkit": {
      driver: "electron",
      platforms: ["macos"]
    },
    "chromium-v23-windows": {
      driver: "electron",
      platforms: ["windows"]
    }
  }
};

describe("desktop E2E runtime-target execution plan", () => {
  it("keeps the existing v22 profile on the Tauri compatibility driver", () => {
    const plan = resolveDesktopE2eRuntimeTarget({
      architecture: "arm64",
      manifest,
      platform: "darwin",
      profileName: "compatibility",
      repositoryRoot: root
    });

    expect(plan).toMatchObject({
      applicationPath: resolve(root, "target/debug/rion-tauri"),
      driver: "tauri",
      runtimeTargetName: "tauri-v22",
      wdioConfigPath: resolve(root, "e2e/desktop/wdio.conf.ts")
    });
  });

  it("launches macOS Chromium through the distinct AppKit target", () => {
    const plan = resolveDesktopE2eRuntimeTarget({
      architecture: "arm64",
      manifest,
      platform: "darwin",
      profileName: "macosChromium",
      repositoryRoot: root
    });

    expect(plan).toMatchObject({
      applicationPath: resolve(root, "out/main/index.js"),
      buildScriptPath: resolve(root, "scripts/buildElectronDesktopE2e.mjs"),
      driver: "electron",
      platform: "macos",
      runtimeTargetName: "chromium-v23-macos-appkit",
      wdioConfigPath: resolve(root, "e2e/desktop/wdio.electron.conf.ts")
    });
  });

  it("refuses to reuse the Windows Chromium target as macOS evidence", () => {
    expect(() => resolveDesktopE2eRuntimeTarget({
      architecture: "arm64",
      manifest,
      platform: "darwin",
      profileName: "windowsChromium",
      repositoryRoot: root
    })).toThrow(/does not support macos/u);
  });

  it("resolves the Windows Chromium entry point without changing its target identity", () => {
    expect(resolveDesktopE2eRuntimeTarget({
      architecture: "x64",
      manifest,
      platform: "win32",
      profileName: "windowsChromium",
      repositoryRoot: root
    })).toMatchObject({
      applicationPath: resolve(root, "out/main/index.js"),
      driver: "electron",
      platform: "windows",
      runtimeTargetName: "chromium-v23-windows"
    });
  });
});
