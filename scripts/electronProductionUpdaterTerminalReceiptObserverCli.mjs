import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  observeElectronProductionUpdaterTerminalReceipt,
  readElectronProductionUpdaterTerminalReceiptCapture
} from "./electronProductionUpdaterTerminalReceiptObserver.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_OBSERVER_CLI_SUMMARY_KIND =
  "rion-production-updater-terminal-receipt-observer-cli-summary";

const COMMAND_OPTIONS = Object.freeze({
  observe: new Set([
    "output",
    "platform",
    "source-journal",
    "target-user-data",
    "target-version"
  ]),
  verify: new Set([
    "expected-sha256",
    "platform",
    "receipt",
    "source-journal",
    "target-version"
  ])
});

export async function runElectronProductionUpdaterTerminalReceiptObserverCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterTerminalReceiptObserverCli.mjs " +
      "<observe|verify> [strict file-based options]"
    );
  }
  const options = parseArguments(optionArguments, command);
  const dependencies = resolveDependencies(dependencyOverrides);
  const capture = command === "observe"
    ? await observeElectronProductionUpdaterTerminalReceipt({
        outputPath: requiredOption(options, "output"),
        platform: requiredOption(options, "platform"),
        signal: requiredSignal(dependencies.signal),
        sourceJournalPath: requiredOption(options, "source-journal"),
        targetUserDataDirectory: requiredOption(options, "target-user-data"),
        targetVersion: requiredOption(options, "target-version")
      }, {
        readFile: dependencies.readFile,
        watchDirectory: dependencies.watchDirectory
      })
    : await readElectronProductionUpdaterTerminalReceiptCapture({
        expectedSha256: requiredOption(options, "expected-sha256"),
        platform: requiredOption(options, "platform"),
        receiptPath: requiredOption(options, "receipt"),
        sourceJournalPath: requiredOption(options, "source-journal"),
        targetVersion: requiredOption(options, "target-version")
      }, { readFile: dependencies.readFile });
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_OBSERVER_CLI_SUMMARY_KIND,
    command,
    status: command === "observe" ? "captured" : "verified",
    authority: capture.authority,
    platform: capture.platform,
    reconciledAt: capture.reconciledAt,
    sourceInstallAttemptId: capture.sourceInstallAttemptId,
    terminalOutcome: capture.terminalOutcome,
    receipt: capture.receipt
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList, command) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error(`Every ${command} terminal-receipt option must have one value.`);
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid ${command} terminal-receipt option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!COMMAND_OPTIONS[command].has(name)) {
      throw new Error(`Unknown ${command} terminal-receipt option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate ${command} terminal-receipt option --${name}.`);
    }
    options.set(name, value);
  }
  for (const name of COMMAND_OPTIONS[command]) requiredOption(options, name);
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The terminal-receipt CLI caller must provide an AbortSignal.");
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Terminal-receipt CLI dependencies must be an object.");
  }
  const allowed = new Set(["readFile", "signal", "watchDirectory", "writeStdout"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown terminal-receipt CLI dependency ${key}.`);
    }
  }
  const dependencies = {
    readFile: value.readFile,
    signal: value.signal,
    watchDirectory: value.watchDirectory,
    writeStdout: value.writeStdout ?? ((source) => process.stdout.write(source))
  };
  for (const name of ["readFile", "watchDirectory"]) {
    if (dependencies[name] !== undefined && typeof dependencies[name] !== "function") {
      throw new Error(`The terminal-receipt CLI ${name} dependency is invalid.`);
    }
  }
  if (typeof dependencies.writeStdout !== "function") {
    throw new Error("The terminal-receipt CLI stdout writer is invalid.");
  }
  return Object.freeze(dependencies);
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = processCancellation();
  runElectronProductionUpdaterTerminalReceiptObserverCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch(() => {
    process.stderr.write("Electron updater terminal-receipt observation failed closed.\n");
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
