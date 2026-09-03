import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  finalizeElectronProductionUpdaterDataPreservation,
  prepareElectronProductionUpdaterDataPreservation
} from "./electronProductionUpdaterDataPreservationObserver.mjs";

export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_CLI_SUMMARY_KIND =
  "rion-production-updater-data-preservation-cli-summary";

const COMMAND_OPTIONS = Object.freeze({
  prepare: new Set([
    "challenge-nonce",
    "expected-challenge-sha256",
    "output",
    "user-data-directory"
  ]),
  finalize: new Set([
    "before-receipt",
    "context",
    "expected-before-receipt-sha256",
    "expected-context-sha256",
    "output",
    "user-data-directory"
  ])
});

export async function runElectronProductionUpdaterDataPreservationObserverCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionUpdaterDataPreservationObserverCli.mjs " +
      "<prepare|finalize> [exact file options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  const summary = command === "prepare"
    ? await prepare(options)
    : await finalize(options, dependencies);
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function prepare(options) {
  const prepared = await prepareElectronProductionUpdaterDataPreservation({
    beforeReceiptPath: requiredOption(options, "output"),
    challengeNoncePath: requiredOption(options, "challenge-nonce"),
    expectedChallengeSha256: requiredOption(
      options,
      "expected-challenge-sha256"
    ),
    userDataDirectory: requiredOption(options, "user-data-directory")
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_CLI_SUMMARY_KIND,
    command: "prepare",
    status: "prepared",
    artifact: prepared.beforeIdentity,
    sentinel: prepared.sentinel
  });
}

async function finalize(options, dependencies) {
  const finalized = await finalizeElectronProductionUpdaterDataPreservation({
    beforeReceiptPath: requiredOption(options, "before-receipt"),
    contextPath: requiredOption(options, "context"),
    expectedBeforeReceiptSha256: requiredOption(
      options,
      "expected-before-receipt-sha256"
    ),
    expectedContextSha256: requiredOption(options, "expected-context-sha256"),
    observationPath: requiredOption(options, "output"),
    userDataDirectory: requiredOption(options, "user-data-directory")
  }, { now: dependencies.now });
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_CLI_SUMMARY_KIND,
    command: "finalize",
    status: "observed",
    artifact: finalized.observationIdentity,
    userDataIdentitySha256:
      finalized.observation.preservation.userDataIdentitySha256
  });
}

function parseArguments(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid updater data-preservation option near ${name ?? "<end>"}.`
      );
    }
    const key = name.slice(2);
    if (options.has(key)) {
      throw new Error(`Duplicate updater data-preservation option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown ${command} updater data-preservation option --${name}.`);
    }
  }
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function resolveDependencies(overrides) {
  for (const name of Object.keys(overrides)) {
    if (name !== "now" && name !== "writeStdout") {
      throw new Error(`Unknown updater data-preservation CLI dependency ${name}.`);
    }
  }
  const now = overrides.now ?? (() => new Date());
  const writeStdout = overrides.writeStdout ?? ((source) => process.stdout.write(source));
  if (typeof now !== "function") {
    throw new Error("The updater data-preservation CLI clock is invalid.");
  }
  if (typeof writeStdout !== "function") {
    throw new Error("The updater data-preservation CLI stdout writer is invalid.");
  }
  return { now, writeStdout };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterDataPreservationObserverCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
