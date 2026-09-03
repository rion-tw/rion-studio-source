import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  createElectronProductionUpdaterEvidenceAttemptOutcome,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW,
  electronProductionUpdaterEvidenceAttemptOutcomeArtifactName,
  readElectronProductionUpdaterEvidenceAttemptOutcome
} from "./electronProductionUpdaterEvidenceAttemptOutcome.mjs";
import {
  publicIdentity,
  readStableFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_CLI_SUMMARY_KIND =
  "rion-production-updater-evidence-attempt-outcome-cli-summary";

const MAX_OBSERVATION_ARTIFACT_BYTES = 64 * 1024 * 1024;

const COMMAND_OPTIONS = Object.freeze({
  create: new Set([
    "attempt-plan-sha256",
    "control-sha",
    "evidence-attempt-id",
    "observation-artifact",
    "observed-at",
    "outcome",
    "output",
    "platform",
    "reason-code",
    "run-attempt",
    "run-id",
    "source-install-attempt-id",
    "source-updater-invoked",
    "transition-kind"
  ]),
  verify: new Set(["expected-sha256", "receipt"])
});

export async function runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
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
      "Usage: electronProductionUpdaterEvidenceAttemptOutcomeCli.mjs " +
      "<create|verify> [exact options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  const file = command === "create"
    ? await createOutcome(options)
    : await readElectronProductionUpdaterEvidenceAttemptOutcome({
        expectedSha256: requiredOption(options, "expected-sha256"),
        receiptPath: requiredOption(options, "receipt")
      });
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_CLI_SUMMARY_KIND,
    command,
    status: command === "create" ? "created" : "verified",
    attemptPlanSha256: file.value.attemptPlanSha256,
    cell: file.value.cell,
    outcome: file.value.outcome,
    producerArtifactName: file.value.producer.artifactName,
    receipt: file.valueIdentity
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function createOutcome(options) {
  const cell = {
    transitionKind: requiredOption(options, "transition-kind"),
    platform: requiredOption(options, "platform"),
    evidenceAttemptId: requiredOption(options, "evidence-attempt-id")
  };
  const runId = requiredOption(options, "run-id");
  const runAttempt = requiredPositiveInteger(options, "run-attempt");
  return createElectronProductionUpdaterEvidenceAttemptOutcome({
    attemptPlanSha256: requiredOption(options, "attempt-plan-sha256"),
    cell,
    deadlineUsedAsSuccess: false,
    observationArtifact: await optionalObservationArtifact(options),
    observedAt: requiredOption(options, "observed-at"),
    outcome: requiredOption(options, "outcome"),
    outputPath: requiredOption(options, "output"),
    producer: {
      repository:
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY,
      workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW,
      runId,
      runAttempt,
      controlSha: requiredOption(options, "control-sha"),
      artifactName: electronProductionUpdaterEvidenceAttemptOutcomeArtifactName({
        cell,
        runId,
        runAttempt
      })
    },
    reasonCode: requiredOption(options, "reason-code"),
    sourceInstallAttemptId: optionalOption(options, "source-install-attempt-id"),
    sourceUpdaterInvoked: requiredBoolean(options, "source-updater-invoked")
  });
}

async function optionalObservationArtifact(options) {
  if (!options.has("observation-artifact")) return null;
  const artifactPath = requiredOption(options, "observation-artifact");
  const file = await readStableFile(
    artifactPath,
    MAX_OBSERVATION_ARTIFACT_BYTES,
    "updater evidence attempt-outcome observation artifact"
  );
  return publicIdentity(artifactPath, file);
}

function parseArguments(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid updater evidence attempt-outcome option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (options.has(key)) {
      throw new Error(`Duplicate updater evidence attempt-outcome option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown ${command} updater evidence attempt-outcome option --${name}.`);
    }
  }
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function optionalOption(options, name) {
  return options.has(name) ? requiredOption(options, name) : null;
}

function requiredPositiveInteger(options, name) {
  const value = requiredOption(options, name);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${name} exceeds the safe integer range.`);
  }
  return parsed;
}

function requiredBoolean(options, name) {
  const value = requiredOption(options, name);
  if (value !== "true" && value !== "false") {
    throw new Error(`--${name} must be true or false.`);
  }
  return value === "true";
}

function resolveDependencies(overrides) {
  for (const name of Object.keys(overrides)) {
    if (name !== "writeStdout") {
      throw new Error(`Unknown updater evidence attempt-outcome CLI dependency ${name}.`);
    }
  }
  const writeStdout = overrides.writeStdout ?? ((source) => process.stdout.write(source));
  if (typeof writeStdout !== "function") {
    throw new Error("The updater evidence attempt-outcome stdout writer is invalid.");
  }
  return { writeStdout };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterEvidenceAttemptOutcomeCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
