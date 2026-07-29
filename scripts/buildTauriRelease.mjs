import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const publicKey = process.env.RION_STUDIO_UPDATER_PUBLIC_KEY?.trim();
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();

if (!publicKey) {
  throw new Error("RION_STUDIO_UPDATER_PUBLIC_KEY is required for updater-signed release artifacts.");
}
if (!privateKey) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY is required for updater-signed release artifacts.");
}

const platformBundle = {};
if (process.platform === "darwin") {
  platformBundle.macOS = { signingIdentity: "-" };
}
else if (process.platform !== "win32") {
  throw new Error("Tauri releases are supported only on macOS and Windows builders.");
}

const endpoint = process.env.RION_STUDIO_UPDATER_ENDPOINT?.trim()
  || "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const endpointUrl = new URL(endpoint);
if (endpointUrl.protocol !== "https:") {
  throw new Error("RION_STUDIO_UPDATER_ENDPOINT must use HTTPS.");
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  throw new Error("package.json must contain a valid semantic version for the Tauri release.");
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "rion-tauri-release-"));
const configPath = path.join(temporaryDirectory, "tauri.release.json");
writeFileSync(configPath, JSON.stringify({
  version: packageJson.version,
  bundle: {
    createUpdaterArtifacts: true,
    ...platformBundle
  },
  plugins: {
    updater: {
      endpoints: [endpoint],
      pubkey: publicKey,
      windows: {
        installMode: "passive"
      }
    }
  }
}));

try {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const forwardedArguments = process.argv.slice(2);
  if (forwardedArguments[0] === "--") forwardedArguments.shift();
  const buildEnvironment = { ...process.env };
  if (process.platform === "darwin") {
    for (const name of [
      "APPLE_API_ISSUER",
      "APPLE_API_KEY",
      "APPLE_API_KEY_PATH",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_TEAM_ID"
    ]) {
      delete buildEnvironment[name];
    }
  }
  await run(
    command,
    ["exec", "tauri", "build", "--config", configPath, ...forwardedArguments],
    buildEnvironment
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

async function run(executable, args, environment) {
  await new Promise((resolveRun, reject) => {
    const child = spawnPlatformCommand(executable, args, {
      env: environment,
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
