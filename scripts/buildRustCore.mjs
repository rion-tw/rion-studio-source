import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCargoExecutable } from "./cargoExecutable.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const platformDirectory = `${process.platform}-${process.arch}`;
const outputDirectory = join(repositoryRoot, "build", "native", platformDirectory);
const libraryName = process.platform === "win32"
  ? "rion_node.dll"
  : process.platform === "darwin"
    ? "librion_node.dylib"
    : "librion_node.so";
const source = join(repositoryRoot, "target", "release", libraryName);
const destination = join(outputDirectory, "rion-core.node");

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(signal
        ? `${command} was terminated by ${signal}.`
        : `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

const cargo = await resolveCargoExecutable();
await run(cargo, ["build", "--locked", "--release", "-p", "rion-node"]);
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, destination);
console.log(`Built Rust application core: ${destination}`);
