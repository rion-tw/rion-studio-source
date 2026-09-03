import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SIGNER_ENVIRONMENT_NAMES = new Set([
  "COMSPEC",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
  "WINDIR"
]);
const SIGNER_PRIVATE_ENVIRONMENT_NAMES = new Set([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_SIGNING_PRIVATE_KEY_PATH"
]);
const MAX_SIGNER_ENTRYPOINT_BYTES = 1024 * 1024;

export function createUpdaterSignerEnvironment(environment, signerHome) {
  const signerEnvironment = createSignerEnvironment(
    environment,
    signerHome,
    true
  );
  const privateKey = requiredEnvironmentValue(
    signerEnvironment.TAURI_SIGNING_PRIVATE_KEY,
    "TAURI_SIGNING_PRIVATE_KEY",
    false
  );
  const privateKeyPath = requiredEnvironmentValue(
    signerEnvironment.TAURI_SIGNING_PRIVATE_KEY_PATH,
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    false
  );
  if (Boolean(privateKey) === Boolean(privateKeyPath)) {
    throw new Error(
      "The updater signer requires exactly one private key source."
    );
  }
  requiredEnvironmentValue(
    signerEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    true
  );
  return signerEnvironment;
}

export function createUpdaterSignerGenerationEnvironment(
  environment,
  signerHome
) {
  return createSignerEnvironment(environment, signerHome, false);
}

function createSignerEnvironment(environment, signerHome, includePrivate) {
  const resolvedSignerHome = path.resolve(signerHome);
  const signerEnvironment = {};
  const selectedNames = new Map();
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    const normalizedName = name.toUpperCase();
    if (!SIGNER_ENVIRONMENT_NAMES.has(normalizedName)) continue;
    if (
      !includePrivate &&
      SIGNER_PRIVATE_ENVIRONMENT_NAMES.has(normalizedName)
    ) continue;
    if (selectedNames.has(normalizedName)) {
      throw new Error(
        `The updater signer environment contains duplicate ${normalizedName} entries.`
      );
    }
    selectedNames.set(normalizedName, name);
    const outputName = SIGNER_PRIVATE_ENVIRONMENT_NAMES.has(normalizedName)
      ? normalizedName
      : name;
    signerEnvironment[outputName] = value;
  }
  signerEnvironment.HOME = resolvedSignerHome;
  signerEnvironment.USERPROFILE = resolvedSignerHome;
  signerEnvironment.APPDATA = path.join(resolvedSignerHome, "appdata");
  signerEnvironment.LOCALAPPDATA = path.join(resolvedSignerHome, "local-appdata");
  signerEnvironment.TEMP = path.join(resolvedSignerHome, "tmp");
  signerEnvironment.TMP = path.join(resolvedSignerHome, "tmp");
  signerEnvironment.TMPDIR = path.join(resolvedSignerHome, "tmp");
  return signerEnvironment;
}

export async function resolveUpdaterSignerEntrypoint(workingDirectory = ".") {
  const repositoryRoot = await realpath(path.resolve(workingDirectory));
  const linkedEntrypoint = path.join(
    repositoryRoot,
    "node_modules",
    "@tauri-apps",
    "cli",
    "tauri.js"
  );
  const entrypoint = await realpath(linkedEntrypoint);
  const relative = path.relative(repositoryRoot, entrypoint);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("The pinned updater signer entrypoint escaped the repository.");
  }
  const metadata = await lstat(entrypoint);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_SIGNER_ENTRYPOINT_BYTES
  ) {
    throw new Error("The pinned updater signer entrypoint is not a bounded regular file.");
  }
  return entrypoint;
}

export async function signUpdaterArtifact(input) {
  const environment = input.environment ?? {};
  const workingDirectory = path.resolve(input.workingDirectory ?? ".");
  const entrypoint = await resolveUpdaterSignerEntrypoint(workingDirectory);
  const signerHome = await mkdtemp(
    path.join(os.tmpdir(), "rion-updater-signer-")
  );
  try {
    await Promise.all([
      mkdir(path.join(signerHome, "appdata")),
      mkdir(path.join(signerHome, "local-appdata")),
      mkdir(path.join(signerHome, "tmp"))
    ]);
    const signerEnvironment = createUpdaterSignerEnvironment(
      environment,
      signerHome
    );
    const privateKeyPath = signerEnvironment.TAURI_SIGNING_PRIVATE_KEY_PATH;
    try {
      await execFileAsync(process.execPath, [
        entrypoint,
        "signer",
        "sign",
        ...(privateKeyPath ? ["--private-key-path", privateKeyPath] : []),
        path.resolve(input.artifactPath)
      ], {
        cwd: workingDirectory,
        env: signerEnvironment,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      });
    } catch {
      throw new Error("Updater artifact signing failed.");
    }
  } finally {
    await rm(signerHome, { force: true, recursive: true });
  }
}

function requiredEnvironmentValue(value, name, required) {
  const normalized = value?.trim();
  if (required && !normalized) throw new Error(`${name} is required.`);
  return normalized || null;
}
