import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertElectronProductionRecoveryStoreRemoteRequest,
  createElectronProductionRecoveryStoreRemoteRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_REQUEST_KIND =
  "rion-electron-production-recovery-store-remote-atomic-pair-request";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_KIND =
  "rion-electron-production-recovery-store-remote-atomic-pair-operation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE =
  "electron-production-recovery-store-remote-atomic-pair-operation.json";

const MAX_RECEIPT_BYTES = 256 * 1024;
const REJECTED_REASONS = new Set([
  "conflict",
  "github-rejected",
  "malformed-record",
  "not-found",
  "path-conflict",
  "path-exists",
  "repository-policy-mismatch"
]);
const INDETERMINATE_REASONS = new Set([
  "server-error",
  "transport",
  "unexpected-response",
  "unknown-acknowledgement",
  "verification-failed"
]);

export function createElectronProductionRecoveryStoreAtomicPairRequest(input) {
  assertExactKeys(
    input,
    ["expectedHeadSha", "packageIdentities", "targets"],
    "recovery-store atomic-pair request input"
  );
  if (
    !Array.isArray(input.packageIdentities) ||
    input.packageIdentities.length !== 2 ||
    !Array.isArray(input.targets) ||
    input.targets.length !== 2
  ) {
    throw new Error("The recovery-store atomic-pair request needs two entries.");
  }
  const requests = input.targets.map((target, index) =>
    createElectronProductionRecoveryStoreRemoteRequest({
      expectedHeadSha: input.expectedHeadSha,
      packageIdentity: input.packageIdentities[index],
      target
    })
  );
  return assertElectronProductionRecoveryStoreAtomicPairRequest({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_REQUEST_KIND,
    operation: "create-atomic-pair",
    requests
  });
}

export function assertElectronProductionRecoveryStoreAtomicPairRequest(value) {
  assertExactKeys(value, ["kind", "operation", "requests", "schemaVersion"],
    "recovery-store atomic-pair request");
  assertEqual(value.schemaVersion, 1,
    "recovery-store atomic-pair request schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_REQUEST_KIND,
    "recovery-store atomic-pair request kind");
  assertEqual(value.operation, "create-atomic-pair",
    "recovery-store atomic-pair request operation");
  if (!Array.isArray(value.requests) || value.requests.length !== 2) {
    throw new Error("The recovery-store atomic-pair request needs two entries.");
  }
  const requests = value.requests.map((request) =>
    assertElectronProductionRecoveryStoreRemoteRequest(request)
  );
  const [first, second] = requests;
  if (
    first.target.path >= second.target.path ||
    first.target.repository !== second.target.repository ||
    first.target.ref !== second.target.ref ||
    !isDeepStrictEqual(
      first.target.repositoryPolicy,
      second.target.repositoryPolicy
    ) ||
    first.expectedHeadSha !== second.expectedHeadSha ||
    first.commitMessage !== second.commitMessage ||
    first.package.byteLength !== second.package.byteLength ||
    first.package.sha256 !== second.package.sha256 ||
    first.package.fileName === second.package.fileName
  ) {
    throw new Error(
      "The recovery-store atomic-pair entries must be sorted, co-located, " +
      "distinct filenames for identical bytes, and share one head fence."
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_REQUEST_KIND,
    operation: "create-atomic-pair",
    requests
  });
}

export function createElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  input
) {
  assertExactKeys(input, ["request", "result"],
    "recovery-store atomic-pair operation receipt input");
  const request = assertElectronProductionRecoveryStoreAtomicPairRequest(
    input.request
  );
  const terminal = terminalFromResult(input.result);
  const applied = terminal.classification === "applied"
    ? appliedFromResult(input.result, request)
    : null;
  return assertElectronProductionRecoveryStoreAtomicPairOperationReceipt({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_KIND,
    operation: "create-atomic-pair",
    requestIdentity: requestIdentity(request),
    terminal,
    applied
  });
}

export function assertElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  value
) {
  assertExactKeys(value, [
    "applied",
    "kind",
    "operation",
    "requestIdentity",
    "schemaVersion",
    "terminal"
  ], "recovery-store atomic-pair operation receipt");
  assertEqual(value.schemaVersion, 1,
    "recovery-store atomic-pair operation schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_KIND,
    "recovery-store atomic-pair operation kind");
  assertEqual(value.operation, "create-atomic-pair",
    "recovery-store atomic-pair operation");
  const request = assertRequestIdentity(value.requestIdentity);
  const terminal = assertTerminal(value.terminal);
  const applied = value.applied === null ? null : assertApplied(value.applied);
  if (terminal.classification === "applied") {
    if (applied === null) {
      throw new Error(
        "An applied recovery-store atomic pair requires Git identities."
      );
    }
    assertEqual(
      sha256(Buffer.from(applied.parentCommitSha, "utf8")),
      request.expectedHeadSha256,
      "recovery-store atomic-pair applied parent fence"
    );
    assertEqual(applied.byteLength, request.entries[0].package.byteLength,
      "recovery-store atomic-pair applied bytes");
    if (!isDeepStrictEqual(
      applied.paths,
      request.entries.map((entry) => entry.target.path)
    )) {
      throw new Error("The recovery-store atomic-pair applied paths changed.");
    }
  } else if (applied !== null) {
    throw new Error(
      "A non-applied recovery-store atomic pair cannot expose Git identities."
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_KIND,
    operation: "create-atomic-pair",
    requestIdentity: request,
    terminal,
    applied
  });
}

export function verifyElectronProductionRecoveryStoreAtomicPairOperationRequest(
  input
) {
  assertExactKeys(input, ["receipt", "request"],
    "recovery-store atomic-pair request verification input");
  const receipt =
    assertElectronProductionRecoveryStoreAtomicPairOperationReceipt(
      input.receipt
    );
  const request = assertElectronProductionRecoveryStoreAtomicPairRequest(
    input.request
  );
  if (!isDeepStrictEqual(receipt.requestIdentity, requestIdentity(request))) {
    throw new Error(
      "The recovery-store atomic-pair request identity does not match."
    );
  }
  return receipt;
}

export function serializeElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionRecoveryStoreAtomicPairOperationReceipt(value)
  );
}

export async function writeElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  input
) {
  assertExactKeys(input, ["outputPath", "receipt"],
    "recovery-store atomic-pair operation write input");
  const receipt =
    assertElectronProductionRecoveryStoreAtomicPairOperationReceipt(
      input.receipt
    );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE,
    "recovery-store atomic-pair operation output"
  );
  const source = serializeCanonicalJson(receipt);
  await writeExclusive(outputPath, source);
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(outputPath, {
      bytes: source.length,
      sha256: sha256(source)
    })
  });
}

export async function readElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  input
) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "recovery-store atomic-pair operation read input");
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "recovery-store atomic-pair operation path"
  );
  assertEqual(path.basename(receiptPath),
    ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE,
    "recovery-store atomic-pair operation filename");
  const expectedSha256 = requiredDigest(
    input.expectedSha256,
    "recovery-store atomic-pair operation SHA-256"
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "recovery-store atomic-pair operation"
  );
  assertEqual(file.sha256, expectedSha256,
    "recovery-store atomic-pair operation SHA-256");
  return deepFreeze({
    receipt:
      assertElectronProductionRecoveryStoreAtomicPairOperationReceipt(
        file.value
      ),
    receiptIdentity: publicIdentity(receiptPath, file)
  });
}

function requestIdentity(request) {
  const fields = {
    entries: request.requests.map((entry) => ({
      target: entry.target,
      package: entry.package
    })),
    expectedHeadSha256: sha256(Buffer.from(
      request.requests[0].expectedHeadSha,
      "utf8"
    )),
    commitMessageSha256: sha256(Buffer.from(
      request.requests[0].commitMessage,
      "utf8"
    ))
  };
  return deepFreeze({
    ...fields,
    requestSha256: sha256(serializeCanonicalJson(requestDigestMaterial(fields)))
  });
}

function assertRequestIdentity(value) {
  assertExactKeys(value, [
    "commitMessageSha256",
    "entries",
    "expectedHeadSha256",
    "requestSha256"
  ], "recovery-store atomic-pair request identity");
  if (!Array.isArray(value.entries) || value.entries.length !== 2) {
    throw new Error("The recovery-store atomic-pair identity needs two entries.");
  }
  const entries = value.entries.map(assertIdentityEntry);
  if (
    entries[0].target.path >= entries[1].target.path ||
    entries[0].target.repository !== entries[1].target.repository ||
    entries[0].target.ref !== entries[1].target.ref ||
    !isDeepStrictEqual(
      entries[0].target.repositoryPolicy,
      entries[1].target.repositoryPolicy
    ) ||
    entries[0].package.byteLength !== entries[1].package.byteLength ||
    entries[0].package.sha256 !== entries[1].package.sha256 ||
    entries[0].package.fileName === entries[1].package.fileName
  ) {
    throw new Error("The recovery-store atomic-pair identity entries changed.");
  }
  const identity = {
    entries,
    expectedHeadSha256: requiredDigest(value.expectedHeadSha256,
      "recovery-store atomic-pair expected head identity"),
    commitMessageSha256: requiredDigest(value.commitMessageSha256,
      "recovery-store atomic-pair commit message identity"),
    requestSha256: requiredDigest(value.requestSha256,
      "recovery-store atomic-pair request identity")
  };
  assertEqual(identity.requestSha256,
    sha256(serializeCanonicalJson(requestDigestMaterial(identity))),
    "recovery-store atomic-pair request SHA-256");
  return deepFreeze(identity);
}

function assertIdentityEntry(value) {
  assertExactKeys(value, ["package", "target"],
    "recovery-store atomic-pair identity entry");
  const request = assertElectronProductionRecoveryStoreRemoteRequest({
    schemaVersion: 1,
    kind: "rion-electron-production-recovery-store-remote-request",
    operation: "create",
    target: value.target,
    expectedHeadSha: "0".repeat(40),
    package: value.package,
    commitMessage: `recovery: store package ${value.package?.sha256}`
  });
  return deepFreeze({ target: request.target, package: request.package });
}

function requestDigestMaterial(identity) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_REQUEST_KIND,
    operation: "create-atomic-pair",
    entries: identity.entries,
    expectedHeadSha256: identity.expectedHeadSha256,
    commitMessageSha256: identity.commitMessageSha256
  });
}

function terminalFromResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The recovery-store atomic-pair result is invalid.");
  }
  if (result.outcome === "applied") {
    assertExactKeys(result, [
      "blobSha",
      "byteLength",
      "commitSha",
      "outcome",
      "parentSha",
      "paths",
      "treeSha"
    ], "applied recovery-store atomic-pair result");
    return deepFreeze({
      classification: "applied",
      reason: null,
      httpStatus: null
    });
  }
  assertExactKeys(result, ["outcome", "reason", "status"],
    "non-applied recovery-store atomic-pair result");
  if (result.outcome !== "rejected" && result.outcome !== "indeterminate") {
    throw new Error("The recovery-store atomic-pair outcome is invalid.");
  }
  const reasons = result.outcome === "rejected"
    ? REJECTED_REASONS
    : INDETERMINATE_REASONS;
  if (!reasons.has(result.reason)) {
    throw new Error("The recovery-store atomic-pair failure reason is invalid.");
  }
  return deepFreeze({
    classification: result.outcome,
    reason: result.reason,
    httpStatus: optionalHttpStatus(result.status)
  });
}

function assertTerminal(value) {
  assertExactKeys(value, ["classification", "httpStatus", "reason"],
    "recovery-store atomic-pair terminal result");
  if (value.classification === "applied") {
    assertEqual(value.reason, null, "applied atomic-pair reason");
    assertEqual(value.httpStatus, null, "applied atomic-pair HTTP status");
    return deepFreeze({
      classification: "applied",
      reason: null,
      httpStatus: null
    });
  }
  const reasons = value.classification === "rejected"
    ? REJECTED_REASONS
    : value.classification === "indeterminate"
      ? INDETERMINATE_REASONS
      : null;
  if (reasons === null || !reasons.has(value.reason)) {
    throw new Error("The recovery-store atomic-pair terminal result is invalid.");
  }
  return deepFreeze({
    classification: value.classification,
    reason: value.reason,
    httpStatus: optionalHttpStatus(value.httpStatus)
  });
}

function appliedFromResult(result, request) {
  const applied = assertApplied({
    parentCommitSha: result.parentSha,
    commitSha: result.commitSha,
    treeSha: result.treeSha,
    blobSha: result.blobSha,
    byteLength: result.byteLength,
    paths: result.paths
  });
  assertEqual(applied.parentCommitSha, request.requests[0].expectedHeadSha,
    "recovery-store atomic-pair applied parent SHA");
  assertEqual(applied.byteLength, request.requests[0].package.byteLength,
    "recovery-store atomic-pair applied byte length");
  if (!isDeepStrictEqual(
    applied.paths,
    request.requests.map((entry) => entry.target.path)
  )) throw new Error("The recovery-store atomic-pair applied paths changed.");
  return applied;
}

function assertApplied(value) {
  assertExactKeys(value, [
    "blobSha",
    "byteLength",
    "commitSha",
    "parentCommitSha",
    "paths",
    "treeSha"
  ], "recovery-store atomic-pair applied identities");
  if (
    !Array.isArray(value.paths) ||
    value.paths.length !== 2 ||
    typeof value.paths[0] !== "string" ||
    typeof value.paths[1] !== "string" ||
    value.paths[0] >= value.paths[1]
  ) {
    throw new Error("The recovery-store atomic-pair applied paths are invalid.");
  }
  const parentCommitSha = requiredCommitSha(value.parentCommitSha,
    "recovery-store atomic-pair parent commit SHA");
  const commitSha = requiredCommitSha(value.commitSha,
    "recovery-store atomic-pair commit SHA");
  const treeSha = requiredCommitSha(value.treeSha,
    "recovery-store atomic-pair tree SHA");
  const blobSha = requiredCommitSha(value.blobSha,
    "recovery-store atomic-pair blob SHA");
  if (new Set([parentCommitSha, commitSha, treeSha, blobSha]).size !== 4) {
    throw new Error("The recovery-store atomic-pair Git identities must differ.");
  }
  return deepFreeze({
    parentCommitSha,
    commitSha,
    treeSha,
    blobSha,
    byteLength: requiredPositiveInteger(value.byteLength,
      "recovery-store atomic-pair byte length"),
    paths: Object.freeze([...value.paths])
  });
}

function optionalHttpStatus(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("The recovery-store atomic-pair HTTP status is invalid.");
  }
  return value;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
