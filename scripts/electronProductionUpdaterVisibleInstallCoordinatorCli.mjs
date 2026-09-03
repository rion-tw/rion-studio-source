import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  coordinateElectronProductionUpdaterVisibleInstall
} from "./electronProductionUpdaterVisibleInstallCoordinator.mjs";

const ALLOWED_OPTIONS = new Set([
  "install-action-output",
  "journal",
  "journal-trace-output",
  "platform",
  "process-id",
  "source-journal-output",
  "target-version",
  "transition-kind"
]);

export async function runElectronProductionUpdaterVisibleInstallCoordinatorCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "observe") {
    throw new Error(
      "Usage: electronProductionUpdaterVisibleInstallCoordinatorCli.mjs " +
      "observe <strict visible-install observation options>"
    );
  }
  const options = parseArguments(optionArguments);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = await dependencies.coordinate({
    installActionOutputPath: requiredOption(options, "install-action-output"),
    journalPath: requiredOption(options, "journal"),
    journalTraceOutputPath: requiredOption(options, "journal-trace-output"),
    platform: requiredOption(options, "platform"),
    processId: requiredProcessId(requiredOption(options, "process-id")),
    signal: dependencies.signal,
    sourceJournalOutputPath: requiredOption(options, "source-journal-output"),
    targetVersion: requiredOption(options, "target-version"),
    transitionKind: requiredOption(options, "transition-kind")
  }, dependencies.coordinatorDependencies);
  await dependencies.writeStdout(serializeCanonicalJson(result));
  return result;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every visible-install observation option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid visible-install option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!ALLOWED_OPTIONS.has(name)) {
      throw new Error(`Unknown visible-install option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate visible-install option --${name}.`);
    }
    options.set(name, value);
  }
  for (const name of ALLOWED_OPTIONS) requiredOption(options, name);
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function requiredProcessId(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("The visible-install process ID is invalid.");
  }
  const processId = Number(value);
  if (!Number.isSafeInteger(processId) || processId <= 1) {
    throw new Error("The visible-install process ID is invalid.");
  }
  return processId;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Visible-install CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "coordinate",
    "coordinatorDependencies",
    "signal",
    "writeStdout"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown visible-install CLI dependency ${key}.`);
    }
  }
  const coordinate = value.coordinate ?? coordinateElectronProductionUpdaterVisibleInstall;
  const signal = requiredSignal(value.signal);
  const writeStdout = value.writeStdout ?? ((source) => process.stdout.write(source));
  if (typeof coordinate !== "function" || typeof writeStdout !== "function") {
    throw new Error("Visible-install CLI dependencies are invalid.");
  }
  return Object.freeze({
    coordinate,
    coordinatorDependencies: value.coordinatorDependencies ?? {},
    signal,
    writeStdout
  });
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The visible-install CLI caller must provide an AbortSignal.");
  }
  return value;
}

function processCancellation() {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("process termination requested"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = processCancellation();
  runElectronProductionUpdaterVisibleInstallCoordinatorCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch(() => {
    process.stderr.write("Electron production updater visible-install observation failed closed.\n");
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
