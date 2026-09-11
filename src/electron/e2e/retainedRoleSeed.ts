import { app } from "electron";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { CoreAddonClient, type RawNodeApiCoreFactory } from "../core/coreAddonClient";
import type { ElectronDesktopE2eRetainedV22Precondition } from "./desktopE2eBridge";
import { markRecoveryExportFailed, type RecoverySourceBinding } from "./sessionRecoverySeed";
const requireNativeModule = createRequire(import.meta.url);
const phase = process.env.RION_STUDIO_E2E_PHASE;
const userDataDirectory = process.env.RION_STUDIO_USER_DATA_DIR;
const artifactDirectory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;

interface NativeAppCoreOptions {
  appVersion: string;
  packaged: boolean;
  platform: "darwin" | "win32";
  runtimeContractVersion: number;
  startupBackupLabel: string;
  userDataDir: string;
}

interface DesktopE2eNativeCoreFactory extends RawNodeApiCoreFactory<NativeAppCoreOptions> {
  createAppCoreForDesktopE2e:
    RawNodeApiCoreFactory<NativeAppCoreOptions>["createAppCore"];
}

const RETAINED_V22_PHASE = "chromium-role-session-reset-seed";
const RETAINED_V22_GAME_NAME = "Chromium Retained v22 Game";
const RETAINED_V22_ROLE_NAME = "Chromium Retained v22 Role";
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
function requireE2eEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Electron desktop E2E entry`);
  return value;
}

function fixtureLaunchUrl(): string {
  const origin = new URL(requireE2eEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  if (
    origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || origin.username !== ""
    || origin.password !== ""
  ) {
    throw new Error("The Electron desktop E2E fixture origin is not loopback HTTP.");
  }
  const launchUrl = new URL("/role/chromium-explicit-reset", origin);
  launchUrl.searchParams.set("marker", "chromium-explicit-reset");
  launchUrl.searchParams.set("mode", "observe");
  return launchUrl.href;
}

export async function seedRetainedV22Role(platform: {
  platform: "darwin" | "win32"; productPlatform: "macos" | "windows";
  runtimeTarget: string; sourceEngine: "wkwebview" | "webview2";
}): Promise<
  ElectronDesktopE2eRetainedV22Precondition | null
> {
  if (phase !== RETAINED_V22_PHASE && phase !== "chromium-role-session-recovery" && phase !== "chromium-role-session-upgrade-seed") return null;
  const token = requireE2eEnvironment("RION_STUDIO_E2E_SESSION_TOKEN");
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new Error("The Electron desktop E2E session token is invalid.");
  }
  if (requireE2eEnvironment("RION_STUDIO_E2E_RUNTIME_TARGET") !== platform.runtimeTarget) {
    throw new Error("The retained-v22 pre-seed target does not match the host platform.");
  }
  if (!userDataDirectory || !isAbsolute(userDataDirectory)) {
    throw new Error("The retained-v22 pre-seed requires an absolute user-data directory.");
  }
  const addonPath = join(
    import.meta.dirname,
    `../../build/native/${process.platform}-${process.arch}/rion-core.node`
  );
  const addon = requireNativeModule(addonPath) as DesktopE2eNativeCoreFactory;
  let sourceBinding: RecoverySourceBinding | undefined;
  const core = await CoreAddonClient.create({
    createAppCore: async (options) => {
      const binding = await addon.createAppCoreForDesktopE2e(options);
      sourceBinding = binding as RecoverySourceBinding;
      return binding;
    }
  }, {
    appVersion: app.getVersion(),
    packaged: false,
    platform: platform.platform,
    runtimeContractVersion: 22,
    startupBackupLabel: "electron-desktop-e2e-retained-v22",
    userDataDir: userDataDirectory
  });
  try {
    const launchUrl = fixtureLaunchUrl();
    const game = await core.invoke({
      type: "gameCreate",
      input: {
        defaultLaunchUrl: launchUrl,
        name: RETAINED_V22_GAME_NAME
      }
    });
    const role = await core.invoke({
      type: "roleCreate",
      input: {
        gameId: game.id,
        launchUrl,
        name: RETAINED_V22_ROLE_NAME,
        notes: "Created only by the Chromium desktop E2E v22 pre-seed."
      }
    });
    await core.invoke({ type: "roleBrowserDirectoryEnsure", id: role.id });
    if (phase === "chromium-role-session-recovery" || phase === "chromium-role-session-upgrade-seed") {
      if (!sourceBinding) throw new Error("Missing recovery source fixture binding");
      const transferId = await sourceBinding.seedRoleSessionRecoveryForDesktopE2e(role.id, phase === "chromium-role-session-upgrade-seed");
      await core.shutdown();
      await markRecoveryExportFailed(addon, {
        appVersion: app.getVersion(), packaged: false, platform: platform.platform,
        runtimeContractVersion: 29, userDataDir: userDataDirectory, startupBackupLabel: "electron-desktop-e2e-recovery-target"
      }, role.id, transferId);
    }
    const precondition = Object.freeze({
      contractVersion: 1,
      gameId: game.id,
      gameName: game.name,
      launchUrl,
      platform: platform.productPlatform,
      roleId: role.id,
      roleName: role.name,
      runtimeContractVersion: 22,
      sourceEngine: platform.sourceEngine
    } satisfies ElectronDesktopE2eRetainedV22Precondition);
    if (artifactDirectory && isAbsolute(artifactDirectory)) {
      writeFileSync(
        join(artifactDirectory, "retained-v22-precondition.json"),
        `${JSON.stringify(precondition, null, 2)}\n`
      );
    }
    return precondition;
  } finally {
    await core.shutdown();
  }
}
