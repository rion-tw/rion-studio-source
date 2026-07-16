import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeDirectory = join(repositoryRoot, "native", "macos", "runtime-tabs");
const nativeBuildDirectory = join(nativeDirectory, "build", "Release");
const builtAddonPath = join(nativeBuildDirectory, "rion-runtime-tabs.node");
const builtTestsPath = join(nativeBuildDirectory, "rion-runtime-tabs-tests");

async function assertFile(path, description) {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${description} was not found at ${path}.`);
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `${command} was terminated by ${signal}.`
          : `${command} exited with code ${code ?? "unknown"}.`
      ));
    });
  });
}

async function copyBuild(arch, includeTests) {
  await assertFile(builtAddonPath, "macOS runtime tabs addon");
  const outputDirectory = join(repositoryRoot, "build", "native", `darwin-${arch}`);
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(builtAddonPath, join(outputDirectory, "rion-runtime-tabs.node"));
  if (includeTests) {
    await assertFile(builtTestsPath, "macOS runtime tabs native tests");
    await copyFile(builtTestsPath, join(outputDirectory, "rion-runtime-tabs-tests"));
  }
}

async function build(arch) {
  await run("pnpm", [
    "exec",
    "node-gyp",
    "rebuild",
    "--directory",
    nativeDirectory,
    `--arch=${arch}`
  ]);
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("Skipping the macOS runtime tabs build on this platform.");
    return;
  }

  await build(process.arch);
  await run(builtTestsPath, []);
  await copyBuild(process.arch, true);

  if (process.arch !== "arm64") {
    await build("arm64");
    await copyBuild("arm64", false);
  }

  console.log(
    `Built macOS runtime tabs addons for ${
      process.arch === "arm64" ? "arm64" : `${process.arch} and arm64`
    }.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
