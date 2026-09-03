import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState,
  readElectronProductionPublicLatestSnapshot,
  writeElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  readElectronProductionPublicationReceipt,
  writeElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";
import {
  assembleElectronProductionPublicationStagingPlan,
  ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW
} from "./electronProductionPublicationStagingPlan.mjs";
import {
  createElectronProductionBaselineLineageFromReceipts,
  createElectronProductionPublicationIntentFromSnapshots,
  recordElectronProductionPublicationRecovery,
  recordElectronProductionPublicationResult
} from "./electronProductionPublicationTransaction.mjs";
import {
  readCanonicalJsonFile,
  requiredPositiveInteger
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  readTauriV22PublicLineageReceipt,
  TAURI_V22_COMPATIBILITY_WORKFLOW
} from "./tauriV22PublicLineage.mjs";

const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const COMMAND_OPTIONS = Object.freeze({
  "staging-plan": new Set([
    "candidate-directory",
    "candidate-receipt",
    "candidate-receipt-sha256",
    "candidate-run-attempt",
    "candidate-run-id",
    "created-at",
    "lease-generation",
    "lease-id",
    "mac-directory",
    "macos-lineage-receipt",
    "macos-lineage-receipt-sha256",
    "output",
    "owner-approval",
    "public-key",
    "source-sha",
    "source-snapshot",
    "source-snapshot-sha256",
    "tauri-lineage-run-attempt",
    "tauri-lineage-run-id",
    "transaction-id",
    "version",
    "windows-directory",
    "windows-lineage-receipt",
    "windows-lineage-receipt-sha256"
  ]),
  snapshot: new Set([
    "asset-directory",
    "candidate-receipt",
    "candidate-receipt-sha256",
    "output",
    "release-json"
  ]),
  "project-target": new Set([
    "output",
    "staged-snapshot",
    "staged-snapshot-sha256"
  ]),
  intent: new Set([
    "lease-generation",
    "lease-id",
    "macos-lineage-receipt",
    "macos-lineage-receipt-sha256",
    "output",
    "recorded-at",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256",
    "transaction-id",
    "windows-lineage-receipt",
    "windows-lineage-receipt-sha256"
  ]),
  "publication-result": new Set([
    "acknowledgement",
    "foreign-lease-generation",
    "foreign-lease-id",
    "lease-generation",
    "lease-id",
    "lease-status",
    "observation",
    "observed-snapshot",
    "observed-snapshot-sha256",
    "output",
    "previous-receipt",
    "previous-receipt-sha256",
    "recorded-at",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "recovery-result": new Set([
    "final-observation",
    "final-snapshot",
    "final-snapshot-sha256",
    "foreign-lease-generation",
    "foreign-lease-id",
    "lease-generation",
    "lease-id",
    "lease-status",
    "observation",
    "observed-snapshot",
    "observed-snapshot-sha256",
    "output",
    "previous-receipt",
    "previous-receipt-sha256",
    "recorded-at",
    "rollback-acknowledgement",
    "rollback-attempted",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ])
});

export async function runElectronProductionPublicationCli(
  argumentsList = process.argv.slice(2)
) {
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new Error(
      "Usage: electronProductionPublicationCli.mjs " +
      "<staging-plan|snapshot|project-target|intent|publication-result|" +
      "recovery-result> [options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  if (command === "staging-plan") return stagingPlanCommand(options);
  if (command === "snapshot") return snapshotCommand(options);
  if (command === "project-target") return projectTargetCommand(options);
  if (command === "intent") return intentCommand(options);
  if (command === "publication-result") return publicationResultCommand(options);
  return recoveryResultCommand(options);
}

async function stagingPlanCommand(options) {
  const sourceSha = requiredOption(options, "source-sha");
  return assembleElectronProductionPublicationStagingPlan({
    createdAt: requiredOption(options, "created-at"),
    lease: {
      id: requiredOption(options, "lease-id"),
      generation: positiveIntegerOption(options, "lease-generation")
    },
    lineage: {
      "darwin-aarch64": {
        path: requiredOption(options, "macos-lineage-receipt"),
        sha256: requiredOption(options, "macos-lineage-receipt-sha256")
      },
      "windows-x86_64": {
        path: requiredOption(options, "windows-lineage-receipt"),
        sha256: requiredOption(options, "windows-lineage-receipt-sha256")
      }
    },
    outputPath: requiredOption(options, "output"),
    ownerApproval: requiredOption(options, "owner-approval"),
    provenance: {
      candidate: {
        headSha: sourceSha,
        repository: "rion-tw/rion-studio-source",
        runAttempt: positiveIntegerOption(options, "candidate-run-attempt"),
        runId: requiredOption(options, "candidate-run-id"),
        workflow: ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW
      },
      lineage: {
        headSha: sourceSha,
        repository: "rion-tw/rion-studio-source",
        runAttempt: positiveIntegerOption(options, "tauri-lineage-run-attempt"),
        runId: requiredOption(options, "tauri-lineage-run-id"),
        workflow: TAURI_V22_COMPATIBILITY_WORKFLOW
      }
    },
    sourceSnapshot: {
      path: requiredOption(options, "source-snapshot"),
      sha256: requiredOption(options, "source-snapshot-sha256")
    },
    targetCandidate: {
      kind: "bundle",
      candidateDirectory: requiredOption(options, "candidate-directory"),
      candidateReceiptPath: requiredOption(options, "candidate-receipt"),
      candidateReceiptSha256: requiredOption(
        options,
        "candidate-receipt-sha256"
      ),
      macDirectory: requiredOption(options, "mac-directory"),
      publicKey: requiredOption(options, "public-key"),
      sourceSha,
      version: requiredOption(options, "version"),
      windowsDirectory: requiredOption(options, "windows-directory")
    },
    transaction: { id: requiredOption(options, "transaction-id") }
  });
}

async function snapshotCommand(options) {
  const releaseFile = await readCanonicalJsonFile(
    requiredOption(options, "release-json"),
    MAX_RELEASE_METADATA_BYTES,
    "public release metadata"
  );
  const candidateReceiptPath = optionalOption(options, "candidate-receipt");
  const candidateReceiptSha256 = optionalOption(
    options,
    "candidate-receipt-sha256"
  );
  if ((candidateReceiptPath === null) !== (candidateReceiptSha256 === null)) {
    throw new Error(
      "--candidate-receipt and --candidate-receipt-sha256 must be provided together."
    );
  }
  const snapshot = await createElectronProductionPublicLatestSnapshot({
    assetDirectory: requiredOption(options, "asset-directory"),
    candidateReceiptPath,
    candidateReceiptSha256,
    release: releaseFile.value
  });
  return writeElectronProductionPublicLatestSnapshot({
    outputPath: requiredOption(options, "output"),
    snapshot
  });
}

async function projectTargetCommand(options) {
  const staged = await readSnapshot(options, "staged");
  const snapshot = deriveElectronProductionExpectedLatestState(staged);
  return writeElectronProductionPublicLatestSnapshot({
    outputPath: requiredOption(options, "output"),
    snapshot
  });
}

async function intentCommand(options) {
  const [sourceSnapshot, targetSnapshot, macos, windows] = await Promise.all([
    readSnapshot(options, "source"),
    readSnapshot(options, "target"),
    readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: requiredOption(
        options,
        "macos-lineage-receipt-sha256"
      ),
      receiptPath: requiredOption(options, "macos-lineage-receipt")
    }),
    readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: requiredOption(
        options,
        "windows-lineage-receipt-sha256"
      ),
      receiptPath: requiredOption(options, "windows-lineage-receipt")
    })
  ]);
  const baselineLineage = createElectronProductionBaselineLineageFromReceipts({
    macos,
    sourceSnapshot,
    targetSnapshot,
    windows
  });
  const receipt = createElectronProductionPublicationIntentFromSnapshots({
    baselineLineage,
    lease: {
      id: requiredOption(options, "lease-id"),
      generation: positiveIntegerOption(options, "lease-generation")
    },
    recordedAt: requiredOption(options, "recorded-at"),
    sourceSnapshot,
    targetSnapshot,
    transactionId: requiredOption(options, "transaction-id")
  });
  return writeElectronProductionPublicationReceipt({
    outputPath: requiredOption(options, "output"),
    receipt
  });
}

async function publicationResultCommand(options) {
  const [previous, sourceSnapshot, targetSnapshot, observedSnapshot] =
    await Promise.all([
      readPreviousReceipt(options),
      readSnapshot(options, "source"),
      readSnapshot(options, "target"),
      readObservation(options, "observation", "observed")
    ]);
  const receipt = recordElectronProductionPublicationResult({
    acknowledgement: requiredOption(options, "acknowledgement"),
    lease: leaseObservation(options),
    observedSnapshot,
    previousReceipt: previous.receipt,
    recordedAt: requiredOption(options, "recorded-at"),
    sourceSnapshot,
    targetSnapshot
  });
  return writeElectronProductionPublicationReceipt({
    outputPath: requiredOption(options, "output"),
    receipt
  });
}

async function recoveryResultCommand(options) {
  const [previous, sourceSnapshot, targetSnapshot, observedSnapshot, finalSnapshot] =
    await Promise.all([
      readPreviousReceipt(options),
      readSnapshot(options, "source"),
      readSnapshot(options, "target"),
      readObservation(options, "observation", "observed"),
      readObservation(options, "final-observation", "final")
    ]);
  const rollbackAttempted = booleanOption(options, "rollback-attempted");
  const rollbackAcknowledgement = requiredOption(
    options,
    "rollback-acknowledgement"
  );
  const receipt = recordElectronProductionPublicationRecovery({
    finalSnapshot,
    lease: leaseObservation(options),
    observedSnapshot,
    previousReceipt: previous.receipt,
    recordedAt: requiredOption(options, "recorded-at"),
    rollbackAcknowledgement: rollbackAcknowledgement === "none"
      ? null
      : rollbackAcknowledgement,
    rollbackAttempted,
    sourceSnapshot,
    targetSnapshot
  });
  return writeElectronProductionPublicationReceipt({
    outputPath: requiredOption(options, "output"),
    receipt
  });
}

function readPreviousReceipt(options) {
  return readElectronProductionPublicationReceipt({
    expectedSha256: requiredOption(options, "previous-receipt-sha256"),
    receiptPath: requiredOption(options, "previous-receipt")
  });
}

async function readSnapshot(options, prefix) {
  return (await readElectronProductionPublicLatestSnapshot({
    expectedFileSha256: requiredOption(options, `${prefix}-snapshot-sha256`),
    snapshotPath: requiredOption(options, `${prefix}-snapshot`)
  })).snapshot;
}

async function readObservation(options, modeName, snapshotPrefix) {
  const mode = requiredOption(options, modeName);
  if (mode === "unknown") {
    rejectPresentOption(options, `${snapshotPrefix}-snapshot`);
    rejectPresentOption(options, `${snapshotPrefix}-snapshot-sha256`);
    return null;
  }
  if (mode !== "snapshot") {
    throw new Error(`--${modeName} must be snapshot or unknown.`);
  }
  return readSnapshot(options, snapshotPrefix);
}

function leaseObservation(options) {
  const status = requiredOption(options, "lease-status");
  const foreign = status === "foreign";
  const foreignLeaseId = optionalOption(options, "foreign-lease-id");
  const foreignLeaseGeneration = optionalOption(
    options,
    "foreign-lease-generation"
  );
  if (foreign !== (foreignLeaseId !== null) ||
      foreign !== (foreignLeaseGeneration !== null)) {
    throw new Error(
      "Foreign lease ID and generation are required only for --lease-status foreign."
    );
  }
  return {
    id: requiredOption(options, "lease-id"),
    generation: positiveIntegerOption(options, "lease-generation"),
    status,
    foreignLeaseId,
    foreignLeaseGeneration: foreign
      ? positiveIntegerValue(foreignLeaseGeneration, "foreign lease generation")
      : null
  };
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every publication option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid publication option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (options.has(key)) throw new Error(`Duplicate publication option --${key}.`);
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown ${command} option --${name}.`);
    }
  }
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function optionalOption(options, name) {
  const value = options.get(name);
  if (value === undefined) return null;
  if (!value.trim()) throw new Error(`--${name} cannot be empty.`);
  return value.trim();
}

function rejectPresentOption(options, name) {
  if (options.has(name)) {
    throw new Error(`--${name} is forbidden for an unknown observation.`);
  }
}

function positiveIntegerOption(options, name) {
  return positiveIntegerValue(requiredOption(options, name), name);
}

function positiveIntegerValue(value, name) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${name} must be a positive integer.`);
  }
  return requiredPositiveInteger(Number(value), name);
}

function booleanOption(options, name) {
  const value = requiredOption(options, name);
  if (value !== "true" && value !== "false") {
    throw new Error(`--${name} must be true or false.`);
  }
  return value === "true";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionPublicationCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
