import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
  assertElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";
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

export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_REQUEST_KIND =
  "rion-electron-production-recovery-store-remote-request";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_KIND =
  "rion-electron-production-recovery-store-remote-operation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE =
  "electron-production-recovery-store-remote-operation.json";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_REQUEST_KIND =
  "rion-electron-production-recovery-store-remote-read-request";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_KIND =
  "rion-electron-production-recovery-store-remote-read-operation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE =
  "electron-production-recovery-store-remote-read-operation.json";

const MAX_OPERATION_RECEIPT_BYTES = 256 * 1024;
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
const READ_REJECTED_REASONS = new Set([
  ...REJECTED_REASONS,
  "content-identity-mismatch"
]);
const READ_LOCAL_INDETERMINATE_REASONS = new Set([
  "content-output-failed",
  "content-verification-failed"
]);

export function createElectronProductionRecoveryStoreRemoteRequest(input) {
  assertExactKeys(
    input,
    ["expectedHeadSha", "packageIdentity", "target"],
    "recovery-store remote request input"
  );
  const target = assertElectronProductionRecoveryStoreRemoteTarget(input.target);
  const packageIdentity = assertPackageIdentity(input.packageIdentity);
  const canonicalTarget = canonicalTargetFromRemote(target);
  assertEqual(
    path.posix.basename(canonicalTarget.path),
    packageIdentity.fileName,
    "recovery-store package target filename"
  );
  const expectedHeadSha = requiredCommitSha(
    input.expectedHeadSha,
    "recovery-store expected head SHA"
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_REQUEST_KIND,
    operation: "create",
    target: canonicalTarget,
    expectedHeadSha,
    package: packageIdentity,
    commitMessage: commitMessageForPackage(packageIdentity.sha256)
  });
}

export function assertElectronProductionRecoveryStoreRemoteRequest(value) {
  assertExactKeys(value, [
    "commitMessage",
    "expectedHeadSha",
    "kind",
    "operation",
    "package",
    "schemaVersion",
    "target"
  ], "recovery-store remote request");
  assertEqual(value.schemaVersion, 1, "recovery-store request schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_REQUEST_KIND,
    "recovery-store request kind"
  );
  assertEqual(value.operation, "create", "recovery-store request operation");
  const target = assertCanonicalTarget(value.target);
  const packageIdentity = assertPackageIdentity(value.package);
  assertEqual(
    path.posix.basename(target.path),
    packageIdentity.fileName,
    "recovery-store package target filename"
  );
  const expectedHeadSha = requiredCommitSha(
    value.expectedHeadSha,
    "recovery-store expected head SHA"
  );
  assertEqual(
    value.commitMessage,
    commitMessageForPackage(packageIdentity.sha256),
    "recovery-store deterministic commit message"
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_REQUEST_KIND,
    operation: "create",
    target,
    expectedHeadSha,
    package: packageIdentity,
    commitMessage: value.commitMessage
  });
}

export function electronProductionRecoveryStoreRemoteRequestSha256(value) {
  const request = assertElectronProductionRecoveryStoreRemoteRequest(value);
  return sha256(serializeCanonicalJson(
    requestIdentityDigestMaterial(requestIdentityFields(request))
  ));
}

export function createElectronProductionRecoveryStoreRemoteOperationReceipt(input) {
  assertExactKeys(
    input,
    ["request", "result"],
    "recovery-store remote operation receipt input"
  );
  const request = assertElectronProductionRecoveryStoreRemoteRequest(input.request);
  const terminal = terminalFromResult(input.result);
  const applied = terminal.classification === "applied"
    ? appliedFromResult(input.result, request)
    : null;
  return assertElectronProductionRecoveryStoreRemoteOperationReceipt({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_KIND,
    operation: "create",
    requestIdentity: requestIdentity(request),
    terminal,
    applied
  });
}

export function assertElectronProductionRecoveryStoreRemoteOperationReceipt(value) {
  assertExactKeys(value, [
    "applied",
    "kind",
    "operation",
    "requestIdentity",
    "schemaVersion",
    "terminal"
  ], "recovery-store remote operation receipt");
  assertEqual(value.schemaVersion, 1, "recovery-store operation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_KIND,
    "recovery-store operation kind"
  );
  assertEqual(value.operation, "create", "recovery-store operation");
  const request = assertRequestIdentity(value.requestIdentity);
  const terminal = assertTerminal(value.terminal);
  const applied = value.applied === null ? null : assertApplied(value.applied);
  if (terminal.classification === "applied") {
    if (applied === null) {
      throw new Error("An applied recovery-store operation requires Git identities.");
    }
    assertEqual(
      sha256(Buffer.from(applied.parentCommitSha, "utf8")),
      request.expectedHeadSha256,
      "recovery-store applied parent request fence"
    );
    assertEqual(
      applied.byteLength,
      request.package.byteLength,
      "recovery-store applied package bytes"
    );
  } else if (applied !== null) {
    throw new Error("A non-applied recovery-store operation cannot expose Git identities.");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_KIND,
    operation: "create",
    requestIdentity: request,
    terminal,
    applied
  });
}

export function verifyElectronProductionRecoveryStoreRemoteOperationRequest(input) {
  assertExactKeys(
    input,
    ["receipt", "request"],
    "recovery-store operation request verification input"
  );
  const receipt = assertElectronProductionRecoveryStoreRemoteOperationReceipt(
    input.receipt
  );
  const request = assertElectronProductionRecoveryStoreRemoteRequest(input.request);
  if (!isDeepStrictEqual(receipt.requestIdentity, requestIdentity(request))) {
    throw new Error("The recovery-store operation request identity does not match.");
  }
  return receipt;
}

export function serializeElectronProductionRecoveryStoreRemoteOperationReceipt(value) {
  return serializeCanonicalJson(
    assertElectronProductionRecoveryStoreRemoteOperationReceipt(value)
  );
}

export function electronProductionRecoveryStoreRemoteOperationReceiptSha256(value) {
  return sha256(serializeElectronProductionRecoveryStoreRemoteOperationReceipt(value));
}

export async function writeElectronProductionRecoveryStoreRemoteOperationReceipt(input) {
  assertExactKeys(
    input,
    ["outputPath", "receipt"],
    "recovery-store operation receipt write input"
  );
  const receipt = assertElectronProductionRecoveryStoreRemoteOperationReceipt(
    input.receipt
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
    "recovery-store operation receipt output"
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

export async function readElectronProductionRecoveryStoreRemoteOperationReceipt(input) {
  assertExactKeys(
    input,
    ["expectedSha256", "receiptPath"],
    "recovery-store operation receipt read input"
  );
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "recovery-store operation receipt path"
  );
  assertEqual(
    path.basename(receiptPath),
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
    "recovery-store operation receipt filename"
  );
  const expectedSha256 = requiredDigest(
    input.expectedSha256,
    "recovery-store operation receipt SHA-256"
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_OPERATION_RECEIPT_BYTES,
    "recovery-store operation receipt"
  );
  assertEqual(file.sha256, expectedSha256,
    "recovery-store operation receipt SHA-256");
  const receipt = assertElectronProductionRecoveryStoreRemoteOperationReceipt(
    file.value
  );
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(receiptPath, file)
  });
}

export function createElectronProductionRecoveryStoreRemoteReadRequest(input) {
  assertExactKeys(
    input,
    ["expectedContent", "target"],
    "recovery-store remote read request input"
  );
  return assertElectronProductionRecoveryStoreRemoteReadRequest({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_REQUEST_KIND,
    operation: "read",
    target: canonicalTargetFromRemote(
      assertElectronProductionRecoveryStoreRemoteTarget(input.target)
    ),
    expectedContent: input.expectedContent
  });
}

export function assertElectronProductionRecoveryStoreRemoteReadRequest(value) {
  assertExactKeys(value, [
    "expectedContent",
    "kind",
    "operation",
    "schemaVersion",
    "target"
  ], "recovery-store remote read request");
  assertEqual(value.schemaVersion, 1,
    "recovery-store read request schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_REQUEST_KIND,
    "recovery-store read request kind"
  );
  assertEqual(value.operation, "read", "recovery-store read request operation");
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_REQUEST_KIND,
    operation: "read",
    target: assertCanonicalTarget(value.target),
    expectedContent: assertExpectedContent(value.expectedContent)
  });
}

export function electronProductionRecoveryStoreRemoteReadRequestSha256(value) {
  const request = assertElectronProductionRecoveryStoreRemoteReadRequest(value);
  return sha256(serializeCanonicalJson(request));
}

export function createElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  input
) {
  assertExactKeys(
    input,
    ["content", "request", "result"],
    "recovery-store remote read operation receipt input"
  );
  const request = assertElectronProductionRecoveryStoreRemoteReadRequest(
    input.request
  );
  const projection = readProjectionFromResult(
    input.result,
    input.content,
    request
  );
  return assertElectronProductionRecoveryStoreRemoteReadOperationReceipt({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_KIND,
    operation: "read",
    requestIdentity: readRequestIdentity(request),
    terminal: projection.terminal,
    observed: projection.observed
  });
}

export function createElectronProductionRecoveryStoreRemoteReadFailureReceipt(
  input
) {
  assertExactKeys(
    input,
    ["reason", "request"],
    "recovery-store remote read failure receipt input"
  );
  const request = assertElectronProductionRecoveryStoreRemoteReadRequest(
    input.request
  );
  if (!READ_LOCAL_INDETERMINATE_REASONS.has(input.reason)) {
    throw new Error("The recovery-store local read failure reason is invalid.");
  }
  return assertElectronProductionRecoveryStoreRemoteReadOperationReceipt({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_KIND,
    operation: "read",
    requestIdentity: readRequestIdentity(request),
    terminal: {
      classification: "indeterminate",
      reason: input.reason,
      httpStatus: null
    },
    observed: null
  });
}

export function assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  value
) {
  assertExactKeys(value, [
    "kind",
    "observed",
    "operation",
    "requestIdentity",
    "schemaVersion",
    "terminal"
  ], "recovery-store remote read operation receipt");
  assertEqual(value.schemaVersion, 1,
    "recovery-store read operation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_KIND,
    "recovery-store read operation kind"
  );
  assertEqual(value.operation, "read", "recovery-store read operation");
  const request = assertReadRequestIdentity(value.requestIdentity);
  const terminal = assertReadTerminal(value.terminal);
  const observed = value.observed === null
    ? null
    : assertReadObserved(value.observed);
  if (terminal.classification === "present") {
    if (observed === null) {
      throw new Error("A present recovery-store read requires observed identities.");
    }
    assertEqual(
      observed.file.fileName,
      path.posix.basename(request.target.path),
      "recovery-store observed target filename"
    );
    if (!readObservedMatchesExpected(observed, request.expectedContent)) {
      throw new Error("The recovery-store observed content identity does not match.");
    }
  } else if (observed !== null) {
    throw new Error(
      "A non-present recovery-store read cannot expose Git identities."
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_KIND,
    operation: "read",
    requestIdentity: request,
    terminal,
    observed
  });
}

export function verifyElectronProductionRecoveryStoreRemoteReadOperationRequest(
  input
) {
  assertExactKeys(
    input,
    ["receipt", "request"],
    "recovery-store read operation request verification input"
  );
  const receipt =
    assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
      input.receipt
    );
  const request = assertElectronProductionRecoveryStoreRemoteReadRequest(
    input.request
  );
  if (!isDeepStrictEqual(receipt.requestIdentity, readRequestIdentity(request))) {
    throw new Error("The recovery-store read request identity does not match.");
  }
  return receipt;
}

export function serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(value)
  );
}

export function electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(
  value
) {
  return sha256(
    serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(value)
  );
}

export async function writeElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  input
) {
  assertExactKeys(
    input,
    ["outputPath", "receipt"],
    "recovery-store read operation receipt write input"
  );
  const receipt =
    assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
      input.receipt
    );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
    "recovery-store read operation receipt output"
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

export async function readElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  input
) {
  assertExactKeys(
    input,
    ["expectedSha256", "receiptPath"],
    "recovery-store read operation receipt read input"
  );
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "recovery-store read operation receipt path"
  );
  assertEqual(
    path.basename(receiptPath),
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
    "recovery-store read operation receipt filename"
  );
  const expectedSha256 = requiredDigest(
    input.expectedSha256,
    "recovery-store read operation receipt SHA-256"
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_OPERATION_RECEIPT_BYTES,
    "recovery-store read operation receipt"
  );
  assertEqual(
    file.sha256,
    expectedSha256,
    "recovery-store read operation receipt SHA-256"
  );
  const receipt =
    assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
      file.value
    );
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(receiptPath, file)
  });
}

function readProjectionFromResult(result, content, request) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The recovery-store remote read result is invalid.");
  }
  if (result.outcome === "present") {
    return readPresentProjection(result, content, request);
  }
  if (content !== null) {
    throw new Error("A non-present recovery-store read cannot include content.");
  }
  if (result.outcome === "absent") {
    assertExactKeys(result, [
      "commitMessage",
      "headSha",
      "outcome",
      "parentShas",
      "treeSha"
    ], "absent recovery-store remote read result");
    assertReadCommitState(result);
    return deepFreeze({
      terminal: {
        classification: "absent",
        reason: "path-absent",
        httpStatus: null
      },
      observed: null
    });
  }
  return deepFreeze({
    terminal: terminalFromResult(result),
    observed: null
  });
}

function readPresentProjection(result, content, request) {
  assertExactKeys(result, [
    "blobSha",
    "byteLength",
    "commitMessage",
    "contentBase64",
    "headSha",
    "outcome",
    "parentShas",
    "treeSha"
  ], "present recovery-store remote read result");
  const commitState = assertReadCommitState(result);
  if (!(content instanceof Uint8Array)) {
    throw new Error("A present recovery-store read requires content bytes.");
  }
  const source = Buffer.from(content);
  const blobSha = requiredCommitSha(
    result.blobSha,
    "recovery-store observed blob SHA"
  );
  if (
    source.length === 0 ||
    source.length > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES ||
    result.byteLength !== source.length ||
    result.contentBase64 !== source.toString("base64") ||
    gitBlobSha(source) !== blobSha
  ) {
    throw new Error("The recovery-store observed content bytes are invalid.");
  }
  const observed = deepFreeze({
    headCommitSha: commitState.headCommitSha,
    treeSha: commitState.treeSha,
    blobSha,
    parentCommitShas: commitState.parentCommitShas,
    file: {
      fileName: path.posix.basename(request.target.path),
      byteLength: source.length,
      sha256: sha256(source)
    }
  });
  if (!readObservedMatchesExpected(observed, request.expectedContent)) {
    return deepFreeze({
      terminal: {
        classification: "rejected",
        reason: "content-identity-mismatch",
        httpStatus: null
      },
      observed: null
    });
  }
  return deepFreeze({
    terminal: {
      classification: "present",
      reason: null,
      httpStatus: null
    },
    observed
  });
}

function assertReadCommitState(value) {
  if (
    typeof value.commitMessage !== "string" ||
    !Array.isArray(value.parentShas) ||
    value.parentShas.length > 64
  ) {
    throw new Error("The recovery-store observed commit state is invalid.");
  }
  const headCommitSha = requiredCommitSha(
    value.headSha,
    "recovery-store observed head commit SHA"
  );
  const treeSha = requiredCommitSha(
    value.treeSha,
    "recovery-store observed tree SHA"
  );
  const parentCommitShas = value.parentShas.map((parentSha) =>
    requiredCommitSha(parentSha, "recovery-store observed parent commit SHA")
  );
  if (
    new Set(parentCommitShas).size !== parentCommitShas.length ||
    parentCommitShas.includes(headCommitSha) ||
    headCommitSha === treeSha
  ) {
    throw new Error("The recovery-store observed commit identities are invalid.");
  }
  return deepFreeze({ headCommitSha, treeSha, parentCommitShas });
}

function assertExpectedContent(value) {
  assertExactKeys(
    value,
    ["byteLength", "sha256"],
    "recovery-store expected content identity"
  );
  const byteLength = value.byteLength === null
    ? null
    : requiredPositiveInteger(
      value.byteLength,
      "recovery-store expected content bytes"
    );
  if (
    byteLength !== null &&
    byteLength > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
  ) {
    throw new Error("The recovery-store expected content exceeds its bound.");
  }
  return deepFreeze({
    byteLength,
    sha256: value.sha256 === null
      ? null
      : requiredDigest(
        value.sha256,
        "recovery-store expected content SHA-256"
      )
  });
}

function readRequestIdentity(request) {
  const fields = {
    target: request.target,
    expectedContent: request.expectedContent
  };
  return deepFreeze({
    ...fields,
    requestSha256: sha256(serializeCanonicalJson(
      readRequestIdentityDigestMaterial(fields)
    ))
  });
}

function assertReadRequestIdentity(value) {
  assertExactKeys(value, [
    "expectedContent",
    "requestSha256",
    "target"
  ], "recovery-store read operation request identity");
  const identity = {
    target: assertCanonicalTarget(value.target),
    expectedContent: assertExpectedContent(value.expectedContent),
    requestSha256: requiredDigest(
      value.requestSha256,
      "recovery-store read request SHA-256"
    )
  };
  assertEqual(
    identity.requestSha256,
    sha256(serializeCanonicalJson(readRequestIdentityDigestMaterial(identity))),
    "recovery-store read request SHA-256"
  );
  return deepFreeze(identity);
}

function readRequestIdentityDigestMaterial(identity) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_REQUEST_KIND,
    operation: "read",
    target: identity.target,
    expectedContent: identity.expectedContent
  });
}

function assertReadTerminal(value) {
  assertExactKeys(
    value,
    ["classification", "httpStatus", "reason"],
    "recovery-store read operation terminal result"
  );
  if (value.classification === "present") {
    assertEqual(value.reason, null, "present recovery-store read reason");
    assertEqual(value.httpStatus, null,
      "present recovery-store read HTTP status");
    return deepFreeze({ classification: "present", reason: null, httpStatus: null });
  }
  if (value.classification === "absent") {
    assertEqual(value.reason, "path-absent", "absent recovery-store read reason");
    assertEqual(value.httpStatus, null,
      "absent recovery-store read HTTP status");
    return deepFreeze({
      classification: "absent",
      reason: "path-absent",
      httpStatus: null
    });
  }
  const reasons = value.classification === "rejected"
    ? READ_REJECTED_REASONS
    : value.classification === "indeterminate"
      ? new Set([...INDETERMINATE_REASONS, ...READ_LOCAL_INDETERMINATE_REASONS])
      : null;
  if (reasons === null || !reasons.has(value.reason)) {
    throw new Error("The recovery-store read terminal result is invalid.");
  }
  return deepFreeze({
    classification: value.classification,
    reason: value.reason,
    httpStatus: optionalHttpStatus(value.httpStatus)
  });
}

function assertReadObserved(value) {
  assertExactKeys(value, [
    "blobSha",
    "file",
    "headCommitSha",
    "parentCommitShas",
    "treeSha"
  ], "recovery-store read observed identities");
  const headCommitSha = requiredCommitSha(
    value.headCommitSha,
    "recovery-store observed head commit SHA"
  );
  const treeSha = requiredCommitSha(
    value.treeSha,
    "recovery-store observed tree SHA"
  );
  const blobSha = requiredCommitSha(
    value.blobSha,
    "recovery-store observed blob SHA"
  );
  if (
    !Array.isArray(value.parentCommitShas) ||
    value.parentCommitShas.length > 64
  ) {
    throw new Error("The recovery-store observed parent identities are invalid.");
  }
  const parentCommitShas = value.parentCommitShas.map((parentSha) =>
    requiredCommitSha(parentSha, "recovery-store observed parent commit SHA")
  );
  if (
    new Set([headCommitSha, treeSha, blobSha]).size !== 3 ||
    new Set(parentCommitShas).size !== parentCommitShas.length ||
    parentCommitShas.includes(headCommitSha)
  ) {
    throw new Error("The recovery-store observed Git identities are invalid.");
  }
  return deepFreeze({
    headCommitSha,
    treeSha,
    blobSha,
    parentCommitShas,
    file: assertPackageIdentity(value.file)
  });
}

function readObservedMatchesExpected(observed, expected) {
  return (expected.byteLength === null ||
      expected.byteLength === observed.file.byteLength) &&
    (expected.sha256 === null || expected.sha256 === observed.file.sha256);
}

function terminalFromResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The recovery-store remote result is invalid.");
  }
  if (result.outcome === "applied") {
    assertExactKeys(result, [
      "blobSha",
      "byteLength",
      "commitSha",
      "outcome",
      "parentSha",
      "treeSha"
    ], "applied recovery-store remote result");
    return deepFreeze({
      classification: "applied",
      reason: null,
      httpStatus: null
    });
  }
  assertExactKeys(
    result,
    ["outcome", "reason", "status"],
    "non-applied recovery-store remote result"
  );
  if (
    result.outcome !== "rejected" &&
    result.outcome !== "indeterminate"
  ) {
    throw new Error("The recovery-store remote outcome is invalid.");
  }
  const reasons = result.outcome === "rejected"
    ? REJECTED_REASONS
    : INDETERMINATE_REASONS;
  if (!reasons.has(result.reason)) {
    throw new Error("The recovery-store remote failure reason is invalid.");
  }
  const status = optionalHttpStatus(result.status);
  return deepFreeze({
    classification: result.outcome,
    reason: result.reason,
    httpStatus: status
  });
}

function appliedFromResult(result, request) {
  const applied = assertApplied({
    parentCommitSha: result.parentSha,
    commitSha: result.commitSha,
    treeSha: result.treeSha,
    blobSha: result.blobSha,
    byteLength: result.byteLength
  });
  assertEqual(
    applied.parentCommitSha,
    request.expectedHeadSha,
    "recovery-store applied parent SHA"
  );
  assertEqual(
    applied.byteLength,
    request.package.byteLength,
    "recovery-store applied package bytes"
  );
  return applied;
}

function assertRequestIdentity(value) {
  assertExactKeys(value, [
    "commitMessageSha256",
    "expectedHeadSha256",
    "package",
    "requestSha256",
    "target"
  ], "recovery-store operation request identity");
  const identity = {
    target: assertCanonicalTarget(value.target),
    package: assertPackageIdentity(value.package),
    expectedHeadSha256: requiredDigest(
      value.expectedHeadSha256,
      "recovery-store expected head identity SHA-256"
    ),
    commitMessageSha256: requiredDigest(
      value.commitMessageSha256,
      "recovery-store commit message SHA-256"
    ),
    requestSha256: requiredDigest(
      value.requestSha256,
      "recovery-store request SHA-256"
    )
  };
  assertEqual(
    identity.requestSha256,
    sha256(serializeCanonicalJson(requestIdentityDigestMaterial(identity))),
    "recovery-store request SHA-256"
  );
  return deepFreeze(identity);
}

function requestIdentity(request) {
  const fields = requestIdentityFields(request);
  return deepFreeze({
    ...fields,
    requestSha256: electronProductionRecoveryStoreRemoteRequestSha256(request)
  });
}

function requestIdentityFields(request) {
  return deepFreeze({
    target: request.target,
    package: request.package,
    expectedHeadSha256: sha256(Buffer.from(request.expectedHeadSha, "utf8")),
    commitMessageSha256: sha256(Buffer.from(request.commitMessage, "utf8"))
  });
}

function requestIdentityDigestMaterial(identity) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_REQUEST_KIND,
    operation: "create",
    target: identity.target,
    package: identity.package,
    expectedHeadSha256: identity.expectedHeadSha256,
    commitMessageSha256: identity.commitMessageSha256
  });
}

function assertTerminal(value) {
  assertExactKeys(
    value,
    ["classification", "httpStatus", "reason"],
    "recovery-store operation terminal result"
  );
  if (value.classification === "applied") {
    assertEqual(value.reason, null, "applied recovery-store reason");
    assertEqual(value.httpStatus, null, "applied recovery-store HTTP status");
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
    throw new Error("The recovery-store operation terminal result is invalid.");
  }
  return deepFreeze({
    classification: value.classification,
    reason: value.reason,
    httpStatus: optionalHttpStatus(value.httpStatus)
  });
}

function assertApplied(value) {
  assertExactKeys(value, [
    "blobSha",
    "byteLength",
    "commitSha",
    "parentCommitSha",
    "treeSha"
  ], "recovery-store applied identities");
  const applied = {
    parentCommitSha: requiredCommitSha(
      value.parentCommitSha,
      "recovery-store parent commit SHA"
    ),
    commitSha: requiredCommitSha(value.commitSha, "recovery-store commit SHA"),
    treeSha: requiredCommitSha(value.treeSha, "recovery-store tree SHA"),
    blobSha: requiredCommitSha(value.blobSha, "recovery-store blob SHA"),
    byteLength: requiredPositiveInteger(
      value.byteLength,
      "recovery-store applied bytes"
    )
  };
  if (
    applied.byteLength >
      ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES ||
    new Set([
      applied.parentCommitSha,
      applied.commitSha,
      applied.treeSha,
      applied.blobSha
    ]).size !== 4
  ) {
    throw new Error("The recovery-store applied identities are invalid.");
  }
  return deepFreeze(applied);
}

function assertCanonicalTarget(value) {
  assertExactKeys(value, [
    "path",
    "ref",
    "repository",
    "repositoryPolicy"
  ], "recovery-store canonical target");
  if (
    typeof value.repository !== "string" ||
    value.repository.split("/").length !== 2
  ) {
    throw new Error("The recovery-store repository slug is invalid.");
  }
  const [owner, repo] = value.repository.split("/");
  return canonicalTargetFromRemote(
    assertElectronProductionRecoveryStoreRemoteTarget({
      owner,
      repo,
      ref: value.ref,
      path: value.path,
      repositoryPolicy: value.repositoryPolicy
    })
  );
}

function canonicalTargetFromRemote(target) {
  return deepFreeze({
    repository: `${target.owner}/${target.repo}`,
    ref: target.ref,
    path: target.path,
    repositoryPolicy: target.repositoryPolicy
  });
}

function assertPackageIdentity(value) {
  assertExactKeys(
    value,
    ["byteLength", "fileName", "sha256"],
    "recovery-store package identity"
  );
  if (
    typeof value.fileName !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(value.fileName) ||
    value.fileName === "." ||
    value.fileName === ".."
  ) {
    throw new Error("The recovery-store package filename is invalid.");
  }
  const byteLength = requiredPositiveInteger(
    value.byteLength,
    "recovery-store package bytes"
  );
  if (byteLength > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES) {
    throw new Error("The recovery-store package exceeds its transport bound.");
  }
  return deepFreeze({
    fileName: value.fileName,
    byteLength,
    sha256: requiredDigest(value.sha256, "recovery-store package SHA-256")
  });
}

function optionalHttpStatus(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("The recovery-store HTTP status is invalid.");
  }
  return value;
}

function commitMessageForPackage(packageSha256) {
  return `recovery: store package ${packageSha256}`;
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
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
