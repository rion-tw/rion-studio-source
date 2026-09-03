import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  createElectronProductionUpdaterEvidenceCellBindings
} from "./electronProductionUpdaterEvidenceCellBindings.mjs";

const OPTIONS = Object.freeze([
  "attempt-plan",
  "attempt-plan-sha256",
  "descriptor",
  "output-root",
  "platform",
  "transition-kind",
  "trusted-bindings",
  "trusted-bindings-sha256"
]);

export async function runElectronProductionUpdaterEvidenceCellBindingsCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "create") {
    throw new Error(
      "Usage: electronProductionUpdaterEvidenceCellBindingsCli.mjs " +
      "create <exact cell-binding options>"
    );
  }
  const options = parseArguments(optionArguments);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = await dependencies.create({
    attemptPlanPath: requiredOption(options, "attempt-plan"),
    descriptorPath: requiredOption(options, "descriptor"),
    expectedAttemptPlanSha256: requiredOption(options, "attempt-plan-sha256"),
    expectedTrustedBindingsSha256: requiredOption(
      options,
      "trusted-bindings-sha256"
    ),
    outputRoot: requiredOption(options, "output-root"),
    platform: requiredOption(options, "platform"),
    transitionKind: requiredOption(options, "transition-kind"),
    trustedBindingsPath: requiredOption(options, "trusted-bindings")
  }, dependencies.bindingDependencies);
  const summary = Object.freeze({
    schemaVersion: 1,
    kind: "rion-electron-production-updater-evidence-cell-bindings-cli-summary",
    status: "created",
    platform: result.platform,
    transitionKind: result.transitionKind,
    outputRoot: result.outputRoot,
    bundleBindings: result.bundleIdentity,
    endpointBindings: result.endpointIdentity
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every updater cell-bindings option must have one value.");
  }
  const allowed = new Set(OPTIONS);
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid updater cell-bindings option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`Unknown updater cell-bindings option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate updater cell-bindings option --${name}.`);
    }
    options.set(name, value);
  }
  const observed = [...options.keys()].sort();
  const expected = [...OPTIONS].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("The updater cell-bindings option set is not exact.");
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
    throw new Error("Updater cell-bindings CLI dependencies must be an object.");
  }
  const allowed = new Set(["bindingDependencies", "create", "writeStdout"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown cell-bindings CLI dependency ${key}.`);
  }
  const create = value.create ?? createElectronProductionUpdaterEvidenceCellBindings;
  const writeStdout = value.writeStdout ?? ((source) => process.stdout.write(source));
  if (typeof create !== "function" || typeof writeStdout !== "function") {
    throw new Error("Updater cell-bindings CLI dependencies are invalid.");
  }
  return Object.freeze({
    bindingDependencies: value.bindingDependencies ?? {},
    create,
    writeStdout
  });
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterEvidenceCellBindingsCli().catch(() => {
    process.stderr.write("Electron production updater cell-bindings failed closed.\n");
    process.exitCode = 1;
  });
}
