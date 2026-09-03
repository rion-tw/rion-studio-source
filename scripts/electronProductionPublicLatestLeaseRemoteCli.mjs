import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS,
  electronProductionPublicLatestLeaseEventSha256,
  readElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
  acquireElectronProductionPublicLatestLeaseRemote,
  observeElectronProductionPublicLatestLeaseRemote,
  observeElectronProductionPublicLatestLeaseReleasedRemote,
  releaseElectronProductionPublicLatestLeaseRemote
} from "./electronProductionPublicLatestLeaseRemote.mjs";
import {
  assertEqual,
  assertExactKeys,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND =
  "rion-electron-production-public-latest-lease-remote-operation";

const COMMAND_OPTIONS = Object.freeze({
  acquire: new Set([
    "control-head-sha",
    "holder-run-attempt",
    "holder-run-id",
    "holder-workflow",
    "lease-id",
    "output",
    "purpose",
    "recorded-at",
    "source-runtime",
    "source-state-sha256",
    "source-version",
    "target-runtime",
    "target-state-sha256",
    "target-version",
    "transaction-id"
  ]),
  observe: new Set([
    "held-lease",
    "held-lease-sha256",
    "output"
  ]),
  "observe-release": new Set([
    "held-lease",
    "held-lease-sha256",
    "output",
    "recorded-at"
  ]),
  release: new Set([
    "held-lease",
    "held-lease-sha256",
    "output",
    "recorded-at"
  ])
});

export class ElectronProductionPublicLatestLeaseRemoteCliFailure extends Error {
  constructor(summary) {
    super(`Remote public-latest lease ${summary.outcome}: ${summary.reason}.`);
    this.name = "ElectronProductionPublicLatestLeaseRemoteCliFailure";
    this.summary = summary;
  }
}

export async function runElectronProductionPublicLatestLeaseRemoteCli(
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
      "Usage: electronProductionPublicLatestLeaseRemoteCli.mjs " +
      "<acquire|observe|observe-release|release> [strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  const outputPath = await resolveCreateNewFile(
    requiredOption(options, "output"),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "remote public-latest lease CLI output"
  );
  const token = requiredToken(dependencies.environment);
  let result;
  let request = null;
  if (command === "acquire") {
    const acquisition = acquisitionInput(options);
    request = acquisitionRequestIdentity(acquisition);
    result = await acquireElectronProductionPublicLatestLeaseRemote({
      acquisition,
      fetchImpl: dependencies.fetchImpl,
      token
    });
  } else {
    const held = (await readElectronProductionPublicLatestLease({
      expectedSha256: requiredOption(options, "held-lease-sha256"),
      leasePath: requiredOption(options, "held-lease")
    })).lease;
    if (command === "release" || command === "observe-release") {
      request = releaseRequestIdentity(
        held,
        requiredOption(options, "recorded-at")
      );
    }
    result = command === "observe"
      ? await observeElectronProductionPublicLatestLeaseRemote({
        expected: held,
        fetchImpl: dependencies.fetchImpl,
        token
      })
      : command === "observe-release"
        ? await observeElectronProductionPublicLatestLeaseReleasedRemote({
          expected: held,
          fetchImpl: dependencies.fetchImpl,
          release: releaseRequest(held, request.attemptedAt),
          token
        })
        : await releaseElectronProductionPublicLatestLeaseRemote({
        expected: held,
        fetchImpl: dependencies.fetchImpl,
        release: releaseRequest(held, request.attemptedAt),
        token
      });
  }
  return finishOperation(command, outputPath, result, request, dependencies);
}

function acquisitionInput(options) {
  return {
    transactionId: requiredOption(options, "transaction-id"),
    leaseId: requiredOption(options, "lease-id"),
    purpose: requiredOption(options, "purpose"),
    holder: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
      workflow: requiredOption(options, "holder-workflow"),
      runId: requiredOption(options, "holder-run-id"),
      runAttempt: positiveIntegerOption(options, "holder-run-attempt"),
      headSha: requiredOption(options, "control-head-sha")
    },
    source: {
      runtime: requiredOption(options, "source-runtime"),
      version: requiredOption(options, "source-version"),
      stateSha256: requiredOption(options, "source-state-sha256")
    },
    target: {
      runtime: requiredOption(options, "target-runtime"),
      version: requiredOption(options, "target-version"),
      stateSha256: requiredOption(options, "target-state-sha256")
    },
    recordedAt: requiredOption(options, "recorded-at")
  };
}

function releaseRequestIdentity(held, attemptedAt) {
  return deepFreeze({
    attemptedAt,
    held: {
      transactionId: held.transactionId,
      leaseId: held.leaseId,
      generation: held.generation,
      revision: held.revision,
      eventSha256: electronProductionPublicLatestLeaseEventSha256(held),
      sourceStateSha256: held.source.stateSha256,
      targetStateSha256: held.target.stateSha256
    }
  });
}

function acquisitionRequestIdentity(acquisition) {
  return deepFreeze({
    expectedHeld: {
      transactionId: acquisition.transactionId,
      leaseId: acquisition.leaseId,
      purpose: acquisition.purpose,
      holder: acquisition.holder,
      source: acquisition.source,
      target: acquisition.target,
      recordedAt: acquisition.recordedAt
    }
  });
}

function releaseRequest(held, attemptedAt) {
  return {
    transactionId: held.transactionId,
    leaseId: held.leaseId,
    generation: held.generation,
    sourceStateSha256: held.source.stateSha256,
    targetStateSha256: held.target.stateSha256,
    recordedAt: attemptedAt
  };
}

async function finishOperation(command, outputPath, result, request, dependencies) {
  if (result.outcome === "rejected" || result.outcome === "indeterminate") {
    return failOperation(
      operationSummary(command, request, result, null),
      dependencies
    );
  }
  let written;
  try {
    written = await writeElectronProductionPublicLatestLease({
      lease: result.lease,
      outputPath
    });
  } catch {
    const localFailure = {
      outcome: "indeterminate",
      reason: "local-output-failed",
      status: null,
      blobSha: result.blobSha,
      lease: result.lease
    };
    return failOperation(
      operationSummary(command, request, localFailure, null),
      dependencies
    );
  }
  const summary = operationSummary(
    command,
    request,
    result,
    written.leaseIdentity
  );
  await emitSummary(summary, dependencies);
  return summary;
}

async function failOperation(summary, dependencies) {
  try {
    await emitSummary(summary, dependencies);
  } finally {
    dependencies.setExitCode(1);
  }
  throw new ElectronProductionPublicLatestLeaseRemoteCliFailure(summary);
}

function operationSummary(command, request, result, output) {
  const hasLease = result.lease !== undefined;
  return assertElectronProductionPublicLatestLeaseRemoteOperationSummary({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
    command,
    request,
    outcome: result.outcome,
    reason: result.reason ?? null,
    httpStatus: result.status ?? null,
    remote: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
      ref: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
      path: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
      blobSha: result.blobSha ?? null
    },
    lease: hasLease
      ? {
        transactionId: result.lease.transactionId,
        leaseId: result.lease.leaseId,
        generation: result.lease.generation,
        revision: result.lease.revision,
        status: result.lease.status,
        eventSha256: electronProductionPublicLatestLeaseEventSha256(result.lease)
      }
      : null,
    output: output === null
      ? null
      : {
        bytes: output.bytes,
        fileName: output.fileName,
        sha256: output.sha256
      }
  });
}

export function assertElectronProductionPublicLatestLeaseRemoteOperationSummary(
  value
) {
  assertExactKeys(value, [
    "command",
    "httpStatus",
    "kind",
    "lease",
    "outcome",
    "output",
    "reason",
    "remote",
    "request",
    "schemaVersion"
  ], "remote public-latest lease operation");
  assertEqual(value.schemaVersion, 1,
    "remote public-latest lease operation schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
    "remote public-latest lease operation kind");
  const commands = new Set(["acquire", "observe", "observe-release", "release"]);
  if (!commands.has(value.command)) {
    throw new Error("The remote public-latest lease command is invalid.");
  }
  const outcomes = new Set(["applied", "observed", "rejected", "indeterminate"]);
  if (!outcomes.has(value.outcome)) {
    throw new Error("The remote public-latest lease outcome is invalid.");
  }
  const request = assertOperationRequest(value.request, value.command);
  const remote = assertRemoteIdentity(value.remote);
  const lease = value.lease === null ? null : assertLeaseIdentity(value.lease);
  const output = value.output === null ? null : assertOutputIdentity(value.output);
  const reason = assertOperationReason(value.reason, value.outcome);
  const httpStatus = optionalHttpStatus(value.httpStatus);
  assertOperationCoherence({
    command: value.command,
    lease,
    outcome: value.outcome,
    output,
    request
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
    command: value.command,
    request,
    outcome: value.outcome,
    reason,
    httpStatus,
    remote,
    lease,
    output
  });
}

function assertOperationRequest(value, command) {
  if (command === "acquire") return assertAcquisitionRequest(value);
  if (command !== "release" && command !== "observe-release") {
    assertEqual(value, null, "non-release remote lease operation request");
    return null;
  }
  assertExactKeys(value, ["attemptedAt", "held"],
    "remote lease release operation request");
  assertExactKeys(value.held, [
    "eventSha256",
    "generation",
    "leaseId",
    "revision",
    "sourceStateSha256",
    "targetStateSha256",
    "transactionId"
  ], "remote lease release held identity");
  return {
    attemptedAt: requiredRfc3339(
      value.attemptedAt,
      "remote lease release attempt time"
    ),
    held: {
      transactionId: requiredUuid(
        value.held.transactionId,
        "remote lease release transaction ID"
      ),
      leaseId: requiredUuid(value.held.leaseId, "remote lease release lease ID"),
      generation: requiredPositiveInteger(
        value.held.generation,
        "remote lease release generation"
      ),
      revision: requiredPositiveInteger(
        value.held.revision,
        "remote lease release held revision"
      ),
      eventSha256: requiredDigest(
        value.held.eventSha256,
        "remote lease release held event SHA-256"
      ),
      sourceStateSha256: requiredDigest(
        value.held.sourceStateSha256,
        "remote lease release source state SHA-256"
      ),
      targetStateSha256: requiredDigest(
        value.held.targetStateSha256,
        "remote lease release target state SHA-256"
      )
    }
  };
}

function assertAcquisitionRequest(value) {
  assertExactKeys(value, ["expectedHeld"],
    "remote lease acquisition operation request");
  const held = value.expectedHeld;
  assertExactKeys(held, [
    "holder",
    "leaseId",
    "purpose",
    "recordedAt",
    "source",
    "target",
    "transactionId"
  ], "remote lease requested held identity");
  const purposes = new Set(Object.keys(
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS
  ));
  if (!purposes.has(held.purpose)) {
    throw new Error("The remote lease acquisition purpose is invalid.");
  }
  assertExactKeys(held.holder, [
    "headSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "remote lease acquisition holder");
  assertEqual(held.holder.repository,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
    "remote lease acquisition holder repository");
  assertEqual(
    held.holder.workflow,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[held.purpose],
    "remote lease acquisition holder workflow"
  );
  assertExactKeys(held.source, ["runtime", "stateSha256", "version"],
    "remote lease acquisition source");
  assertExactKeys(held.target, ["runtime", "stateSha256", "version"],
    "remote lease acquisition target");
  return {
    expectedHeld: {
      transactionId: requiredUuid(
        held.transactionId,
        "remote lease acquisition transaction ID"
      ),
      leaseId: requiredUuid(held.leaseId, "remote lease acquisition lease ID"),
      purpose: held.purpose,
      holder: {
        repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
        workflow: held.holder.workflow,
        runId: requiredDecimalIdentifier(
          held.holder.runId,
          "remote lease acquisition run ID"
        ),
        runAttempt: requiredPositiveInteger(
          held.holder.runAttempt,
          "remote lease acquisition run attempt"
        ),
        headSha: requiredCommitSha(
          held.holder.headSha,
          "remote lease acquisition head SHA"
        )
      },
      source: assertRequestedState(held.source, "source"),
      target: assertRequestedState(held.target, "target"),
      recordedAt: requiredRfc3339(
        held.recordedAt,
        "remote lease acquisition time"
      )
    }
  };
}

function assertRequestedState(value, label) {
  if (value.runtime !== "tauri-v22" && value.runtime !== "electron-v23") {
    throw new Error(`The remote lease acquisition ${label} runtime is invalid.`);
  }
  return {
    runtime: value.runtime,
    version: requiredSemanticVersion(
      value.version,
      `remote lease acquisition ${label} version`
    ),
    stateSha256: requiredDigest(
      value.stateSha256,
      `remote lease acquisition ${label} state SHA-256`
    )
  };
}

function requiredDecimalIdentifier(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function assertRemoteIdentity(value) {
  assertExactKeys(value, ["blobSha", "path", "ref", "repository"],
    "remote public-latest lease identity");
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
    "remote public-latest lease repository");
  assertEqual(value.ref, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
    "remote public-latest lease ref");
  assertEqual(value.path, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
    "remote public-latest lease path");
  return {
    repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
    ref: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
    path: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
    blobSha: value.blobSha === null
      ? null
      : requiredCommitSha(value.blobSha, "remote public-latest lease blob SHA")
  };
}

function assertLeaseIdentity(value) {
  assertExactKeys(value, [
    "eventSha256",
    "generation",
    "leaseId",
    "revision",
    "status",
    "transactionId"
  ], "remote public-latest lease result identity");
  if (value.status !== "held" && value.status !== "released") {
    throw new Error("The remote public-latest lease result status is invalid.");
  }
  return {
    transactionId: requiredUuid(value.transactionId,
      "remote public-latest lease result transaction ID"),
    leaseId: requiredUuid(value.leaseId,
      "remote public-latest lease result lease ID"),
    generation: requiredPositiveInteger(value.generation,
      "remote public-latest lease result generation"),
    revision: requiredPositiveInteger(value.revision,
      "remote public-latest lease result revision"),
    status: value.status,
    eventSha256: requiredDigest(value.eventSha256,
      "remote public-latest lease result event SHA-256")
  };
}

function assertOutputIdentity(value) {
  assertExactKeys(value, ["bytes", "fileName", "sha256"],
    "remote public-latest lease output identity");
  assertEqual(value.fileName, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "remote public-latest lease output filename");
  return {
    bytes: requiredPositiveInteger(value.bytes,
      "remote public-latest lease output bytes"),
    fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    sha256: requiredDigest(value.sha256,
      "remote public-latest lease output SHA-256")
  };
}

function assertOperationReason(value, outcome) {
  if (outcome === "applied" || outcome === "observed") {
    assertEqual(value, null, "successful remote lease operation reason");
    return null;
  }
  const reasons = new Set([
    "conflict",
    "github-rejected",
    "held",
    "local-output-failed",
    "malformed-record",
    "server-error",
    "transport",
    "unauthoritative-absence",
    "unexpected-response",
    "unknown-acknowledgement",
    "verification-failed"
  ]);
  if (typeof value !== "string" || !reasons.has(value)) {
    throw new Error("The remote public-latest lease operation reason is invalid.");
  }
  return value;
}

function optionalHttpStatus(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("The remote public-latest lease HTTP status is invalid.");
  }
  return value;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)
  ) throw new Error(`The ${label} is invalid.`);
  return value;
}

function assertOperationCoherence(input) {
  if (input.command === "release" && input.outcome === "applied") {
    if (
      input.lease?.status !== "released" || input.output === null ||
      input.lease.transactionId !== input.request.held.transactionId ||
      input.lease.leaseId !== input.request.held.leaseId ||
      input.lease.generation !== input.request.held.generation ||
      input.lease.revision !== input.request.held.revision + 1
    ) throw new Error("The applied remote lease release successor is invalid.");
  }
  if (input.command === "observe-release" && input.outcome === "observed") {
    if (
      input.lease?.status !== "released" || input.output === null ||
      input.lease.transactionId !== input.request.held.transactionId ||
      input.lease.leaseId !== input.request.held.leaseId ||
      input.lease.generation !== input.request.held.generation ||
      input.lease.revision !== input.request.held.revision + 1
    ) throw new Error("The observed remote lease release successor is invalid.");
  }
  if (
    (input.outcome === "applied" || input.outcome === "observed") &&
    (input.lease === null || input.output === null)
  ) throw new Error("A successful remote lease operation requires local evidence.");
  if (
    (input.outcome === "rejected" || input.outcome === "indeterminate") &&
    input.output !== null
  ) throw new Error("A failed remote lease operation cannot claim local output.");
}

async function emitSummary(summary, dependencies) {
  await dependencies.writeStdout(serializeCanonicalJson(summary));
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every remote lease CLI option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid remote lease CLI option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty remote lease CLI option --${key}.`);
    }
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

function positiveIntegerOption(options, name) {
  const value = requiredOption(options, name);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return requiredPositiveInteger(Number(value), name);
}

function requiredToken(environment) {
  const token = environment.GH_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GH_TOKEN is required for the remote public-latest lease CLI.");
  }
  return token;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Remote lease CLI dependencies must be an object.");
  }
  const allowed = new Set(["environment", "fetchImpl", "setExitCode", "writeStdout"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown remote lease CLI dependency ${name}.`);
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
  if (!environment || typeof environment !== "object" ||
      typeof fetchImpl !== "function" || typeof setExitCode !== "function" ||
      typeof writeStdout !== "function") {
    throw new Error("Remote lease CLI dependencies are invalid.");
  }
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
  runElectronProductionPublicLatestLeaseRemoteCli().catch((error) => {
    if (!(error instanceof ElectronProductionPublicLatestLeaseRemoteCliFailure)) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    process.exitCode = 1;
  });
}
