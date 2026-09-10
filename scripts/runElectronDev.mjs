import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createMacosGameModeDevelopmentBundle } from
  "./electronMacosGameModeBundle.mjs";
import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const requireFromRepository = createRequire(resolve(repositoryRoot, "package.json"));

export function electronDevLaunchSpec({
  arguments: forwardedArguments = [],
  electronExecutable,
  environment = process.env,
  platform = process.platform
}) {
  if (platform === "darwin" && !electronExecutable) {
    throw new Error("macOS Electron development requires a prepared Game Mode bundle.");
  }
  return Object.freeze({
    args: [
      "exec",
      "electron-vite",
      "dev",
      "--config",
      "electron.vite.config.ts",
      ...forwardedArguments
    ],
    command: platform === "win32" ? "pnpm.cmd" : "pnpm",
    environment: {
      ...environment,
      ...(platform === "darwin"
        ? { ELECTRON_EXEC_PATH: electronExecutable }
        : {})
    }
  });
}

export async function runElectronDev(
  forwardedArguments = [],
  {
    environment = process.env,
    platform = process.platform,
    prepareBundle = createMacosGameModeDevelopmentBundle,
    resolveElectronExecutable = () => requireFromRepository("electron"),
    signalEmitter = process,
    spawnCommand = spawnPlatformCommand
  } = {}
) {
  let developmentBundle;
  let cleanupPromise;
  let child;
  const forwardedSignals = new Set();
  const cleanupDevelopmentBundle = () => {
    if (!developmentBundle) return Promise.resolve();
    cleanupPromise ??= developmentBundle.cleanup();
    return cleanupPromise;
  };
  const forwardSignal = (signal) => {
    if (forwardedSignals.has(signal)) return;
    forwardedSignals.add(signal);
    void cleanupDevelopmentBundle().catch(() => undefined);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      // Cleanup still runs after the child reports its authoritative exit.
    }
  };
  const signalHandlers = new Map([
    ["SIGINT", () => forwardSignal("SIGINT")],
    ["SIGTERM", () => forwardSignal("SIGTERM")]
  ]);

  try {
    if (platform === "darwin") {
      developmentBundle = await prepareBundle(resolveElectronExecutable());
    }
    const launch = electronDevLaunchSpec({
      arguments: forwardedArguments,
      electronExecutable: developmentBundle?.executablePath,
      environment,
      platform
    });
    child = spawnCommand(launch.command, launch.args, {
      cwd: repositoryRoot,
      env: launch.environment,
      stdio: "inherit"
    });
    for (const [signal, handler] of signalHandlers) {
      signalEmitter.on(signal, handler);
    }
    const result = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    if (result.signal === "SIGINT") return 130;
    if (result.signal === "SIGTERM") return 143;
    return result.code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      signalEmitter.off(signal, handler);
    }
    await cleanupDevelopmentBundle();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runElectronDev(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
