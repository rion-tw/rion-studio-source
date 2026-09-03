import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  createUpdaterSignerGenerationEnvironment,
  resolveUpdaterSignerEntrypoint
} from "./updaterSignerEnvironment.mjs";

const execFileAsync = promisify(execFile);
const FIXTURE_VERSION = "8.5.0";

export function decodeTauriPublicKey(encodedPublicKey) {
  let keyFile;
  try {
    keyFile = Buffer.from(String(encodedPublicKey).trim(), "base64").toString("utf8");
  } catch (error) {
    throw new Error("The ephemeral Tauri public key is not base64 encoded.", {
      cause: error
    });
  }
  const lines = keyFile.trim().split(/\r?\n/u);
  if (
    lines.length !== 2 ||
    !lines[0]?.startsWith("untrusted comment:") ||
    !/^RW[A-Za-z0-9+/]{54}$/u.test(lines[1] ?? "")
  ) {
    throw new Error("The ephemeral Tauri public key file is invalid.");
  }
  return lines[1];
}

export async function prepareElectronUpdaterCiFixture(environment = process.env) {
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") {
    throw new Error("The ephemeral Electron updater fixture is restricted to GitHub CI.");
  }
  const runnerTemporary = requiredAbsolutePath(environment.RUNNER_TEMP, "RUNNER_TEMP");
  const githubEnvironment = requiredAbsolutePath(environment.GITHUB_ENV, "GITHUB_ENV");
  assertProductionSigningEnvironmentAbsent(environment);
  const fixtureRoot = await mkdtemp(join(runnerTemporary, "rion-electron-updater-"));
  const privateKeyPath = join(fixtureRoot, "ephemeral-updater.key");
  const password = randomBytes(24).toString("base64url");
  const signerHome = join(fixtureRoot, "signer-home");
  await Promise.all([
    mkdir(join(signerHome, "appdata"), { recursive: true }),
    mkdir(join(signerHome, "local-appdata"), { recursive: true }),
    mkdir(join(signerHome, "tmp"), { recursive: true })
  ]);
  const signerEntrypoint = await resolveUpdaterSignerEntrypoint(resolve("."));
  try {
    await execFileAsync(process.execPath, [
      signerEntrypoint,
      "signer",
      "generate",
      "--ci",
      "--password",
      password,
      "--write-keys",
      privateKeyPath
    ], {
      cwd: resolve("."),
      env: createUpdaterSignerGenerationEnvironment(environment, signerHome),
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
  } catch {
    throw new Error("Ephemeral updater signer generation failed.");
  }
  const publicKey = decodeTauriPublicKey(
    await readFile(`${privateKeyPath}.pub`, "utf8")
  );
  const entries = {
    RION_STUDIO_ELECTRON_PACKAGE_VERSION: FIXTURE_VERSION,
    RION_STUDIO_UPDATER_ENDPOINT:
      "https://updates.invalid/ci-fixture/latest.json",
    RION_STUDIO_UPDATER_PUBLIC_KEY: publicKey,
    RION_UPDATER_CI_FIXTURE_ROOT: fixtureRoot,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    TAURI_SIGNING_PRIVATE_KEY_PATH: privateKeyPath
  };
  await appendFile(
    githubEnvironment,
    Object.entries(entries).map(([name, value]) => `${name}=${value}\n`).join(""),
    { encoding: "utf8", mode: 0o600 }
  );
  return { fixtureRoot, publicKey, version: FIXTURE_VERSION };
}

function assertProductionSigningEnvironmentAbsent(environment) {
  const inherited = Object.keys(environment).filter((name) =>
    name.toUpperCase().startsWith("TAURI_SIGNING_")
  );
  if (inherited.length > 0) {
    throw new Error(
      "The ephemeral updater key generator must not receive signing material."
    );
  }
}

function requiredAbsolutePath(value, name) {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await prepareElectronUpdaterCiFixture();
  console.log(`Prepared ephemeral updater fixture under ${fixture.fixtureRoot}.`);
}
