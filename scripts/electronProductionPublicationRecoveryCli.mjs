import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  readElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicLatestLeaseReleaseOperationBindings,
  readElectronProductionPublicLatestLeaseReleaseOperation
} from "./electronProductionPublicLatestLeaseReleaseOperation.mjs";
import {
  readElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
  assertElectronProductionPublicLatestRecoveryObservationBindings,
  assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings,
  readElectronProductionPublicLatestRecoveryObservation,
  readElectronProductionPublicLatestRecoveryRollback
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  assertElectronProductionPublicationRecoveryOutcomeBindings,
  assertElectronProductionPublicationRecoveryStoreSealBindings,
  createElectronProductionPublicationRecoveryOutcome,
  createElectronProductionPublicationRecoveryStoreSeal,
  readElectronProductionPublicationRecoveryOutcome,
  readElectronProductionPublicationRecoveryOutcomeAttempt,
  readElectronProductionPublicationRecoveryStoreSeal,
  writeElectronProductionPublicationRecoveryOutcome,
  writeElectronProductionPublicationRecoveryOutcomeAttempt,
  writeElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";
import {
  electronProductionPublicationRecoveryPublicMutationOperationOutcomeEvidence,
  readElectronProductionPublicationRecoveryPublicMutationOperation
} from "./electronProductionPublicationRecoveryPublicMutationOperation.mjs";
import {
  readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  readElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "./electronProductionRecoveryCapsule.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  readElectronProductionRecoveryStoreRemoteOperationReceipt
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredDigest
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_CLI_SUMMARY_KIND =
  "rion-electron-production-publication-recovery-cli-summary";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_INPUT_KIND =
  "rion-electron-production-publication-recovery-store-seal-materialization";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND =
  "rion-electron-production-publication-recovery-outcome-materialization";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_STORED_CAPSULE_BYTES = Math.min(
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumPackageBytes,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
);
const COMMAND_OPTIONS = Object.freeze({
  "materialize-store-seal": new Set([
    "capsule",
    "capsule-manifest",
    "capsule-manifest-sha256",
    "capsule-sha256",
    "held-lease",
    "held-lease-sha256",
    "input",
    "input-sha256",
    "output",
    "publication-intent",
    "publication-intent-sha256",
    "remote-operation",
    "remote-operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "verify-store-seal": new Set([
    "capsule",
    "capsule-manifest",
    "capsule-manifest-sha256",
    "capsule-sha256",
    "held-lease",
    "held-lease-sha256",
    "publication-intent",
    "publication-intent-sha256",
    "remote-operation",
    "remote-operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "materialize-outcome": new Set([
    "attempt-output",
    "held-lease",
    "held-lease-sha256",
    "input",
    "input-sha256",
    "lease-release-operation",
    "lease-release-operation-sha256",
    "operation",
    "operation-sha256",
    "previous-outcome",
    "previous-outcome-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256",
    "terminal-output"
  ]),
  "verify-outcome": new Set([
    "held-lease",
    "held-lease-sha256",
    "lease-release-operation",
    "lease-release-operation-sha256",
    "operation",
    "operation-sha256",
    "outcome",
    "outcome-sha256",
    "previous-outcome",
    "previous-outcome-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "materialize-marker-outcome": new Set([
    "attempt-output",
    "held-lease",
    "held-lease-sha256",
    "input",
    "input-sha256",
    "previous-outcome",
    "previous-outcome-sha256",
    "public-mutation-authorization",
    "public-mutation-authorization-sha256",
    "public-mutation-operation",
    "public-mutation-operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256",
    "terminal-output"
  ]),
  "verify-marker-outcome": new Set([
    "held-lease",
    "held-lease-sha256",
    "outcome",
    "outcome-sha256",
    "previous-outcome",
    "previous-outcome-sha256",
    "public-mutation-authorization",
    "public-mutation-authorization-sha256",
    "public-mutation-operation",
    "public-mutation-operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ])
});
const REQUIRED_COMMAND_OPTIONS = Object.freeze({
  "materialize-store-seal": COMMAND_OPTIONS["materialize-store-seal"],
  "verify-store-seal": COMMAND_OPTIONS["verify-store-seal"],
  "materialize-outcome": new Set([
    "attempt-output",
    "held-lease",
    "held-lease-sha256",
    "input",
    "input-sha256",
    "operation",
    "operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256",
    "terminal-output"
  ]),
  "verify-outcome": new Set([
    "held-lease",
    "held-lease-sha256",
    "operation",
    "operation-sha256",
    "outcome",
    "outcome-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "materialize-marker-outcome": new Set([
    "attempt-output",
    "held-lease",
    "held-lease-sha256",
    "input",
    "input-sha256",
    "public-mutation-authorization",
    "public-mutation-authorization-sha256",
    "public-mutation-operation",
    "public-mutation-operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256",
    "terminal-output"
  ]),
  "verify-marker-outcome": new Set([
    "held-lease",
    "held-lease-sha256",
    "outcome",
    "outcome-sha256",
    "public-mutation-authorization",
    "public-mutation-authorization-sha256",
    "public-mutation-operation",
    "public-mutation-operation-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "store-seal",
    "store-seal-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ])
});

export async function runElectronProductionPublicationRecoveryCli(
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
      "Usage: electronProductionPublicationRecoveryCli.mjs " +
      "<materialize-store-seal|verify-store-seal|materialize-outcome|" +
      "verify-outcome|materialize-marker-outcome|verify-marker-outcome> " +
      "[strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  assertRequiredCommandOptions(command, options);
  let summary;
  if (command === "materialize-store-seal") {
    summary = await materializeStoreSeal(options);
  } else if (command === "verify-store-seal") {
    summary = await verifyStoreSeal(options);
  } else if (command === "materialize-outcome") {
    summary = await materializeOutcome(options);
  } else if (command === "materialize-marker-outcome") {
    summary = await materializeMarkerOutcome(options);
  } else if (command === "verify-marker-outcome") {
    summary = await verifyMarkerOutcome(options);
  } else {
    summary = await verifyOutcome(options);
  }
  dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function materializeStoreSeal(options) {
  const [request, foundation, capsule, capsuleManifest, remoteOperation] =
    await Promise.all([
    readMaterializationInput(
      options,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_INPUT_KIND,
      ["committedAt", "kind", "schemaVersion", "sealedAt", "writer"],
      "publication recovery store-seal materialization input"
    ),
    readStoreSealFoundation(options),
    readCanonicalIdentity(
      options,
      "capsule",
      "capsule-sha256",
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
      MAX_STORED_CAPSULE_BYTES,
      "publication recovery capsule"
    ),
    readCanonicalIdentity(
      options,
      "capsule-manifest",
      "capsule-manifest-sha256",
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumManifestBytes,
      "publication recovery capsule manifest"
    ),
    readRemoteOperation(options)
  ]);
  assertPackedManifestBinding(capsule, capsuleManifest);
  const durableStore = durableStoreFromAppliedOperation(
    remoteOperation,
    capsule,
    request.committedAt
  );
  const seal = createElectronProductionPublicationRecoveryStoreSeal({
    capsuleBytes: capsule.bytes,
    capsuleManifestBytes: capsuleManifest.bytes,
    capsuleManifestSha256: capsuleManifest.sha256,
    capsuleSha256: capsule.sha256,
    durableStore,
    heldLease: foundation.heldLease,
    publicationIntent: foundation.publicationIntent,
    sealedAt: request.sealedAt,
    sourceSnapshot: foundation.sourceSnapshot,
    targetSnapshot: foundation.targetSnapshot,
    writer: request.writer
  });
  assertElectronProductionPublicationRecoveryStoreSealBindings({
    ...foundation,
    seal
  });
  const written = await writeElectronProductionPublicationRecoveryStoreSeal({
    outputPath: requiredOption(options, "output"),
    receipt: seal
  });
  return createSummary(
    "materialize-store-seal",
    "materialized",
    written.receiptIdentity,
    null
  );
}

async function verifyStoreSeal(options) {
  const [readSeal, foundation, capsule, capsuleManifest, remoteOperation] =
    await Promise.all([
    readStoreSeal(options),
    readStoreSealFoundation(options),
    readCanonicalIdentity(
      options,
      "capsule",
      "capsule-sha256",
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
      MAX_STORED_CAPSULE_BYTES,
      "publication recovery capsule"
    ),
    readCanonicalIdentity(
      options,
      "capsule-manifest",
      "capsule-manifest-sha256",
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumManifestBytes,
      "publication recovery capsule manifest"
    ),
    readRemoteOperation(options)
  ]);
  assertElectronProductionPublicationRecoveryStoreSealBindings({
    ...foundation,
    seal: readSeal.receipt
  });
  assertPackedManifestBinding(capsule, capsuleManifest);
  assertStoreSealEvidence(
    readSeal.receipt,
    capsule,
    capsuleManifest,
    remoteOperation
  );
  return createSummary(
    "verify-store-seal",
    "verified",
    readSeal.receiptIdentity,
    null
  );
}

async function materializeOutcome(options) {
  const [request, foundation, operationFile, leaseReleaseFile] =
    await Promise.all([
      readMaterializationInput(
        options,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
        [
          "determinedAt",
          "kind",
          "recoveryRun",
          "schemaVersion"
        ],
        "publication recovery outcome materialization input"
      ),
      readOutcomeFoundation(options),
      readRecoveryOperation(options),
      readLeaseReleaseOperation(options)
    ]);
  assertLegacyReadOnlyEvidence(operationFile, leaseReleaseFile);
  const initialEvidence = deriveOutcomeEvidence(operationFile, foundation);
  const leaseRelease = deriveLeaseReleaseEvidence(
    leaseReleaseFile,
    foundation,
    initialEvidence
  );
  const evidence = authoritativeOutcomeEvidence(initialEvidence, leaseRelease);
  return materializeOutcomeEvidence(
    options,
    request,
    foundation,
    {
      ...evidence,
      leaseRelease: leaseRelease.core
    },
    "materialize-outcome"
  );
}

async function materializeMarkerOutcome(options) {
  const [request, foundation] = await Promise.all([
    readMaterializationInput(
      options,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
      ["determinedAt", "kind", "recoveryRun", "schemaVersion"],
      "publication recovery marker outcome materialization input"
    ),
    readOutcomeFoundation(options)
  ]);
  const evidence = await readMarkerOutcomeEvidence(options, foundation);
  return materializeOutcomeEvidence(
    options,
    request,
    foundation,
    evidence,
    "materialize-marker-outcome"
  );
}

async function materializeOutcomeEvidence(
  options,
  request,
  foundation,
  evidence,
  command
) {
  const previousFile = await readPreviousOutcome(options, foundation);
  assertMarkerOutcomeContext(
    evidence,
    request.recoveryRun,
    request.determinedAt,
    previousFile
  );
  const outcome = createElectronProductionPublicationRecoveryOutcome({
    beforeMutation: evidence.beforeMutation,
    determinedAt: request.determinedAt,
    finalObservation: evidence.finalObservation,
    heldLease: foundation.heldLease,
    leaseRelease: evidence.leaseRelease,
    mutation: evidence.mutation,
    previousOutcomeSha256: previousFile?.receiptIdentity.sha256 ?? null,
    recoveryOperation: evidence.recoveryOperation,
    recoveryRun: request.recoveryRun,
    sourceSnapshot: foundation.sourceSnapshot,
    storeSeal: foundation.storeSeal,
    targetSnapshot: foundation.targetSnapshot
  });
  assertOutcomeFoundationBindings(foundation, outcome);
  assertOutcomePredecessor(previousFile, outcome);
  const written =
    await writeElectronProductionPublicationRecoveryOutcomeAttempt({
    outputPath: requiredOption(options, "attempt-output"),
    receipt: outcome
  });
  const terminal = outcome.outcome.terminal
    ? await writeElectronProductionPublicationRecoveryOutcome({
        outputPath: requiredOption(options, "terminal-output"),
        receipt: outcome
      })
    : null;
  return createSummary(
    command,
    "materialized",
    written.receiptIdentity,
    outcome.outcome,
    terminal?.receiptIdentity ?? null
  );
}

async function verifyOutcome(options) {
  const [readOutcome, foundation, operationFile, leaseReleaseFile] =
    await Promise.all([
      readRecoveryOutcomeAny({
      expectedSha256: requiredOption(options, "outcome-sha256"),
      receiptPath: requiredOption(options, "outcome")
    }),
    readOutcomeFoundation(options),
      readRecoveryOperation(options),
      readLeaseReleaseOperation(options)
    ]);
  assertLegacyReadOnlyEvidence(operationFile, leaseReleaseFile);
  const initialEvidence = deriveOutcomeEvidence(operationFile, foundation);
  const leaseRelease = deriveLeaseReleaseEvidence(
    leaseReleaseFile,
    foundation,
    initialEvidence
  );
  const evidence = authoritativeOutcomeEvidence(initialEvidence, leaseRelease);
  return verifyOutcomeEvidence(options, readOutcome, foundation, {
    ...evidence,
    leaseRelease: leaseRelease.core
  }, "verify-outcome");
}

async function verifyMarkerOutcome(options) {
  const [readOutcome, foundation] = await Promise.all([
    readRecoveryOutcomeAny({
      expectedSha256: requiredOption(options, "outcome-sha256"),
      receiptPath: requiredOption(options, "outcome")
    }),
    readOutcomeFoundation(options)
  ]);
  const evidence = await readMarkerOutcomeEvidence(options, foundation);
  return verifyOutcomeEvidence(
    options,
    readOutcome,
    foundation,
    evidence,
    "verify-marker-outcome"
  );
}

async function verifyOutcomeEvidence(
  options,
  readOutcome,
  foundation,
  evidence,
  command
) {
  const outcome = assertOutcomeFoundationBindings(
    foundation,
    readOutcome.receipt
  );
  const previousFile = await readPreviousOutcome(options, foundation);
  assertMarkerOutcomeContext(
    evidence,
    outcome.recoveryRun,
    outcome.outcome.determinedAt,
    previousFile
  );
  const expected = createElectronProductionPublicationRecoveryOutcome({
    beforeMutation: evidence.beforeMutation,
    determinedAt: outcome.outcome.determinedAt,
    finalObservation: evidence.finalObservation,
    heldLease: foundation.heldLease,
    leaseRelease: evidence.leaseRelease,
    mutation: evidence.mutation,
    previousOutcomeSha256: previousFile?.receiptIdentity.sha256 ?? null,
    recoveryOperation: evidence.recoveryOperation,
    recoveryRun: outcome.recoveryRun,
    sourceSnapshot: foundation.sourceSnapshot,
    storeSeal: foundation.storeSeal,
    targetSnapshot: foundation.targetSnapshot
  });
  if (!serializeCanonicalJson(expected).equals(serializeCanonicalJson(outcome))) {
    throw new Error(
      "The publication recovery outcome does not match its authoritative operation."
    );
  }
  assertOutcomePredecessor(previousFile, outcome);
  return createSummary(
    command,
    "verified",
    readOutcome.receiptIdentity,
    outcome.outcome
  );
}

async function readStoreSealFoundation(options) {
  const [heldLease, publicationIntent, sourceSnapshot, targetSnapshot] =
    await Promise.all([
      readHeldLease(options),
      readElectronProductionPublicationReceipt({
        expectedSha256: requiredOption(options, "publication-intent-sha256"),
        receiptPath: requiredOption(options, "publication-intent")
      }),
      readSnapshot(options, "source"),
      readSnapshot(options, "target")
    ]);
  return Object.freeze({
    heldLease: heldLease.lease,
    publicationIntent: publicationIntent.receipt,
    sourceSnapshot: sourceSnapshot.snapshot,
    targetSnapshot: targetSnapshot.snapshot
  });
}

async function readOutcomeFoundation(options) {
  const [heldLease, storeSeal, sourceSnapshot, targetSnapshot] =
    await Promise.all([
      readHeldLease(options),
      readStoreSeal(options),
      readSnapshot(options, "source"),
      readSnapshot(options, "target")
    ]);
  return Object.freeze({
    heldLease: heldLease.lease,
    heldLeaseFileSha256: heldLease.leaseIdentity.sha256,
    sourceSnapshotFileSha256: sourceSnapshot.file.sha256,
    sourceSnapshot: sourceSnapshot.snapshot,
    storeSeal: storeSeal.receipt,
    targetSnapshotFileSha256: targetSnapshot.file.sha256,
    targetSnapshot: targetSnapshot.snapshot
  });
}

async function readMarkerOutcomeEvidence(options, foundation) {
  const [authorizationFile, operationFile] = await Promise.all([
    readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      expectedSha256: requiredOption(
        options,
        "public-mutation-authorization-sha256"
      ),
      receiptPath: requiredOption(options, "public-mutation-authorization")
    }),
    readElectronProductionPublicationRecoveryPublicMutationOperation({
      expectedSha256: requiredOption(
        options,
        "public-mutation-operation-sha256"
      ),
      receiptPath: requiredOption(options, "public-mutation-operation")
    })
  ]);
  const evidence =
    electronProductionPublicationRecoveryPublicMutationOperationOutcomeEvidence({
    authorization: authorizationFile.value,
    authorizationSha256: authorizationFile.valueIdentity.sha256,
    heldLease: foundation.heldLease,
    heldLeaseFileSha256: foundation.heldLeaseFileSha256,
    operation: operationFile.value,
    sourceSnapshot: foundation.sourceSnapshot,
    sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
    targetSnapshot: foundation.targetSnapshot,
    targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
  });
  return Object.freeze({
    ...evidence,
    markerContext: Object.freeze({
      authority: operationFile.value.authority,
      resolvedAt: operationFile.value.resolvedAt
    })
  });
}

function assertLegacyReadOnlyEvidence(operationFile, leaseReleaseFile) {
  if (operationFile.receipt.kind ===
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND) {
    throw new Error(
      "An unmarked rollback PATCH cannot materialize a recovery outcome."
    );
  }
  if (leaseReleaseFile !== null &&
      leaseReleaseFile.operation.operation !== "reconcile-released-lease") {
    throw new Error(
      "An unmarked release PUT cannot materialize a recovery outcome."
    );
  }
}

function assertMarkerOutcomeContext(
  evidence,
  recoveryRun,
  determinedAt,
  previousFile
) {
  if (evidence.markerContext === undefined) return;
  const context = evidence.markerContext;
  if (!serializeCanonicalJson(context.authority.currentRun)
    .equals(serializeCanonicalJson(recoveryRun))) {
    throw new Error(
      "The marker outcome recovery run does not match its operation authority."
    );
  }
  assertEqual(
    previousFile?.receiptIdentity.sha256 ?? null,
    context.authority.previousOutcomeSha256,
    "marker outcome predecessor SHA-256"
  );
  if (Date.parse(determinedAt) < Date.parse(context.resolvedAt)) {
    throw new Error(
      "The marker outcome determination cannot precede operation resolution."
    );
  }
}

function readHeldLease(options) {
  assertEqual(
    path.basename(requiredOption(options, "held-lease")),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "publication recovery held-lease filename"
  );
  return readElectronProductionPublicLatestLease({
    expectedSha256: requiredOption(options, "held-lease-sha256"),
    leasePath: requiredOption(options, "held-lease")
  });
}

function readStoreSeal(options) {
  return readElectronProductionPublicationRecoveryStoreSeal({
    expectedSha256: requiredOption(options, "store-seal-sha256"),
    receiptPath: requiredOption(options, "store-seal")
  });
}

function readSnapshot(options, prefix) {
  return readElectronProductionPublicLatestSnapshot({
    expectedFileSha256: requiredOption(options, `${prefix}-snapshot-sha256`),
    snapshotPath: requiredOption(options, `${prefix}-snapshot`)
  });
}

async function readRecoveryOperation(options) {
  const receiptPath = requiredOption(options, "operation");
  const expectedSha256 = requiredOption(options, "operation-sha256");
  const fileName = path.basename(receiptPath);
  if (fileName === ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE) {
    return readElectronProductionPublicLatestRecoveryObservation({
      expectedSha256,
      receiptPath
    });
  }
  if (fileName === ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE) {
    return readElectronProductionPublicLatestRecoveryRollback({
      expectedSha256,
      receiptPath
    });
  }
  throw new Error("The authoritative recovery operation filename is invalid.");
}

function readLeaseReleaseOperation(options) {
  const operationPath = optionalOption(options, "lease-release-operation");
  const expectedSha256 = optionalOption(
    options,
    "lease-release-operation-sha256"
  );
  if (operationPath === undefined && expectedSha256 === undefined) return null;
  if (operationPath === undefined || expectedSha256 === undefined) {
    throw new Error(
      "Lease-release operation path and SHA-256 must be supplied together."
    );
  }
  return readElectronProductionPublicLatestLeaseReleaseOperation({
    expectedSha256,
    operationPath
  });
}

async function readPreviousOutcome(options, foundation) {
  const receiptPath = optionalOption(options, "previous-outcome");
  const expectedSha256 = optionalOption(options, "previous-outcome-sha256");
  if (receiptPath === undefined && expectedSha256 === undefined) return null;
  if (receiptPath === undefined || expectedSha256 === undefined) {
    throw new Error(
      "Previous recovery outcome path and SHA-256 must be supplied together."
    );
  }
  const file = await readRecoveryOutcomeAny({ expectedSha256, receiptPath });
  const previous = assertOutcomeFoundationBindings(foundation, file.receipt);
  if (previous.outcome.terminal) {
    throw new Error("A terminal recovery outcome cannot have a successor attempt.");
  }
  return file;
}

function readRecoveryOutcomeAny(input) {
  return path.basename(input.receiptPath) ===
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    ? readElectronProductionPublicationRecoveryOutcome(input)
    : readElectronProductionPublicationRecoveryOutcomeAttempt(input);
}

function assertOutcomePredecessor(previousFile, outcome) {
  if (previousFile === null) {
    if (outcome.previousOutcomeSha256 !== null) {
      throw new Error("The recovery outcome predecessor is missing.");
    }
    return;
  }
  if (outcome.previousOutcomeSha256 !== previousFile.receiptIdentity.sha256) {
    throw new Error("The recovery outcome predecessor SHA-256 does not match.");
  }
  const previous = previousFile.receipt;
  if (
    Date.parse(outcome.recoveryRun.startedAt) <
    Date.parse(previous.outcome.determinedAt)
  ) throw new Error("A recovery outcome successor cannot precede its predecessor.");
  if (outcome.recoveryRun.runId === previous.recoveryRun.runId) {
    if (outcome.recoveryRun.runAttempt <= previous.recoveryRun.runAttempt) {
      throw new Error(
        "A same-run recovery outcome successor must use a greater run attempt."
      );
    }
  }
}

function deriveOutcomeEvidence(operationFile, foundation) {
  const receipt = operationFile.receipt;
  if (receipt.kind === ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND) {
    const observation =
      assertElectronProductionPublicLatestRecoveryObservationBindings({
        observation: receipt,
        sourceSnapshot: foundation.sourceSnapshot,
        sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
        targetSnapshot: foundation.targetSnapshot,
        targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
      });
    const coreObservation = observationReferenceToCore({
      classification: observation.observation.classification,
      observedAt: observation.observedAt,
      snapshot: observation.observation.snapshot
    });
    return Object.freeze({
      beforeMutation: coreObservation,
      finalObservation: coreObservation,
      mutation: Object.freeze({
        kind: "none",
        submitted: false,
        acknowledgement: null,
        submittedAt: null,
        resultRecordedAt: null
      }),
      recoveryOperation: Object.freeze({
        kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
        sha256: operationFile.receiptIdentity.sha256
      })
    });
  }
  if (receipt.kind !== ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND) {
    throw new Error("The authoritative recovery operation kind is invalid.");
  }
  const rollback =
    assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings({
      heldLease: foundation.heldLease,
      rollback: receipt,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
    });
  return Object.freeze({
    beforeMutation: observationReferenceToCore(rollback.before),
    finalObservation: observationReferenceToCore(rollback.final),
    mutation: Object.freeze({
      kind: "rollback",
      submitted: true,
      acknowledgement: rollback.mutation.acknowledgement,
      submittedAt: rollback.mutation.submittedAt,
      resultRecordedAt: rollback.mutation.resultRecordedAt
    }),
    recoveryOperation: Object.freeze({
      kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
      sha256: operationFile.receiptIdentity.sha256
    })
  });
}

function observationReferenceToCore(reference) {
  const classification = reference.classification === "source" ||
      reference.classification === "target"
    ? reference.classification
    : "unknown";
  return Object.freeze({
    classification,
    observedAt: reference.observedAt,
    stateSha256: classification === "unknown"
      ? null
      : reference.snapshot.stateSha256
  });
}

function deriveLeaseReleaseEvidence(operationFile, foundation, evidence) {
  if (operationFile === null) {
    return Object.freeze({
      core: Object.freeze({
        attempted: false,
        acknowledgement: null,
        attemptedAt: null,
        operationSha256: null,
        resolvedAt: null,
        successorEventSha256: null
      }),
      preReleaseObservation: null,
      recoveryOperation: evidence.recoveryOperation
    });
  }
  const recoveryOperation = evidence.mutation.kind === "none"
    ? operationFile.operation.recoveryOperation
    : evidence.recoveryOperation;
  const operation =
    assertElectronProductionPublicLatestLeaseReleaseOperationBindings({
      heldLease: foundation.heldLease,
      operation: operationFile.operation,
      recoveryOperation,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
    });
  return Object.freeze({
    core: Object.freeze({
      attempted: true,
      acknowledgement: operation.acknowledgement,
      attemptedAt: operation.attemptedAt,
      operationSha256: operationFile.operationIdentity.sha256,
      resolvedAt: operation.resolvedAt,
      successorEventSha256: operation.successor?.eventSha256 ?? null
    }),
    preReleaseObservation: observationReferenceToCore({
      classification:
        operation.preReleaseObservation.receipt.observation.classification,
      observedAt: operation.preReleaseObservation.receipt.observedAt,
      snapshot: operation.preReleaseObservation.receipt.observation.snapshot
    }),
    recoveryOperation
  });
}

function authoritativeOutcomeEvidence(evidence, leaseRelease) {
  if (evidence.mutation.kind !== "none" ||
      leaseRelease.preReleaseObservation === null) return evidence;
  if (evidence.beforeMutation.classification !== "source") {
    throw new Error(
      "The source no-op recovery-operation binding is not an exact source observation."
    );
  }
  return Object.freeze({
    beforeMutation: leaseRelease.preReleaseObservation,
    finalObservation: leaseRelease.preReleaseObservation,
    mutation: evidence.mutation,
    recoveryOperation: leaseRelease.recoveryOperation
  });
}

function assertOutcomeFoundationBindings(foundation, outcome) {
  return assertElectronProductionPublicationRecoveryOutcomeBindings({
    heldLease: foundation.heldLease,
    outcome,
    sourceSnapshot: foundation.sourceSnapshot,
    storeSeal: foundation.storeSeal,
    targetSnapshot: foundation.targetSnapshot
  });
}

async function readMaterializationInput(options, kind, keys, label) {
  const file = await readCanonicalJsonFile(
    requiredOption(options, "input"),
    MAX_INPUT_BYTES,
    label
  );
  assertEqual(
    file.sha256,
    requiredDigest(requiredOption(options, "input-sha256"), `${label} SHA-256`),
    `${label} SHA-256`
  );
  assertExactKeys(file.value, keys, label);
  assertEqual(file.value.schemaVersion, 1, `${label} schema version`);
  assertEqual(file.value.kind, kind, `${label} kind`);
  return file.value;
}

async function readCanonicalIdentity(
  options,
  pathOption,
  digestOption,
  expectedName,
  maximumBytes,
  label
) {
  const filePath = requiredOption(options, pathOption);
  assertEqual(path.basename(filePath), expectedName, `${label} filename`);
  const file = await readCanonicalJsonFile(filePath, maximumBytes, label);
  assertEqual(
    file.sha256,
    requiredDigest(requiredOption(options, digestOption), `${label} SHA-256`),
    `${label} SHA-256`
  );
  return Object.freeze({
    ...publicIdentity(filePath, file),
    source: file.source,
    value: file.value
  });
}

function readRemoteOperation(options) {
  return readElectronProductionRecoveryStoreRemoteOperationReceipt({
    expectedSha256: requiredOption(options, "remote-operation-sha256"),
    receiptPath: requiredOption(options, "remote-operation")
  });
}

function durableStoreFromAppliedOperation(
  operationFile,
  capsule,
  committedAt
) {
  const operation = operationFile.receipt;
  if (operation.terminal.classification !== "applied" ||
      operation.applied === null) {
    throw new Error(
      "A recovery store seal requires an applied remote operation receipt."
    );
  }
  const remotePackage = operation.requestIdentity.package;
  for (const [actual, expected, label] of [
    [remotePackage.fileName, capsule.fileName, "filename"],
    [remotePackage.byteLength, capsule.bytes, "byte length"],
    [remotePackage.sha256, capsule.sha256, "SHA-256"]
  ]) assertEqual(actual, expected, `recovery capsule remote-operation ${label}`);
  const { target } = operation.requestIdentity;
  return {
    repository: target.repository,
    ref: target.ref,
    path: target.path,
    repositoryPolicy: target.repositoryPolicy,
    byteLength: operation.applied.byteLength,
    blobSha: operation.applied.blobSha,
    treeSha: operation.applied.treeSha,
    parentCommitSha: operation.applied.parentCommitSha,
    commitSha: operation.applied.commitSha,
    remoteReceiptSha256: operationFile.receiptIdentity.sha256,
    committedAt
  };
}

function assertStoreSealEvidence(
  seal,
  capsule,
  capsuleManifest,
  remoteOperation
) {
  for (const [actual, expected, label] of [
    [seal.capsuleFileName, capsule.fileName, "capsule filename"],
    [seal.capsuleBytes, capsule.bytes, "capsule byte length"],
    [seal.capsuleSha256, capsule.sha256, "capsule SHA-256"],
    [seal.capsuleManifestBytes, capsuleManifest.bytes, "manifest byte length"],
    [seal.capsuleManifestSha256, capsuleManifest.sha256, "manifest SHA-256"]
  ]) assertEqual(actual, expected, `recovery store-seal ${label} binding`);
  const expectedStore = durableStoreFromAppliedOperation(
    remoteOperation,
    capsule,
    seal.durableStore.committedAt
  );
  for (const key of [
    "repository",
    "ref",
    "path",
    "byteLength",
    "blobSha",
    "treeSha",
    "parentCommitSha",
    "commitSha",
    "remoteReceiptSha256",
    "committedAt"
  ]) {
    assertEqual(
      seal.durableStore[key],
      expectedStore[key],
      `recovery store-seal durable-store ${key}`
    );
  }
  for (const key of ["defaultBranch", "visibility"]) {
    assertEqual(
      seal.durableStore.repositoryPolicy[key],
      expectedStore.repositoryPolicy[key],
      `recovery store-seal repository policy ${key}`
    );
  }
}

function assertPackedManifestBinding(capsule, capsuleManifest) {
  assertExactKeys(capsule.value, [
    "encoding",
    "fileCount",
    "files",
    "intent",
    "kind",
    "manifest",
    "schemaVersion",
    "totalFileBytes"
  ], "publication recovery capsule package");
  assertEqual(capsule.value.schemaVersion, 1,
    "publication recovery capsule package schema version");
  assertEqual(capsule.value.kind, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND,
    "publication recovery capsule package kind");
  assertEqual(capsule.value.encoding, "base64",
    "publication recovery capsule package encoding");
  assertExactKeys(
    capsule.value.manifest,
    ["bytes", "path", "sha256"],
    "publication recovery capsule package manifest identity"
  );
  const embedded = capsule.value.files?.[ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME];
  assertExactKeys(
    embedded,
    ["bytes", "contentBase64", "sha256"],
    "publication recovery capsule package manifest entry"
  );
  for (const [actual, expected, label] of [
    [capsule.value.manifest.path, capsuleManifest.fileName, "path"],
    [capsule.value.manifest.bytes, capsuleManifest.bytes, "byte length"],
    [capsule.value.manifest.sha256, capsuleManifest.sha256, "SHA-256"],
    [embedded.bytes, capsuleManifest.bytes, "entry byte length"],
    [embedded.sha256, capsuleManifest.sha256, "entry SHA-256"]
  ]) assertEqual(actual, expected, `packed recovery capsule manifest ${label}`);
  if (typeof embedded.contentBase64 !== "string") {
    throw new Error("The packed recovery capsule manifest content must be base64.");
  }
  const decoded = Buffer.from(embedded.contentBase64, "base64");
  assertEqual(decoded.toString("base64"), embedded.contentBase64,
    "packed recovery capsule manifest canonical base64");
  if (!decoded.equals(capsuleManifest.source)) {
    throw new Error("The packed recovery capsule manifest bytes do not match.");
  }
}

function createSummary(command, status, output, outcome, terminalOutput = null) {
  const decision = outcome === null
    ? null
    : Object.freeze({
      classification: outcome.classification,
      safeToReleaseLease: outcome.safeToReleaseLease,
      terminal: outcome.terminal
    });
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_CLI_SUMMARY_KIND,
    command,
    status,
    output: {
      bytes: output.bytes,
      fileName: output.fileName,
      sha256: output.sha256
    },
    terminalOutput: terminalOutput === null
      ? null
      : {
          bytes: terminalOutput.bytes,
          fileName: terminalOutput.fileName,
          sha256: terminalOutput.sha256
        },
    outcome: decision
  });
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every publication recovery CLI option requires one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    if (!rawName.startsWith("--") || rawName.length === 2) {
      throw new Error(`Invalid publication recovery CLI option ${rawName}.`);
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate publication recovery CLI option --${name}.`);
    }
    options.set(name, argumentsList[index + 1]);
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

function assertRequiredCommandOptions(command, options) {
  for (const name of REQUIRED_COMMAND_OPTIONS[command]) {
    requiredOption(options, name);
  }
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required publication recovery option --${name}.`);
  }
  return value;
}

function optionalOption(options, name) {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw new Error(`Publication recovery option --${name} cannot be empty.`);
  }
  return value;
}

function resolveDependencies(overrides) {
  for (const name of Object.keys(overrides)) {
    if (name !== "writeStdout") {
      throw new Error(`Unknown publication recovery CLI dependency ${name}.`);
    }
  }
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  if (typeof writeStdout !== "function") {
    throw new Error("Publication recovery CLI dependencies are invalid.");
  }
  return Object.freeze({ writeStdout });
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
  runElectronProductionPublicationRecoveryCli().catch(() => {
    process.stderr.write("Electron production recovery CLI failed closed.\n");
    process.exitCode = 1;
  });
}
