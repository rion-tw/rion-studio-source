import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
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
    process.platform !== "win32"
  ) {
    throw new Error("Previous Electron updater fixtures are restricted to Windows GitHub CI.");
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
