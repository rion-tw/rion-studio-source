import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultAddonPath = join(
  repositoryRoot,
  "build",
  "native",
  "darwin-arm64",
  "rion-runtime-tabs.node"
);
const hostOutputDirectory = join(
  repositoryRoot,
  "build",
  "native",
  `darwin-${process.arch}`
);
const hostAddonPath = join(hostOutputDirectory, "rion-runtime-tabs.node");
const hostTestsPath = join(hostOutputDirectory, "rion-runtime-tabs-tests");

async function assertFile(path, description) {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${description} was not found at ${path}.`);
  }
}

async function runTests() {
  await assertFile(hostTestsPath, "macOS runtime tabs native tests");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(hostTestsPath, [], {
      cwd: repositoryRoot,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        signal
          ? `macOS runtime tabs tests were terminated by ${signal}.`
          : `macOS runtime tabs tests exited with code ${code ?? "unknown"}.`
      ));
    });
  });
}

function parseArguments(args) {
  let addonPath;
  let shouldRunTests = false;
  for (const argument of args) {
    if (argument === "--tests") {
      shouldRunTests = true;
    } else if (!addonPath) {
      addonPath = resolve(repositoryRoot, argument);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  return { addonPath: addonPath ?? defaultAddonPath, shouldRunTests };
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("Skipping macOS runtime tabs verification on this platform.");
    return;
  }

  const options = parseArguments(process.argv.slice(2));
  await assertFile(options.addonPath, "macOS runtime tabs addon");
  const { stdout } = await execFileAsync("lipo", ["-archs", options.addonPath], {
    encoding: "utf8"
  });
  if (!stdout.trim().split(/\s+/u).includes("arm64")) {
    throw new Error(`Packaged macOS runtime tabs addon is not arm64: ${stdout.trim()}`);
  }

  await assertFile(hostAddonPath, "host macOS runtime tabs addon");
  const addon = require(hostAddonPath);
  if (addon.protocolVersion !== 5) {
    throw new Error(
      `Unexpected macOS runtime tabs protocol: ${String(addon.protocolVersion)}.`
    );
  }
  for (const method of [
    "createController",
    "destroyController",
    "getContentLayout",
    "prepareFullscreenTransition",
    "setFullscreenPolicy",
    "setRevealLocked",
    "updateController"
  ]) {
    if (typeof addon[method] !== "function") {
      throw new Error(`macOS runtime tabs addon is missing ${method}().`);
    }
  }

  if (options.shouldRunTests) await runTests();
  console.log(`Verified macOS runtime tabs protocol 5: ${options.addonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
