import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const DEFAULT_WINDOWS_EXTENSIONS = [".EXE", ".CMD", ".BAT", ".COM"];

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function environmentValue(environment, name, platform) {
  if (platform !== "win32") {
    return environment[name];
  }

  const matchingKey = Object.keys(environment).find((key) => key.toUpperCase() === name);
  return matchingKey ? environment[matchingKey] : undefined;
}

function executableNames(command, environment, platform) {
  if (platform !== "win32" || win32.extname(command)) {
    return [command];
  }

  const configuredExtensions = environmentValue(environment, "PATHEXT", platform)
    ?.split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const extensions = configuredExtensions?.length
    ? configuredExtensions
    : DEFAULT_WINDOWS_EXTENSIONS;
  return extensions.map((extension) => `${command}${extension}`);
}

async function findExecutable(command, options) {
  const {
    environment,
    isUsable,
    pathApi,
    pathDelimiter,
    platform
  } = options;
  const normalizedCommand = unquote(command);
  const containsPathSeparator = normalizedCommand.includes("/") || normalizedCommand.includes("\\");

  if (pathApi.isAbsolute(normalizedCommand) || containsPathSeparator) {
    for (const candidate of executableNames(normalizedCommand, environment, platform)) {
      if (await isUsable(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  const searchPath = environmentValue(environment, "PATH", platform) ?? "";
  const directories = searchPath
    .split(pathDelimiter)
    .map(unquote)
    .filter(Boolean);

  for (const directory of directories) {
    for (const name of executableNames(normalizedCommand, environment, platform)) {
      const candidate = pathApi.join(directory, name);
      if (await isUsable(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function defaultIsUsable(path, platform) {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCargoExecutable({
  environment = process.env,
  homeDirectory = homedir(),
  isUsable,
  platform = process.platform
} = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const canExecute = isUsable ?? ((path) => defaultIsUsable(path, platform));
  const findOptions = {
    environment,
    isUsable: canExecute,
    pathApi,
    pathDelimiter,
    platform
  };
  const configuredCargo = environmentValue(environment, "CARGO", platform)?.trim();

  if (configuredCargo) {
    const resolved = await findExecutable(configuredCargo, findOptions);
    if (resolved) {
      return resolved;
    }
    throw new Error(
      `CARGO is set to ${JSON.stringify(configuredCargo)}, but that executable was not found or cannot be run.`
    );
  }

  const fromPath = await findExecutable("cargo", findOptions);
  if (fromPath) {
    return fromPath;
  }

  const cargoHomes = [
    environmentValue(environment, "CARGO_HOME", platform)?.trim(),
    homeDirectory ? pathApi.join(homeDirectory, ".cargo") : undefined
  ].filter(Boolean);

  for (const cargoHome of new Set(cargoHomes)) {
    const cargoPath = pathApi.join(unquote(cargoHome), "bin", "cargo");
    const resolved = await findExecutable(cargoPath, findOptions);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "Cargo was not found. Install Rust with rustup (https://rustup.rs), restart the terminal, "
      + "or set CARGO to the absolute path of the cargo executable."
  );
}

export async function environmentWithCargoExecutable(options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const cargo = await resolveCargoExecutable({ ...options, environment, platform });
  const pathKey = platform === "win32"
    ? Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "Path"
    : "PATH";
  const currentPath = environmentValue(environment, "PATH", platform) ?? "";
  const cargoDirectory = pathApi.dirname(cargo);
  const normalize = platform === "win32"
    ? (value) => value.toLowerCase()
    : (value) => value;
  const hasCargoDirectory = currentPath
    .split(pathDelimiter)
    .map(unquote)
    .some((directory) => normalize(directory) === normalize(cargoDirectory));

  return {
    ...environment,
    CARGO: cargo,
    [pathKey]: hasCargoDirectory
      ? currentPath
      : [cargoDirectory, currentPath].filter(Boolean).join(pathDelimiter)
  };
}
