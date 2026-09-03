import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  readElectronProductionUpdaterEvidenceNativeHostBindings
} from "./electronProductionUpdaterEvidenceNativeHostObservation.mjs";
import {
  discoverAndObserveElectronProductionUpdaterTargetProcess
} from "./electronProductionUpdaterTargetProcessObservation.mjs";

const COMMON_OPTIONS = Object.freeze([
  "bindings",
  "expected-executable",
  "launch-arguments-output",
  "launched-after-milliseconds",
  "native-host-output"
]);
const DARWIN_OPTIONS = Object.freeze([
  ...COMMON_OPTIONS,
  "inventory-executable",
  "inventory-executable-sha256"
]);
const ALL_OPTIONS = new Set(DARWIN_OPTIONS);

export async function runElectronProductionUpdaterTargetProcessObservationCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "observe") {
    throw new Error(
      "Usage: electronProductionUpdaterTargetProcessObservationCli.mjs " +
      "observe <exact target-process options>"
    );
  }
  const options = parseArguments(optionArguments);
  const dependencies = resolveDependencies(dependencyOverrides);
  const bindingsFile = await dependencies.readBindings(
    requiredOption(options, "bindings")
  );
  const isDarwin = bindingsFile.bindings.context.platform === "darwin-aarch64";
  assertExactOptions(options, isDarwin ? DARWIN_OPTIONS : COMMON_OPTIONS);
  const result = await dependencies.observe({
    bindings: bindingsFile.bindings,
    expectedExecutablePath: requiredOption(options, "expected-executable"),
    launchArgumentsOutputPath: requiredOption(options, "launch-arguments-output"),
    launchedAfterMilliseconds: requiredPositiveInteger(
      requiredOption(options, "launched-after-milliseconds")
    ),
    nativeHostObservationOutputPath: requiredOption(options, "native-host-output"),
    platformProcess: isDarwin
      ? {
          inventoryExecutablePath: requiredOption(options, "inventory-executable"),
          inventoryExecutableSha256: requiredOption(
            options,
            "inventory-executable-sha256"
          )
        }
      : {},
    signal: dependencies.signal
  }, dependencies.observerDependencies);
  await dependencies.writeStdout(serializeCanonicalJson(result));
  return result;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every target-process observation option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid target-process option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!ALL_OPTIONS.has(name)) {
      throw new Error(`Unknown target-process option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate target-process option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertExactOptions(options, expected) {
  const observedNames = [...options.keys()].sort();
  const expectedNames = [...expected].sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The target-process observation option set is not exact.");
  }
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function requiredPositiveInteger(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("--launched-after-milliseconds must be a positive integer.");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error("--launched-after-milliseconds must be a positive integer.");
  }
  return result;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Target-process CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "observe",
    "observerDependencies",
    "readBindings",
    "signal",
    "writeStdout"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown target-process CLI dependency ${key}.`);
    }
  }
  const observe = value.observe ??
    discoverAndObserveElectronProductionUpdaterTargetProcess;
  const readBindings = value.readBindings ??
    readElectronProductionUpdaterEvidenceNativeHostBindings;
  const writeStdout = value.writeStdout ?? ((source) => process.stdout.write(source));
  if ([observe, readBindings, writeStdout].some((entry) =>
    typeof entry !== "function"
  )) throw new Error("Target-process CLI dependencies are invalid.");
  return Object.freeze({
    observe,
    observerDependencies: value.observerDependencies ?? {},
    readBindings,
    signal: requiredSignal(value.signal),
    writeStdout
  });
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The target-process CLI caller must provide an AbortSignal.");
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
  runElectronProductionUpdaterTargetProcessObservationCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch(() => {
    process.stderr.write("Electron production updater target-process observation failed closed.\n");
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
