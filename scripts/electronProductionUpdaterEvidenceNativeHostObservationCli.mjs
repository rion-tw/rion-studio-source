import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  observeElectronProductionUpdaterEvidenceNativeHost,
  readElectronProductionUpdaterEvidenceNativeHostBindings,
  readElectronProductionUpdaterEvidenceNativeHostObservation
} from "./electronProductionUpdaterEvidenceNativeHostObservation.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_CLI_SUMMARY_KIND =
  "rion-production-updater-native-host-observation-cli-summary";

const OBSERVE_COMMON_OPTIONS = Object.freeze([
  "bindings",
  "expected-executable",
  "launch-arguments",
  "launch-arguments-sha256",
  "output",
  "process-id"
]);
const OBSERVE_DARWIN_OPTIONS = Object.freeze([
  ...OBSERVE_COMMON_OPTIONS,
  "inventory-executable",
  "inventory-executable-sha256",
  "launched-after-milliseconds"
]);
const OBSERVE_WINDOWS_OPTIONS = Object.freeze([
  ...OBSERVE_COMMON_OPTIONS,
  "process-creation-milliseconds"
]);
const ALL_OPTIONS = Object.freeze({
  observe: new Set([...OBSERVE_DARWIN_OPTIONS, ...OBSERVE_WINDOWS_OPTIONS]),
  verify: new Set(["bindings", "expected-sha256", "observation"])
});

export async function runElectronProductionUpdaterEvidenceNativeHostObservationCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(ALL_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterEvidenceNativeHostObservationCli.mjs " +
      "<observe|verify> [exact options]"
    );
  }
  const options = parseArguments(optionArguments, command);
  const dependencies = resolveDependencies(dependencyOverrides);
  const bindingsFile =
    await readElectronProductionUpdaterEvidenceNativeHostBindings(
      requiredOption(options, "bindings")
    );
  let result;
  if (command === "observe") {
    const isDarwin = bindingsFile.bindings.context.platform === "darwin-aarch64";
    assertExactOptionNames(
      options,
      isDarwin ? OBSERVE_DARWIN_OPTIONS : OBSERVE_WINDOWS_OPTIONS,
      "observe"
    );
    const processBinding = isDarwin
      ? {
          inventoryExecutablePath: requiredOption(
            options,
            "inventory-executable"
          ),
          inventoryExecutableSha256: requiredOption(
            options,
            "inventory-executable-sha256"
          ),
          launchedAfterMilliseconds: requiredPositiveIntegerOption(
            options,
            "launched-after-milliseconds"
          ),
          platform: "darwin",
          processId: requiredPositiveIntegerOption(options, "process-id")
        }
      : {
          creationMilliseconds: requiredPositiveIntegerOption(
            options,
            "process-creation-milliseconds"
          ),
          platform: "win32",
          processId: requiredPositiveIntegerOption(options, "process-id")
        };
    result = await observeElectronProductionUpdaterEvidenceNativeHost({
      bindings: bindingsFile.bindings,
      expectedExecutablePath: requiredOption(options, "expected-executable"),
      launchArgumentsPath: requiredOption(options, "launch-arguments"),
      launchArgumentsSha256: requiredOption(
        options,
        "launch-arguments-sha256"
      ),
      outputPath: requiredOption(options, "output"),
      process: processBinding,
      signal: requiredSignal(dependencies.signal)
    }, moduleDependencies(dependencies));
  } else {
    assertVerifyOptionNames(options);
    result = await readElectronProductionUpdaterEvidenceNativeHostObservation({
      bindings: bindingsFile.bindings,
      ...(options.has("expected-sha256")
        ? { expectedSha256: requiredOption(options, "expected-sha256") }
        : {}),
      observationPath: requiredOption(options, "observation")
    });
  }
  const summary = Object.freeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_CLI_SUMMARY_KIND,
    command,
    status: command === "observe" ? "observed" : "verified",
    artifact: result.observationIdentity
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList, command) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error(`Every native-host ${command} option must have one value.`);
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid native-host ${command} option near ${rawName ?? "<end>"}.`
      );
    }
    const name = rawName.slice(2);
    if (!ALL_OPTIONS[command].has(name)) {
      throw new Error(`Unknown native-host ${command} option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate native-host ${command} option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertExactOptionNames(options, expected, command) {
  const observed = [...options.keys()].sort();
  const required = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(required)) {
    throw new Error(`The native-host ${command} option set is not exact.`);
  }
}

function assertVerifyOptionNames(options) {
  const expected = options.has("expected-sha256")
    ? ["bindings", "expected-sha256", "observation"]
    : ["bindings", "observation"];
  assertExactOptionNames(options, expected, "verify");
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function requiredPositiveIntegerOption(options, name) {
  const source = requiredOption(options, name);
  if (!/^[1-9]\d*$/u.test(source)) {
    throw new Error(`--${name} must be a positive safe integer.`);
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive safe integer.`);
  }
  return value;
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The native-host CLI caller must provide an AbortSignal.");
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native-host CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "hostPlatform",
    "now",
    "observeDarwinProcess",
    "queryWindowsProcess",
    "signal",
    "writeStdout"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown native-host CLI dependency ${key}.`);
    }
  }
  for (const key of [
    "now",
    "observeDarwinProcess",
    "queryWindowsProcess",
    "writeStdout"
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "function") {
      throw new Error(`The native-host CLI dependency ${key} is invalid.`);
    }
  }
  return Object.freeze({
    hostPlatform: value.hostPlatform,
    now: value.now,
    observeDarwinProcess: value.observeDarwinProcess,
    queryWindowsProcess: value.queryWindowsProcess,
    signal: value.signal,
    writeStdout: value.writeStdout ?? ((source) => process.stdout.write(source))
  });
}

function moduleDependencies(dependencies) {
  return Object.fromEntries([
    ["hostPlatform", dependencies.hostPlatform],
    ["now", dependencies.now],
    ["observeDarwinProcess", dependencies.observeDarwinProcess],
    ["queryWindowsProcess", dependencies.queryWindowsProcess]
  ].filter(([, value]) => value !== undefined));
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
  runElectronProductionUpdaterEvidenceNativeHostObservationCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
