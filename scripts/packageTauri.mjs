import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { environmentWithCargoExecutable } from "./cargoExecutable.mjs";
import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const platform = process.platform;
const baseEnvironment = await environmentWithCargoExecutable();

if (platform !== "darwin" && platform !== "win32") {
  throw new Error("Local Tauri packages are supported only on macOS and Windows.");
}

await run(command("pnpm"), ["run", "verify:system-only"], baseEnvironment);

const buildEnvironment = { ...baseEnvironment };
if (platform === "darwin") {
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

const temporaryDirectory = await mkdtemp(join(tmpdir(), "rion-tauri-package-"));
const configPath = join(temporaryDirectory, "tauri.package.json");
await writeFile(configPath, JSON.stringify({
  bundle: {
    createUpdaterArtifacts: false,
    ...(platform === "darwin" ? { macOS: { signingIdentity: "-" } } : {})
  }
}));
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

function forwardedArguments() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  return args;
}

function command(name) {
  return platform === "win32" ? `${name}.cmd` : name;
}

async function run(executable, args, env) {
  await new Promise((resolveRun, reject) => {
    const child = spawnPlatformCommand(executable, args, {
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
