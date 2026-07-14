import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const protocolVersionOutput = "rion-window-frame-helper protocol 1";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeOutputDirectory = join(repositoryRoot, "build", "native", "win32-x64");
const defaultHelperPath = join(nativeOutputDirectory, "rion-window-frame-helper.exe");
const nativeTestsPath = join(nativeOutputDirectory, "rion-window-frame-helper-tests.exe");

async function assertFile(path, description) {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${description} was not found at ${path}.`);
  }
}

async function runTests() {
  await assertFile(nativeTestsPath, "Windows window frame helper tests");

  await new Promise((resolvePromise, reject) => {
    const child = spawn(nativeTestsPath, [], {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(
        new Error(
          signal
            ? `Windows window frame helper tests were terminated by ${signal}.`
            : `Windows window frame helper tests exited with code ${code ?? "unknown"}.`
        )
      );
    });
  });
}

function parseArguments(args) {
  let helperPath;
  let shouldRunTests = false;

  for (const argument of args) {
    if (argument === "--tests") {
      shouldRunTests = true;
    } else if (!helperPath) {
      helperPath = resolve(repositoryRoot, argument);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (shouldRunTests && helperPath) {
    throw new Error("--tests can only be used with the helper in build/native/win32-x64.");
  }

  return {
    helperPath: helperPath ?? defaultHelperPath,
    shouldRunTests
  };
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Skipping Windows window frame helper verification on this platform.");
    return;
  }

  const options = parseArguments(process.argv.slice(2));
  await assertFile(options.helperPath, "Windows window frame helper");

  const { stdout, stderr } = await execFileAsync(options.helperPath, ["--version"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
  const actualVersionOutput = stdout.trim();

  if (actualVersionOutput !== protocolVersionOutput) {
    throw new Error(
      `Unexpected Windows window frame helper version output: ${JSON.stringify(actualVersionOutput)}.`
    );
  }
  if (stderr.trim()) {
    throw new Error(
      `Windows window frame helper wrote unexpected version output to stderr: ${JSON.stringify(stderr.trim())}.`
    );
  }

  console.log(`Verified Windows window frame helper protocol 1: ${options.helperPath}`);

  if (options.shouldRunTests) {
    await runTests();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
