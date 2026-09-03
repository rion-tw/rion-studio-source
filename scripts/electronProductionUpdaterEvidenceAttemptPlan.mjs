import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertSemanticVersionIsNewer,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND =
  "rion-electron-production-updater-evidence-attempt-plan";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND =
  "rion-electron-production-updater-evidence-attempt-plan-bindings";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE =
  "electron-production-updater-evidence-attempt-plan.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_WORKFLOW =
  ".github/workflows/electron-production-updater-evidence.yml";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY =
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_TRANSITIONS =
  Object.freeze([
    "tauri-v22-to-electron-v23",
    "electron-v23-to-electron-v23"
  ]);
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_PLATFORMS =
  Object.freeze(["darwin-aarch64", "windows-x86_64"]);

const CANDIDATE_WORKFLOW =
  ".github/workflows/electron-production-candidate.yml";
const TAURI_V22_LINEAGE_WORKFLOW =
  ".github/workflows/electron-updater-tauri-v22-compatibility.yml";
const PROVISIONAL_PUBLICATION_WORKFLOW =
  ".github/workflows/electron-production-provisional-publish.yml";
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_BINDINGS_BYTES = 1024 * 1024;
const CHALLENGE_NONCE_BYTES = 32;
const CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function createElectronProductionUpdaterEvidenceAttemptPlan(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, ["bindings", "challengeNonce", "outputPath"],
    "updater evidence attempt-plan create input");
  const bindings = assertElectronProductionUpdaterEvidenceAttemptPlanBindings(
    input.bindings
  );
  const challengeNonce = requiredChallengeNonce(input.challengeNonce);
  const dependencies = resolveDependencies(dependencyOverrides);
  const issuedAtDate = requiredCurrentDate(dependencies.now());
  const issuedAt = issuedAtDate.toISOString();
  const expiresAt = new Date(
    issuedAtDate.getTime() + CHALLENGE_LIFETIME_MS
  ).toISOString();
  const identifiers = createUniqueIdentifiers(dependencies.randomUuid);
  const cells = expectedCellCoordinates().map((coordinate, index) => ({
    ...coordinate,
    evidenceAttemptId: identifiers[index + 1]
  }));
  const plan = assertElectronProductionUpdaterEvidenceAttemptPlan({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND,
    producer: bindings.producer,
    upstream: bindings.upstream,
    challenge: {
      expiresAt,
      id: identifiers[0],
      issuedAt,
      nonceSha256: createHash("sha256").update(challengeNonce).digest("hex")
    },
    cells
  }, { now: issuedAtDate });
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE,
    "updater evidence attempt-plan output"
  );
  await writeExclusive(outputPath, serializeCanonicalJson(plan));
  return readElectronProductionUpdaterEvidenceAttemptPlan(
    { planPath: outputPath },
    { now: () => issuedAtDate }
  );
}

export async function readElectronProductionUpdaterEvidenceAttemptPlan(
  input,
  dependencyOverrides = {}
) {
  assertOptionalExpectedDigestInput(input);
  const planPath = requiredAbsolutePath(
    input.planPath,
    "updater evidence attempt-plan"
  );
  assertEqual(
    path.basename(planPath),
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE,
    "updater evidence attempt-plan filename"
  );
  const file = await readCanonicalJsonFile(
    planPath,
    MAX_PLAN_BYTES,
    "updater evidence attempt-plan"
  );
  if (input.expectedSha256 !== undefined) {
    assertEqual(
      file.sha256,
      requiredDigest(input.expectedSha256, "updater evidence attempt-plan SHA-256"),
      "updater evidence attempt-plan SHA-256"
    );
  }
  const now = requiredCurrentDate(resolveDependencies(dependencyOverrides).now());
  return deepFreeze({
    plan: assertElectronProductionUpdaterEvidenceAttemptPlan(file.value, { now }),
    planIdentity: publicIdentity(planPath, file),
    planPath
  });
}

export async function readElectronProductionUpdaterEvidenceAttemptPlanBindings(
  bindingsPath
) {
  const file = await readCanonicalJsonFile(
    bindingsPath,
    MAX_BINDINGS_BYTES,
    "updater evidence attempt-plan bindings"
  );
  return deepFreeze({
    bindings: assertElectronProductionUpdaterEvidenceAttemptPlanBindings(file.value),
    bindingsIdentity: publicIdentity(bindingsPath, file),
    bindingsPath: requiredAbsolutePath(
      bindingsPath,
      "updater evidence attempt-plan bindings"
    )
  });
}

export async function readElectronProductionUpdaterEvidenceChallengeNonce(
  noncePath
) {
  const file = await readStableFile(
    noncePath,
    CHALLENGE_NONCE_BYTES,
    "updater evidence challenge nonce"
  );
  return requiredChallengeNonce(file.source);
}

export function assertElectronProductionUpdaterEvidenceAttemptPlanBindings(value) {
  assertExactKeys(value, ["kind", "producer", "schemaVersion", "upstream"],
    "updater evidence attempt-plan bindings");
  assertEqual(value.schemaVersion, 1,
    "updater evidence attempt-plan bindings schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
    "updater evidence attempt-plan bindings kind");
  const upstream = assertUpstream(value.upstream);
  const producer = assertProducer(value.producer, upstream.target);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
    producer,
    upstream
  });
}

export function assertElectronProductionUpdaterEvidenceAttemptPlan(
  value,
  options = {}
) {
  assertExactKeys(value, [
    "cells",
    "challenge",
    "kind",
    "producer",
    "schemaVersion",
    "upstream"
  ], "updater evidence attempt plan");
  assertEqual(value.schemaVersion, 1, "updater evidence attempt-plan schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND,
    "updater evidence attempt-plan kind");
  const upstream = assertUpstream(value.upstream);
  const producer = assertProducer(value.producer, upstream.target);
  const challenge = assertChallenge(value.challenge, options.now);
  const cells = assertCells(value.cells, challenge.id);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND,
    producer,
    upstream,
    challenge,
    cells
  });
}

function assertProducer(value, target) {
  assertExactKeys(value, [
    "aggregateArtifactName",
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "updater evidence attempt-plan producer");
  const runAttempt = requiredPositiveInteger(
    value.runAttempt,
    "updater evidence producer run attempt"
  );
  const expectedArtifactName =
    `electron-production-updater-terminal-evidence-${target.version}-` +
    `${target.sourceSha}-attempt-${runAttempt}`;
  assertEqual(value.aggregateArtifactName, expectedArtifactName,
    "updater evidence aggregate artifact name");
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    "updater evidence producer repository");
  assertEqual(value.workflow,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_WORKFLOW,
    "updater evidence producer workflow");
  return Object.freeze({
    aggregateArtifactName: expectedArtifactName,
    controlSha: requiredCommitSha(value.controlSha,
      "updater evidence producer control SHA"),
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    runAttempt,
    runId: requiredRunId(value.runId, "updater evidence producer run ID"),
    workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_WORKFLOW
  });
}

function assertUpstream(value) {
  assertExactKeys(value, [
    "priorV23",
    "provisionalPublication",
    "tauriV22",
    "target"
  ], "updater evidence attempt-plan upstream identities");
  const target = assertCandidateIdentity(value.target, "target");
  const priorV23 = assertCandidateIdentity(value.priorV23, "prior-v23");
  assertSemanticVersionIsNewer(
    target.version,
    priorV23.version,
    "updater evidence target candidate version"
  );
  if (target.sourceSha === priorV23.sourceSha ||
      target.candidateReceiptSha256 === priorV23.candidateReceiptSha256) {
    throw new Error("The target and prior-v23 candidate identities must be distinct.");
  }
  const tauriV22 = assertTauriIdentity(value.tauriV22, target);
  assertSemanticVersionIsNewer(
    target.version,
    tauriV22.version,
    "updater evidence target versus Tauri v22 version"
  );
  const provisionalPublication = assertProvisionalIdentity(
    value.provisionalPublication,
    target
  );
  return deepFreeze({ target, priorV23, tauriV22, provisionalPublication });
}

function assertCandidateIdentity(value, label) {
  assertExactKeys(value, [
    "artifactName",
    "candidateReceiptSha256",
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "trustedControlReceiptSha256",
    "version",
    "workflow"
  ], `${label} candidate identity`);
  const sourceSha = requiredCommitSha(value.sourceSha, `${label} source SHA`);
  const version = requiredSemanticVersion(value.version, `${label} version`);
  const runAttempt = requiredPositiveInteger(value.runAttempt, `${label} run attempt`);
  const expectedArtifactName =
    `electron-production-candidate-${version}-${sourceSha}-attempt-${runAttempt}`;
  assertEqual(value.artifactName, expectedArtifactName, `${label} artifact name`);
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    `${label} repository`);
  assertEqual(value.workflow, CANDIDATE_WORKFLOW, `${label} workflow`);
  return Object.freeze({
    artifactName: expectedArtifactName,
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      `${label} candidate receipt SHA-256`
    ),
    controlSha: requiredCommitSha(value.controlSha, `${label} control SHA`),
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    runAttempt,
    runId: requiredRunId(value.runId, `${label} run ID`),
    sourceSha,
    trustedControlReceiptSha256: requiredDigest(
      value.trustedControlReceiptSha256,
      `${label} trusted-control receipt SHA-256`
    ),
    version,
    workflow: CANDIDATE_WORKFLOW
  });
}

function assertTauriIdentity(value, target) {
  assertExactKeys(value, [
    "artifacts",
    "controlSha",
    "releaseTag",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "targetSourceSha",
    "version",
    "workflow"
  ], "Tauri v22 upstream identity");
  const runId = requiredRunId(value.runId, "Tauri v22 lineage run ID");
  const runAttempt = requiredPositiveInteger(
    value.runAttempt,
    "Tauri v22 lineage run attempt"
  );
  const version = requiredSemanticVersion(value.version, "Tauri v22 version");
  assertEqual(value.releaseTag, `v${version}`, "Tauri v22 release tag");
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    "Tauri v22 lineage repository");
  assertEqual(value.workflow, TAURI_V22_LINEAGE_WORKFLOW,
    "Tauri v22 lineage workflow");
  assertEqual(value.targetSourceSha, target.sourceSha,
    "Tauri v22 lineage target source SHA");
  assertExactKeys(value.artifacts,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_PLATFORMS,
    "Tauri v22 lineage artifacts");
  const artifacts = {};
  const receiptDigests = new Set();
  for (const platform of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_PLATFORMS) {
    const artifact = value.artifacts[platform];
    assertExactKeys(artifact, ["artifactName", "receiptSha256"],
      `${platform} Tauri v22 lineage artifact`);
    const expectedArtifactName =
      `tauri-v22-public-lineage-${platform}-${runId}-${runAttempt}`;
    assertEqual(artifact.artifactName, expectedArtifactName,
      `${platform} Tauri v22 lineage artifact name`);
    const receiptSha256 = requiredDigest(
      artifact.receiptSha256,
      `${platform} Tauri v22 lineage receipt SHA-256`
    );
    if (receiptDigests.has(receiptSha256)) {
      throw new Error("The Tauri v22 platform lineage receipts must be distinct.");
    }
    receiptDigests.add(receiptSha256);
    artifacts[platform] = Object.freeze({
      artifactName: expectedArtifactName,
      receiptSha256
    });
  }
  return deepFreeze({
    artifacts,
    controlSha: requiredCommitSha(value.controlSha, "Tauri v22 lineage control SHA"),
    releaseTag: `v${version}`,
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    runAttempt,
    runId,
    sourceSha: requiredCommitSha(value.sourceSha, "Tauri v22 source SHA"),
    targetSourceSha: target.sourceSha,
    version,
    workflow: TAURI_V22_LINEAGE_WORKFLOW
  });
}

function assertProvisionalIdentity(value, target) {
  assertExactKeys(value, [
    "artifactName",
    "controlSha",
    "receiptSha256",
    "repository",
    "revision",
    "runAttempt",
    "runId",
    "transactionId",
    "workflow"
  ], "provisional-publication upstream identity");
  const runAttempt = requiredPositiveInteger(
    value.runAttempt,
    "provisional-publication run attempt"
  );
  const expectedArtifactName =
    `electron-production-publication-provisional-${target.version}-` +
    `${target.sourceSha}-attempt-${runAttempt}`;
  assertEqual(value.artifactName, expectedArtifactName,
    "provisional-publication artifact name");
  assertEqual(value.repository,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    "provisional-publication repository");
  assertEqual(value.workflow, PROVISIONAL_PUBLICATION_WORKFLOW,
    "provisional-publication workflow");
  return Object.freeze({
    artifactName: expectedArtifactName,
    controlSha: requiredCommitSha(value.controlSha,
      "provisional-publication control SHA"),
    receiptSha256: requiredDigest(
      value.receiptSha256,
      "provisional-publication receipt SHA-256"
    ),
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY,
    revision: requiredPositiveInteger(
      value.revision,
      "provisional-publication revision"
    ),
    runAttempt,
    runId: requiredRunId(value.runId, "provisional-publication run ID"),
    transactionId: requiredUuid(
      value.transactionId,
      "provisional-publication transaction ID"
    ),
    workflow: PROVISIONAL_PUBLICATION_WORKFLOW
  });
}

function assertChallenge(value, nowValue) {
  assertExactKeys(value, ["expiresAt", "id", "issuedAt", "nonceSha256"],
    "updater evidence attempt-plan challenge");
  const challenge = Object.freeze({
    expiresAt: requiredRfc3339(value.expiresAt, "evidence challenge expiry"),
    id: requiredUuid(value.id, "evidence challenge ID"),
    issuedAt: requiredRfc3339(value.issuedAt, "evidence challenge issue time"),
    nonceSha256: requiredDigest(value.nonceSha256,
      "evidence challenge nonce SHA-256")
  });
  const issuedAt = Date.parse(challenge.issuedAt);
  const expiresAt = Date.parse(challenge.expiresAt);
  const duration = expiresAt - issuedAt;
  if (duration <= 0 || duration > CHALLENGE_LIFETIME_MS) {
    throw new Error("The evidence challenge lifetime must be positive and at most 24 hours.");
  }
  const now = requiredCurrentDate(nowValue ?? new Date()).getTime();
  if (now < issuedAt) {
    throw new Error("The evidence challenge has not been issued yet.");
  }
  if (now >= expiresAt) {
    throw new Error("The evidence challenge is expired.");
  }
  return challenge;
}

function assertCells(value, challengeId) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("The updater evidence attempt plan must contain exactly four cells.");
  }
  const expected = expectedCellCoordinates();
  const identifiers = new Set([challengeId]);
  return Object.freeze(value.map((cell, index) => {
    assertExactKeys(cell, ["evidenceAttemptId", "platform", "transitionKind"],
      `updater evidence attempt-plan cell ${index + 1}`);
    assertEqual(cell.transitionKind, expected[index].transitionKind,
      `updater evidence attempt-plan cell ${index + 1} transition`);
    assertEqual(cell.platform, expected[index].platform,
      `updater evidence attempt-plan cell ${index + 1} platform`);
    const evidenceAttemptId = requiredUuid(
      cell.evidenceAttemptId,
      `updater evidence attempt-plan cell ${index + 1} attempt ID`
    );
    if (identifiers.has(evidenceAttemptId)) {
      throw new Error("The updater evidence challenge and four attempt IDs must be unique.");
    }
    identifiers.add(evidenceAttemptId);
    return Object.freeze({
      evidenceAttemptId,
      platform: expected[index].platform,
      transitionKind: expected[index].transitionKind
    });
  }));
}

function expectedCellCoordinates() {
  return ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_TRANSITIONS.flatMap(
    (transitionKind) =>
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_PLATFORMS.map(
        (platform) => Object.freeze({ platform, transitionKind })
      )
  );
}

function createUniqueIdentifiers(randomUuid) {
  const identifiers = [];
  const unique = new Set();
  for (let index = 0; index < 5; index += 1) {
    const identifier = requiredUuid(
      randomUuid(),
      index === 0 ? "generated challenge ID" : `generated evidence attempt ID ${index}`
    );
    if (unique.has(identifier)) {
      throw new Error("The generated challenge and evidence attempt IDs must be unique.");
    }
    unique.add(identifier);
    identifiers.push(identifier);
  }
  return identifiers;
}

function requiredChallengeNonce(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== CHALLENGE_NONCE_BYTES) {
    throw new Error("The updater evidence challenge nonce must contain exactly 32 raw bytes.");
  }
  return Buffer.from(value);
}

function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal string.`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  return value;
}

function requiredCurrentDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("The updater evidence attempt-plan clock is invalid.");
  }
  return new Date(value.getTime());
}

function resolveDependencies(overrides) {
  return {
    now: overrides.now ?? (() => new Date()),
    randomUuid: overrides.randomUuid ?? randomUUID
  };
}

function assertOptionalExpectedDigestInput(value) {
  const expectedKeys = value?.expectedSha256 === undefined
    ? ["planPath"]
    : ["expectedSha256", "planPath"];
  assertExactKeys(value, expectedKeys, "updater evidence attempt-plan read input");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
