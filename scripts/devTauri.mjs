import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { environmentWithCargoExecutable } from "./cargoExecutable.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const platform = process.platform;
const macOsDevBundleRunner = fileURLToPath(new URL("./runMacDevBundle.mjs", import.meta.url));

try {
  const environment = await environmentWithCargoExecutable();
  configureMacOsDevBundleRunner(environment);
  process.exitCode = await run(command("pnpm"), ["exec", "tauri", "dev"], environment);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function configureMacOsDevBundleRunner(environment) {
  if (platform !== "darwin") return;
  const architecture = process.arch === "arm64" ? "AARCH64" : "X86_64";
  const variable = `CARGO_TARGET_${architecture}_APPLE_DARWIN_RUNNER`;
  environment[variable] ??= macOsDevBundleRunner;
}

function command(name) {
  return platform === "win32" ? `${name}.cmd` : name;
}

async function run(executable, args, env = process.env) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${executable} was terminated by ${signal}.`));
      else resolveRun(code ?? 1);
    });
  });
}
