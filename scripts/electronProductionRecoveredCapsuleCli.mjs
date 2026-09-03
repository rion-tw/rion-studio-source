import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  materializeElectronProductionRecoveredCapsule,
  verifyElectronProductionRecoveredCapsule
} from "./electronProductionRecoveredCapsule.mjs";

export const ELECTRON_PRODUCTION_RECOVERED_CAPSULE_CLI_SUMMARY_KIND =
  "rion-electron-production-recovered-capsule-cli-summary";

const COMMON_OPTIONS = Object.freeze([
  "capsule",
  "capsule-sha256",
  "store-seal",
  "store-seal-sha256",
  "transaction-id"
]);
const COMMAND_OPTIONS = Object.freeze({
  "verify-recovered": new Set(COMMON_OPTIONS),
  "materialize-recovered": new Set([...COMMON_OPTIONS, "output-root"])
});

export async function runElectronProductionRecoveredCapsuleCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new Error(
      "Usage: electronProductionRecoveredCapsuleCli.mjs " +
      "<verify-recovered|materialize-recovered> [strict local options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertOptions(command, options);
  const input = {
    capsulePath: requiredOption(options, "capsule"),
    expectedCapsuleSha256: requiredOption(options, "capsule-sha256"),
    expectedStoreSealSha256: requiredOption(options, "store-seal-sha256"),
    storeSealPath: requiredOption(options, "store-seal"),
    transactionId: requiredOption(options, "transaction-id")
  };
  const result = command === "verify-recovered"
    ? await dependencies.verifyRecovered(input)
    : await dependencies.materializeRecovered({
      ...input,
      outputRoot: requiredOption(options, "output-root")
    });
  const verification = command === "verify-recovered"
    ? result
    : result.verification;
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERED_CAPSULE_CLI_SUMMARY_KIND,
    command,
    status: command === "verify-recovered" ? "verified" : "materialized",
    verification
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every recovered-capsule option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid recovered-capsule option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate recovered-capsule option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown ${command} option --${name}.`);
    }
  }
  for (const name of allowed) requiredOption(options, name);
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required recovered-capsule option --${name}.`);
  }
  return value;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovered-capsule CLI dependencies must be an object.");
  }
  const allowed = new Set(["materializeRecovered", "verifyRecovered", "writeStdout"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown recovered-capsule CLI dependency ${name}.`);
    }
  }
  const dependencies = {
    materializeRecovered: overrides.materializeRecovered ??
      materializeElectronProductionRecoveredCapsule,
    verifyRecovered: overrides.verifyRecovered ??
      verifyElectronProductionRecoveredCapsule,
    writeStdout: overrides.writeStdout ?? ((source) => process.stdout.write(source))
  };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    throw new Error("Recovered-capsule CLI dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionRecoveredCapsuleCli().catch(() => {
    process.stderr.write("Electron production recovered-capsule verification failed closed.\n");
    process.exitCode = 1;
  });
}
