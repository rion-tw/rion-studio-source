#!/usr/bin/env node

import { chmod, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { macDevBundleInfoPlist } from "./macDevBundleInfoPlist.mjs";
import {
  macGameModeMetadataEnabled,
  macWebKitExperimentExecutableEnvironment
} from "./runMacWebKitExperiment.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const [requestedExecutable, ...applicationArguments] = process.argv.slice(2);

if (!requestedExecutable) {
  console.error("The macOS Tauri dev runner requires a compiled application executable.");
  process.exitCode = 1;
} else {
  await runBundled(resolve(requestedExecutable), applicationArguments);
}

async function runBundled(sourceExecutable, applicationArguments) {
  const bundleRoot = join(repositoryRoot, "target", "rion-dev", "Rion Studio Dev.app");
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

  if (typeof process.execve !== "function") {
    throw new Error("The macOS Tauri dev runner requires Node.js process.execve().");
  }
  process.chdir(dirname(sourceExecutable));
  process.execve(
    bundledExecutable,
    [bundledExecutable, ...applicationArguments],
    macWebKitExperimentExecutableEnvironment()
  );
}
