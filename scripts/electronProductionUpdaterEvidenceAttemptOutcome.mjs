import { createHash } from "node:crypto";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND =
  "rion-production-updater-evidence-attempt-outcome";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE =
  "electron-production-updater-evidence-attempt-outcome.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW =
  ".github/workflows/electron-production-updater-evidence.yml";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY =
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_MAX_BYTES =
  64 * 1024;

const OUTCOMES = Object.freeze(["failed", "cancelled", "indeterminate"]);
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const RECEIPT_KEYS = Object.freeze([
  "attemptPlanSha256",
  "cell",
  "cutoverEligible",
  "deadlineUsedAsSuccess",
  "kind",
  "observationArtifact",
  "observedAt",
  "outcome",
  "producer",
  "reasonCode",
  "schemaVersion",
  "sourceInstallAttemptId",
  "sourceUpdaterInvoked",
  "terminal"
]);

export function electronProductionUpdaterEvidenceAttemptOutcomeArtifactName(input) {
  assertExactKeys(input, ["cell", "runAttempt", "runId"],
    "updater evidence attempt-outcome artifact-name input");
  const cell = assertCell(input.cell);
  const runId = requiredRunId(input.runId, "updater evidence producer run ID");
  const runAttempt = requiredPositiveInteger(
    input.runAttempt,
    "updater evidence producer run attempt"
  );
  return "electron-production-updater-evidence-attempt-outcome-" +
    `${cell.transitionKind}-${cell.platform}-${cell.evidenceAttemptId}` +
    `-run-${runId}-attempt-${runAttempt}`;
}

export async function createElectronProductionUpdaterEvidenceAttemptOutcome(input) {
  assertExactKeys(input, [
    "attemptPlanSha256",
    "cell",
    "deadlineUsedAsSuccess",
    "observationArtifact",
    "observedAt",
    "outcome",
    "outputPath",
    "producer",
    "reasonCode",
    "sourceInstallAttemptId",
    "sourceUpdaterInvoked"
  ], "updater evidence attempt-outcome create input");
  const value = assertElectronProductionUpdaterEvidenceAttemptOutcome({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND,
    cutoverEligible: false,
    terminal: true,
    outcome: input.outcome,
    deadlineUsedAsSuccess: input.deadlineUsedAsSuccess,
    cell: input.cell,
    attemptPlanSha256: input.attemptPlanSha256,
    producer: input.producer,
    sourceUpdaterInvoked: input.sourceUpdaterInvoked,
    sourceInstallAttemptId: input.sourceInstallAttemptId,
    reasonCode: input.reasonCode,
    observedAt: input.observedAt,
    observationArtifact: input.observationArtifact
  });
  const source = serializeCanonicalJson(value);
  if (source.length > ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_MAX_BYTES) {
    throw new Error("The updater evidence attempt outcome exceeds its byte limit.");
  }
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE,
    "updater evidence attempt-outcome receipt"
  );
  await writeExclusive(outputPath, source);
  return readElectronProductionUpdaterEvidenceAttemptOutcome({
    expectedSha256: sha256Source(source),
    receiptPath: outputPath
  });
}

export function assertElectronProductionUpdaterEvidenceAttemptOutcome(value) {
  assertExactKeys(value, RECEIPT_KEYS, "updater evidence attempt-outcome receipt");
  assertEqual(value.schemaVersion, 1,
    "updater evidence attempt-outcome schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND,
    "updater evidence attempt-outcome kind"
  );
  assertEqual(value.cutoverEligible, false,
    "updater evidence attempt-outcome cutover eligibility");
  assertEqual(value.terminal, true,
    "updater evidence attempt-outcome terminality");
  const outcome = requiredEnum(
    value.outcome,
    OUTCOMES,
    "updater evidence attempt outcome"
  );
  assertEqual(value.deadlineUsedAsSuccess, false,
    "updater evidence attempt-outcome deadline-as-success flag");
  const cell = assertCell(value.cell);
  const attemptPlanSha256 = requiredDigest(
    value.attemptPlanSha256,
    "updater evidence attempt-plan SHA-256"
  );
  const producer = assertProducer(value.producer, cell);
  const sourceUpdaterInvoked = requiredBoolean(
    value.sourceUpdaterInvoked,
    "updater evidence source-updater invocation"
  );
  const sourceInstallAttemptId = requiredSourceInstallAttemptId(
    value.sourceInstallAttemptId,
    cell.transitionKind
  );
  if (!sourceUpdaterInvoked && sourceInstallAttemptId !== null) {
    throw new Error(
      "A source install attempt ID requires source-updater invocation."
    );
  }
  const reasonCode = requiredReasonCode(value.reasonCode);
  const observedAt = requiredRfc3339(
    value.observedAt,
    "updater evidence attempt-outcome observation time"
  );
  const observationArtifact = value.observationArtifact === null
    ? null
    : assertObservationArtifact(value.observationArtifact);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND,
    cutoverEligible: false,
    terminal: true,
    outcome,
    deadlineUsedAsSuccess: false,
    cell,
    attemptPlanSha256,
    producer,
    sourceUpdaterInvoked,
    sourceInstallAttemptId,
    reasonCode,
    observedAt,
    observationArtifact
  });
}

export function serializeElectronProductionUpdaterEvidenceAttemptOutcome(value) {
  return serializeCanonicalJson(
    assertElectronProductionUpdaterEvidenceAttemptOutcome(value)
  );
}

export async function readElectronProductionUpdaterEvidenceAttemptOutcome(input) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "updater evidence attempt-outcome read input");
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "updater evidence attempt-outcome receipt path"
  );
  assertEqual(
    path.basename(receiptPath),
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE,
    "updater evidence attempt-outcome receipt filename"
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_MAX_BYTES,
    "updater evidence attempt-outcome receipt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(
      input.expectedSha256,
      "updater evidence attempt-outcome receipt SHA-256"
    ),
    "updater evidence attempt-outcome receipt SHA-256"
  );
  const value = assertElectronProductionUpdaterEvidenceAttemptOutcome(file.value);
  if (!file.source.equals(serializeCanonicalJson(value))) {
    throw new Error("The updater evidence attempt-outcome receipt must be canonical.");
  }
  return deepFreeze({
    value,
    valueIdentity: publicIdentity(receiptPath, file),
    valuePath: receiptPath
  });
}

function assertCell(value) {
  assertExactKeys(value, ["evidenceAttemptId", "platform", "transitionKind"],
    "updater evidence attempt-outcome cell");
  return {
    transitionKind: requiredEnum(
      value.transitionKind,
      TRANSITIONS,
      "updater evidence transition"
    ),
    platform: requiredEnum(value.platform, PLATFORMS, "updater evidence platform"),
    evidenceAttemptId: requiredUuid(
      value.evidenceAttemptId,
      "updater evidence attempt ID"
    )
  };
}

function assertProducer(value, cell) {
  assertExactKeys(value, [
    "artifactName",
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "updater evidence attempt-outcome producer");
  assertEqual(
    value.repository,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY,
    "updater evidence producer repository"
  );
  assertEqual(
    value.workflow,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW,
    "updater evidence producer workflow"
  );
  const runId = requiredRunId(value.runId, "updater evidence producer run ID");
  const runAttempt = requiredPositiveInteger(
    value.runAttempt,
    "updater evidence producer run attempt"
  );
  const controlSha = requiredCommitSha(
    value.controlSha,
    "updater evidence producer control SHA"
  );
  const artifactName = electronProductionUpdaterEvidenceAttemptOutcomeArtifactName({
    cell,
    runId,
    runAttempt
  });
  assertEqual(
    value.artifactName,
    artifactName,
    "updater evidence producer artifact name"
  );
  return {
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY,
    workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW,
    runId,
    runAttempt,
    controlSha,
    artifactName
  };
}

function assertObservationArtifact(value) {
  assertExactKeys(value, ["bytes", "fileName", "sha256"],
    "updater evidence attempt-outcome observation artifact");
  return {
    fileName: requiredFileName(
      value.fileName,
      "updater evidence observation artifact filename"
    ),
    bytes: requiredPositiveInteger(
      value.bytes,
      "updater evidence observation artifact bytes"
    ),
    sha256: requiredDigest(
      value.sha256,
      "updater evidence observation artifact SHA-256"
    )
  };
}

function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,29}$/u.test(value)) {
    throw new Error(`The ${label} must be a bounded positive decimal ID.`);
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

function requiredReasonCode(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,159}$/u.test(value)) {
    throw new Error(
      "The updater evidence attempt-outcome reason code must be a bounded stable code."
    );
  }
  return value;
}

function requiredFileName(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 ||
      value === "." || value === ".." || path.basename(value) !== value ||
      value.includes("\\") || value.includes("\0")) {
    throw new Error(`The ${label} must be a bounded direct filename.`);
  }
  return value;
}

function requiredSourceInstallAttemptId(value, transitionKind) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("The source install attempt ID must be null or a string.");
  }
  if (transitionKind === "tauri-v22-to-electron-v23") {
    const match = /^update-install-([1-9][0-9]*)$/u.exec(value);
    const maximum = "18446744073709551615";
    if (!match || match[1].length > maximum.length ||
        (match[1].length === maximum.length && match[1] > maximum)) {
      throw new Error(
        "The Tauri v22 source install attempt ID must be update-install-<u64>."
      );
    }
    return value;
  }
  const prefix = "update-install-";
  if (!value.startsWith(prefix)) {
    throw new Error(
      "The Electron v23 source install attempt ID must contain an RFC 9562 UUID."
    );
  }
  requiredUuid(
    value.slice(prefix.length),
    "Electron v23 source install attempt ID"
  );
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`The ${label} must be boolean.`);
  return value;
}

function requiredEnum(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`The ${label} is unsupported.`);
  return value;
}

function sha256Source(source) {
  return createHash("sha256").update(source).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
