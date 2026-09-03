import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW,
  readElectronProductionUpdaterEvidenceBundle
} from "./electronProductionUpdaterEvidenceBundle.mjs";
import {
  assertEqual,
  assertExactKeys,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_REPOSITORY =
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_TRANSITIONS = Object.freeze([
  "electron-v23-to-electron-v23",
  "tauri-v22-to-electron-v23"
]);
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_PLATFORMS = Object.freeze([
  "darwin-aarch64",
  "windows-x86_64"
]);

const MAX_CHALLENGE_MILLISECONDS = 24 * 60 * 60 * 1000;
const SHARED_TARGET_KEYS = Object.freeze([
  "candidateReceiptSha256",
  "embeddedUpdaterEndpoint",
  "manifestName",
  "runtime",
  "servedManifestSha256",
  "sourceSha",
  "version"
]);

export async function readElectronProductionUpdaterEvidenceAggregate(input) {
  assertExactKeys(input, [
    "aggregateRoot",
    "expectedChallenge",
    "expectedCells",
    "expectedProvenance",
    "expectedSources",
    "expectedTarget"
  ], "updater evidence aggregate read input");
  const expectedTarget = assertExpectedTarget(input.expectedTarget);
  const expectedProvenance = assertExpectedProvenance(
    input.expectedProvenance,
    expectedTarget
  );
  const expectedSources = assertExpectedSources(input.expectedSources);
  const expectedChallenge = assertExpectedChallenge(input.expectedChallenge);
  const expectedCells = assertExpectedCells(input.expectedCells);
  const aggregate = await captureDirectory(
    input.aggregateRoot,
    "updater evidence aggregate root"
  );
  await assertExactDirectoryNames(
    aggregate.path,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_TRANSITIONS,
    "updater evidence aggregate root"
  );

  const bundles = {};
  const receiptSha256 = {};
  const evidenceAttemptIds = new Set();
  let sharedTarget = null;
  let sharedTrustSha256 = null;
  const platformTargets = new Map();
  for (const transition of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_TRANSITIONS) {
    const transitionDirectory = await captureDirectory(
      join(aggregate.path, transition),
      `${transition} evidence directory`
    );
    await assertExactDirectoryNames(
      transitionDirectory.path,
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_PLATFORMS,
      `${transition} evidence directory`
    );
    bundles[transition] = {};
    receiptSha256[transition] = {};
    for (const platform of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_PLATFORMS) {
      const bundle = await readElectronProductionUpdaterEvidenceBundle({
        outputRoot: join(transitionDirectory.path, platform)
      });
      const receipt = bundle.receipt;
      assertEqual(receipt.transitionKind, transition, "aggregate transition slot");
      assertEqual(receipt.platform, platform, "aggregate platform slot");
      assertDeepEqual(receipt.challenge, expectedChallenge, "aggregate challenge");
      assertDeepEqual(receipt.producer, expectedProvenance, "aggregate provenance");
      assertEqual(receipt.target.sourceSha, expectedTarget.sourceSha,
        "aggregate target source SHA");
      assertEqual(receipt.target.version, expectedTarget.version,
        "aggregate target version");
      assertEqual(receipt.target.candidateReceiptSha256,
        expectedTarget.candidateReceiptSha256,
        "aggregate target candidate receipt SHA-256");
      assertTransitionSource(receipt.source, transition, expectedSources);
      const evidenceAttemptId = requiredUuid(
        receipt.transaction.evidenceAttemptId,
        "aggregate evidence attempt ID"
      );
      assertEqual(
        evidenceAttemptId,
        expectedCells[transition][platform],
        `${transition} ${platform} planned evidence attempt ID`
      );
      if (evidenceAttemptIds.has(evidenceAttemptId)) {
        throw new Error("The four updater evidence attempt IDs must be unique.");
      }
      evidenceAttemptIds.add(evidenceAttemptId);
      const target = sharedTargetFields(receipt.target);
      if (sharedTarget === null) sharedTarget = target;
      else assertDeepEqual(target, sharedTarget, "aggregate shared target binding");
      const trustSha256 = requiredDigest(
        receipt.trust.updaterPublicKeySha256,
        "aggregate updater public-key SHA-256"
      );
      if (sharedTrustSha256 === null) sharedTrustSha256 = trustSha256;
      else assertEqual(trustSha256, sharedTrustSha256,
        "aggregate updater public-key SHA-256");
      const platformTarget = platformTargetFields(receipt);
      if (!platformTargets.has(platform)) platformTargets.set(platform, platformTarget);
      else assertDeepEqual(
        platformTarget,
        platformTargets.get(platform),
        `${platform} aggregate target binding`
      );
      bundles[transition][platform] = bundle;
      receiptSha256[transition][platform] = bundle.receiptSha256;
    }
    await assertDirectoryUnchanged(transitionDirectory);
  }
  await assertExactDirectoryNames(
    aggregate.path,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_TRANSITIONS,
    "updater evidence aggregate root"
  );
  await assertDirectoryUnchanged(aggregate);
  return deepFreeze({
    aggregateRoot: aggregate.path,
    bundles,
    challenge: expectedChallenge,
    cells: expectedCells,
    evidenceAttemptIds: [...evidenceAttemptIds].sort(),
    producer: expectedProvenance,
    sources: expectedSources,
    receiptSha256,
    target: sharedTarget,
    trust: { updaterPublicKeySha256: sharedTrustSha256 }
  });
}

function assertExpectedCells(value) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("The aggregate expected cells must contain exactly four entries.");
  }
  const expectedCoordinates = [
    ["tauri-v22-to-electron-v23", "darwin-aarch64"],
    ["tauri-v22-to-electron-v23", "windows-x86_64"],
    ["electron-v23-to-electron-v23", "darwin-aarch64"],
    ["electron-v23-to-electron-v23", "windows-x86_64"]
  ];
  const cells = {};
  const identifiers = new Set();
  value.forEach((cell, index) => {
    const label = `aggregate expected cell ${index + 1}`;
    assertExactKeys(cell, ["evidenceAttemptId", "platform", "transitionKind"], label);
    const [transitionKind, platform] = expectedCoordinates[index];
    assertEqual(cell.transitionKind, transitionKind, `${label} transition`);
    assertEqual(cell.platform, platform, `${label} platform`);
    const evidenceAttemptId = requiredUuid(cell.evidenceAttemptId, `${label} attempt ID`);
    if (identifiers.has(evidenceAttemptId)) {
      throw new Error("The aggregate expected cell attempt IDs must be unique.");
    }
    identifiers.add(evidenceAttemptId);
    cells[transitionKind] ??= {};
    cells[transitionKind][platform] = evidenceAttemptId;
  });
  return deepFreeze(cells);
}

function assertExpectedTarget(value) {
  assertExactKeys(value, [
    "candidateReceiptSha256",
    "sourceSha",
    "version"
  ], "aggregate expected target");
  return Object.freeze({
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      "aggregate target candidate receipt SHA-256"
    ),
    sourceSha: requiredCommitSha(value.sourceSha, "aggregate target source SHA"),
    version: requiredSemanticVersion(value.version, "aggregate target version")
  });
}

function assertExpectedSources(value) {
  assertExactKeys(value, ["priorV23", "tauriV22"], "aggregate expected sources");
  assertExactKeys(value.tauriV22, ["sourceSha", "version"],
    "aggregate expected Tauri source");
  assertExactKeys(value.priorV23, [
    "candidateReceiptSha256",
    "sourceSha",
    "version"
  ], "aggregate expected prior-v23 source");
  return deepFreeze({
    priorV23: {
      candidateReceiptSha256: requiredDigest(
        value.priorV23.candidateReceiptSha256,
        "aggregate prior-v23 candidate receipt SHA-256"
      ),
      sourceSha: requiredCommitSha(value.priorV23.sourceSha,
        "aggregate prior-v23 source SHA"),
      version: requiredSemanticVersion(value.priorV23.version,
        "aggregate prior-v23 version")
    },
    tauriV22: {
      sourceSha: requiredCommitSha(value.tauriV22.sourceSha,
        "aggregate Tauri source SHA"),
      version: requiredSemanticVersion(value.tauriV22.version,
        "aggregate Tauri version")
    }
  });
}

function assertExpectedProvenance(value, target) {
  assertExactKeys(value, [
    "artifactName",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "workflow"
  ], "aggregate expected provenance");
  const runAttempt = requiredPositiveInteger(
    value.runAttempt,
    "aggregate evidence run attempt"
  );
  const sourceSha = requiredCommitSha(
    value.sourceSha,
    "aggregate evidence target source SHA"
  );
  assertEqual(sourceSha, target.sourceSha, "aggregate provenance target source SHA");
  const expectedArtifactName =
    `electron-production-updater-terminal-evidence-${target.version}-${sourceSha}` +
    `-attempt-${runAttempt}`;
  assertEqual(value.artifactName, expectedArtifactName,
    "aggregate evidence artifact name");
  assertEqual(value.repository, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_REPOSITORY,
    "aggregate evidence repository");
  assertEqual(value.workflow, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW,
    "aggregate evidence workflow");
  return Object.freeze({
    artifactName: expectedArtifactName,
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_REPOSITORY,
    runAttempt,
    runId: requiredRunId(value.runId, "aggregate evidence run ID"),
    sourceSha,
    workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW
  });
}

function assertExpectedChallenge(value) {
  assertExactKeys(value, [
    "expiresAt",
    "id",
    "issuedAt",
    "nonceSha256"
  ], "aggregate expected challenge");
  const challenge = Object.freeze({
    expiresAt: requiredRfc3339(value.expiresAt, "aggregate challenge expiry"),
    id: requiredUuid(value.id, "aggregate challenge ID"),
    issuedAt: requiredRfc3339(value.issuedAt, "aggregate challenge issue time"),
    nonceSha256: requiredDigest(
      value.nonceSha256,
      "aggregate challenge nonce SHA-256"
    )
  });
  const duration = Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt);
  if (duration <= 0 || duration > MAX_CHALLENGE_MILLISECONDS) {
    throw new Error("The aggregate challenge lifetime must be positive and at most 24 hours.");
  }
  return challenge;
}

function assertTransitionSource(source, transition, expectedSources) {
  const expected = transition === "tauri-v22-to-electron-v23"
    ? ["tauri-v22", "published-release"]
    : ["electron-v23", "production-candidate"];
  assertEqual(source.runtime, expected[0], `${transition} source runtime`);
  assertEqual(source.lineageKind, expected[1], `${transition} source lineage`);
  const expectedIdentity = transition === "tauri-v22-to-electron-v23"
    ? expectedSources.tauriV22
    : expectedSources.priorV23;
  assertEqual(source.sourceSha, expectedIdentity.sourceSha,
    `${transition} source SHA`);
  assertEqual(source.version, expectedIdentity.version,
    `${transition} source version`);
  if (transition === "electron-v23-to-electron-v23") {
    assertEqual(source.candidateReceiptSha256,
      expectedIdentity.candidateReceiptSha256,
      `${transition} candidate receipt SHA-256`);
  }
}

function sharedTargetFields(target) {
  return Object.freeze(Object.fromEntries(
    SHARED_TARGET_KEYS.map((key) => [key, target[key]])
  ));
}

function platformTargetFields(receipt) {
  return Object.freeze({
    artifactName: receipt.target.artifactName,
    artifactSha256: receipt.target.artifactSha256,
    signatureName: receipt.target.signatureName,
    signatureSha256: receipt.target.signatureSha256,
    targetRunningImageSha256: receipt.transaction.targetRunningImageSha256
  });
}

async function captureDirectory(value, label) {
  const requested = requiredAbsolutePath(value, label);
  const metadata = await lstat(requested, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const path = await realpath(requested);
  const resolved = await lstat(path, { bigint: true });
  assertSameDirectory(metadata, resolved, label);
  return Object.freeze({ metadata, path });
}

async function assertExactDirectoryNames(directory, expected, label) {
  const names = (await readdir(directory)).sort();
  const sortedExpected = [...expected].sort();
  if (!isDeepStrictEqual(names, sortedExpected)) {
    throw new Error(`The ${label} inventory is not exact.`);
  }
}

async function assertDirectoryUnchanged(directory) {
  const observed = await lstat(directory.path, { bigint: true });
  assertSameDirectory(directory.metadata, observed, "updater evidence aggregate directory");
}

function assertSameDirectory(expected, observed, label) {
  if (
    !observed.isDirectory() || observed.isSymbolicLink() ||
    expected.dev !== observed.dev || expected.ino !== observed.ino ||
    expected.mode !== observed.mode || expected.mtimeNs !== observed.mtimeNs ||
    expected.ctimeNs !== observed.ctimeNs
  ) throw new Error(`The ${label} identity changed while read.`);
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
