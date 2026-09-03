import { lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  electronProductionPublicLatestLeaseEventSha256,
  readElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
  createElectronProductionPublicLatestLeaseReleaseOperation,
  electronProductionPublicLatestLeaseReleaseOperationSha256,
  readElectronProductionPublicLatestLeaseReleaseOperation,
  serializeElectronProductionPublicLatestLeaseReleaseOperation
} from "./electronProductionPublicLatestLeaseReleaseOperation.mjs";
import {
  ElectronProductionPublicLatestLeaseRemoteCliFailure,
  assertElectronProductionPublicLatestLeaseRemoteOperationSummary,
  runElectronProductionPublicLatestLeaseRemoteCli
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
  observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote
} from "./electronProductionPublicLatestLeaseRemote.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
  electronProductionPublicLatestRecoveryObservationSha256,
  electronProductionPublicLatestRecoveryRollbackSha256,
  readElectronProductionPublicLatestRecoveryObservation,
  readElectronProductionPublicLatestRecoveryRollback,
  serializeElectronProductionPublicLatestRecoveryObservation,
  serializeElectronProductionPublicLatestRecoveryRollback,
  writeElectronProductionPublicLatestRecoveryObservation
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  ElectronProductionPublicLatestRollbackNotSubmittedError,
  observeElectronProductionPublicLatestRecoveryRemote,
  rollbackElectronProductionPublicLatestRecoveryRemote
} from "./electronProductionPublicLatestRecoveryRemote.mjs";
import {
  readElectronProductionPublicationRecoveryOutcomeAttempt
} from "./electronProductionPublicationRecovery.mjs";
import {
  readElectronProductionPublicationRecoveryLeaseReleaseAuthorization
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  readElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertEqual,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND =
  "rion-electron-production-public-latest-recovery-cli-summary";

const CURRENT_RUN_OPTIONS = [
  "current-control-sha",
  "current-run-attempt",
  "current-run-id",
  "current-run-repository",
  "current-run-started-at",
  "current-run-workflow"
];

const COMMAND_OPTIONS = Object.freeze({
  observe: new Set([
    "observed-at",
    "output",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  rollback: new Set([
    "final-observation-output",
    "final-observed-at",
    "held-lease",
    "held-lease-sha256",
    "output",
    "pre-observation",
    "pre-observation-sha256",
    "result-recorded-at",
    "source-snapshot",
    "source-snapshot-sha256",
    "submitted-at",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "release-lease": new Set([
    ...CURRENT_RUN_OPTIONS,
    "attempted-at",
    "held-lease",
    "held-lease-sha256",
    "output",
    "previous-outcome",
    "previous-outcome-sha256",
    "release-authorization",
    "release-authorization-sha256",
    "released-lease-output",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "reconcile-lease-release": new Set([
    ...CURRENT_RUN_OPTIONS,
    "held-lease",
    "held-lease-sha256",
    "observed-at",
    "output",
    "previous-outcome",
    "previous-outcome-sha256",
    "release-authorization",
    "release-authorization-sha256",
    "released-lease-output",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "route-lease-release": new Set([
    ...CURRENT_RUN_OPTIONS,
    "held-lease",
    "held-lease-sha256",
    "observed-at",
    "output",
    "previous-outcome",
    "previous-outcome-sha256",
    "release-authorization",
    "release-authorization-sha256",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ])
});
const OPTIONAL_COMMAND_OPTIONS = Object.freeze({
  "release-lease": new Set(["previous-outcome", "previous-outcome-sha256"]),
  "reconcile-lease-release": new Set([
    "previous-outcome",
    "previous-outcome-sha256"
  ]),
  "route-lease-release": new Set([
    "previous-outcome",
    "previous-outcome-sha256"
  ])
});

export class ElectronProductionPublicLatestRecoveryCliFailure extends Error {
  constructor(summary) {
    super(`Public-latest recovery ${summary.command} failed closed.`);
    this.name = "ElectronProductionPublicLatestRecoveryCliFailure";
    this.summary = summary;
  }
}

export async function runElectronProductionPublicLatestRecoveryCli(
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
      "Usage: electronProductionPublicLatestRecoveryCli.mjs " +
      "<observe|rollback|release-lease|reconcile-lease-release|" +
      "route-lease-release> [strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedAndRequiredOptions(command, options);
  const token = requiredToken(dependencies.environment);
  if (command === "observe") return observeCommand(options, token, dependencies);
  if (command === "rollback") return rollbackCommand(options, token, dependencies);
  if (command === "release-lease") {
    return releaseLeaseCommand(options, token, dependencies);
  }
  if (command === "reconcile-lease-release") {
    return reconcileLeaseReleaseCommand(options, token, dependencies);
  }
  return routeLeaseReleaseCommand(options, token, dependencies);
}

async function observeCommand(options, token, dependencies) {
  const foundation = await readFoundation(options);
  const observation =
    await observeElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
      observedAt: requiredOption(options, "observed-at"),
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token
    });
  const written = await writeElectronProductionPublicLatestRecoveryObservation({
    outputPath: requiredOption(options, "output"),
    receipt: observation
  });
  const summary = createSummary({
    command: "observe",
    observation: observation.observation.classification,
    observationTransport: observation.transport.outcome,
    observationOutput: written.receiptIdentity,
    rollbackAcknowledgement: null,
    rollbackOutput: null
  });
  await emitSummary(summary, dependencies);
  if (observation.transport.outcome !== "observed") {
    dependencies.setExitCode(1);
    throw new ElectronProductionPublicLatestRecoveryCliFailure(summary);
  }
  return summary;
}

async function rollbackCommand(options, token, dependencies) {
  const [foundation, heldLease, preObservation] = await Promise.all([
    readFoundation(options),
    readElectronProductionPublicLatestLease({
      expectedSha256: requiredOption(options, "held-lease-sha256"),
      leasePath: requiredOption(options, "held-lease")
    }),
    readElectronProductionPublicLatestRecoveryObservation({
      expectedSha256: requiredOption(options, "pre-observation-sha256"),
      receiptPath: requiredOption(options, "pre-observation")
    })
  ]);
  const reservations = await reserveOutputSet([
    {
      expectedName: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
      label: "final recovery observation output",
      path: requiredOption(options, "final-observation-output")
    },
    {
      expectedName: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
      label: "recovery rollback output",
      path: requiredOption(options, "output")
    }
  ]);
  let result;
  try {
    result = await rollbackElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
      finalObservedAt: requiredOption(options, "final-observed-at"),
      heldLease: heldLease.lease,
      preObservation: preObservation.receipt,
      preObservationSha256: preObservation.receiptIdentity.sha256,
      resultRecordedAt: requiredOption(options, "result-recorded-at"),
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      submittedAt: requiredOption(options, "submitted-at"),
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token
    });
  } catch (error) {
    if (error instanceof ElectronProductionPublicLatestRollbackNotSubmittedError) {
      await discardReservations(reservations);
    }
    throw error;
  }
  const finalWritten = await commitObservationReservation(
    reservations[0],
    result.finalObservation
  );
  if (
    finalWritten.receiptIdentity.sha256 !==
    electronProductionPublicLatestRecoveryObservationSha256(
      result.finalObservation
    ) ||
    finalWritten.receiptIdentity.sha256 !== result.rollback.final.observationSha256
  ) {
    throw new Error("The final recovery observation output identity changed.");
  }
  const rollbackWritten = await commitRollbackReservation(
    reservations[1],
    result.rollback
  );
  const summary = createSummary({
    command: "rollback",
    observation: result.finalObservation.observation.classification,
    observationTransport: result.finalObservation.transport.outcome,
    observationOutput: finalWritten.receiptIdentity,
    rollbackAcknowledgement: result.rollback.mutation.acknowledgement,
    rollbackOutput: rollbackWritten.receiptIdentity
  });
  await emitSummary(summary, dependencies);
  if (
    result.rollback.mutation.acknowledgement !== "confirmed" ||
    result.finalObservation.transport.outcome !== "observed" ||
    result.finalObservation.observation.classification !== "source"
  ) {
    dependencies.setExitCode(1);
    throw new ElectronProductionPublicLatestRecoveryCliFailure(summary);
  }
  return summary;
}

async function routeLeaseReleaseCommand(options, token, dependencies) {
  const resolvedAt = requiredOption(options, "observed-at");
  const [foundation, heldLease, authorizationFile] = await Promise.all([
    readFoundation(options),
    readElectronProductionPublicLatestLease({
      expectedSha256: requiredOption(options, "held-lease-sha256"),
      leasePath: requiredOption(options, "held-lease")
    }),
    readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      receiptPath: requiredOption(options, "release-authorization"),
      expectedSha256: requiredOption(options, "release-authorization-sha256")
    })
  ]);
  const authority = await assertAuthorizedChainHead(
    options,
    authorizationFile,
    foundation,
    heldLease,
    "route"
  );
  assertAuthorizedResolutionTime(authority.authorization, resolvedAt);
  const [observationReservation] = await reserveOutputSet([{
    expectedName: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
    label: "lease-release route observation output",
    path: requiredOption(options, "output")
  }]);
  let observation;
  try {
    observation = await observeElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
      observedAt: resolvedAt,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token
    });
  } catch (error) {
    await discardReservations([observationReservation]);
    throw error;
  }
  const written = await commitObservationReservation(
    observationReservation,
    observation
  );
  let leaseResult = null;
  if (
    observation.transport.outcome === "observed" &&
    observation.observation.classification === "source"
  ) {
    leaseResult =
      await observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote({
        expected: heldLease.lease,
        fetchImpl: dependencies.fetchImpl,
        token
      });
  }
  const decision = deriveLeaseReleaseRoute(authority, leaseResult);
  const summary = createRouteSummary({
    decision,
    observation,
    observationOutput: written.receiptIdentity
  });
  await emitSummary(summary, dependencies);
  if (decision.route === "blocked") {
    dependencies.setExitCode(1);
    throw new ElectronProductionPublicLatestRecoveryCliFailure(summary);
  }
  return summary;
}

async function releaseLeaseCommand(options, token, dependencies) {
  const [foundation, heldLease, authorizationFile] = await Promise.all([
    readFoundation(options),
    readElectronProductionPublicLatestLease({
      expectedSha256: requiredOption(options, "held-lease-sha256"),
      leasePath: requiredOption(options, "held-lease")
    }),
    readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      receiptPath: requiredOption(options, "release-authorization"),
      expectedSha256: requiredOption(
        options,
        "release-authorization-sha256"
      )
    })
  ]);
  const authority = await assertAuthorizedChainHead(
    options,
    authorizationFile,
    foundation,
    heldLease,
    "release"
  );
  const attemptedAt = requiredOption(options, "attempted-at");
  assertAuthorizedResolutionTime(authority.authorization, attemptedAt);
  assertIntentPrecedesRelease(authority.authorization, attemptedAt);
  const releasedLeaseOutput = await resolveCreateNewFile(
    assertReleasedLeaseOutput(options),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "released public-latest lease output"
  );
  const [operationReservation] = await reserveOutputSet([{
    expectedName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
    label: "public-latest lease release operation output",
    path: requiredOption(options, "output")
  }]);
  let preReleaseObservation;
  try {
    preReleaseObservation =
      await observeElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
      observedAt: attemptedAt,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token
    });
  } catch (error) {
    await discardReservations([operationReservation]);
    throw error;
  }
  if (
    preReleaseObservation.transport.outcome !== "observed" ||
    preReleaseObservation.observation.classification !== "source"
  ) {
    await discardReservations([operationReservation]);
    throw new Error(
      "Lease release requires a fresh exact source observation before CAS."
    );
  }
  const authoritativeRecoveryEvidence = Object.freeze({
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    sha256: electronProductionPublicLatestRecoveryObservationSha256(
      preReleaseObservation
    )
  });
  let remoteOperation;
  try {
    remoteOperation = await runElectronProductionPublicLatestLeaseRemoteCli([
      "release",
      "--held-lease", heldLease.leasePath,
      "--held-lease-sha256", heldLease.leaseIdentity.sha256,
      "--recorded-at", attemptedAt,
      "--output", releasedLeaseOutput
    ], {
      environment: dependencies.environment,
      fetchImpl: dependencies.fetchImpl,
      setExitCode: () => undefined,
      writeStdout: () => undefined
    });
  } catch (error) {
    if (!(error instanceof ElectronProductionPublicLatestLeaseRemoteCliFailure)) {
      throw error;
    }
    remoteOperation = error.summary;
  }
  const operation = createElectronProductionPublicLatestLeaseReleaseOperation({
    heldLease: heldLease.lease,
    preReleaseObservation,
    recoveryOperation: authoritativeRecoveryEvidence,
    remoteOperation,
    resolvedAt: attemptedAt
  });
  const written = await commitLeaseReleaseReservation(
    operationReservation,
    operation
  );
  const summary = createReleaseSummary(
    "release-lease",
    operation,
    written.operationIdentity
  );
  await emitSummary(summary, dependencies);
  if (operation.acknowledgement !== "confirmed") {
    dependencies.setExitCode(1);
    throw new ElectronProductionPublicLatestRecoveryCliFailure(summary);
  }
  return summary;
}

async function reconcileLeaseReleaseCommand(options, token, dependencies) {
  const resolvedAt = requiredOption(options, "observed-at");
  const [foundation, heldLease, authorizationFile] =
    await Promise.all([
      readFoundation(options),
      readElectronProductionPublicLatestLease({
        expectedSha256: requiredOption(options, "held-lease-sha256"),
        leasePath: requiredOption(options, "held-lease")
      }),
      readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        receiptPath: requiredOption(options, "release-authorization"),
        expectedSha256: requiredOption(
          options,
          "release-authorization-sha256"
        )
      })
    ]);
  const authority = await assertAuthorizedChainHead(
    options,
    authorizationFile,
    foundation,
    heldLease,
    "reconcile"
  );
  assertAuthorizedResolutionTime(authority.authorization, resolvedAt);
  const releasedLeaseOutput = await resolveCreateNewFile(
    assertReleasedLeaseOutput(options),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "reconciled released public-latest lease output"
  );
  const [operationReservation] = await reserveOutputSet([{
    expectedName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
    label: "reconciled public-latest lease release operation output",
    path: requiredOption(options, "output")
  }]);
  let preReleaseObservation;
  try {
    preReleaseObservation =
      await observeElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
        observedAt: resolvedAt,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token
    });
  } catch (error) {
    await discardReservations([operationReservation]);
    throw error;
  }
  if (
    preReleaseObservation.transport.outcome !== "observed" ||
    preReleaseObservation.observation.classification !== "source"
  ) {
    await discardReservations([operationReservation]);
    throw new Error(
      "Lease-release reconciliation requires a fresh exact source observation."
    );
  }
  const authoritativeRecoveryEvidence = Object.freeze({
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    sha256: electronProductionPublicLatestRecoveryObservationSha256(
      preReleaseObservation
    )
  });
  const remoteResult =
    await observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote({
      expected: heldLease.lease,
      fetchImpl: dependencies.fetchImpl,
      token
    });
  const pendingAttemptedAt = authority.pendingUnknownAttemptedAt;
  if (remoteResult.outcome !== "observed" && pendingAttemptedAt === null) {
    await discardReservations([operationReservation]);
    throw new Error(
      "A zero-chain release reconciliation did not observe a released successor."
    );
  }
  const attemptedAt = remoteResult.outcome === "observed"
    ? remoteResult.lease.recordedAt
    : pendingAttemptedAt;
  if (pendingAttemptedAt !== null && attemptedAt !== pendingAttemptedAt) {
    await discardReservations([operationReservation]);
    throw new Error(
      "The released successor does not match the durable unknown attempt."
    );
  }
  try {
    assertIntentPrecedesRelease(authority.authorization, attemptedAt);
  } catch (error) {
    await discardReservations([operationReservation]);
    throw error;
  }
  const remoteOperation = await summarizeReleasedSuccessorObservation({
    heldLease: heldLease.lease,
    outputPath: releasedLeaseOutput,
    preserveUnknownAcknowledgement: pendingAttemptedAt !== null,
    result: remoteResult,
    attemptedAt
  });
  const operation = createElectronProductionPublicLatestLeaseReleaseOperation({
    heldLease: heldLease.lease,
    preReleaseObservation,
    recoveryOperation: authoritativeRecoveryEvidence,
    remoteOperation,
    resolvedAt
  });
  const written = await commitLeaseReleaseReservation(
    operationReservation,
    operation
  );
  const summary = createReleaseSummary(
    "reconcile-lease-release",
    operation,
    written.operationIdentity
  );
  await emitSummary(summary, dependencies);
  if (operation.acknowledgement !== "confirmed") {
    dependencies.setExitCode(1);
    throw new ElectronProductionPublicLatestRecoveryCliFailure(summary);
  }
  return summary;
}

async function assertAuthorizedChainHead(
  options,
  authorizationFile,
  foundation,
  heldFile,
  mode
) {
  const authorization = authorizationFile.value;
  assertCurrentRunBinding(options, authorization.currentRun);
  const intent = authorization.authority.intent;
  const proof = authorization.evidence.freshChainProof.receipt;
  if (proof.kind !==
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND ||
      proof.status === "terminal") {
    throw new Error("A terminal recovery chain cannot authorize public mutation.");
  }
  const heldLease = heldFile.lease;
  for (const [actual, expected, label] of [
    [authorization.transactionId, heldLease.transactionId, "transaction ID"],
    [intent.heldLease.leaseId, heldLease.leaseId, "lease ID"],
    [intent.heldLease.generation, heldLease.generation, "lease generation"],
    [intent.heldLease.revision, heldLease.revision, "held revision"],
    [intent.heldLease.eventSha256,
      electronProductionPublicLatestLeaseEventSha256(heldLease),
      "held event SHA-256"],
    [intent.heldLease.fileSha256, heldFile.leaseIdentity.sha256,
      "held file SHA-256"],
    [intent.heldLease.sourceStateSha256,
      foundation.sourceSnapshot.stateSha256, "source state SHA-256"],
    [intent.heldLease.targetStateSha256,
      foundation.targetSnapshot.stateSha256, "target state SHA-256"],
    [intent.foundation.sourceSnapshotSha256,
      foundation.sourceSnapshotFileSha256, "source snapshot SHA-256"],
    [intent.foundation.targetSnapshotSha256,
      foundation.targetSnapshotFileSha256, "target snapshot SHA-256"],
    [proof.foundation.heldLeaseSha256, heldFile.leaseIdentity.sha256,
      "chain held file SHA-256"],
    [proof.foundation.storeSealSha256, intent.foundation.storeSealSha256,
      "chain store-seal SHA-256"]
  ]) assertEqual(actual, expected,
    `authorized public-latest release ${label}`);
  if (heldLease.status !== "held" ||
      heldLease.purpose !== "electron-v23-provisional-publication") {
    throw new Error("Authorized public-latest release requires its exact held lease.");
  }
  const previousPair = optionalPreviousOutcome(options);
  const latest = proof.latestOutcome;
  if ((latest === null) !== (previousPair === null)) {
    throw new Error(
      "The durable recovery chain head and previous outcome input do not match."
    );
  }
  let previousOutcome = null;
  if (latest !== null && previousPair !== null) {
    const previousFile =
      await readElectronProductionPublicationRecoveryOutcomeAttempt({
        receiptPath: previousPair.path,
        expectedSha256: previousPair.sha256
      });
    for (const [actual, expected, label] of [
      [previousFile.receiptIdentity.fileName, latest.fileName, "filename"],
      [previousFile.receiptIdentity.bytes, latest.bytes, "bytes"],
      [previousFile.receiptIdentity.sha256, latest.sha256, "SHA-256"],
      [previousFile.receipt.transactionId, intent.transactionId,
        "transaction ID"],
      [previousFile.receipt.lease.leaseId, intent.heldLease.leaseId,
        "lease ID"],
      [previousFile.receipt.lease.generation, intent.heldLease.generation,
        "lease generation"],
      [previousFile.receipt.lease.eventSha256, intent.heldLease.eventSha256,
        "held event SHA-256"],
      [previousFile.receipt.durableStore.sealSha256,
        intent.foundation.storeSealSha256, "store-seal SHA-256"],
      [previousFile.receipt.source.stateSha256,
        intent.heldLease.sourceStateSha256, "source state SHA-256"],
      [previousFile.receipt.target.stateSha256,
        intent.heldLease.targetStateSha256, "target state SHA-256"]
    ]) assertEqual(actual, expected,
      `authorized previous recovery outcome ${label}`);
    if (previousFile.receipt.outcome.terminal) {
      throw new Error("A terminal previous outcome cannot authorize mutation.");
    }
    previousOutcome = previousFile.receipt;
  }
  const unknownAttemptTimes = new Set(proof.outcomes
    .filter((outcome) => outcome.leaseRelease.acknowledgement === "unknown")
    .map((outcome) => outcome.leaseRelease.attemptedAt));
  if (unknownAttemptTimes.has(null) || unknownAttemptTimes.size > 1) {
    throw new Error(
      "The durable recovery chain has conflicting unknown release attempts."
    );
  }
  const pendingUnknownAttemptedAt = unknownAttemptTimes.size === 0
    ? null
    : [...unknownAttemptTimes][0];
  if (mode === "release") {
    if (pendingUnknownAttemptedAt !== null) {
      throw new Error(
        "A historically unknown release acknowledgement permanently forbids retry PUT."
      );
    }
    if (previousOutcome !== null &&
        previousOutcome.leaseRelease.acknowledgement !== "rejected" &&
        !isConfirmedRollbackReadyForRelease(previousOutcome)) {
      throw new Error(
        "A new release PUT requires an empty chain, rejected attempt, or exact rollback pair."
      );
    }
    if (
      previousOutcome === null &&
      authorization.headTransition.mode !== "created-now"
    ) {
      throw new Error(
        "A resumed empty recovery chain cannot authorize another release PUT."
      );
    }
  }
  return Object.freeze({
    authorization,
    pendingUnknownAttemptedAt,
    previousOutcome,
    proof
  });
}

function optionalPreviousOutcome(options) {
  const filePath = options.get("previous-outcome") ?? null;
  const sha256 = options.get("previous-outcome-sha256") ?? null;
  if ((filePath === null) !== (sha256 === null)) {
    throw new Error(
      "--previous-outcome and --previous-outcome-sha256 must be supplied together."
    );
  }
  return filePath === null ? null : { path: filePath, sha256 };
}

function assertCurrentRunBinding(options, expected) {
  const attemptSource = requiredOption(options, "current-run-attempt");
  if (!/^[1-9][0-9]*$/u.test(attemptSource)) {
    throw new Error("The current recovery run attempt is invalid.");
  }
  const actual = {
    repository: requiredOption(options, "current-run-repository"),
    workflow: requiredOption(options, "current-run-workflow"),
    runId: requiredOption(options, "current-run-id"),
    runAttempt: Number(attemptSource),
    controlSha: requiredOption(options, "current-control-sha"),
    startedAt: requiredOption(options, "current-run-started-at")
  };
  for (const [value, expectedValue, label] of [
    [actual.repository, expected.repository, "repository"],
    [actual.workflow, expected.workflow, "workflow"],
    [actual.runId, expected.runId, "run ID"],
    [actual.runAttempt, expected.runAttempt, "run attempt"],
    [actual.controlSha, expected.controlSha, "control SHA"],
    [actual.startedAt, expected.startedAt, "start time"]
  ]) assertEqual(value, expectedValue,
    `release authorization current-run ${label}`);
}

function assertAuthorizedResolutionTime(authorization, resolvedAt) {
  for (const [floor, label] of [
    [authorization.verifiedAt, "authorization verification"],
    [authorization.authority.intent.authorizedAt, "durable intent"]
  ]) {
    if (Date.parse(resolvedAt) < Date.parse(floor)) {
      throw new Error(`The release resolution precedes its ${label}.`);
    }
  }
}

function assertIntentPrecedesRelease(authorization, attemptedAt) {
  const intent = authorization.authority.intent;
  for (const [floor, label] of [
    [intent.authorizedAt, "durable intent"],
    [intent.recoveryRun.startedAt, "intent recovery run"],
    [intent.foundation.temporalFloor.storeSealedAt, "store seal"],
    [intent.foundation.temporalFloor.previousOutcomeDeterminedAt,
      "intent predecessor"]
  ]) {
    if (floor !== null && Date.parse(attemptedAt) < Date.parse(floor)) {
      throw new Error(`The release attempt precedes its ${label}.`);
    }
  }
}

function deriveLeaseReleaseRoute(authority, leaseResult) {
  if (leaseResult === null) {
    return Object.freeze({
      route: "blocked",
      leaseObservation: "not-read",
      reason: "public-latest-not-source"
    });
  }
  if (leaseResult.outcome === "observed") {
    try {
      assertIntentPrecedesRelease(
        authority.authorization,
        leaseResult.lease.recordedAt
      );
    } catch {
      return Object.freeze({
        route: "blocked",
        leaseObservation: "released",
        reason: "released-before-intent"
      });
    }
    if (
      authority.pendingUnknownAttemptedAt !== null &&
      leaseResult.lease.recordedAt !== authority.pendingUnknownAttemptedAt
    ) {
      return Object.freeze({
        route: "blocked",
        leaseObservation: "released",
        reason: "released-at-foreign-time"
      });
    }
    return Object.freeze({
      route: "reconcile-released",
      leaseObservation: "released",
      reason: "exact-direct-successor"
    });
  }
  if (leaseResult.outcome === "rejected" && leaseResult.reason === "held") {
    if (authority.pendingUnknownAttemptedAt !== null) {
      return Object.freeze({
        route: "reconcile-pending",
        leaseObservation: "held",
        reason: "unknown-attempt-still-held"
      });
    }
    if (
      authority.previousOutcome === null &&
      authority.authorization.headTransition.mode !== "created-now"
    ) {
      return Object.freeze({
        route: "blocked",
        leaseObservation: "held",
        reason: "resumed-empty-chain"
      });
    }
    if (
      authority.previousOutcome === null ||
      authority.previousOutcome.leaseRelease.acknowledgement === "rejected" ||
      isRollbackSourceReadyForRelease(authority.previousOutcome)
    ) {
      return Object.freeze({
        route: "release-held",
        leaseObservation: "held",
        reason: "exact-held"
      });
    }
  }
  return Object.freeze({
    route: "blocked",
    leaseObservation: leaseResult.outcome === "indeterminate"
      ? "indeterminate"
      : "foreign",
    reason: leaseResult.outcome === "indeterminate"
      ? "lease-observation-indeterminate"
      : "lease-conflict"
  });
}

function isRollbackSourceReadyForRelease(outcome) {
  return outcome.leaseRelease.attempted === false &&
    outcome.mutation.kind === "rollback" &&
    outcome.observation.beforeMutation.classification === "target" &&
    outcome.observation.final.classification === "source";
}

function isConfirmedRollbackReadyForRelease(outcome) {
  return isRollbackSourceReadyForRelease(outcome) &&
    outcome.mutation.acknowledgement === "confirmed";
}

async function summarizeReleasedSuccessorObservation(input) {
  let output = null;
  if (input.result.outcome === "observed") {
    const written = await writeElectronProductionPublicLatestLease({
      lease: input.result.lease,
      outputPath: input.outputPath
    });
    output = written.leaseIdentity;
  }
  const unresolved = input.result.outcome !== "observed" &&
    input.preserveUnknownAcknowledgement;
  return assertElectronProductionPublicLatestLeaseRemoteOperationSummary({
    schemaVersion: 1,
    kind: "rion-electron-production-public-latest-lease-remote-operation",
    command: "observe-release",
    request: {
      attemptedAt: input.attemptedAt,
      held: {
        transactionId: input.heldLease.transactionId,
        leaseId: input.heldLease.leaseId,
        generation: input.heldLease.generation,
        revision: input.heldLease.revision,
        eventSha256:
          electronProductionPublicLatestLeaseEventSha256(input.heldLease),
        sourceStateSha256: input.heldLease.source.stateSha256,
        targetStateSha256: input.heldLease.target.stateSha256
      }
    },
    outcome: unresolved ? "indeterminate" : input.result.outcome,
    reason: unresolved
      ? "unknown-acknowledgement"
      : input.result.reason ?? null,
    httpStatus: input.result.status ?? null,
    remote: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
      ref: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
      path: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
      blobSha: input.result.blobSha ?? null
    },
    lease: input.result.lease === undefined
      ? null
      : {
          transactionId: input.result.lease.transactionId,
          leaseId: input.result.lease.leaseId,
          generation: input.result.lease.generation,
          revision: input.result.lease.revision,
          status: input.result.lease.status,
          eventSha256:
            electronProductionPublicLatestLeaseEventSha256(input.result.lease)
        },
    output
  });
}

function assertReleasedLeaseOutput(options) {
  const outputPath = requiredOption(options, "released-lease-output");
  if (path.basename(outputPath) !== ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE) {
    throw new Error("The released lease output filename is invalid.");
  }
  return outputPath;
}

async function readFoundation(options) {
  const [source, target] = await Promise.all([
    readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: requiredOption(options, "source-snapshot-sha256"),
      snapshotPath: requiredOption(options, "source-snapshot")
    }),
    readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: requiredOption(options, "target-snapshot-sha256"),
      snapshotPath: requiredOption(options, "target-snapshot")
    })
  ]);
  return Object.freeze({
    sourceSnapshot: source.snapshot,
    sourceSnapshotFileSha256: source.file.sha256,
    targetSnapshot: target.snapshot,
    targetSnapshotFileSha256: target.file.sha256
  });
}

function createSummary(input) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND,
    command: input.command,
    status: "recorded",
    outputs: {
      observation: input.observationOutput,
      rollback: input.rollbackOutput
    },
    evidence: {
      observation: input.observation,
      observationTransport: input.observationTransport,
      rollbackAcknowledgement: input.rollbackAcknowledgement
    }
  });
}

function createReleaseSummary(command, operation, operationOutput) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND,
    command,
    status: "recorded",
    outputs: {
      operation: operationOutput,
      releasedLease: operation.successor === null
        ? null
        : operation.remoteOperation.receipt.output
    },
    evidence: {
      acknowledgement: operation.acknowledgement
    }
  });
}

function createRouteSummary(input) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND,
    command: "route-lease-release",
    status: "recorded",
    outputs: { observation: input.observationOutput },
    evidence: {
      observation: input.observation.observation.classification,
      observationTransport: input.observation.transport.outcome,
      leaseObservation: input.decision.leaseObservation,
      route: input.decision.route,
      reason: input.decision.reason
    }
  });
}

async function reserveOutputSet(specifications) {
  const paths = await Promise.all(specifications.map((specification) =>
    resolveCreateNewFile(
      specification.path,
      specification.expectedName,
      specification.label
    )
  ));
  if (new Set(paths).size !== paths.length) {
    throw new Error("Recovery operation outputs must be distinct create-new files.");
  }
  const reservations = [];
  try {
    for (let index = 0; index < paths.length; index += 1) {
      const handle = await open(paths[index], "wx", 0o600);
      const identity = await handle.stat();
      reservations.push({
        committed: false,
        device: identity.dev,
        handle,
        inode: identity.ino,
        path: paths[index],
        specification: specifications[index]
      });
    }
  } catch (error) {
    await discardReservations(reservations);
    throw error;
  }
  return reservations;
}

async function discardReservations(reservations) {
  await Promise.all(reservations.map(async (reservation) => {
    if (reservation.committed) return;
    if (reservation.handle !== null) {
      await reservation.handle.close().catch(() => undefined);
      reservation.handle = null;
    }
    let current;
    try {
      current = await lstat(reservation.path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (
      current.dev === reservation.device &&
      current.ino === reservation.inode &&
      current.isFile()
    ) await rm(reservation.path, { force: false });
  }));
}

async function commitObservationReservation(reservation, receipt) {
  await commitReservation(
    reservation,
    serializeElectronProductionPublicLatestRecoveryObservation(receipt)
  );
  return readElectronProductionPublicLatestRecoveryObservation({
    expectedSha256:
      electronProductionPublicLatestRecoveryObservationSha256(receipt),
    receiptPath: reservation.path
  });
}

async function commitRollbackReservation(reservation, receipt) {
  await commitReservation(
    reservation,
    serializeElectronProductionPublicLatestRecoveryRollback(receipt)
  );
  return readElectronProductionPublicLatestRecoveryRollback({
    expectedSha256: electronProductionPublicLatestRecoveryRollbackSha256(receipt),
    receiptPath: reservation.path
  });
}

async function commitLeaseReleaseReservation(reservation, operation) {
  await commitReservation(
    reservation,
    serializeElectronProductionPublicLatestLeaseReleaseOperation(operation)
  );
  return readElectronProductionPublicLatestLeaseReleaseOperation({
    expectedSha256:
      electronProductionPublicLatestLeaseReleaseOperationSha256(operation),
    operationPath: reservation.path
  });
}

async function commitReservation(reservation, source) {
  try {
    await reservation.handle.writeFile(source);
    await reservation.handle.sync();
  } finally {
    await reservation.handle.close();
    reservation.handle = null;
  }
  reservation.committed = true;
}

async function emitSummary(summary, dependencies) {
  await dependencies.writeStdout(serializeCanonicalJson(summary));
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every public-latest recovery CLI option requires one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    if (!rawName.startsWith("--") || rawName.length === 2) {
      throw new Error(`Invalid public-latest recovery CLI option ${rawName}.`);
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate public-latest recovery CLI option --${name}.`);
    }
    options.set(name, argumentsList[index + 1]);
  }
  return options;
}

function assertAllowedAndRequiredOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  const optional = OPTIONAL_COMMAND_OPTIONS[command] ?? new Set();
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown ${command} option --${name}.`);
  }
  for (const name of allowed) {
    if (!optional.has(name)) requiredOption(options, name);
  }
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required public-latest recovery option --${name}.`);
  }
  return value;
}

function requiredToken(environment) {
  const token = environment.GH_TOKEN;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    /\s/u.test(token)
  ) throw new Error("The public-latest recovery GH_TOKEN is required.");
  return token;
}

function resolveDependencies(overrides) {
  for (const name of Object.keys(overrides)) {
    if (!["environment", "fetchImpl", "setExitCode", "writeStdout"].includes(name)) {
      throw new Error(`Unknown public-latest recovery CLI dependency ${name}.`);
    }
  }
  const environment = overrides.environment ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const setExitCode = overrides.setExitCode ?? ((code) => {
    process.exitCode = code;
  });
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  if (
    !environment || typeof environment !== "object" ||
    typeof fetchImpl !== "function" ||
    typeof setExitCode !== "function" ||
    typeof writeStdout !== "function"
  ) throw new Error("Public-latest recovery CLI dependencies are invalid.");
  return Object.freeze({ environment, fetchImpl, setExitCode, writeStdout });
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
  runElectronProductionPublicLatestRecoveryCli().catch((error) => {
    if (!(error instanceof ElectronProductionPublicLatestRecoveryCliFailure)) {
      process.stderr.write("Electron production public-latest recovery failed closed.\n");
    }
    process.exitCode = 1;
  });
}
