import { resolve } from "node:path";

const PLATFORM_NAMES = new Map([
  ["darwin", "macos"],
  ["win32", "windows"]
]);

export function resolveDesktopE2eRuntimeTarget({
  architecture,
  manifest,
  platform,
  profileName,
  repositoryRoot
}) {
  const profile = manifest.profiles?.[profileName];
  if (!profile) throw new Error(`Unknown desktop E2E profile: ${profileName}`);
  const runtimeTargetName = profile.runtimeTarget;
  const runtimeTarget = manifest.runtimeTargets?.[runtimeTargetName];
  if (!runtimeTarget) {
    throw new Error(
      `Desktop E2E profile ${profileName} references unknown runtime target ${runtimeTargetName ?? "<missing>"}`
    );
  }
  const platformName = PLATFORM_NAMES.get(platform);
  if (!platformName) {
    throw new Error(`Desktop E2E does not support host platform ${platform}`);
  }
  if (!runtimeTarget.platforms?.includes(platformName)) {
    throw new Error(
      `Desktop E2E runtime target ${runtimeTargetName} does not support ${platformName}`
    );
  }

  const root = resolve(repositoryRoot);
  if (runtimeTarget.driver === "tauri") {
    return {
      applicationPath: resolve(
        root,
        "target",
        "debug",
        platform === "win32" ? "rion-tauri.exe" : "rion-tauri"
      ),
      architecture,
      buildScriptPath: resolve(root, "scripts/buildDesktopE2e.mjs"),
      driver: "tauri",
      platform: platformName,
      runtimeTargetName,
      wdioConfigPath: resolve(root, "e2e/desktop/wdio.conf.ts")
    };
  }
  if (runtimeTarget.driver === "electron") {
    return {
      applicationPath: resolve(root, "out/main/index.js"),
      architecture,
      buildScriptPath: resolve(root, "scripts/buildElectronDesktopE2e.mjs"),
      driver: "electron",
      platform: platformName,
      runtimeTargetName,
      wdioConfigPath: resolve(root, "e2e/desktop/wdio.electron.conf.ts")
    };
  }
  throw new Error(
    `Desktop E2E runtime target ${runtimeTargetName} has unsupported driver ${runtimeTarget.driver ?? "<missing>"}`
  );
}
