import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  realpath,
  readFile,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertSemanticVersionIsNewer,
  requiredSemanticVersion
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

import { extractSafeTarGzipSubtree } from "./safeTarGzipExtraction.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export async function buildElectronUpdaterPreviousFixtures(environment = process.env, {
  platform = process.platform,
  executeFile = execFileAsync
} = {}) {
  if (
    environment.CI !== "true" ||
    environment.GITHUB_ACTIONS !== "true" ||
    (platform !== "darwin" && platform !== "win32")
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
  if (platform === "darwin") {
    return prepareMacosPublishedTauriV22Fixture({
      environment,
      fixtureRoot,
      githubEnvironment,
      priorV23Version,
      targetVersion,
      executeFile
    });
  }
  const installers = {};
  for (const [label, version] of [["V23", priorV23Version]]) {
    const output = join(fixtureRoot, `previous-${version}`);
    // Execute the pinned CLI with Node: .cmd shims cannot be spawned directly
    // on Windows, and shell interpolation would corrupt fixture paths.
    await executeFile(process.execPath, [
      require.resolve("electron-builder/cli.js"),
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
        ...unsignedFixtureEnvironment(environment),
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

async function prepareMacosPublishedTauriV22Fixture({
  environment,
  fixtureRoot,
  githubEnvironment,
  priorV23Version,
  targetVersion,
  executeFile
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
  // Immutable published source: never rebuild or relabel a retired runtime.
  const source = Object.freeze({
    repository: "rion-tw/rion-studio", releaseId: 377881658, assetId: 532406564,
    sourceSha: "cde23e1201a750f1456a0d35424085e9d9f155dc",
    version: "8.3.0", bytes: 14229514,
    sha256: "003ef23b36e592515e42e522156630cce642c1b0a6d42bfe6c1026d88ee9b9b0",
    url: "https://github.com/rion-tw/rion-studio/releases/download/v8.3.0/Rion.Studio-mac.app.tar.gz"
  });
  if (tauriV22Version !== source.version) {
    throw new Error("The previous macOS source version must match the pinned published v22 asset.");
  }
  const sourceRoot = await mkdtemp(join(fixtureRoot, "published-v22-"));
  const archivePath = join(sourceRoot, "Rion.Studio-mac.app.tar.gz");
  const application = join(sourceRoot, "Rion Studio.app");
  const buildEnvironment = unsignedFixtureEnvironment(environment);
  // External asset-download boundary: fixed HTTPS source, bounded redirects,
  // 10-second connect / 30-second total acknowledgement; no retries.
  await executeFile("/usr/bin/curl", [
    "--fail", "--silent", "--show-error", "--location", "--max-redirs", "2",
    "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "10", "--max-time", "30",
    "--max-filesize", String(source.bytes), "--output", archivePath, source.url
  ], { cwd: resolve("."), env: buildEnvironment, maxBuffer: 1024 * 1024, windowsHide: true });
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.nlink !== 1 ||
      archive.size !== source.bytes ||
      createHash("sha256").update(await readFile(archivePath)).digest("hex") !== source.sha256) {
    throw new Error("The published v22 source archive differs from its pinned bytes or SHA-256.");
  }
  const extraction = await extractSafeTarGzipSubtree({
    archivePath, archiveRoot: "Rion Studio.app", destinationPath: application,
    limits: { maximumArchiveBytes: source.bytes, maximumExpandedBytes: 128 * 1024 * 1024,
      maximumFileBytes: 64 * 1024 * 1024, maximumTotalFileBytes: 128 * 1024 * 1024 }
  });
  if (extraction.archiveSha256 !== source.sha256 || extraction.archiveBytes !== source.bytes) {
    throw new Error("The published v22 archive changed during safe extraction.");
  }
  await verifyTauriV22Application(application, tauriV22Version);
  await writeFile(join(sourceRoot, "published-source.json"), `${JSON.stringify({
    ...source, application, extraction, sourceRuntime: "tauri-v22", installed: false
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
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

function unsignedFixtureEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(?:TAURI_SIGNING_|APPLE_)/iu.test(name)
  ));
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
