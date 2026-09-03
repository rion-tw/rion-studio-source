import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const TAURI_V22_WINDOWS_INSTALL_REGISTRY_KEY =
  "Software\\rionstudio\\Rion Studio";
export const TAURI_V22_WINDOWS_UNINSTALL_REGISTRY_KEY =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Rion Studio";

const SNAPSHOT_KEYS = Object.freeze([
  "displayIcon",
  "displayName",
  "displayVersion",
  "installLocation",
  "installRegistryDefault",
  "installRegistryKey",
  "mainBinaryName",
  "mainBinaryPath",
  "mainBinaryRegular",
  "mainBinaryReparsePoint",
  "publisher",
  "uninstallRegistryKey",
  "uninstallerPath",
  "uninstallerRegular",
  "uninstallerReparsePoint",
  "uninstallString"
]);

export function assertTauriV22WindowsInstallContract(snapshot, input) {
  assertExactKeys(snapshot, SNAPSHOT_KEYS, "Windows v22 install snapshot");
  const installDirectory = canonicalWindowsDirectory(
    input?.installDirectory,
    "expected install directory"
  );
  const version = requiredSemanticVersion(input?.version);
  const mainBinaryPath = win32.join(installDirectory, "rion-tauri.exe");
  const uninstallerPath = win32.join(installDirectory, "uninstall.exe");
  const expected = Object.freeze({
    displayIcon: quote(mainBinaryPath),
    displayName: "Rion Studio",
    displayVersion: version,
    installLocation: quote(installDirectory),
    installRegistryDefault: installDirectory,
    installRegistryKey: TAURI_V22_WINDOWS_INSTALL_REGISTRY_KEY,
    mainBinaryName: "rion-tauri.exe",
    mainBinaryPath,
    mainBinaryRegular: true,
    mainBinaryReparsePoint: false,
    publisher: "rionstudio",
    uninstallRegistryKey: TAURI_V22_WINDOWS_UNINSTALL_REGISTRY_KEY,
    uninstallerPath,
    uninstallerRegular: true,
    uninstallerReparsePoint: false,
    uninstallString: quote(uninstallerPath)
  });
  for (const key of SNAPSHOT_KEYS) {
    if (snapshot[key] !== expected[key]) {
      throw new Error(`The published Tauri v22 ${key} did not match its NSIS contract.`);
    }
  }
  return Object.freeze({ ...snapshot });
}

async function runCli(argumentsList) {
  const options = parseOptions(argumentsList);
  const snapshotPath = options.get("snapshot");
  if (!snapshotPath) throw new Error("--snapshot is required.");
  const metadata = await lstat(snapshotPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new Error("The Windows v22 install snapshot must be a bounded regular file.");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    throw new Error("The Windows v22 install snapshot is invalid JSON.", {
      cause: error
    });
  }
  assertTauriV22WindowsInstallContract(snapshot, {
    installDirectory: options.get("install-directory"),
    version: options.get("version")
  });
  process.stdout.write("Verified the exact published Tauri v22 Windows NSIS registry and file contract.\n");
}

function parseOptions(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid Windows v22 install option near ${option ?? "<end>"}.`);
    }
    const name = option.slice(2);
    if (!["install-directory", "snapshot", "version"].includes(name)) {
      throw new Error(`Unknown Windows v22 install option --${name}.`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate Windows v22 install option --${name}.`);
    }
    values.set(name, value);
  }
  return values;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an unexpected schema.`);
  }
}

function canonicalWindowsDirectory(value, label) {
  if (
    typeof value !== "string" ||
    !win32.isAbsolute(value) ||
    win32.normalize(value) !== value ||
    win32.parse(value).root.toLowerCase() === value.toLowerCase()
  ) {
    throw new Error(`The ${label} must be a canonical non-root Windows path.`);
  }
  return value;
}

function requiredSemanticVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    throw new Error("The expected Tauri v22 version must be strict SemVer.");
  }
  return value;
}

function quote(value) {
  return `"${value}"`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCli(process.argv.slice(2));
}
