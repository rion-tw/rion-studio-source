import { execFile } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertSemanticVersionIsNewer,
  requiredSemanticVersion
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const execFileAsync = promisify(execFile);

export async function buildElectronUpdaterPreviousFixtures(environment = process.env) {
  if (
    environment.CI !== "true" ||
    environment.GITHUB_ACTIONS !== "true" ||
    (process.platform !== "darwin" && process.platform !== "win32")
  ) {
    throw new Error(
      "Previous updater fixtures are restricted to macOS or Windows GitHub CI."
    );
  }
  const fixtureRoot = requiredAbsolutePath(
    environment.RION_UPDATER_CI_FIXTURE_ROOT,
    "RION_UPDATER_CI_FIXTURE_ROOT"
  );
  const githubEnvironment = requiredAbsolutePath(environment.GITHUB_ENV, "GITHUB_ENV");
  const priorV23Version = requiredSemanticVersion(
    environment.RION_UPDATER_PRIOR_V23_VERSION,
    "RION_UPDATER_PRIOR_V23_VERSION"
  );
  const targetVersion = requiredSemanticVersion(
    environment.RION_STUDIO_ELECTRON_PACKAGE_VERSION,
    "RION_STUDIO_ELECTRON_PACKAGE_VERSION"
  );
  assertSemanticVersionIsNewer(
    targetVersion,
    priorV23Version,
    "Electron target application version"
  );
  if (process.platform === "darwin") {
    return buildMacosTauriV22Fixture({
      environment,
      fixtureRoot,
      githubEnvironment,
      priorV23Version,
      targetVersion
    });
  }
  const installers = {};
  for (const [label, version] of [["V23", priorV23Version]]) {
    const output = join(fixtureRoot, `previous-${version}`);
    await execFileAsync("pnpm.cmd", [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.config.mjs",
      "--win",
      "--x64",
      "--publish",
      "never",
      `--config.directories.output=${output}`
    ], {
      cwd: resolve("."),
      env: {
        ...environment,
        RION_STUDIO_ELECTRON_PACKAGE_VERSION: version
      },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    installers[label] = join(output, "Rion.Studio-win.exe");
  }
  await appendFile(
    githubEnvironment,
    Object.entries(installers)
      .map(([label, installer]) =>
        `RION_UPDATER_PREVIOUS_${label}_INSTALLER=${installer}\n`)
      .join("") +
      `RION_UPDATER_PREVIOUS_V23_VERSION=${priorV23Version}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return installers;
}

async function buildMacosTauriV22Fixture({
  environment,
  fixtureRoot,
  githubEnvironment,
  priorV23Version,
  targetVersion
}) {
  const tauriV22Version = requiredSemanticVersion(
    environment.RION_UPDATER_TAURI_V22_VERSION,
    "RION_UPDATER_TAURI_V22_VERSION"
  );
  assertSemanticVersionIsNewer(
    priorV23Version,
    tauriV22Version,
    "Prior Electron v23 application version"
  );
  assertSemanticVersionIsNewer(
    targetVersion,
    tauriV22Version,
    "Electron target application version"
  );
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "rion-tauri-v22-updater-fixture-")
  );
  const configPath = join(temporaryDirectory, "tauri.fixture.json");
  const cargoTargetDirectory = join(fixtureRoot, "tauri-v22-target");
  const application = join(
    cargoTargetDirectory,
    "release/bundle/macos/Rion Studio.app"
  );
  const buildEnvironment = {
    ...environment,
    CARGO_TARGET_DIR: cargoTargetDirectory
  };
  for (const name of [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_SIGNING_PRIVATE_KEY_PATH"
  ]) {
    delete buildEnvironment[name];
  }
  await writeFile(configPath, JSON.stringify({
    bundle: {
      createUpdaterArtifacts: false,
      macOS: { signingIdentity: "-" }
    },
    version: tauriV22Version
  }), { encoding: "utf8", mode: 0o600 });
  try {
    await execFileAsync("pnpm", [
      "exec",
      "tauri",
      "build",
      "--config",
      configPath,
      "--bundles",
      "app"
    ], {
      cwd: resolve("."),
      env: buildEnvironment,
      maxBuffer: 64 * 1024 * 1024
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  await verifyTauriV22Application(application, tauriV22Version);
  await appendFile(
    githubEnvironment,
    `RION_UPDATER_PROBE_PREVIOUS_APP=${application}\n` +
      `RION_UPDATER_PROBE_PREVIOUS_VERSIONS=${tauriV22Version},${priorV23Version}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return { APP: application };
}

async function verifyTauriV22Application(application, expectedVersion) {
  const applicationStat = await lstat(application);
  if (!applicationStat.isDirectory() || applicationStat.isSymbolicLink()) {
    throw new Error("The previous Tauri v22 updater fixture must be a real app directory.");
  }
  if (await realpath(application) !== resolve(application)) {
    throw new Error("The previous Tauri v22 updater fixture must use its canonical path.");
  }
  const executable = join(application, "Contents/MacOS/rion-tauri");
  const executableStat = await lstat(executable);
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
    throw new Error("The previous Tauri v22 updater fixture executable is invalid.");
  }
  try {
    await lstat(join(application, "Contents/Resources/app.asar"));
    throw new Error("The previous Tauri v22 updater fixture must not contain Electron app.asar.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const plistPath = join(application, "Contents/Info.plist");
  const [shortVersion, bundleVersion] = await Promise.all([
    readPlistValue(plistPath, "CFBundleShortVersionString"),
    readPlistValue(plistPath, "CFBundleVersion")
  ]);
  if (shortVersion !== expectedVersion || bundleVersion !== expectedVersion) {
    throw new Error("The previous Tauri v22 updater fixture version is invalid.");
  }
  await execFileAsync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    application
  ]);
}

async function readPlistValue(plistPath, key) {
  const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    plistPath
  ], { encoding: "utf8" });
  return stdout.trim();
}

function requiredAbsolutePath(value, name) {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildElectronUpdaterPreviousFixtures();
  console.log("Built ephemeral previous-version Electron updater fixtures.");
}
