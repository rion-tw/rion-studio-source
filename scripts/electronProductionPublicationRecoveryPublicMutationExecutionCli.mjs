import { createHash } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  electronProductionPublicLatestLeaseEventSha256,
  readElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  createElectronProductionPublicLatestLeaseReleaseOperation,
  electronProductionPublicLatestLeaseReleaseOperationSha256
} from "./electronProductionPublicLatestLeaseReleaseOperation.mjs";
import {
  ElectronProductionPublicLatestLeaseRemoteCliFailure,
  runElectronProductionPublicLatestLeaseRemoteCli
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import {
  observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote
} from "./electronProductionPublicLatestLeaseRemote.mjs";
import {
  electronProductionPublicLatestRecoveryObservationSha256,
  electronProductionPublicLatestRecoveryRollbackSha256
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  ElectronProductionPublicLatestRollbackNotSubmittedError,
  observeElectronProductionPublicLatestRecoveryRemoteAtResult,
  rollbackElectronProductionPublicLatestRecoveryRemoteAtResult
} from "./electronProductionPublicLatestRecoveryRemote.mjs";
import {
  readElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE,
  assertElectronProductionPublicationRecoveryPublicMutationAuthorizationBindings,
  assertElectronProductionPublicationRecoveryPublicMutationOperationBindings,
  createElectronProductionPublicationRecoveryPublicMutationOperation,
  electronProductionPublicationRecoveryPublicMutationOperationSha256,
  readElectronProductionPublicationRecoveryPublicMutationOperation,
  serializeElectronProductionPublicationRecoveryPublicMutationOperation
} from "./electronProductionPublicationRecoveryPublicMutationOperation.mjs";
import {
  readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_EXECUTION_CLI_SUMMARY_KIND =
  "rion-electron-production-publication-recovery-public-mutation-execution-cli-summary";

const CURRENT_RUN_OPTIONS = [
  "current-control-sha",
  "current-run-attempt",
  "current-run-id",
  "current-run-repository",
  "current-run-started-at",
  "current-run-workflow"
];
const FOUNDATION_OPTIONS = [
  "authorization",
  "authorization-sha256",
  "held-lease",
  "held-lease-sha256",
  "source-snapshot",
  "source-snapshot-sha256",
  "target-snapshot",
  "target-snapshot-sha256"
];
const COMMAND_OPTIONS = Object.freeze({
  execute: new Set([
    ...CURRENT_RUN_OPTIONS,
    ...FOUNDATION_OPTIONS,
    "output",
    "released-lease-output"
  ]),
  verify: new Set([
    ...CURRENT_RUN_OPTIONS,
    ...FOUNDATION_OPTIONS,
    "operation",
    "operation-sha256"
  ])
});
const REQUIRED_OPTIONS = Object.freeze({
  execute: new Set([
    ...CURRENT_RUN_OPTIONS,
    ...FOUNDATION_OPTIONS,
    "output"
  ]),
  verify: COMMAND_OPTIONS.verify
});

export class ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure
  extends Error {
  constructor(summary) {
    super("The marker-bound public mutation did not reach a confirmed safe state.");
    this.name =
      "ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure";
    this.summary = summary;
  }
}

export async function runElectronProductionPublicationRecoveryPublicMutationExecutionCli(
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
      "Usage: electronProductionPublicationRecoveryPublicMutationExecutionCli.mjs " +
      "<execute|verify> [strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertOptions(command, options);
  const context = await readContext(options);
  assertCurrentRun(options, context.authorization.currentRun);
  const summary = command === "verify"
    ? await verifyOperation(options, context)
    : await executeOperation(options, context, dependencies);
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  if (command === "execute" && !isSuccessful(summary)) {
    dependencies.setExitCode(1);
    throw new ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure(
      summary
    );
  }
  return summary;
}

async function readContext(options) {
  const [authorizationFile, heldFile, sourceFile, targetFile] =
    await Promise.all([
      readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
        expectedSha256: requiredOption(options, "authorization-sha256"),
        receiptPath: requiredOption(options, "authorization")
      }),
      readElectronProductionPublicLatestLease({
        expectedSha256: requiredOption(options, "held-lease-sha256"),
        leasePath: requiredOption(options, "held-lease")
      }),
      readElectronProductionPublicLatestSnapshot({
        expectedFileSha256: requiredOption(options, "source-snapshot-sha256"),
        snapshotPath: requiredOption(options, "source-snapshot")
      }),
      readElectronProductionPublicLatestSnapshot({
        expectedFileSha256: requiredOption(options, "target-snapshot-sha256"),
        snapshotPath: requiredOption(options, "target-snapshot")
      })
    ]);
  const bindingInput = {
    authorization: authorizationFile.value,
    authorizationSha256: authorizationFile.valueIdentity.sha256,
    heldLease: heldFile.lease,
    heldLeaseFileSha256: heldFile.leaseIdentity.sha256,
    sourceSnapshot: sourceFile.snapshot,
    sourceSnapshotFileSha256: sourceFile.file.sha256,
    targetSnapshot: targetFile.snapshot,
    targetSnapshotFileSha256: targetFile.file.sha256
  };
  const authorization =
    assertElectronProductionPublicationRecoveryPublicMutationAuthorizationBindings(
      bindingInput
    );
  return Object.freeze({
    ...bindingInput,
    authorization,
    authorizationSha256: authorizationFile.valueIdentity.sha256,
    heldLeasePath: heldFile.leasePath
  });
}

async function executeOperation(options, context, dependencies) {
  assertExecutionOptions(options, context.authorization);
  const reservation = await reserveOperationOutput(
    requiredOption(options, "output")
  );
  let operation;
  try {
    const token = requiredToken(dependencies.environment);
    operation = context.authorization.headTransition.mode === "resumed-existing"
      ? await reconcileMarker(context, token, dependencies)
      : context.authorization.operation === "rollback-public-latest"
        ? await executeRollback(context, token, dependencies)
        : await executeRelease(context, options, token, dependencies);
    assertElectronProductionPublicationRecoveryPublicMutationOperationBindings({
      ...foundationBinding(context),
      operation
    });
    const written = await commitOperationReservation(reservation, operation);
    return createSummary("execute", written.value, written.valueIdentity);
  } catch (error) {
    await discardOperationReservation(reservation);
    throw error;
  }
}

async function executeRollback(
  context,
  token,
  dependencies
) {
  try {
    const result = await dependencies.rollbackRecovery({
      fetchImpl: dependencies.fetchImpl,
      heldLease: context.heldLease,
      preObservation:
        context.authorization.authority.attempt.publicMutation.observation.receipt,
      preObservationSha256:
        context.authorization.authority.attempt.publicMutation.observation.sha256,
      recordTime: dependencies.clock,
      sourceSnapshot: context.sourceSnapshot,
      sourceSnapshotFileSha256: context.sourceSnapshotFileSha256,
      submissionNotBefore: context.authorization.verifiedAt,
      targetSnapshot: context.targetSnapshot,
      targetSnapshotFileSha256: context.targetSnapshotFileSha256,
      token
    });
    const resolvedAt = recordExecutionTime(
      dependencies.clock,
      result.finalObservation.observedAt,
      "rollback operation resolution"
    );
    return createOperation(context, {
      beforeObservation: result.preObservation,
      finalObservation: result.finalObservation,
      mode: "actual-transport",
      resolvedAt,
      successor: null,
      transportOperation: result.rollback,
      transportOperationSha256:
        electronProductionPublicLatestRecoveryRollbackSha256(result.rollback)
    });
  } catch (error) {
    if (!(error instanceof ElectronProductionPublicLatestRollbackNotSubmittedError)) {
      throw error;
    }
    const finalObservation = await observePublicLatest(
      context,
      token,
      dependencies
    );
    const resolvedAt = recordExecutionTime(
      dependencies.clock,
      finalObservation.observedAt,
      "rejected rollback resolution"
    );
    return createOperation(context, {
      beforeObservation:
        context.authorization.authority.attempt.publicMutation.observation.receipt,
      finalObservation,
      mode: "precondition-rejected",
      resolvedAt,
      successor: null,
      transportOperation: null,
      transportOperationSha256: null
    });
  }
}

async function executeRelease(
  context,
  options,
  token,
  dependencies
) {
  const beforeObservation = await observePublicLatest(
    context,
    token,
    dependencies
  );
  if (beforeObservation.transport.outcome !== "observed" ||
      beforeObservation.observation.classification !== "source") {
    const resolvedAt = recordExecutionTime(
      dependencies.clock,
      beforeObservation.observedAt,
      "rejected lease-release resolution"
    );
    return createOperation(context, {
      beforeObservation:
        context.authorization.authority.attempt.publicMutation.observation.receipt,
      finalObservation: beforeObservation,
      mode: "precondition-rejected",
      resolvedAt,
      successor: null,
      transportOperation: null,
      transportOperationSha256: null
    });
  }
  const releasedLeaseOutput = await resolveCreateNewFile(
    requiredOption(options, "released-lease-output"),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "marker-bound released lease output"
  );
  const attemptedAt = recordExecutionTime(
    dependencies.clock,
    laterTime(
      beforeObservation.observedAt,
      context.authorization.verifiedAt
    ),
    "lease-release submission"
  );
  let remoteOperation;
  try {
    remoteOperation = await dependencies.runLeaseRemote([
      "release",
      "--held-lease", context.heldLeasePath,
      "--held-lease-sha256", context.heldLeaseFileSha256,
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
  const transportOperation =
    createElectronProductionPublicLatestLeaseReleaseOperation({
      heldLease: context.heldLease,
      preReleaseObservation: beforeObservation,
      recoveryOperation: {
        kind: "rion-electron-production-public-latest-recovery-observation",
        sha256:
          electronProductionPublicLatestRecoveryObservationSha256(
            beforeObservation
          )
      },
      remoteOperation,
      resolvedAt: attemptedAt
    });
  const resolvedAt = recordExecutionTime(
    dependencies.clock,
    attemptedAt,
    "lease-release operation resolution"
  );
  return createOperation(context, {
    beforeObservation,
    finalObservation: beforeObservation,
    mode: "actual-transport",
    resolvedAt,
    successor: null,
    transportOperation,
    transportOperationSha256:
      electronProductionPublicLatestLeaseReleaseOperationSha256(
        transportOperation
      )
  });
}

async function reconcileMarker(context, token, dependencies) {
  const finalObservation = await observePublicLatest(
    context,
    token,
    dependencies
  );
  let successor = null;
  if (context.authorization.operation === "release-held-lease") {
    const observed = await dependencies.observeLeaseSuccessor({
      expected: context.heldLease,
      fetchImpl: dependencies.fetchImpl,
      token
    });
    if (observed.outcome === "observed" &&
        Date.parse(observed.lease.recordedAt) >= Date.parse(
          context.authorization.authority.attempt.reservedAt
        )) {
      const source = serializeElectronProductionPublicLatestLease(observed.lease);
      successor = Object.freeze({
        lease: observed.lease,
        eventSha256:
          electronProductionPublicLatestLeaseEventSha256(observed.lease),
        bytes: observed.bytes,
        fileSha256: createHash("sha256").update(source).digest("hex"),
        blobSha: observed.blobSha
      });
    }
  }
  const resolvedAt = recordExecutionTime(
    dependencies.clock,
    finalObservation.observedAt,
    "marker reconciliation resolution"
  );
  return createOperation(context, {
    beforeObservation:
      context.authorization.authority.attempt.publicMutation.observation.receipt,
    finalObservation,
    mode: "marker-reconciliation",
    resolvedAt,
    successor,
    transportOperation: null,
    transportOperationSha256: null
  });
}

function createOperation(context, input) {
  return createElectronProductionPublicationRecoveryPublicMutationOperation({
    authorization: context.authorization,
    authorizationSha256: context.authorizationSha256,
    beforeObservation: input.beforeObservation,
    beforeObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(
        input.beforeObservation
      ),
    finalObservation: input.finalObservation,
    finalObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(
        input.finalObservation
      ),
    heldLease: context.heldLease,
    heldLeaseFileSha256: context.heldLeaseFileSha256,
    mode: input.mode,
    resolvedAt: input.resolvedAt,
    sourceSnapshot: context.sourceSnapshot,
    sourceSnapshotFileSha256: context.sourceSnapshotFileSha256,
    successor: input.successor,
    targetSnapshot: context.targetSnapshot,
    targetSnapshotFileSha256: context.targetSnapshotFileSha256,
    transportOperation: input.transportOperation,
    transportOperationSha256: input.transportOperationSha256
  });
}

async function observePublicLatest(context, token, dependencies) {
  return dependencies.observeRecovery({
    fetchImpl: dependencies.fetchImpl,
    recordObservedAt: dependencies.clock,
    sourceSnapshot: context.sourceSnapshot,
    sourceSnapshotFileSha256: context.sourceSnapshotFileSha256,
    targetSnapshot: context.targetSnapshot,
    targetSnapshotFileSha256: context.targetSnapshotFileSha256,
    token
  });
}

async function verifyOperation(options, context) {
  const file =
    await readElectronProductionPublicationRecoveryPublicMutationOperation({
      expectedSha256: requiredOption(options, "operation-sha256"),
      receiptPath: requiredOption(options, "operation")
    });
  assertElectronProductionPublicationRecoveryPublicMutationOperationBindings({
    ...foundationBinding(context),
    operation: file.value
  });
  return createSummary("verify", file.value, file.valueIdentity);
}

function foundationBinding(context) {
  return {
    authorization: context.authorization,
    authorizationSha256: context.authorizationSha256,
    heldLease: context.heldLease,
    heldLeaseFileSha256: context.heldLeaseFileSha256,
    sourceSnapshot: context.sourceSnapshot,
    sourceSnapshotFileSha256: context.sourceSnapshotFileSha256,
    targetSnapshot: context.targetSnapshot,
    targetSnapshotFileSha256: context.targetSnapshotFileSha256
  };
}

function assertExecutionOptions(options, authorization) {
  if (authorization.headTransition.mode === "resumed-existing") {
    assertAbsentOptions(options, ["released-lease-output"]);
    return;
  }
  if (authorization.operation === "rollback-public-latest") {
    assertAbsentOptions(options, ["released-lease-output"]);
    return;
  }
  requiredOption(options, "released-lease-output");
}

function assertCurrentRun(options, expected) {
  const runAttempt = requiredOption(options, "current-run-attempt");
  if (!/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error("The current public-mutation run attempt is invalid.");
  }
  const actual = {
    repository: requiredOption(options, "current-run-repository"),
    workflow: requiredOption(options, "current-run-workflow"),
    runId: requiredOption(options, "current-run-id"),
    runAttempt: Number(runAttempt),
    controlSha: requiredOption(options, "current-control-sha"),
    startedAt: requiredOption(options, "current-run-started-at")
  };
  if (!serializeCanonicalJson(actual).equals(serializeCanonicalJson(expected))) {
    throw new Error(
      "The current public-mutation run does not match its authorization."
    );
  }
}

function assertAbsentOptions(options, names) {
  for (const name of names) {
    if (options.has(name)) {
      throw new Error(`The --${name} option is invalid for this marker mode.`);
    }
  }
}

function createSummary(command, operation, identity) {
  return Object.freeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_EXECUTION_CLI_SUMMARY_KIND,
    command,
    status: command === "execute" ? "recorded" : "verified",
    operation: operation.operation,
    mode: operation.mode,
    finalObservation: operation.final.receipt.observation.classification,
    acknowledgement: operation.operation === "rollback-public-latest"
      ? operation.result.mutation.acknowledgement
      : operation.result.leaseRelease.acknowledgement,
    output: identity
  });
}

function isSuccessful(summary) {
  return summary.mode === "actual-transport"
    ? summary.acknowledgement === "confirmed" &&
        summary.finalObservation === "source"
    : summary.mode === "marker-reconciliation" &&
        summary.operation === "release-held-lease" &&
        summary.acknowledgement === "confirmed" &&
        summary.finalObservation === "source";
}

async function reserveOperationOutput(value) {
  const outputPath = await resolveCreateNewFile(
    value,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE,
    "marker-bound public-mutation operation output"
  );
  const handle = await open(outputPath, "wx", 0o600);
  const metadata = await handle.stat({ bigint: true });
  return {
    committed: false,
    device: metadata.dev,
    handle,
    inode: metadata.ino,
    path: outputPath
  };
}

async function commitOperationReservation(reservation, operation) {
  await assertReservationPath(reservation);
  const source =
    serializeElectronProductionPublicationRecoveryPublicMutationOperation(
      operation
    );
  try {
    await reservation.handle.writeFile(source);
    await reservation.handle.sync();
  } finally {
    await reservation.handle.close();
    reservation.handle = null;
  }
  await assertReservationPath(reservation);
  reservation.committed = true;
  return readElectronProductionPublicationRecoveryPublicMutationOperation({
    expectedSha256:
      electronProductionPublicationRecoveryPublicMutationOperationSha256(
        operation
      ),
    receiptPath: reservation.path
  });
}

async function discardOperationReservation(reservation) {
  if (reservation.committed) return;
  if (reservation.handle !== null) {
    await reservation.handle.close().catch(() => undefined);
    reservation.handle = null;
  }
  let current;
  try {
    current = await lstat(reservation.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (sameReservation(reservation, current)) {
    await rm(reservation.path, { force: false });
  }
}

async function assertReservationPath(reservation) {
  const current = await lstat(reservation.path, { bigint: true });
  if (!sameReservation(reservation, current)) {
    throw new Error("The marker-bound operation output identity changed.");
  }
}

function sameReservation(reservation, current) {
  return current.isFile() && current.nlink === 1n &&
    current.dev === reservation.device && current.ino === reservation.inode;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every public-mutation execution option requires one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    if (!rawName.startsWith("--") || rawName.length === 2) {
      throw new Error(`Invalid public-mutation execution option ${rawName}.`);
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate public-mutation execution option --${name}.`);
    }
    options.set(name, argumentsList[index + 1]);
  }
  return options;
}

function assertOptions(command, options) {
  for (const name of options.keys()) {
    if (!COMMAND_OPTIONS[command].has(name)) {
      throw new Error(`Unknown ${command} option --${name}.`);
    }
  }
  for (const name of REQUIRED_OPTIONS[command]) requiredOption(options, name);
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The --${name} option is required.`);
  }
  return value;
}

function requiredToken(environment) {
  const token = environment.GH_TOKEN;
  if (typeof token !== "string" || token.length === 0 ||
      token.length > 4096 || /\s/u.test(token)) {
    throw new Error("The marker-bound public mutation GH_TOKEN is required.");
  }
  return token;
}

function recordExecutionTime(clock, floor, label) {
  const value = clock();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      Date.parse(value) < Date.parse(floor)) {
    throw new Error(`The ${label} is invalid or precedes its event floor.`);
  }
  return value;
}

function laterTime(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function resolveDependencies(overrides) {
  const allowed = new Set([
    "environment",
    "fetchImpl",
    "clock",
    "observeLeaseSuccessor",
    "observeRecovery",
    "rollbackRecovery",
    "runLeaseRemote",
    "setExitCode",
    "writeStdout"
  ]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown public-mutation execution dependency ${name}.`);
    }
  }
  const dependencies = {
    clock: overrides.clock ?? (() => new Date().toISOString()),
    environment: overrides.environment ?? process.env,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    observeLeaseSuccessor: overrides.observeLeaseSuccessor ??
      observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote,
    observeRecovery: overrides.observeRecovery ??
      observeElectronProductionPublicLatestRecoveryRemoteAtResult,
    rollbackRecovery: overrides.rollbackRecovery ??
      rollbackElectronProductionPublicLatestRecoveryRemoteAtResult,
    runLeaseRemote: overrides.runLeaseRemote ??
      runElectronProductionPublicLatestLeaseRemoteCli,
    setExitCode: overrides.setExitCode ?? ((code) => {
      process.exitCode = code;
    }),
    writeStdout: overrides.writeStdout ?? ((source) => {
      process.stdout.write(source);
    })
  };
  for (const [name, value] of Object.entries(dependencies)) {
    if ((name === "environment" && (!value || typeof value !== "object")) ||
        (name !== "environment" && typeof value !== "function")) {
      throw new Error("Public-mutation execution dependencies are invalid.");
    }
  }
  return Object.freeze(dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runElectronProductionPublicationRecoveryPublicMutationExecutionCli()
    .catch((error) => {
      if (!(error instanceof
          ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure)) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}
