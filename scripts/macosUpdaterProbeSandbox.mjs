import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DENIED_EXECUTABLES = Object.freeze([
  "/bin/launchctl",
  "/usr/bin/open",
  "/usr/bin/osascript",
  "/usr/bin/sudo"
]);
const WRITABLE_DEVICE_LITERALS = Object.freeze(["/dev/null"]);

export async function createMacosUpdaterProbeSandboxProfile(input) {
  const runtimeRoot = await canonicalRealDirectory(
    input.runtimeRoot,
    "runtime root"
  );
  const cargoTargetDirectory = await canonicalRealDirectory(
    input.cargoTargetDirectory,
    "Cargo target directory"
  );
  const runtimeHome = await canonicalRealDirectory(
    input.runtimeHome,
    "runtime home"
  );
  const runtimeTemp = await canonicalRealDirectory(
    input.runtimeTemp,
    "runtime temporary directory"
  );
  assertStrictDescendant(runtimeRoot, runtimeHome, "runtime home");
  assertStrictDescendant(runtimeRoot, runtimeTemp, "runtime temporary directory");

  const writableDirectories = [
    runtimeRoot,
    cargoTargetDirectory,
    runtimeHome,
    runtimeTemp
  ];
  const writableFilters = [
    ...writableDirectories.map((directory) =>
      `      (subpath ${quoteSandboxLiteral(directory)})`),
    ...WRITABLE_DEVICE_LITERALS.map((device) =>
      `      (literal ${quoteSandboxLiteral(device)})`)
  ];
  const deniedExecutableFilters = DENIED_EXECUTABLES.map((executable) =>
    `  (literal ${quoteSandboxLiteral(executable)})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*",
    "  (require-not",
    "    (require-any",
    ...writableFilters,
    "    )",
    "  )",
    ")",
    "(deny process-exec",
    ...deniedExecutableFilters,
    ")",
    ""
  ].join("\n");
}

async function canonicalRealDirectory(value, label) {
  const directory = requiredSafeAbsolutePath(value, label);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The macOS updater ${label} must be a real directory.`);
  }
  return realpath(directory);
}

function assertStrictDescendant(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`The macOS updater ${label} must stay inside the runtime root.`);
  }
}

function requiredSafeAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`The macOS updater ${label} must be one safe absolute path.`);
  }
  return path.resolve(value);
}

function quoteSandboxLiteral(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid macOS updater sandbox option near ${option ?? "<end>"}.`);
    }
    const name = option.slice(2);
    if (!new Set([
      "cargo-target-directory",
      "runtime-home",
      "runtime-root",
      "runtime-temp"
    ]).has(name)) {
      throw new Error(`Unsupported macOS updater sandbox option --${name}.`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate macOS updater sandbox option --${name}.`);
    }
    values.set(name, value);
  }
  return values;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const options = parseArguments(process.argv.slice(2));
  const profile = await createMacosUpdaterProbeSandboxProfile({
    cargoTargetDirectory: options.get("cargo-target-directory"),
    runtimeHome: options.get("runtime-home"),
    runtimeRoot: options.get("runtime-root"),
    runtimeTemp: options.get("runtime-temp")
  });
  process.stdout.write(profile);
}
