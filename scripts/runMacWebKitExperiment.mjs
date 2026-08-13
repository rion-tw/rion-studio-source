import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
export const MAC_WEBKIT_EXPERIMENT_MODES = Object.freeze([
  "system-gpu-process",
  "system-direct",
  "stp-gpu-process",
  "stp-direct",
  "stp-gpu-process-dom-rendering",
  "stp-gpu-process-all-rendering"
]);
const MODES = new Set([
  ...MAC_WEBKIT_EXPERIMENT_MODES,
  "matrix"
]);

export function parseMacWebKitExperimentArguments(
  args,
  { cwd = repositoryRoot, platform = process.platform } = {}
) {
  if (platform !== "darwin") {
    throw new Error("The WKWebView experiment launcher requires macOS.");
  }
  const options = new Map();
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Invalid WKWebView experiment argument: ${argument}`);
    if (options.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    options.set(match[1], match[2]);
  }
  const mode = options.get("mode");
  if (!mode || !MODES.has(mode)) {
    throw new Error(`--mode must be one of: ${[...MODES].join(", ")}`);
  }
  for (const key of options.keys()) {
    if (!["data-dir", "mode", "sample-ms", "stp-app"].includes(key)) {
      throw new Error(`Unknown WKWebView experiment option: --${key}`);
    }
  }
  const sampleMs = Number(options.get("sample-ms") ?? 10_000);
  if (!Number.isSafeInteger(sampleMs) || sampleMs < 1_500 || sampleMs > 600_000) {
    throw new Error("--sample-ms must be an integer between 1500 and 600000.");
  }
  const dataDir = resolve(options.get("data-dir") ?? join(cwd, "target", "rion-webkit-experiment-data"));
  const modes = mode === "matrix"
    ? [...MAC_WEBKIT_EXPERIMENT_MODES]
    : [mode];
  const usesStp = modes.some((candidate) => candidate.startsWith("stp-"));
  const stpApp = options.get("stp-app");
  if (usesStp && !stpApp) {
    throw new Error("STP experiment modes require --stp-app=/absolute/path/to/Safari Technology Preview.app.");
  }
  if (stpApp && !isAbsolute(stpApp)) {
    throw new Error("--stp-app must be an absolute path.");
  }
  return {
    dataDir,
    mode,
    modes,
    sampleMs,
    stpApp: stpApp ? resolve(stpApp) : undefined,
    stpFrameworkPath: stpApp
      ? join(resolve(stpApp), "Contents", "Frameworks")
      : undefined,
    usesStp
  };
}

export function macWebKitExperimentEnvironment(options, inherited = process.env) {
  const environment = {
    ...inherited,
    RION_STUDIO_USER_DATA_DIR: options.dataDir,
    RION_WEBKIT_EXPERIMENT_ISOLATED: "1",
    RION_WEBKIT_EXPERIMENT_MODE: options.mode,
    RION_WEBKIT_EXPERIMENT_SAMPLE_MS: String(options.sampleMs)
  };
  if (options.mode.startsWith("stp-") && options.stpFrameworkPath) {
    environment.DYLD_FRAMEWORK_PATH = options.stpFrameworkPath;
    environment.RION_WEBKIT_EXPERIMENT_STP_APP = options.stpApp;
  } else {
    delete environment.DYLD_FRAMEWORK_PATH;
    delete environment.RION_WEBKIT_EXPERIMENT_STP_APP;
  }
  return environment;
}

// pnpm intentionally strips DYLD_* variables before running lifecycle commands.
// Restore the validated STP framework override only at the final dev executable
// boundary so the experiment label cannot disagree with the loaded WebKit.
export function macWebKitExperimentExecutableEnvironment(inherited = process.env) {
  const environment = { ...inherited };
  if (environment.RION_WEBKIT_EXPERIMENT_ISOLATED !== "1") return environment;

  delete environment.DYLD_FRAMEWORK_PATH;
  const mode = environment.RION_WEBKIT_EXPERIMENT_MODE;
  if (!mode?.startsWith("stp-")) return environment;

  const stpApp = environment.RION_WEBKIT_EXPERIMENT_STP_APP;
  if (!stpApp || !isAbsolute(stpApp)) {
    throw new Error("An isolated STP experiment requires an absolute RION_WEBKIT_EXPERIMENT_STP_APP path.");
  }
  environment.DYLD_FRAMEWORK_PATH = join(resolve(stpApp), "Contents", "Frameworks");
  return environment;
}

async function runExperimentCell(options, mode, index, count) {
  const cell = { ...options, mode };
  const environment = macWebKitExperimentEnvironment(cell);
  process.stdout.write([
    `Rion WKWebView experiment ${index}/${count}: ${mode}`,
    `Isolated data: ${cell.dataDir}`,
    `Sample duration: ${cell.sampleMs} ms`,
    `WebKit: ${environment.DYLD_FRAMEWORK_PATH ?? "system framework"}`,
    "Diagnostic overlay: original WebGL canvas presentation (baseline).",
    "Warm up the same Flyff scene for 30 seconds, run the in-app performance diagnostic, then export its result.",
    count > 1 ? "Close Rion Studio to continue to the next A/B cell." : ""
  ].filter(Boolean).join("\n") + "\n");
  return new Promise((resolveExit, reject) => {
    const child = spawnPlatformCommand("pnpm", ["run", "dev"], {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Rion Dev was terminated by ${signal}.`));
      else resolveExit(code ?? 1);
    });
  });
}

async function run() {
  const options = parseMacWebKitExperimentArguments(process.argv.slice(2));
  if (options.stpFrameworkPath) {
    await access(join(options.stpFrameworkPath, "WebKit.framework"), constants.R_OK);
  }
  for (const [index, mode] of options.modes.entries()) {
    const exitCode = await runExperimentCell(options, mode, index + 1, options.modes.length);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return;
    }
  }
  process.exitCode = 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
