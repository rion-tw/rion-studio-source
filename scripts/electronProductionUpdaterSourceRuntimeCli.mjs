import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  launchElectronProductionUpdaterSourceRuntime,
  prepareElectronProductionUpdaterSourceRuntime
} from "./electronProductionUpdaterSourceRuntime.mjs";

export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_CLI_SUMMARY_KIND =
  "rion-electron-production-updater-source-runtime-cli-summary";

const COMMAND_OPTIONS = Object.freeze({
  prepare: Object.freeze([
    "artifact",
    "bindings",
    "install-root",
    "output",
    "platform",
    "transition-kind",
    "user-data"
  ]),
  launch: Object.freeze([
    "expected-preparation-sha256",
    "output",
    "preparation"
  ])
});

export async function runElectronProductionUpdaterSourceRuntimeCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterSourceRuntimeCli.mjs " +
      "<prepare|launch> <exact options>"
    );
  }
  const options = parseArguments(optionArguments, command);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = command === "prepare"
    ? await dependencies.prepare({
        artifactPath: requiredOption(options, "artifact"),
        bindingsPath: requiredOption(options, "bindings"),
        installRoot: requiredOption(options, "install-root"),
        outputPath: requiredOption(options, "output"),
        platform: requiredOption(options, "platform"),
        signal: dependencies.signal,
        transitionKind: requiredOption(options, "transition-kind"),
        userDataDirectory: requiredOption(options, "user-data")
      }, dependencies.runtimeDependencies)
    : await dependencies.launch({
        expectedPreparationSha256: requiredOption(
          options,
          "expected-preparation-sha256"
        ),
        outputPath: requiredOption(options, "output"),
        preparationPath: requiredOption(options, "preparation"),
        signal: dependencies.signal
      }, dependencies.runtimeDependencies);
  const summary = command === "prepare"
    ? Object.freeze({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_CLI_SUMMARY_KIND,
        command,
        status: "prepared",
        artifact: result.preparationIdentity,
        executablePath: result.receipt.installation.executablePath,
        userDataDirectory: result.userDataDirectory
      })
    : Object.freeze({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_CLI_SUMMARY_KIND,
        command,
        status: "launched",
        artifact: result.launchIdentity,
        launchedAfterMilliseconds: result.launch.launchedAfterMilliseconds,
        processId: result.launch.processId
      });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList, command) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error(`Every source-runtime ${command} option must have one value.`);
  }
  const expected = new Set(COMMAND_OPTIONS[command]);
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid source-runtime option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!expected.has(name)) {
      throw new Error(`Unknown source-runtime ${command} option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate source-runtime ${command} option --${name}.`);
    }
    options.set(name, value);
  }
  const observed = [...options.keys()].sort();
  const exact = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(exact)) {
    throw new Error(`The source-runtime ${command} option set is not exact.`);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Source-runtime CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "launch", "prepare", "runtimeDependencies", "signal", "writeStdout"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown source-runtime CLI dependency ${key}.`);
  }
  const prepare = value.prepare ?? prepareElectronProductionUpdaterSourceRuntime;
  const launch = value.launch ?? launchElectronProductionUpdaterSourceRuntime;
  const writeStdout = value.writeStdout ?? ((source) => process.stdout.write(source));
  if ([prepare, launch, writeStdout].some((entry) => typeof entry !== "function")) {
    throw new Error("Source-runtime CLI dependencies are invalid.");
  }
  return Object.freeze({
    launch,
    prepare,
    runtimeDependencies: value.runtimeDependencies ?? {},
    signal: requiredSignal(value.signal),
    writeStdout
  });
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The source-runtime CLI caller must provide an AbortSignal.");
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

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = processCancellation();
  runElectronProductionUpdaterSourceRuntimeCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch(() => {
    process.stderr.write("Electron production updater source-runtime action failed closed.\n");
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
