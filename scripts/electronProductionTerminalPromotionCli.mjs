import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ELECTRON_PRODUCTION_TERMINAL_PROMOTION_WORKFLOW,
  finalizeElectronProductionTerminalPromotion
} from "./electronProductionTerminalPromotion.mjs";

const ALLOWED_OPTIONS = new Set([
  "final-observation",
  "final-observation-sha256",
  "finalized-at",
  "held-lease",
  "held-lease-sha256",
  "lease-release-resolved-at",
  "lease-remote-operation",
  "lease-remote-operation-sha256",
  "output",
  "owner-approval",
  "pre-release-observation",
  "pre-release-observation-sha256",
  "provisional-publication-receipt",
  "provisional-publication-receipt-sha256",
  "readiness-receipt",
  "readiness-receipt-sha256",
  "source-snapshot",
  "source-snapshot-sha256",
  "target-snapshot",
  "target-snapshot-sha256"
]);

export async function runElectronProductionTerminalPromotionCli(
  argumentsList = process.argv.slice(2),
  environment = process.env
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "finalize") {
    throw new Error(
      "Usage: electronProductionTerminalPromotionCli.mjs finalize [exact receipt options]"
    );
  }
  const options = parseArguments(optionArguments);
  const finalizedAt = requiredOption(options, "finalized-at");
  return finalizeElectronProductionTerminalPromotion({
    finalObservationPath: requiredOption(options, "final-observation"),
    finalObservationSha256: requiredOption(
      options,
      "final-observation-sha256"
    ),
    finalizedAt,
    heldLeasePath: requiredOption(options, "held-lease"),
    heldLeaseSha256: requiredOption(options, "held-lease-sha256"),
    leaseReleaseResolvedAt: requiredOption(
      options,
      "lease-release-resolved-at"
    ),
    leaseRemoteOperationPath: requiredOption(
      options,
      "lease-remote-operation"
    ),
    leaseRemoteOperationSha256: requiredOption(
      options,
      "lease-remote-operation-sha256"
    ),
    outputPath: requiredOption(options, "output"),
    ownerApproval: requiredOption(options, "owner-approval"),
    preReleaseObservationPath: requiredOption(
      options,
      "pre-release-observation"
    ),
    preReleaseObservationSha256: requiredOption(
      options,
      "pre-release-observation-sha256"
    ),
    producer: {
      repository: requiredEnvironment(environment, "GITHUB_REPOSITORY"),
      workflow: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_WORKFLOW,
      event: requiredEnvironment(environment, "GITHUB_EVENT_NAME"),
      runId: requiredEnvironment(environment, "GITHUB_RUN_ID"),
      runAttempt: requiredPositiveIntegerEnvironment(
        environment,
        "GITHUB_RUN_ATTEMPT"
      ),
      controlSha: requiredEnvironment(environment, "GITHUB_SHA"),
      producedAt: finalizedAt
    },
    provisionalPublicationReceiptPath: requiredOption(
      options,
      "provisional-publication-receipt"
    ),
    provisionalPublicationReceiptSha256: requiredOption(
      options,
      "provisional-publication-receipt-sha256"
    ),
    readinessReceiptPath: requiredOption(options, "readiness-receipt"),
    readinessReceiptSha256: requiredOption(
      options,
      "readiness-receipt-sha256"
    ),
    sourceSnapshotPath: requiredOption(options, "source-snapshot"),
    sourceSnapshotSha256: requiredOption(
      options,
      "source-snapshot-sha256"
    ),
    targetSnapshotPath: requiredOption(options, "target-snapshot"),
    targetSnapshotSha256: requiredOption(
      options,
      "target-snapshot-sha256"
    )
  });
}

function parseArguments(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined ||
        value.startsWith("--")) {
      throw new Error(
        `Invalid terminal-promotion option near ${name ?? "<end>"}.`
      );
    }
    const key = name.slice(2);
    if (!ALLOWED_OPTIONS.has(key)) {
      throw new Error(`Unknown terminal-promotion option --${key}.`);
    }
    if (options.has(key)) {
      throw new Error(`Duplicate terminal-promotion option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredPositiveIntegerEnvironment(environment, name) {
  const value = requiredEnvironment(environment, name);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range.`);
  }
  return parsed;
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionTerminalPromotionCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
