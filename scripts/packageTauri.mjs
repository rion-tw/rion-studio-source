import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const platform = process.platform;

if (platform !== "darwin" && platform !== "win32") {
  throw new Error("Local Tauri packages are supported only on macOS and Windows.");
}

const untrustedEnvironment = { ...process.env };
delete untrustedEnvironment.RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR;
delete untrustedEnvironment.RION_STUDIO_WINDOWS_INPUT_ATTESTED;

await run(command("pnpm"), ["run", "verify:system-only"], untrustedEnvironment);
await run(command("pnpm"), ["run", "test:native:system-input"], untrustedEnvironment);

const debugExecutable = platform === "win32"
  ? "target/debug/rion-tauri.exe"
  : "target/debug/rion-tauri";
for (const script of ["test:native:runtime-restore", "test:native:file-operations"]) {
  await run(
    command("pnpm"),
    ["run", script, "--", "--executable", debugExecutable],
    untrustedEnvironment
  );
}

const buildEnvironment = { ...process.env };
if (platform === "darwin") {
  buildEnvironment.RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR =
    (await capture("sw_vers", ["-productVersion"])).split(".")[0];
} else {
  buildEnvironment.RION_STUDIO_WINDOWS_INPUT_ATTESTED = "1";
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "rion-tauri-package-"));
const configPath = join(temporaryDirectory, "tauri.package.json");
await writeFile(configPath, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
try {
  const buildArgs = forwardedArguments();
  if (!buildArgs.some((arg) => arg === "--bundles" || arg === "-b" || arg.startsWith("--bundles="))) {
    buildArgs.push("--bundles", platform === "darwin" ? "app,dmg" : "nsis");
  }
  await run(
    command("pnpm"),
    ["exec", "tauri", "build", "--config", configPath, ...buildArgs],
    buildEnvironment
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

const packagedExecutable = platform === "win32"
  ? "target/release/rion-tauri.exe"
  : "target/release/bundle/macos/Rion Studio.app/Contents/MacOS/rion-tauri";
await run(command("pnpm"), [
  "run",
  "test:native:system-input",
  "--",
  "--executable",
  packagedExecutable,
  "--require-compiled-attestation"
], buildEnvironment);
for (const script of ["test:native:runtime-restore", "test:native:file-operations"]) {
  await run(command("pnpm"), [
    "run",
    script,
    "--",
    "--executable",
    packagedExecutable
  ], buildEnvironment);
}

function forwardedArguments() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  return args;
}

async function capture(executable, args) {
  return await new Promise((resolveCapture, reject) => {
    let output = "";
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${executable} was terminated by ${signal}.`));
      else if (code === 0) resolveCapture(output.trim());
      else reject(new Error(`${executable} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function command(name) {
  return platform === "win32" ? `${name}.cmd` : name;
}

async function run(executable, args, env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${executable} was terminated by ${signal}.`));
      else if (code === 0) resolveRun();
      else reject(new Error(`${executable} exited with code ${code ?? "unknown"}.`));
    });
  });
}
