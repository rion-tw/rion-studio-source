import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import { runPackagedCoreOperation, launchRoleThroughNativeInput } from "./packagedElectronBlackBox.mjs";
import { verifyPackagedElectron, resolveElectronPackageLayout } from "./verifyElectronPackage.mjs";
import { resolvePackagedElectronSmokeIsolation } from "./packagedElectronSmokeIsolation.mjs";
import { createPackagedElectronRuntimeEnvironment } from "./runtimeEnvironmentPolicy.mjs";
import { createDarwinPrivatePackagedElectronBundle } from "./packagedElectronDarwinPrivateBundle.mjs";
import { capturePackagedElectronPackageManifest, assertPackagedElectronPackageManifestUnchanged } from "./packagedElectronPackageManifest.mjs";
import { buildDarwinPackagedProcessInventory, createPackagedElectronProcessOwner,
  waitForPackagedElectronProcessOwnership, terminatePackagedElectronProcessTree,
  assertPackagedElectronProcessTreeGone, packagedElectronSpawnOptions } from "./packagedElectronProcessCleanup.mjs";

let stage = "verify-package";
let artifactDirectory;
async function main() {
  // Manual production observation. No E2E bridge, debug port, custom protocol,
  // HTTPS exception or injected page code. Quitting the visible app ends the run.
  const argument = process.argv.indexOf("--app");
  if (argument < 0 || !process.argv[argument + 1]) throw new Error("Usage: node scripts/preparePackagedWorkspaceDrm.mjs --app <bundle>");
  const application = resolve(process.argv[argument + 1]);
  await verifyPackagedElectron(application);
  const manifest = await capturePackagedElectronPackageManifest(application);
  artifactDirectory = resolve(import.meta.dirname, "../.desktop-e2e-artifacts",
    `packaged-drm-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const isolation = resolvePackagedElectronSmokeIsolation(artifactDirectory, process.platform);
  await mkdir(isolation.userDataDirectory, { recursive: true });
  let privateBundle;
  let owner;
  let child;
  let failure;
  try {
    if (process.platform === "darwin") privateBundle = await createDarwinPrivatePackagedElectronBundle(application);
    const execution = privateBundle?.applicationPath ?? application;
    const { executablePath, resourcesPath } = resolveElectronPackageLayout(execution);
    assertPackagedElectronPackageManifestUnchanged(manifest, await capturePackagedElectronPackageManifest(execution));
    const { version: appVersion } = JSON.parse(extractFile(join(resourcesPath, "app.asar"), "package.json", false).toString("utf8"));
    const addon = createRequire(import.meta.url)(join(resourcesPath, "native/rion-core.node"));
    stage = "packaged-updater-preflight";
    // Decode the package's embedded release configuration without checking for,
    // downloading or installing an update. Never substitute test signing keys.
    await addon.createChromiumUpdater({ userDataDir: isolation.userDataDirectory,
      platform: process.platform, currentVersion: appVersion, packaged: true });
    stage = "seed-isolated-core";
    const core = await addon.createAppCore({ appVersion, packaged: true,
      platform: process.platform, runtimeContractVersion: 47, userDataDir: isolation.userDataDirectory });
    const workspaceName = "DRM capability workspace";
    await runPackagedCoreOperation(core, async () => {
      const invoke = async command => JSON.parse(await core.invoke(JSON.stringify(command)));
      const { currentVersions } = await invoke({ type: "legalAcceptanceStatus" });
      await invoke({ type: "legalAcceptanceAccept", input: { fairUseVersion: currentVersions.fairUse,
        privacyVersion: currentVersions.privacy, termsVersion: currentVersions.terms } });
      const game = await invoke({ type: "gameCreate", input: { name: "DRM isolated diagnostics",
        defaultLaunchUrl: "https://example.com/" } });
      const first = await invoke({ type: "roleCreate", input: { gameId: game.id,
        name: "DRM control A", launchUrl: "https://example.com/" } });
      const second = await invoke({ type: "roleCreate", input: { gameId: game.id,
        name: "DRM control B", launchUrl: "https://example.com/" } });
      await invoke({ type: "workspaceCreate", input: { name: workspaceName, template: "main_left_stack_right",
        slots: [{ web: { lastUrl: "https://shaka-project.github.io/shaka-player/support.html" } },
          { roleId: first.id }, { roleId: second.id }] } });
    });
    const inventoryExecutablePath = process.platform === "darwin"
      ? await buildDarwinPackagedProcessInventory(join(artifactDirectory, "native-tools")) : undefined;
    stage = "launch-package";
    const spawnedAtMilliseconds = Date.now();
    child = spawn(executablePath, ["--force-renderer-accessibility"], {
      env: createPackagedElectronRuntimeEnvironment({ ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, isolation.environment),
      stdio: "ignore", ...packagedElectronSpawnOptions(process.platform) });
    const closed = once(child, "close");
    owner = createPackagedElectronProcessOwner({ child, executablePath, inventoryExecutablePath,
      platform: process.platform, privateBundle, spawnedAtMilliseconds });
    await waitForPackagedElectronProcessOwnership(owner);
    const interrupted = () => { void terminatePackagedElectronProcessTree(owner).catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    stage = "native-workspace-launch";
    await launchRoleThroughNativeInput({ platform: process.platform, processId: owner.processId, roleName: workspaceName });
    console.log(JSON.stringify({ artifactDirectory, processId: owner.processId, applicationPath: execution,
      stage: "manual-native-observation-required", workspace: workspaceName,
      instruction: "Record public support/player evidence through visible UI; quit this isolated app when finished." }, null, 2));
    const [code, signal] = await closed;
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await assertPackagedElectronProcessTreeGone(owner);
    assertPackagedElectronPackageManifestUnchanged(manifest, await capturePackagedElectronPackageManifest(execution));
    await writeFile(join(artifactDirectory, "packaged-drm-launch.json"), JSON.stringify({ schemaVersion: 1,
      platform: process.platform, architecture: process.arch, appVersion,
      isolation: isolation.isolationKind, exitCode: code, exitSignal: signal,
      archiveUnmodified: true, playback: "manual-evidence-required", netflix: "not-tested" }, null, 2));
  } catch (error) {
    failure = error;
  } finally {
    let processTreeGone = !child;
    try {
      if (owner) {
        await terminatePackagedElectronProcessTree(owner);
        await assertPackagedElectronProcessTreeGone(owner);
        processTreeGone = true;
      } else if (child && child.exitCode === null) child.kill();
    } catch (error) { failure ??= error; }
    try {
      if (processTreeGone) await privateBundle?.cleanup();
      assertPackagedElectronPackageManifestUnchanged(manifest, await capturePackagedElectronPackageManifest(application));
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

try { await main(); } catch (error) {
  // Native cleanup errors can carry process inventories. Do not export them.
  const code = String(error?.message).match(/\b(?:UPDATE_[A-Z_]+|CORE_RUNTIME_CONTRACT_MISMATCH)\b/)?.[0]
    ?? "PACKAGED_DRM_PREPARATION_FAILED";
  const result = { schemaVersion: 1, stage, errorCode: code, playback: "not-tested", netflix: "not-tested" };
  console.error(JSON.stringify(result));
  if (artifactDirectory) await writeFile(join(artifactDirectory, "packaged-drm-failure.json"), JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
