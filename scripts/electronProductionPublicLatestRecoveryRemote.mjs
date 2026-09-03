import { createHash } from "node:crypto";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  assertElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  observeElectronProductionPublicLatestLeaseRemote
} from "./electronProductionPublicLatestLeaseRemote.mjs";
import {
  createElectronProductionPublicLatestRecoveryObservation,
  createElectronProductionPublicLatestRecoveryRollback,
  electronProductionPublicLatestRecoveryObservationSha256,
  assertElectronProductionPublicLatestRecoveryObservationBindings
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
  assertElectronProductionPublicLatestSnapshot,
  createElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertEqual,
  assertExactKeys,
  requiredDigest,
  requiredRfc3339
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_API_ROOT =
  "https://api.github.com";

const REPOSITORY_API =
  `${ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_API_ROOT}/repos/` +
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY;
const LATEST_RELEASE_API = `${REPOSITORY_API}/releases/latest`;
const MAX_METADATA_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ElectronProductionPublicLatestRollbackNotSubmittedError
  extends Error {
  constructor(message) {
    super(message);
    this.name = "ElectronProductionPublicLatestRollbackNotSubmittedError";
  }
}

export async function observeElectronProductionPublicLatestRecoveryRemote(input) {
  assertExactKeys(input, [
    "fetchImpl",
    "observedAt",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256",
    "token"
  ], "public-latest recovery remote observation input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const foundation = assertFoundation(input);
  const observedAt = requiredRfc3339(
    input.observedAt,
    "public-latest recovery remote observation time"
  );
  const result = await observeLatest(dependencies, foundation);
  return createElectronProductionPublicLatestRecoveryObservation({
    observedAt,
    result,
    sourceSnapshot: foundation.sourceSnapshot,
    sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
    targetSnapshot: foundation.targetSnapshot,
    targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
  });
}

export async function observeElectronProductionPublicLatestRecoveryRemoteAtResult(
  input
) {
  assertExactKeys(input, [
    "fetchImpl",
    "recordObservedAt",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256",
    "token"
  ], "result-timed public-latest recovery remote observation input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const foundation = assertFoundation(input);
  const recordObservedAt = requiredClock(
    input.recordObservedAt,
    "public-latest recovery observation clock"
  );
  const result = await observeLatest(dependencies, foundation);
  const observedAt = recordTime(
    recordObservedAt,
    null,
    "public-latest recovery result observation time"
  );
  return createElectronProductionPublicLatestRecoveryObservation({
    observedAt,
    result,
    sourceSnapshot: foundation.sourceSnapshot,
    sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
    targetSnapshot: foundation.targetSnapshot,
    targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
  });
}

export async function rollbackElectronProductionPublicLatestRecoveryRemote(input) {
  assertExactKeys(input, [
    "fetchImpl",
    "finalObservedAt",
    "heldLease",
    "preObservation",
    "preObservationSha256",
    "resultRecordedAt",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "submittedAt",
    "targetSnapshot",
    "targetSnapshotFileSha256",
    "token"
  ], "public-latest recovery remote rollback input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const foundation = assertFoundation(input);
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  assertRollbackLease(heldLease, foundation);
  const preObservation =
    assertElectronProductionPublicLatestRecoveryObservationBindings({
      observation: input.preObservation,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
    });
  const preObservationSha256 = requiredDigest(
    input.preObservationSha256,
    "pre-rollback public-latest observation SHA-256"
  );
  assertEqual(
    preObservationSha256,
    electronProductionPublicLatestRecoveryObservationSha256(preObservation),
    "pre-rollback public-latest observation SHA-256"
  );
  if (
    preObservation.transport.outcome !== "observed" ||
    preObservation.observation.classification !== "target"
  ) {
    throw new Error(
      "Rollback is allowed only after a fresh exact target observation."
    );
  }
  const submittedAt = requiredRfc3339(
    input.submittedAt,
    "public-latest rollback submission time"
  );
  const resultRecordedAt = requiredRfc3339(
    input.resultRecordedAt,
    "public-latest rollback result time"
  );
  const finalObservedAt = requiredRfc3339(
    input.finalObservedAt,
    "public-latest rollback final observation time"
  );
  assertTimeOrder(preObservation.observedAt, submittedAt,
    "Rollback submission cannot precede its target observation.");
  assertTimeOrder(submittedAt, resultRecordedAt,
    "Rollback result cannot precede submission.");
  assertTimeOrder(resultRecordedAt, finalObservedAt,
    "Final rollback observation cannot precede the mutation result.");

  let freshPreObservation;
  try {
    freshPreObservation =
      await observeElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
      observedAt: submittedAt,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token: dependencies.token
    });
  } catch {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "Rollback could not complete its last-moment target observation."
    );
  }
  if (
    freshPreObservation.transport.outcome !== "observed" ||
    freshPreObservation.observation.classification !== "target"
  ) {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "Rollback requires a last-moment exact target observation before PATCH."
    );
  }
  const freshPreObservationSha256 =
    electronProductionPublicLatestRecoveryObservationSha256(
      freshPreObservation
    );
  const policy = await observeRepositoryPolicy(dependencies);
  if (policy !== null) {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "The fixed public repository policy changed before rollback."
    );
  }
  const freshLease = await observeElectronProductionPublicLatestLeaseRemote({
    expected: heldLease,
    fetchImpl: dependencies.fetchImpl,
    token: dependencies.token
  });
  if (freshLease.outcome !== "observed") {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "Rollback requires a last-moment exact held lease before PATCH."
    );
  }
  const mutationResult = await patchSourceLatest(
    dependencies,
    foundation.sourceSnapshot
  );
  const finalObservation =
    await observeElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: dependencies.fetchImpl,
      observedAt: finalObservedAt,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token: dependencies.token
    });
  const finalObservationSha256 =
    electronProductionPublicLatestRecoveryObservationSha256(finalObservation);
  const rollback = createElectronProductionPublicLatestRecoveryRollback({
    finalObservation,
    finalObservationSha256,
    heldLease,
    mutation: {
      submitted: true,
      releaseId: foundation.sourceSnapshot.release.id,
      makeLatest: true,
      acknowledgement: mutationResult.acknowledgement,
      submittedAt,
      resultRecordedAt,
      reason: mutationResult.reason,
      httpStatus: mutationResult.status
    },
    preObservation: freshPreObservation,
    preObservationSha256: freshPreObservationSha256,
    sourceSnapshot: foundation.sourceSnapshot,
    sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
    targetSnapshot: foundation.targetSnapshot,
    targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
  });
  return deepFreeze({
    finalObservation,
    preObservation: freshPreObservation,
    rollback
  });
}

export async function rollbackElectronProductionPublicLatestRecoveryRemoteAtResult(
  input
) {
  assertExactKeys(input, [
    "fetchImpl",
    "heldLease",
    "preObservation",
    "preObservationSha256",
    "recordTime",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "submissionNotBefore",
    "targetSnapshot",
    "targetSnapshotFileSha256",
    "token"
  ], "result-timed public-latest recovery rollback input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const foundation = assertFoundation(input);
  const clock = requiredClock(
    input.recordTime,
    "public-latest rollback event clock"
  );
  const submissionNotBefore = requiredRfc3339(
    input.submissionNotBefore,
    "public-latest rollback submission floor"
  );
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  assertRollbackLease(heldLease, foundation);
  const preObservation =
    assertElectronProductionPublicLatestRecoveryObservationBindings({
      observation: input.preObservation,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
    });
  assertEqual(
    electronProductionPublicLatestRecoveryObservationSha256(preObservation),
    requiredDigest(
      input.preObservationSha256,
      "pre-rollback public-latest observation SHA-256"
    ),
    "pre-rollback public-latest observation SHA-256"
  );
  if (preObservation.transport.outcome !== "observed" ||
      preObservation.observation.classification !== "target") {
    throw new Error(
      "Rollback is allowed only after an exact target observation."
    );
  }
  let freshPreObservation;
  try {
    freshPreObservation =
      await observeElectronProductionPublicLatestRecoveryRemoteAtResult({
        fetchImpl: dependencies.fetchImpl,
        recordObservedAt: clock,
        sourceSnapshot: foundation.sourceSnapshot,
        sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
        targetSnapshot: foundation.targetSnapshot,
        targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
        token: dependencies.token
      });
  } catch {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "Rollback could not complete its last-moment target observation."
    );
  }
  if (freshPreObservation.transport.outcome !== "observed" ||
      freshPreObservation.observation.classification !== "target") {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "Rollback requires a last-moment exact target observation before PATCH."
    );
  }
  const policy = await observeRepositoryPolicy(dependencies);
  if (policy !== null) {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "The fixed public repository policy changed before rollback."
    );
  }
  const freshLease = await observeElectronProductionPublicLatestLeaseRemote({
    expected: heldLease,
    fetchImpl: dependencies.fetchImpl,
    token: dependencies.token
  });
  if (freshLease.outcome !== "observed") {
    throw new ElectronProductionPublicLatestRollbackNotSubmittedError(
      "Rollback requires a last-moment exact held lease before PATCH."
    );
  }
  const submittedAt = recordTime(
    clock,
    laterTime(freshPreObservation.observedAt, submissionNotBefore),
    "public-latest rollback submission time"
  );
  const mutationResult = await patchSourceLatest(
    dependencies,
    foundation.sourceSnapshot
  );
  const resultRecordedAt = recordTime(
    clock,
    submittedAt,
    "public-latest rollback result time"
  );
  const finalObservation =
    await observeElectronProductionPublicLatestRecoveryRemoteAtResult({
      fetchImpl: dependencies.fetchImpl,
      recordObservedAt: clock,
      sourceSnapshot: foundation.sourceSnapshot,
      sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
      targetSnapshot: foundation.targetSnapshot,
      targetSnapshotFileSha256: foundation.targetSnapshotFileSha256,
      token: dependencies.token
    });
  assertTimeOrder(
    resultRecordedAt,
    finalObservation.observedAt,
    "Final rollback observation cannot precede its mutation result."
  );
  const rollback = createElectronProductionPublicLatestRecoveryRollback({
    finalObservation,
    finalObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(
        finalObservation
      ),
    heldLease,
    mutation: {
      submitted: true,
      releaseId: foundation.sourceSnapshot.release.id,
      makeLatest: true,
      acknowledgement: mutationResult.acknowledgement,
      submittedAt,
      resultRecordedAt,
      reason: mutationResult.reason,
      httpStatus: mutationResult.status
    },
    preObservation: freshPreObservation,
    preObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(
        freshPreObservation
      ),
    sourceSnapshot: foundation.sourceSnapshot,
    sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
    targetSnapshot: foundation.targetSnapshot,
    targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
  });
  return deepFreeze({
    finalObservation,
    preObservation: freshPreObservation,
    rollback
  });
}

async function observeLatest(dependencies, foundation) {
  const policy = await observeRepositoryPolicy(dependencies);
  if (policy !== null) return policy;
  const latestRequest = await fetchApiJson(
    dependencies,
    LATEST_RELEASE_API,
    { method: "GET" }
  );
  if (latestRequest.outcome !== "value") return latestRequest;
  const latest = minimalLatestIdentity(latestRequest.value);
  if (latest === null) return rejected("malformed-record", 200, null);
  const expected = latest.releaseId === foundation.sourceSnapshot.release.id
    ? foundation.sourceSnapshot
    : latest.releaseId === foundation.targetSnapshot.release.id
      ? foundation.targetSnapshot
      : null;
  if (expected === null) {
    return Object.freeze({ outcome: "observed", latest, snapshot: null });
  }
  const release = exactKnownRelease(latestRequest.value, expected);
  if (release === null) return rejected("snapshot-mismatch", 200, latest);
  const reference = await fetchApiJson(
    dependencies,
    `${REPOSITORY_API}/git/ref/tags/${encodeURIComponent(expected.release.tag)}`,
    { method: "GET" }
  );
  if (reference.outcome !== "value") return { ...reference, latest };
  if (!isExactTagReference(reference.value, expected)) {
    return rejected("snapshot-mismatch", 200, latest);
  }
  const built = await downloadAndBuildSnapshot(
    dependencies,
    release,
    expected
  );
  if (built.outcome !== "snapshot") return { ...built, latest };
  const confirmation = await confirmKnownLatest(
    dependencies,
    expected,
    latest
  );
  if (confirmation !== null) return confirmation;
  return Object.freeze({ outcome: "observed", latest, snapshot: built.snapshot });
}

async function confirmKnownLatest(dependencies, expected, originalLatest) {
  const latestRequest = await fetchApiJson(
    dependencies,
    LATEST_RELEASE_API,
    { method: "GET" }
  );
  if (latestRequest.outcome !== "value") {
    return { ...latestRequest, latest: originalLatest };
  }
  const latest = minimalLatestIdentity(latestRequest.value);
  if (
    latest === null ||
    latest.releaseId !== originalLatest.releaseId ||
    latest.updatedAt !== originalLatest.updatedAt ||
    exactKnownRelease(latestRequest.value, expected) === null
  ) return rejected("snapshot-mismatch", 200, latest);
  const reference = await fetchApiJson(
    dependencies,
    `${REPOSITORY_API}/git/ref/tags/${encodeURIComponent(expected.release.tag)}`,
    { method: "GET" }
  );
  if (reference.outcome !== "value") return { ...reference, latest };
  if (!isExactTagReference(reference.value, expected)) {
    return rejected("snapshot-mismatch", 200, latest);
  }
  return null;
}

async function downloadAndBuildSnapshot(dependencies, release, expected) {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rion-public-latest-recovery-")
  );
  try {
    for (const asset of release.assets) {
      const result = await downloadAsset(
        dependencies.fetchImpl,
        asset,
        path.join(temporaryRoot, asset.name)
      );
      if (result !== null) return result;
    }
    try {
      const snapshot = await createElectronProductionPublicLatestSnapshot({
        assetDirectory: temporaryRoot,
        candidateReceiptSummary: expected.candidateReceipt,
        release
      });
      return Object.freeze({ outcome: "snapshot", snapshot });
    } catch {
      return rejected("snapshot-mismatch", 200, null);
    }
  } finally {
    await rm(temporaryRoot, { force: false, recursive: true });
  }
}

async function downloadAsset(fetchImpl, asset, outputPath) {
  let response;
  try {
    response = await fetchImpl(asset.url, {
      method: "GET",
      headers: {
        Accept: "application/octet-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "rion-studio-public-latest-recovery"
      },
      cache: "no-store",
      redirect: "follow"
    });
  } catch {
    return indeterminate("transport", null, null);
  }
  if (!response || !Number.isInteger(response.status)) {
    return indeterminate("transport", null, null);
  }
  if (response.status >= 500) {
    await cancelResponseBody(response);
    return indeterminate("server-error", response.status, null);
  }
  if (response.status >= 400 && response.status < 500) {
    await cancelResponseBody(response);
    return rejected("github-rejected", response.status, null);
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    return indeterminate("unexpected-response", response.status, null);
  }
  const declared = response.headers?.get?.("content-length");
  if (
    declared !== null && declared !== undefined &&
    (!/^\d+$/u.test(declared) || Number(declared) !== asset.bytes)
  ) {
    await cancelResponseBody(response);
    return rejected("snapshot-mismatch", 200, null);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    return rejected("malformed-record", 200, null);
  }
  const handle = await open(outputPath, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    while (true) {
      let event;
      try {
        event = await reader.read();
      } catch {
        return indeterminate("transport", null, null);
      }
      if (event.done) break;
      if (!(event.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        return rejected("malformed-record", 200, null);
      }
      bytes += event.value.byteLength;
      if (bytes > asset.bytes) {
        await reader.cancel().catch(() => undefined);
        return rejected("snapshot-mismatch", 200, null);
      }
      digest.update(event.value);
      await writeComplete(handle, event.value);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (
    bytes !== asset.bytes ||
    `sha256:${digest.digest("hex")}` !== asset.digest
  ) return rejected("snapshot-mismatch", 200, null);
  return null;
}

async function patchSourceLatest(dependencies, sourceSnapshot) {
  const releaseId = sourceSnapshot.release.id;
  const request = await fetchOnce(
    dependencies,
    `${REPOSITORY_API}/releases/${releaseId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ make_latest: "true" })
    }
  );
  if (request.outcome === "transport-error") {
    return mutationUnknown("transport", null);
  }
  const { response } = request;
  if (response.status >= 400 && response.status < 500) {
    await cancelResponseBody(response);
    return Object.freeze({
      acknowledgement: "rejected",
      reason: "github-rejected",
      status: response.status
    });
  }
  if (response.status >= 500) {
    await cancelResponseBody(response);
    return mutationUnknown("server-error", response.status);
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    return mutationUnknown("unexpected-response", response.status);
  }
  let value;
  try {
    value = await readBoundedJson(response, MAX_METADATA_BYTES);
  } catch {
    return mutationUnknown("unexpected-response", 200);
  }
  if (
    releaseIdFromApi(value?.id) !== releaseId ||
    value?.tag_name !== sourceSnapshot.release.tag ||
    value?.draft !== false ||
    value?.prerelease !== false
  ) return mutationUnknown("unexpected-response", 200);
  return Object.freeze({
    acknowledgement: "confirmed",
    reason: "applied-response",
    status: 200
  });
}

async function observeRepositoryPolicy(dependencies) {
  const request = await fetchApiJson(
    dependencies,
    REPOSITORY_API,
    { method: "GET" }
  );
  if (request.outcome !== "value") return request;
  const value = request.value;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.full_name !== ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY ||
    value.private !== false ||
    value.visibility !== "public" ||
    value.default_branch !== "main"
  ) return rejected("repository-policy-mismatch", 200, null);
  return null;
}

async function fetchApiJson(dependencies, url, init) {
  const request = await fetchOnce(dependencies, url, init);
  if (request.outcome === "transport-error") {
    return indeterminate("transport", null, null);
  }
  const { response } = request;
  if (response.status >= 500) {
    await cancelResponseBody(response);
    return indeterminate("server-error", response.status, null);
  }
  if (response.status >= 400 && response.status < 500) {
    await cancelResponseBody(response);
    return rejected("github-rejected", response.status, null);
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    return indeterminate("unexpected-response", response.status, null);
  }
  try {
    return Object.freeze({
      outcome: "value",
      value: await readBoundedJson(response, MAX_METADATA_BYTES)
    });
  } catch {
    return rejected("malformed-record", 200, null);
  }
}

async function fetchOnce(dependencies, url, init) {
  try {
    const response = await dependencies.fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${dependencies.token}`,
        "Cache-Control": "no-cache",
        "User-Agent": "rion-studio-public-latest-recovery",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : {
          "Content-Type": "application/json"
        })
      },
      cache: "no-store",
      redirect: "error"
    });
    if (!response || !Number.isInteger(response.status)) {
      return Object.freeze({ outcome: "transport-error" });
    }
    return Object.freeze({ outcome: "response", response });
  } catch {
    return Object.freeze({ outcome: "transport-error" });
  }
}

async function readBoundedJson(response, maximumBytes) {
  const source = await readBoundedBody(response, maximumBytes);
  return JSON.parse(UTF8_DECODER.decode(source));
}

async function readBoundedBody(response, maximumBytes) {
  const declared = response.headers?.get?.("content-length");
  if (
    declared !== null && declared !== undefined &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    await cancelResponseBody(response);
    throw new Error("The GitHub recovery response exceeds its size limit.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("The GitHub recovery response body is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const event = await reader.read();
    if (event.done) break;
    if (!(event.value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The GitHub recovery response body is invalid.");
    }
    bytes += event.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The GitHub recovery response exceeds its size limit.");
    }
    chunks.push(Buffer.from(event.value));
  }
  return Buffer.concat(chunks, bytes);
}

async function writeComplete(handle, source) {
  let offset = 0;
  while (offset < source.byteLength) {
    const result = await handle.write(
      source,
      offset,
      source.byteLength - offset,
      null
    );
    if (result.bytesWritten <= 0) {
      throw new Error("The recovery asset write did not make progress.");
    }
    offset += result.bytesWritten;
  }
}

async function cancelResponseBody(response) {
  try {
    await response.body?.getReader?.().cancel();
  } catch {
    // This discarded response is already a closed non-success result.
  }
}

function assertFoundation(input) {
  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const targetSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  if (
    sourceSnapshot.observationKind !== "observed-release" ||
    sourceSnapshot.release.isLatest !== true
  ) throw new Error("The recovery source must be an observed latest snapshot.");
  if (
    targetSnapshot.observationKind !== "expected-latest-projection" ||
    targetSnapshot.release.isLatest !== true
  ) throw new Error("The recovery target must be an expected latest projection.");
  if (
    sourceSnapshot.release.id === targetSnapshot.release.id ||
    sourceSnapshot.stateSha256 === targetSnapshot.stateSha256
  ) throw new Error("The recovery source and target snapshots must be distinct.");
  return Object.freeze({
    sourceSnapshot,
    sourceSnapshotFileSha256: requiredDigest(
      input.sourceSnapshotFileSha256,
      "recovery source snapshot file SHA-256"
    ),
    targetSnapshot,
    targetSnapshotFileSha256: requiredDigest(
      input.targetSnapshotFileSha256,
      "recovery target snapshot file SHA-256"
    )
  });
}

function assertRollbackLease(lease, foundation) {
  assertEqual(lease.status, "held", "public-latest rollback lease status");
  assertEqual(lease.purpose, "electron-v23-provisional-publication",
    "public-latest rollback lease purpose");
  assertEqual(lease.source.stateSha256,
    foundation.sourceSnapshot.stateSha256,
    "public-latest rollback lease source state binding");
  assertEqual(lease.target.stateSha256,
    foundation.targetSnapshot.stateSha256,
    "public-latest rollback lease target state binding");
}

function minimalLatestIdentity(value) {
  const releaseId = releaseIdFromApi(value?.id);
  if (releaseId === null || !isRfc3339(value?.updated_at)) return null;
  return Object.freeze({ releaseId, updatedAt: value.updated_at });
}

function exactKnownRelease(value, expected) {
  if (
    releaseIdFromApi(value?.id) !== expected.release.id ||
    value?.tag_name !== expected.release.tag ||
    value?.draft !== false ||
    value?.prerelease !== false ||
    !Array.isArray(value?.assets) ||
    value.assets.length !== ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.length
  ) return null;
  const normalizedAssets = [];
  const observedIds = new Set();
  const observedNames = new Set();
  for (const expectedAsset of expected.assets) {
    const matches = value.assets.filter((asset) =>
      asset && typeof asset === "object" && asset.name === expectedAsset.name
    );
    if (matches.length !== 1) return null;
    const asset = matches[0];
    const id = releaseIdFromApi(asset.id);
    if (
      id !== expectedAsset.id ||
      asset.size !== expectedAsset.bytes ||
      asset.digest !== expectedAsset.digest ||
      asset.browser_download_url !== expectedAsset.url ||
      asset.content_type !== expectedAsset.contentType ||
      asset.state !== "uploaded" ||
      observedIds.has(id) ||
      observedNames.has(asset.name)
    ) return null;
    observedIds.add(id);
    observedNames.add(asset.name);
    normalizedAssets.push({
      id,
      name: asset.name,
      bytes: asset.size,
      digest: asset.digest,
      url: asset.browser_download_url,
      contentType: asset.content_type
    });
  }
  return {
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    id: expected.release.id,
    tag: expected.release.tag,
    targetCommitish: expected.release.targetCommitish,
    isLatest: true,
    draft: false,
    prerelease: false,
    assets: normalizedAssets
  };
}

function isExactTagReference(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    value.ref === `refs/tags/${expected.release.tag}` &&
    value.object && typeof value.object === "object" &&
    !Array.isArray(value.object) &&
    value.object.type === "commit" &&
    value.object.sha === expected.release.targetCommitish;
}

function releaseIdFromApi(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function assertDependencies(fetchImpl, token) {
  if (typeof fetchImpl !== "function") {
    throw new Error("The public-latest recovery fetch implementation is required.");
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    /\s/u.test(token)
  ) throw new Error("The public-latest recovery token is invalid.");
  return Object.freeze({ fetchImpl, token });
}

function rejected(reason, status, latest) {
  return Object.freeze({ outcome: "rejected", reason, status, latest });
}

function indeterminate(reason, status, latest) {
  return Object.freeze({ outcome: "indeterminate", reason, status, latest });
}

function mutationUnknown(reason, status) {
  return Object.freeze({ acknowledgement: "unknown", reason, status });
}

function isRfc3339(value) {
  if (typeof value !== "string") return false;
  try {
    return requiredRfc3339(value, "GitHub latest update time") === value;
  } catch {
    return false;
  }
}

function requiredClock(value, label) {
  if (typeof value !== "function") {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function recordTime(clock, floor, label) {
  const value = requiredRfc3339(clock(), label);
  if (floor !== null && Date.parse(value) < Date.parse(floor)) {
    throw new Error(`The ${label} precedes its authoritative event floor.`);
  }
  return value;
}

function laterTime(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function assertTimeOrder(previous, next, message) {
  if (Date.parse(next) < Date.parse(previous)) throw new Error(message);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
