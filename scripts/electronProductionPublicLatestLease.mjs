import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertSemanticVersionIsNewer,
  publicIdentity,
  readCanonicalJsonFile,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_KIND =
  "rion-electron-production-public-latest-lease";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE =
  "electron-production-public-latest-lease.json";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY =
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS =
  Object.freeze({
    "electron-v23-provisional-publication":
      ".github/workflows/electron-production-provisional-publish.yml",
    "tauri-v22-publication": ".github/workflows/publish-public-release.yml",
    "tauri-v22-latest-restore": ".github/workflows/restore-public-latest.yml"
  });

const MAX_LEASE_BYTES = 1024 * 1024;
const LEASE_STATUSES = new Set(["held", "released"]);
const GENESIS_VACANT_GENERATION = 0;
const MAX_GENERATION = Math.floor(Number.MAX_SAFE_INTEGER / 2);

export function acquireElectronProductionPublicLatestLease(input) {
  assertExactKeys(input, [
    "holder",
    "leaseId",
    "previous",
    "purpose",
    "recordedAt",
    "source",
    "target",
    "transactionId",
    "vacantGeneration"
  ], "public-latest lease acquisition input");
  const predecessor = assertAcquisitionPredecessor(
    input.previous,
    input.vacantGeneration,
    input.recordedAt
  );
  const purpose = assertPurpose(input.purpose);
  const source = assertState(input.source, "source");
  const target = assertState(input.target, "target");
  assertPurposeStateTransition(purpose, source, target);
  if (source.stateSha256 === target.stateSha256) {
    throw new Error("The public-latest source and target states must be distinct.");
  }
  const recordedAt = requiredRfc3339(
    input.recordedAt,
    "public-latest lease acquisition time"
  );
  const transactionId = requiredUuid(input.transactionId,
    "public-latest transaction ID");
  const leaseId = requiredUuid(input.leaseId, "public-latest lease ID");
  if (predecessor.transactionId === transactionId || predecessor.leaseId === leaseId) {
    throw new Error(
      "A successor public-latest lease must use new transaction and lease IDs."
    );
  }
  return assertElectronProductionPublicLatestLease({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_KIND,
    transactionId,
    leaseId,
    vacantGeneration: predecessor.vacantGeneration,
    generation: predecessor.vacantGeneration + 1,
    status: "held",
    purpose,
    holder: assertHolder(input.holder, purpose),
    source,
    target,
    revision: predecessor.revision + 1,
    acquiredFromEventSha256: predecessor.eventSha256,
    previousEventSha256: predecessor.eventSha256,
    acquiredAt: recordedAt,
    recordedAt
  });
}

export function releaseElectronProductionPublicLatestLease(previousValue, input) {
  const previous = assertElectronProductionPublicLatestLease(previousValue);
  if (previous.status !== "held") {
    throw new Error("Only an exactly held public-latest lease can be released.");
  }
  assertExactKeys(input, [
    "generation",
    "leaseId",
    "recordedAt",
    "sourceStateSha256",
    "targetStateSha256",
    "transactionId"
  ], "public-latest lease release input");
  assertEqual(
    requiredUuid(input.transactionId, "release transaction ID"),
    previous.transactionId,
    "public-latest lease release transaction ID fence"
  );
  assertEqual(
    requiredUuid(input.leaseId, "release lease ID"),
    previous.leaseId,
    "public-latest lease release ID fence"
  );
  assertEqual(
    requiredPositiveInteger(input.generation, "release lease generation"),
    previous.generation,
    "public-latest lease release generation fence"
  );
  assertEqual(
    requiredDigest(input.sourceStateSha256, "release source state SHA-256"),
    previous.source.stateSha256,
    "public-latest lease release source state SHA-256 fence"
  );
  assertEqual(
    requiredDigest(input.targetStateSha256, "release target state SHA-256"),
    previous.target.stateSha256,
    "public-latest lease release target state SHA-256 fence"
  );
  const recordedAt = requiredRfc3339(
    input.recordedAt,
    "public-latest lease release time"
  );
  assertTimeDoesNotPrecede(
    recordedAt,
    previous.recordedAt,
    "A public-latest lease release cannot precede its acquisition."
  );
  return assertElectronProductionPublicLatestLease({
    ...previous,
    status: "released",
    revision: previous.revision + 1,
    previousEventSha256: electronProductionPublicLatestLeaseEventSha256(previous),
    recordedAt
  });
}

export function assertElectronProductionPublicLatestLeaseHeldObservation(input) {
  assertExactKeys(input, ["expected", "observed"],
    "public-latest held lease observation input");
  const expected = assertElectronProductionPublicLatestLease(input.expected);
  if (expected.status !== "held") {
    throw new Error("The expected public-latest lease must be held.");
  }
  let observed;
  try {
    observed = assertElectronProductionPublicLatestLease(input.observed);
  } catch (error) {
    throw new Error(
      "The observed public-latest lease is unknown and must fail closed.",
      { cause: error }
    );
  }
  if (observed.status !== "held") {
    throw new Error("The observed public-latest lease is not held and must fail closed.");
  }
  if (!isDeepStrictEqual(observed, expected)) {
    throw new Error("The observed public-latest lease is foreign and must fail closed.");
  }
  return observed;
}

export function assertElectronProductionPublicLatestLeaseSuccessor(input) {
  assertExactKeys(input, ["next", "previous"],
    "public-latest lease successor input");
  const previous = assertElectronProductionPublicLatestLease(input.previous);
  const next = assertElectronProductionPublicLatestLease(input.next);
  if (previous.status !== "released" || next.status !== "held") {
    throw new Error(
      "A public-latest lease successor requires released-to-held transition."
    );
  }
  if (next.transactionId === previous.transactionId ||
      next.leaseId === previous.leaseId) {
    throw new Error(
      "A public-latest lease successor must use new transaction and lease IDs."
    );
  }
  assertEqual(next.vacantGeneration, previous.generation,
    "successor vacant generation");
  assertEqual(next.generation, previous.generation + 1,
    "successor lease generation");
  assertEqual(next.revision, previous.revision + 1,
    "successor lease revision");
  const previousSha256 = electronProductionPublicLatestLeaseEventSha256(previous);
  assertEqual(next.acquiredFromEventSha256, previousSha256,
    "successor acquisition-event SHA-256");
  assertEqual(next.previousEventSha256, previousSha256,
    "successor previous-event SHA-256");
  assertTimeDoesNotPrecede(
    next.recordedAt,
    previous.recordedAt,
    "A public-latest lease successor cannot precede its vacancy."
  );
  return next;
}

export function assertElectronProductionPublicLatestLease(value) {
  assertExactKeys(value, [
    "acquiredAt",
    "acquiredFromEventSha256",
    "generation",
    "holder",
    "kind",
    "leaseId",
    "previousEventSha256",
    "purpose",
    "recordedAt",
    "revision",
    "schemaVersion",
    "source",
    "status",
    "target",
    "transactionId",
    "vacantGeneration"
  ], "public-latest lease");
  assertEqual(value.schemaVersion, 1, "public-latest lease schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_KIND,
    "public-latest lease kind");
  const transactionId = requiredUuid(value.transactionId,
    "public-latest transaction ID");
  const leaseId = requiredUuid(value.leaseId, "public-latest lease ID");
  const vacantGeneration = requiredVacantGeneration(value.vacantGeneration);
  const generation = requiredLeaseGeneration(value.generation);
  if (generation !== vacantGeneration + 1) {
    throw new Error(
      "The public-latest lease generation must immediately follow its explicit vacancy."
    );
  }
  if (!LEASE_STATUSES.has(value.status)) {
    throw new Error("The public-latest lease status is invalid.");
  }
  const purpose = assertPurpose(value.purpose);
  const holder = assertHolder(value.holder, purpose);
  const source = assertState(value.source, "source");
  const target = assertState(value.target, "target");
  assertPurposeStateTransition(purpose, source, target);
  if (source.stateSha256 === target.stateSha256) {
    throw new Error("The public-latest source and target states must be distinct.");
  }
  const revision = requiredPositiveInteger(value.revision,
    "public-latest lease revision");
  const acquiredAt = requiredRfc3339(value.acquiredAt,
    "public-latest lease acquisition time");
  const recordedAt = requiredRfc3339(value.recordedAt,
    "public-latest lease event time");
  const normalized = {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_KIND,
    transactionId,
    leaseId,
    vacantGeneration,
    generation,
    status: value.status,
    purpose,
    holder,
    source,
    target,
    revision,
    acquiredFromEventSha256: optionalDigest(
      value.acquiredFromEventSha256,
      "public-latest lease acquisition-event SHA-256"
    ),
    previousEventSha256: optionalDigest(
      value.previousEventSha256,
      "public-latest lease previous-event SHA-256"
    ),
    acquiredAt,
    recordedAt
  };
  assertLeaseEventShape(normalized);
  return deepFreeze(normalized);
}

export function electronProductionPublicLatestLeaseEventSha256(value) {
  const lease = assertElectronProductionPublicLatestLease(value);
  return sha256(serializeCanonicalJson(lease));
}

export function serializeElectronProductionPublicLatestLease(value) {
  return serializeCanonicalJson(assertElectronProductionPublicLatestLease(value));
}

export async function writeElectronProductionPublicLatestLease(input) {
  assertExactKeys(input, ["lease", "outputPath"],
    "public-latest lease write input");
  const lease = assertElectronProductionPublicLatestLease(input.lease);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "public-latest lease"
  );
  const source = serializeCanonicalJson(lease);
  await writeExclusive(outputPath, source);
  const reread = await readCanonicalJsonFile(
    outputPath,
    MAX_LEASE_BYTES,
    "public-latest lease"
  );
  assertEqual(reread.sha256, sha256(source),
    "public-latest lease stable reread SHA-256");
  const rereadLease = assertElectronProductionPublicLatestLease(reread.value);
  if (!isDeepStrictEqual(rereadLease, lease)) {
    throw new Error("The public-latest lease changed during its stable reread.");
  }
  return deepFreeze({
    lease: rereadLease,
    leaseIdentity: publicIdentity(outputPath, reread),
    leasePath: outputPath
  });
}

export async function readElectronProductionPublicLatestLease(input) {
  assertExactKeys(input, ["expectedSha256", "leasePath"],
    "public-latest lease read input");
  const file = await readCanonicalJsonFile(
    input.leasePath,
    MAX_LEASE_BYTES,
    "public-latest lease"
  );
  assertEqual(path.basename(input.leasePath),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    "public-latest lease filename");
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256, "public-latest lease SHA-256"),
    "public-latest lease SHA-256"
  );
  return deepFreeze({
    lease: assertElectronProductionPublicLatestLease(file.value),
    leaseIdentity: publicIdentity(input.leasePath, file),
    leasePath: path.resolve(input.leasePath)
  });
}

function assertAcquisitionPredecessor(previousValue, vacantValue, recordedAtValue) {
  const vacantGeneration = requiredVacantGeneration(vacantValue);
  if (previousValue === null) {
    assertEqual(vacantGeneration, GENESIS_VACANT_GENERATION,
      "genesis vacant public-latest lease generation");
    return {
      eventSha256: null,
      leaseId: null,
      revision: 0,
      transactionId: null,
      vacantGeneration
    };
  }
  const previous = assertElectronProductionPublicLatestLease(previousValue);
  if (previous.status !== "released") {
    throw new Error(
      "A public-latest lease can be reacquired only from the exact released record."
    );
  }
  assertEqual(vacantGeneration, previous.generation,
    "reacquired vacant public-latest lease generation");
  if (previous.generation >= MAX_GENERATION) {
    throw new Error("The public-latest lease generation cannot be incremented safely.");
  }
  const recordedAt = requiredRfc3339(recordedAtValue,
    "public-latest lease acquisition time");
  assertTimeDoesNotPrecede(
    recordedAt,
    previous.recordedAt,
    "A public-latest lease acquisition cannot precede its vacancy."
  );
  return {
    eventSha256: electronProductionPublicLatestLeaseEventSha256(previous),
    leaseId: previous.leaseId,
    revision: previous.revision,
    transactionId: previous.transactionId,
    vacantGeneration
  };
}

function assertLeaseEventShape(value) {
  const heldRevision = (value.generation * 2) - 1;
  if (value.status === "held") {
    assertEqual(value.revision, heldRevision, "held public-latest lease revision");
    assertEqual(value.previousEventSha256, value.acquiredFromEventSha256,
      "held public-latest lease predecessor fence");
    assertEqual(value.recordedAt, value.acquiredAt,
      "held public-latest lease acquisition event time");
  } else {
    assertEqual(value.revision, heldRevision + 1,
      "released public-latest lease revision");
    assertTimeDoesNotPrecede(
      value.recordedAt,
      value.acquiredAt,
      "A released public-latest lease cannot precede its acquisition."
    );
    const expectedHeld = {
      ...value,
      status: "held",
      revision: heldRevision,
      previousEventSha256: value.acquiredFromEventSha256,
      recordedAt: value.acquiredAt
    };
    assertEqual(
      value.previousEventSha256,
      sha256(serializeCanonicalJson(expectedHeld)),
      "released public-latest lease previous-event SHA-256"
    );
  }
  if (value.generation === 1) {
    assertEqual(value.acquiredFromEventSha256, null,
      "genesis public-latest lease predecessor");
  } else {
    requiredDigest(value.acquiredFromEventSha256,
      "public-latest lease acquisition-event SHA-256");
  }
}

function assertHolder(value, purpose) {
  assertExactKeys(value, [
    "headSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "public-latest lease holder");
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
    "public-latest lease holder repository");
  assertEqual(value.workflow,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[purpose],
    "public-latest lease holder workflow for purpose");
  return {
    repository: value.repository,
    workflow: value.workflow,
    runId: requiredRunId(value.runId, "public-latest lease holder run ID"),
    runAttempt: requiredPositiveInteger(value.runAttempt,
      "public-latest lease holder run attempt"),
    headSha: requiredCommitSha(value.headSha, "public-latest lease holder head SHA")
  };
}

function assertState(value, label) {
  assertExactKeys(value, ["runtime", "stateSha256", "version"],
    `public-latest lease ${label}`);
  if (value.runtime !== "tauri-v22" && value.runtime !== "electron-v23") {
    throw new Error(`The public-latest lease ${label} runtime is invalid.`);
  }
  return {
    runtime: value.runtime,
    version: requiredSemanticVersion(value.version,
      `public-latest lease ${label} application version`),
    stateSha256: requiredDigest(value.stateSha256,
      `public-latest lease ${label} state SHA-256`)
  };
}

function assertPurposeStateTransition(purpose, source, target) {
  const expectedTargetRuntime = purpose === "electron-v23-provisional-publication"
    ? "electron-v23"
    : "tauri-v22";
  if (purpose !== "tauri-v22-latest-restore") {
    assertEqual(source.runtime, "tauri-v22",
      "public-latest lease source runtime for purpose");
  }
  assertEqual(target.runtime, expectedTargetRuntime,
    "public-latest lease target runtime for purpose");
  if (purpose !== "tauri-v22-latest-restore") {
    assertSemanticVersionIsNewer(
      target.version,
      source.version,
      "public-latest lease target application version"
    );
  }
}

function assertPurpose(value) {
  if (typeof value !== "string" ||
      !Object.hasOwn(ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS, value)) {
    throw new Error("The public-latest lease purpose is invalid.");
  }
  return value;
}

function requiredVacantGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_GENERATION) {
    throw new Error(
      "The vacant public-latest lease generation must be safely incrementable."
    );
  }
  return value;
}

function requiredLeaseGeneration(value) {
  const generation = requiredPositiveInteger(value, "public-latest lease generation");
  if (generation > MAX_GENERATION) {
    throw new Error("The public-latest lease generation is too large for its revision chain.");
  }
  return generation;
}

function optionalDigest(value, label) {
  return value === null ? null : requiredDigest(value, label);
}

function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal GitHub run ID.`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function assertTimeDoesNotPrecede(actual, previous, message) {
  if (Date.parse(actual) < Date.parse(previous)) throw new Error(message);
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
