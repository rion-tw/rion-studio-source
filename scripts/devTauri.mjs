import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { basename, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { environmentWithCargoExecutable } from "./cargoExecutable.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const platform = process.platform;
const macOsDevBundleRunner = fileURLToPath(new URL("./runMacDevBundle.mjs", import.meta.url));

try {
  const environment = await environmentWithCargoExecutable();
  if (process.argv.includes("--degraded")) {
    console.warn("Starting degraded Tauri development; trusted native input remains disabled.");
    delete environment.RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR;
    delete environment.RION_STUDIO_WINDOWS_INPUT_ATTESTED;
    configureMacOsDevBundleRunner(environment);
    process.exitCode = await run(command("pnpm"), ["exec", "tauri", "dev"], environment);
  } else if (platform !== "darwin" && platform !== "win32") {
    console.warn("Native input attestation is available only on macOS and Windows; starting degraded Tauri development.");
    process.exitCode = await run(command("pnpm"), ["exec", "tauri", "dev"], environment);
  } else {
    await main(environment);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function main(baseEnvironment) {
  const osVersion = await systemVersion();
  const attestationVersion = platform === "darwin" ? osVersion.split(".")[0] : osVersion;
  const fingerprint = await attestationFingerprint(attestationVersion);
  const attestationDirectory = join(repositoryRoot, "target", "rion-attestation");
  const attestationPath = join(attestationDirectory, `${platform}-${fingerprint}.json`);
  const cachedAttestation = await readAttestation(attestationPath, {
    attestationVersion,
    fingerprint,
    platform
  });

  if (!cachedAttestation) {
    console.log(`No native input attestation matches ${platform} ${osVersion}; running the packaged behavior harness.`);
    console.log("The harness sends 1,000 synthetic key cycles only to a hidden System WebView; it does not read or control the physical keyboard.");
    const untrustedEnvironment = { ...baseEnvironment };
    delete untrustedEnvironment.RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR;
    delete untrustedEnvironment.RION_STUDIO_WINDOWS_INPUT_ATTESTED;
    const result = await run(
      command("pnpm"),
      ["run", "test:native:system-input"],
      untrustedEnvironment
    );
    if (result !== 0) {
      throw new Error("Native input attestation failed; Tauri development was not started. Use pnpm dev:degraded for UI-only work.");
    }
    await mkdir(attestationDirectory, { recursive: true });
    await writeFile(attestationPath, `${JSON.stringify({
      schemaVersion: 1,
      platform,
      osVersion,
      attestationVersion,
      fingerprint,
      attestedAt: new Date().toISOString()
    }, null, 2)}\n`);
  } else {
    console.log(`Using cached native input attestation ${basename(attestationPath)}.`);
  }

  const environment = { ...baseEnvironment };
  if (platform === "darwin") {
    environment.RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR = osVersion.split(".")[0];
  } else {
    environment.RION_STUDIO_WINDOWS_INPUT_ATTESTED = "1";
  }
  configureMacOsDevBundleRunner(environment);
  process.exitCode = await run(command("pnpm"), ["exec", "tauri", "dev"], environment);
}

function configureMacOsDevBundleRunner(environment) {
  if (platform !== "darwin") return;
  const architecture = process.arch === "arm64" ? "AARCH64" : "X86_64";
  const variable = `CARGO_TARGET_${architecture}_APPLE_DARWIN_RUNNER`;
  environment[variable] ??= macOsDevBundleRunner;
}

async function attestationFingerprint(attestationVersion) {
  const hash = createHash("sha256");
  hash.update(`schema=1\nplatform=${platform}\nos=${attestationVersion}\n`);
  const paths = [
    "Cargo.lock",
    "Cargo.toml",
    "scripts/verifySystemTrustedInput.mjs",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/src/system_runtime.rs",
    platform === "darwin" ? "src-tauri/native/macos" : "src-tauri/native/windows"
  ];
  for (const path of await expand(paths)) {
    hash.update(`${relative(repositoryRoot, path).replaceAll("\\", "/")}\n`);
    hash.update(await readFile(path));
  }
  return hash.digest("hex").slice(0, 24);
}

async function expand(paths) {
  const files = [];
  for (const repositoryPath of paths) {
    const path = join(repositoryRoot, repositoryPath);
    const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      files.push(path);
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) files.push(...await expand([relative(repositoryRoot, child)]));
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

async function systemVersion() {
  if (platform === "darwin") {
    const output = await capture("sw_vers", ["-productVersion"]);
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(output)) throw new Error(`Invalid macOS version: ${output}`);
    return output;
  }
  return release();
}

async function capture(executable, args) {
  return await new Promise((resolveCapture, reject) => {
    let output = "";
    const child = spawn(executable, args, { cwd: repositoryRoot, windowsHide: true });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolveCapture(output.trim())
      : reject(new Error(`${executable} exited with code ${code ?? "unknown"}.`)));
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readAttestation(path, expected) {
  if (!await exists(path)) return undefined;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.schemaVersion === 1 &&
      value?.platform === expected.platform &&
      value?.attestationVersion === expected.attestationVersion &&
      value?.fingerprint === expected.fingerprint &&
      typeof value?.attestedAt === "string" &&
      !Number.isNaN(Date.parse(value.attestedAt))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
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
