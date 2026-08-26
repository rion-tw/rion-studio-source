#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { macDevBundleInfoPlist } from "./macDevBundleInfoPlist.mjs";
import {
  macGameModeMetadataEnabled,
  macWebKitExperimentExecutableEnvironment
} from "./runMacWebKitExperiment.mjs";
import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const [requestedExecutable, ...applicationArguments] = process.argv.slice(2);

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  if (!requestedExecutable) {
    console.error("The macOS Tauri dev runner requires a compiled application executable.");
    process.exitCode = 1;
  } else {
    process.exitCode = await runBundled(
      resolve(requestedExecutable),
      applicationArguments
    );
  }
}

export function macDevBundleLaunchArguments(bundleRoot, applicationArguments = []) {
  const arguments_ = [
    "-n",
    "-W",
    "-F",
    bundleRoot
  ];
  if (applicationArguments.length > 0) {
    arguments_.push("--args", ...applicationArguments);
  }
  return arguments_;
}

export function macDevBundleRoot(homeDirectory = homedir()) {
  return join(
    homeDirectory,
    "Applications",
    "Rion Studio Development",
    "Rion Studio Dev.app"
  );
}

async function runBundled(sourceExecutable, applicationArguments) {
  // gamepolicyd discovers metadata-labelled development games only from an
  // Applications location. Keep this runner-owned bundle separate from any
  // production installation while still making Game Mode eligible in dev.
  const bundleRoot = macDevBundleRoot();
  const contents = join(bundleRoot, "Contents");
  const executableDirectory = join(contents, "MacOS");
  const resourcesDirectory = join(contents, "Resources");
  const executableName = basename(sourceExecutable);
  const bundledExecutable = join(executableDirectory, executableName);
  const temporaryExecutable = join(executableDirectory, `.${executableName}.tmp`);

  await Promise.all([
    mkdir(executableDirectory, { recursive: true }),
    mkdir(resourcesDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(contents, "Info.plist"), macDevBundleInfoPlist(executableName, {
      gameModeEnabled: macGameModeMetadataEnabled()
    })),
    copyFile(join(repositoryRoot, "build", "icon.icns"), join(resourcesDirectory, "icon.icns"))
  ]);
  await copyFile(sourceExecutable, temporaryExecutable);
  await chmod(temporaryExecutable, 0o755);
  await rename(temporaryExecutable, bundledExecutable);
  await execute("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    bundleRoot
  ]);

  return await launchWithLaunchServices(
    bundleRoot,
    applicationArguments,
    dirname(sourceExecutable),
    macWebKitExperimentExecutableEnvironment()
  );
}

async function launchWithLaunchServices(bundleRoot, applicationArguments, cwd, env) {
  return await new Promise((resolveExit, reject) => {
    const child = spawnPlatformCommand(
      "/usr/bin/open",
      macDevBundleLaunchArguments(bundleRoot, applicationArguments),
      { cwd, env, stdio: "inherit" }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Rion Studio Dev was terminated by ${signal}.`));
      else resolveExit(code ?? 1);
    });
  });
}
