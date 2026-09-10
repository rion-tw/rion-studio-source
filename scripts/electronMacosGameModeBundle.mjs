import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  realpath
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const PRIVATE_ROOT_PREFIX = "rion-electron-game-mode-";
const CLEANUP_GUARDIAN_PATH = join(
  import.meta.dirname,
  "electronMacosGameModeBundleCleanup.mjs"
);
const ELECTRON_APPLICATION_SUFFIX = Object.freeze([
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron"
]);

export const MACOS_GAME_MODE_CATEGORY = "public.app-category.games";
export const MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID =
  "com.rionstudio.launcher.dev";
export const MACOS_GAME_MODE_DEVELOPMENT_NAME = "Rion Studio Dev";

function resolveMacosElectronApplicationPath(electronExecutable) {
  const executablePath = resolve(electronExecutable);
  if (executablePath !== electronExecutable) {
    throw new Error("The macOS Electron executable path must be absolute and normalized.");
  }
  const segments = ELECTRON_APPLICATION_SUFFIX.slice(1).toReversed();
  let cursor = executablePath;
  for (const segment of segments) {
    if (basename(cursor) !== segment) {
      throw new Error(
        "The macOS development runtime must be the pinned Electron.app executable."
      );
    }
    cursor = dirname(cursor);
  }
  if (!basename(cursor).endsWith(".app")) {
    throw new Error("The macOS Electron executable must be contained by an application bundle.");
  }
  return cursor;
}

export function resolveElectronMacosApplicationPath(electronExecutable) {
  const applicationPath = resolveMacosElectronApplicationPath(electronExecutable);
  if (basename(applicationPath) !== "Electron.app") {
    throw new Error(
      "The macOS development runtime must be the pinned Electron.app executable."
    );
  }
  return applicationPath;
}

export function assertMacosGameModeInfo(
  info,
  { development = false } = {}
) {
  const expected = {
    LSApplicationCategoryType: MACOS_GAME_MODE_CATEGORY,
    LSSupportsGameMode: true,
    ...(development
      ? {
          CFBundleDisplayName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
          CFBundleIdentifier: MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID,
          CFBundleName: MACOS_GAME_MODE_DEVELOPMENT_NAME
        }
      : {})
  };
  const failures = Object.entries(expected).flatMap(([name, value]) =>
    info?.[name] === value
      ? []
      : [`${name}: expected ${String(value)}, received ${String(info?.[name] ?? "missing")}`]
  );
  if (failures.length > 0) {
    throw new Error(
      `macOS Game Mode bundle verification failed:\n- ${failures.join("\n- ")}`
    );
  }
  return Object.freeze({ ...expected });
}

export async function readMacosApplicationInfo(applicationPath) {
  const infoPath = join(resolve(applicationPath), "Contents", "Info.plist");
  const metadata = await lstat(infoPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`The macOS application Info.plist is invalid: ${infoPath}`);
  }
  const result = await executeFile(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", infoPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`The macOS application Info.plist is malformed: ${infoPath}`, {
      cause: error
    });
  }
}

export async function inspectMacosGameModeExecutable(
  electronExecutable,
  { development = false } = {}
) {
  const applicationPath = resolveMacosElectronApplicationPath(electronExecutable);
  const info = await readMacosApplicationInfo(applicationPath);
  assertMacosGameModeInfo(info, { development });
  return Object.freeze({ applicationPath, executablePath: electronExecutable, info });
}

export async function createMacosGameModeDevelopmentBundle(electronExecutable) {
  const sourceApplicationPath = resolveElectronMacosApplicationPath(electronExecutable);
  const [sourceApplication, sourceExecutable, temporaryDirectory] = await Promise.all([
    lstat(sourceApplicationPath),
    lstat(electronExecutable),
    realpath(tmpdir())
  ]);
  if (
    !sourceApplication.isDirectory() || sourceApplication.isSymbolicLink() ||
    !sourceExecutable.isFile() || sourceExecutable.isSymbolicLink()
  ) {
    throw new Error("The pinned macOS Electron.app source is not a real application bundle.");
  }

  const privateRoot = await realpath(await mkdtemp(
    join(temporaryDirectory, PRIVATE_ROOT_PREFIX)
  ));
  await chmod(privateRoot, 0o700);
  const applicationPath = join(privateRoot, `${MACOS_GAME_MODE_DEVELOPMENT_NAME}.app`);
  const executablePath = join(applicationPath, "Contents", "MacOS", "Electron");
  let cleanupPromise;
  let cleanupGuardian;
  const cleanup = () => {
    if (!cleanupPromise) {
      try {
        removePrivateRoot(privateRoot, temporaryDirectory);
        cleanupPromise = Promise.resolve();
      } catch (error) {
        cleanupPromise = Promise.reject(error);
      }
      if (cleanupGuardian?.connected) cleanupGuardian.disconnect();
    }
    void cleanupPromise.catch(() => undefined);
    return cleanupPromise;
  };

  try {
    await executeFile("/usr/bin/ditto", [
      "--rsrc",
      "--extattr",
      "--acl",
      sourceApplicationPath,
      applicationPath
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const infoPath = join(applicationPath, "Contents", "Info.plist");
    const sourceInfo = await readMacosApplicationInfo(applicationPath);
    const replacements = [
      ["CFBundleDisplayName", "-string", MACOS_GAME_MODE_DEVELOPMENT_NAME],
      ["CFBundleIdentifier", "-string", MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID],
      ["CFBundleName", "-string", MACOS_GAME_MODE_DEVELOPMENT_NAME],
      ["LSApplicationCategoryType", "-string", MACOS_GAME_MODE_CATEGORY],
      ["LSSupportsGameMode", "-bool", "true"]
    ];
    for (const [key, type, value] of replacements) {
      const action = Object.hasOwn(sourceInfo, key) ? "-replace" : "-insert";
      await executeFile(
        "/usr/bin/plutil",
        [action, key, type, value, infoPath],
        { encoding: "utf8", maxBuffer: 1024 * 1024 }
      );
    }
    const inspection = await inspectMacosGameModeExecutable(executablePath, {
      development: true
    });
    cleanupGuardian = await startCleanupGuardian(
      privateRoot,
      temporaryDirectory
    );
    return Object.freeze({
      ...inspection,
      cleanup,
      privateRoot,
      sourceApplicationPath
    });
  } catch (error) {
    let cleanupFailure;
    try {
      await cleanup();
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        "The macOS Game Mode development bundle failed and could not be cleaned up.",
        { cause: error }
      );
    }
    throw error;
  }
}

export function removeMacosGameModePrivateRoot(
  privateRoot,
  temporaryDirectory
) {
  if (
    dirname(privateRoot) !== temporaryDirectory ||
    !basename(privateRoot).startsWith(PRIVATE_ROOT_PREFIX)
  ) {
    throw new Error("Refusing to remove an invalid macOS Game Mode bundle root.");
  }
  rmSync(privateRoot, { force: true, recursive: true });
}

function removePrivateRoot(privateRoot, temporaryDirectory) {
  removeMacosGameModePrivateRoot(privateRoot, temporaryDirectory);
}

async function startCleanupGuardian(privateRoot, temporaryDirectory) {
  const guardian = spawn(
    process.execPath,
    [CLEANUP_GUARDIAN_PATH, privateRoot, temporaryDirectory],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    }
  );
  await new Promise((resolveReady, reject) => {
    const onError = (error) => {
      guardian.off("exit", onExit);
      guardian.off("message", onMessage);
      reject(error);
    };
    const onExit = (code, signal) => {
      guardian.off("error", onError);
      guardian.off("message", onMessage);
      reject(new Error(
        `macOS Game Mode cleanup guardian exited before readiness (${String(code ?? signal)}).`
      ));
    };
    const onMessage = (message) => {
      if (message !== "ready") return;
      guardian.off("error", onError);
      guardian.off("exit", onExit);
      guardian.off("message", onMessage);
      resolveReady();
    };
    guardian.once("error", onError);
    guardian.once("exit", onExit);
    guardian.on("message", onMessage);
  });
  guardian.unref();
  guardian.channel?.unref();
  guardian.on("error", () => undefined);
  return guardian;
}
