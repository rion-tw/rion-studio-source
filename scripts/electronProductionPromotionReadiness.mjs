import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { verifyElectronProductionCandidateBundle } from
  "./electronProductionCandidateVerifier.mjs";
import { readTrustedControlReceipt } from
  "./electronProductionCandidateTrustedControl.mjs";
import {
  readElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";
import {
  assertEqual,
  assertExactKeys,
  compareSemanticVersions,
  requiredCommitSha,
  requiredDigest
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  assertExactRecord,
  assertNonnegativeInteger,
  assertPositiveInteger,
  requiredHttpsUpdaterEndpoint,
  requiredReleaseTag,
  requiredRfc3339,
  requiredRunId,
  requiredSemanticVersion,
  requiredSourceInstallAttemptId,
  requiredString,
  requiredUuid
} from "./electronProductionPromotionReadinessValidation.mjs";
import {
  assertTauriV22PublicLineagePair,
  readTauriV22PublicLineageReceipt
} from "./tauriV22PublicLineage.mjs";

export const ELECTRON_PRODUCTION_PROMOTION_READINESS_APPROVAL =
  "VERIFY ELECTRON PRODUCTION PROMOTION READINESS";
export const ELECTRON_PRODUCTION_PROMOTION_READINESS_RECEIPT =
  "electron-production-promotion-readiness-receipt.json";
export const ELECTRON_PRODUCTION_EVIDENCE_WORKFLOW =
  ".github/workflows/electron-production-updater-evidence.yml";
export const ELECTRON_PRODUCTION_PROVISIONAL_PUBLICATION_WORKFLOW =
  ".github/workflows/electron-production-provisional-publish.yml";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const MAX_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TAURI_V22_REDIRECTS = 3;
const EVIDENCE_KIND = "rion-production-updater-terminal-transaction";
const TAURI_V22_DEFAULT_UPDATER_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const TAURI_V22_RELEASE_ASSET_HOST = "release-assets.githubusercontent.com";
const RECEIPT_NAME = "terminal-receipt.json";
const TRUSTED_CONTROL_RECEIPT_NAME =
  "electron-production-candidate-trusted-control-receipt.json";
const ATTACHMENT_NAMES = Object.freeze([
  "data-preservation-observation.json",
  "endpoint-observation.json",
  "native-host-observation.json",
  "product-terminal-receipt.json",
  "source-event-stream.jsonl",
  "source-install-journal.json",
  "source-release-snapshot.json",
  "target-terminal-record.json"
]);
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);
const PLATFORM_TARGETS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    nativeHostKind: "appkit-chromium",
    retainedAppKitHost: true
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    nativeHostKind: "bundled-chromium",
    retainedAppKitHost: false
  })
});
const ATTACHMENT_CONTEXT_KEYS = Object.freeze([
  "challenge",
  "evidenceAttemptId",
  "kind",
  "platform",
  "schemaVersion",
  "sourceInstallAttemptId",
  "transitionKind"
]);
const SOURCE_EVENT_SEQUENCE = Object.freeze([
  Object.freeze({ event: "source-updater-invoked", phase: "checking" }),
  Object.freeze({ event: "target-manifest-observed", phase: "checking" }),
  Object.freeze({ event: "target-artifact-verified", phase: "downloaded" }),
  Object.freeze({ event: "source-install-accepted", phase: "accepted" }),
  Object.freeze({ event: "source-install-prepared", phase: "installing" }),
  Object.freeze({ event: "source-drain-started", phase: "draining" }),
  Object.freeze({ event: "source-handoff", phase: null }),
  Object.freeze({ event: "target-first-boot", phase: null }),
  Object.freeze({ event: "target-terminal", phase: "applied" })
]);

export async function verifyElectronProductionPromotionReadiness(input) {
  assertEqual(
    input.ownerApproval,
    ELECTRON_PRODUCTION_PROMOTION_READINESS_APPROVAL,
    "promotion-readiness owner approval"
  );
  const evidenceDirectory = await requiredDirectory(
    input.evidenceDirectory,
    "terminal evidence directory"
  );
  const candidateDirectories = {
    candidate: await requiredDirectory(input.candidateDirectory, "candidate directory"),
    mac: await requiredDirectory(input.macDirectory, "macOS platform candidate directory"),
    priorCandidate: await requiredDirectory(
      input.priorCandidateDirectory,
      "prior Electron candidate directory"
    ),
    priorMac: await requiredDirectory(
      input.priorMacDirectory,
      "prior Electron macOS platform candidate directory"
    ),
    priorWindows: await requiredDirectory(
      input.priorWindowsDirectory,
      "prior Electron Windows platform candidate directory"
    ),
    windows: await requiredDirectory(input.windowsDirectory, "Windows platform candidate directory")
  };
  const outputPath = await resolveCreateNewOutputPath(
    input.outputPath,
    "readiness receipt output path"
  );
  assertPathOutside(outputPath, evidenceDirectory, "terminal evidence directory");
  for (const directory of Object.values(candidateDirectories)) {
    assertPathOutside(outputPath, directory, "candidate evidence");
  }
  const now = input.now instanceof Date ? input.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("The readiness verification time is invalid.");
  const candidate = await verifyElectronProductionCandidateBundle({
    candidateDirectory: candidateDirectories.candidate,
    candidateReceiptPath: input.candidateReceiptPath,
    candidateReceiptSha256: input.candidateReceiptSha256,
    macDirectory: candidateDirectories.mac,
    publicKey: input.publicKey,
    sourceSha: input.sourceSha,
    version: input.version,
    windowsDirectory: candidateDirectories.windows
  });
  const priorCandidate = await verifyElectronProductionCandidateBundle({
    candidateDirectory: candidateDirectories.priorCandidate,
    candidateReceiptPath: input.priorCandidateReceiptPath,
    candidateReceiptSha256: input.priorCandidateReceiptSha256,
    macDirectory: candidateDirectories.priorMac,
    publicKey: input.publicKey,
    sourceSha: input.priorElectronSourceSha,
    version: input.priorElectronVersion,
    windowsDirectory: candidateDirectories.priorWindows
  });
  assertVersionIsNewer(candidate.version, priorCandidate.version);
  const provenance = validateProvenance(input.provenance);
  const [candidateControl, priorCandidateControl] = await Promise.all([
    readClosedTrustedControlReceipt({
      controlPlaneSha: provenance.candidateRunControlSha,
      label: "candidate trusted-control", repository: provenance.repository,
      receiptPath: input.candidateTrustedControlReceiptPath,
      runAttempt: provenance.candidateRunAttempt,
      runId: provenance.candidateRunId,
      sourceSha: candidate.sourceSha, version: candidate.version
    }),
    readClosedTrustedControlReceipt({
      controlPlaneSha: provenance.priorCandidateRunControlSha,
      label: "prior candidate control", repository: provenance.repository,
      receiptPath: input.priorCandidateTrustedControlReceiptPath,
      runAttempt: provenance.priorCandidateRunAttempt,
      runId: provenance.priorCandidateRunId,
      sourceSha: priorCandidate.sourceSha, version: priorCandidate.version
    })
  ]);
  assertTrustedControlCandidate(candidateControl.receipt, candidate, "candidate");
  assertTrustedControlCandidate(priorCandidateControl.receipt, priorCandidate, "prior candidate");
  const expectedChallenge = Object.freeze({
    id: requiredUuid(input.challengeId, "evidence challenge ID"),
    nonceSha256: requiredDigest(input.challengeNonceSha256, "evidence challenge nonce SHA-256")
  });
  const tauriVersion = requiredSemanticVersion(input.tauriVersion, "Tauri v22 version");
  assertVersionIsNewer(candidate.version, tauriVersion);
  const tauriReleaseTag = requiredReleaseTag(input.tauriReleaseTag);
  if (tauriReleaseTag !== `v${tauriVersion}`) {
    throw new Error("The Tauri v22 release tag must exactly match its semantic version.");
  }
  const expectedTauriRelease = Object.freeze({
    releaseTag: tauriReleaseTag,
    sourceSha: requiredCommitSha(input.tauriSourceSha, "Tauri v22 source SHA"),
    version: tauriVersion
  });
  const tauriLineage = {
    macos: await readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: input.tauriLineageReceiptSha256?.["darwin-aarch64"],
      receiptPath: input.tauriLineageReceiptPath?.["darwin-aarch64"]
    }),
    windows: await readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: input.tauriLineageReceiptSha256?.["windows-x86_64"],
      receiptPath: input.tauriLineageReceiptPath?.["windows-x86_64"]
    })
  };
  assertTauriV22PublicLineagePair(tauriLineage);
  assertTauriLineageBindings(tauriLineage, expectedTauriRelease, candidate, provenance);
  const expectedTauri = Object.freeze({
    ...expectedTauriRelease,
    platforms: Object.freeze({
      "darwin-aarch64": tauriLineage.macos,
      "windows-x86_64": tauriLineage.windows
    })
  });
  const provisionalPublication = await readAndVerifyProvisionalPublication({
    candidate,
    expectedTauri,
    provenance,
    receiptPath: input.provisionalPublicationReceiptPath,
    receiptSha256: input.provisionalPublicationReceiptSha256
  });

  const evidence = {};
  const evidenceAttemptIds = new Set();
  let challengeWindow = null;
  await assertExactDirectoryInventory(
    evidenceDirectory,
    TRANSITIONS,
    "terminal evidence aggregate"
  );
  for (const transition of TRANSITIONS) {
    evidence[transition] = {};
    await assertExactDirectoryInventory(
      join(evidenceDirectory, transition),
      PLATFORMS,
      `${transition} terminal evidence`
    );
    for (const platform of PLATFORMS) {
      const directory = await requiredDirectory(
        join(evidenceDirectory, transition, platform),
        `${transition} ${platform} evidence directory`
      );
      const expectedDigest = requiredDigest(
        input.evidenceReceiptSha256?.[transition]?.[platform],
        `${transition} ${platform} receipt SHA-256`
      );
      const verified = await readAndVerifyTerminalEvidence({
        candidate,
        directory,
        expectedChallenge,
        expectedChallengeWindow: challengeWindow,
        expectedDigest,
        expectedPriorCandidate: priorCandidate,
        expectedTauri,
        now,
        platform,
        provenance,
        transition
      });
      if (evidenceAttemptIds.has(verified.receipt.transaction.evidenceAttemptId)) {
        throw new Error("Every terminal updater transaction must use a distinct evidence attempt ID.");
      }
      evidenceAttemptIds.add(verified.receipt.transaction.evidenceAttemptId);
      challengeWindow ??= verified.challengeWindow;
      evidence[transition][platform] = verified;
    }
  }
  assertCrossPlatformSourceLineage(evidence, expectedTauri, candidate.version);
  await assertExactDirectoryInventory(
    evidenceDirectory,
    TRANSITIONS,
    "terminal evidence aggregate"
  );

  const receipt = {
    schemaVersion: 4,
    kind: "rion-electron-production-promotion-readiness",
    status: "verified-terminal-evidence",
    publication: {
      allowedByThisWorkflow: false,
      status: "externally-served-terminal-evidence-observed",
      terminalPromotionReceipt: false
    },
    ownerGate: {
      approval: ELECTRON_PRODUCTION_PROMOTION_READINESS_APPROVAL,
      environment: "electron-production-release"
    },
    candidate: {
      receiptFileName: "electron-production-candidate-receipt.json",
      receiptSha256: candidate.receiptSha256,
      trustedControlReceiptSha256: candidateControl.receiptSha256,
      sourceSha: candidate.sourceSha,
      version: candidate.version,
      updaterBaseUrl: candidate.updaterBaseUrl,
      updaterEndpoint: candidate.updaterEndpoint,
      publicKeySha256: candidate.receipt.publicKeySha256,
      assets: candidate.receipt.assets
    },
    priorElectronCandidate: {
      receiptSha256: priorCandidate.receiptSha256,
      trustedControlReceiptSha256: priorCandidateControl.receiptSha256,
      sourceSha: priorCandidate.sourceSha,
      version: priorCandidate.version,
      updaterEndpoint: priorCandidate.updaterEndpoint,
      publicKeySha256: priorCandidate.receipt.publicKeySha256,
      assets: priorCandidate.receipt.assets
    },
    provisionalPublication,
    tauriV22PublicLineage: summarizeTauriLineage(
      tauriLineage,
      input.tauriLineageReceiptSha256,
      provenance
    ),
    provenance,
    challenge: {
      id: expectedChallenge.id,
      nonceSha256: expectedChallenge.nonceSha256,
      issuedAt: challengeWindow.issuedAt,
      expiresAt: challengeWindow.expiresAt
    },
    evidence: summarizeEvidence(evidence),
    compatibility: {
      macosAppKitRetained: true,
      stableTauriReleasePath: "retained-as-rollback-source-until-terminal-promotion",
      windowsEvidenceIndependent: true
    },
    verifiedAt: now.toISOString()
  };
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze(receipt);
}

async function assertExactDirectoryInventory(directory, expectedNames, label) {
  const actualNames = (await readdir(directory)).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw new Error(`The ${label} inventory must be exact.`);
  }
}

async function readClosedTrustedControlReceipt(input) {
  const receiptPath = resolveRequiredPath(input.receiptPath, `${input.label} receipt`);
  assertEqual(basename(receiptPath), TRUSTED_CONTROL_RECEIPT_NAME,
    `${input.label} receipt file name`);
  const directory = await requiredDirectory(dirname(receiptPath), `${input.label} directory`);
  const names = await readdir(directory);
  if (names.length !== 1 || names[0] !== TRUSTED_CONTROL_RECEIPT_NAME) {
    throw new Error(`The ${input.label} artifact inventory must contain only ${TRUSTED_CONTROL_RECEIPT_NAME}.`);
  }
  return readTrustedControlReceipt({ ...input, receiptPath });
}

function assertTrustedControlCandidate(control, candidate, label) {
  assertEqual(control.candidate.updaterEndpoint, candidate.updaterEndpoint, `${label} updater endpoint`);
  assertEqual(control.updaterTrust.publicKeySha256, candidate.receipt.publicKeySha256, `${label} updater-key SHA-256`);
}

async function readAndVerifyProvisionalPublication(input) {
  const verified = await readElectronProductionPublicationReceipt({
    expectedSha256: input.receiptSha256,
    receiptPath: resolveRequiredPath(input.receiptPath, "provisional publication receipt")
  });
  const receipt = verified.receipt;
  assertEqual(receipt.phase, "provisional", "provisional publication phase");
  assertEqual(receipt.terminal, false, "provisional publication terminality");
  assertEqual(receipt.outcome, null, "provisional publication outcome");
  assertEqual(receipt.publication.acknowledgement, "confirmed", "provisional publication acknowledgement");
  assertEqual(receipt.publication.observedState, "target", "provisional publication observed state");
  assertEqual(receipt.publication.observedStateSha256, receipt.target.stateSha256, "provisional publication target readback");
  const bindings = [
    [receipt.target.candidateReceiptSha256, input.candidate.receiptSha256, "provisional target candidate receipt SHA-256"],
    [receipt.target.sourceSha, input.candidate.sourceSha, "provisional target source SHA"],
    [receipt.target.version, input.candidate.version, "provisional target version"],
    [receipt.target.manifestSha256, input.candidate.receipt.assets["latest.json"], "provisional target manifest SHA-256"],
    [receipt.baseline.sourceSha, input.expectedTauri.sourceSha, "provisional baseline source SHA"],
    [receipt.baseline.version, input.expectedTauri.version, "provisional baseline version"],
    [receipt.baseline.releaseTag, input.expectedTauri.releaseTag, "provisional baseline release tag"],
    [receipt.baseline.manifestSha256,
      input.expectedTauri.platforms["darwin-aarch64"].assets.manifest.sha256,
      "provisional baseline manifest SHA-256"]
  ];
  for (const [actual, expected, label] of bindings) assertEqual(actual, expected, label);
  return Object.freeze({
    receiptFileName: verified.receiptIdentity.fileName,
    receiptSha256: verified.receiptIdentity.sha256,
    transactionId: receipt.transactionId, revision: receipt.revision,
    previousEventSha256: receipt.previousEventSha256,
    phase: receipt.phase, terminal: receipt.terminal, outcome: receipt.outcome,
    baseline: receipt.baseline, target: receipt.target, lease: receipt.lease,
    publication: receipt.publication,
    recordedAt: receipt.recordedAt,
    producer: Object.freeze({
      artifactName: `electron-production-publication-provisional-${input.candidate.version}-${input.candidate.sourceSha}-attempt-${input.provenance.provisionalPublicationRunAttempt}`,
      repository: input.provenance.repository,
      workflow: ELECTRON_PRODUCTION_PROVISIONAL_PUBLICATION_WORKFLOW,
      runId: input.provenance.provisionalPublicationRunId,
      runAttempt: input.provenance.provisionalPublicationRunAttempt,
      sourceSha: input.candidate.sourceSha
    })
  });
}

async function readAndVerifyTerminalEvidence(input) {
  const expectedNames = [RECEIPT_NAME, ...ATTACHMENT_NAMES].sort();
  const names = (await readdir(input.directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `${input.transition} ${input.platform} evidence inventory must be exactly ${expectedNames.join(", ")}.`
    );
  }
  const receiptPath = join(input.directory, RECEIPT_NAME);
  const source = await readBoundedRegularFile(receiptPath, MAX_RECEIPT_BYTES, "terminal receipt");
  const receiptSha256 = sha256Buffer(source);
  assertEqual(receiptSha256, input.expectedDigest, `${input.transition} ${input.platform} receipt SHA-256`);
  const receipt = parseJsonObject(source, `${input.transition} ${input.platform} terminal receipt`);
  const challengeWindow = assertTerminalReceipt(receipt, input);
  const attachments = {};
  const attachmentSources = {};
  for (const name of ATTACHMENT_NAMES) {
    const attachmentSource = await readBoundedRegularFile(
      join(input.directory, name),
      MAX_ATTACHMENT_BYTES,
      name
    );
    const identity = Object.freeze({
      bytes: attachmentSource.length,
      sha256: sha256Buffer(attachmentSource)
    });
    assertEqual(identity.sha256, receipt.attachments[name], `${name} SHA-256`);
    attachments[name] = identity;
    attachmentSources[name] = attachmentSource;
  }
  assertEqual(
    receipt.source.releaseSnapshotSha256,
    attachments["source-release-snapshot.json"].sha256,
    "source release snapshot SHA-256"
  );
  const attachmentBindings = {
    dataPreservationObservationSha256: "data-preservation-observation.json",
    endpointObservationSha256: "endpoint-observation.json",
    nativeHostObservationSha256: "native-host-observation.json",
    productTerminalReceiptSha256: "product-terminal-receipt.json",
    sourceEventStreamSha256: "source-event-stream.jsonl",
    sourceInstallJournalSha256: "source-install-journal.json",
    targetTerminalRecordSha256: "target-terminal-record.json"
  };
  for (const [field, name] of Object.entries(attachmentBindings)) {
    assertEqual(receipt.transaction[field], attachments[name].sha256, `${field} attachment binding`);
  }
  assertAttachmentSemantics(receipt, attachmentSources, input);
  return Object.freeze({
    attachments: Object.freeze(attachments),
    challengeWindow,
    receipt,
    receiptSha256
  });
}

function assertTerminalReceipt(receipt, input) {
  assertExactKeys(receipt, [
    "attachments",
    "challenge",
    "completedAt",
    "cutoverEligible",
    "evidenceKind",
    "nativeRuntime",
    "platform",
    "preservation",
    "producer",
    "schemaVersion",
    "source",
    "target",
    "transaction",
    "transitionKind",
    "trust"
  ], "terminal updater receipt");
  assertEqual(receipt.schemaVersion, 1, "terminal updater receipt schema version");
  assertEqual(receipt.evidenceKind, EVIDENCE_KIND, "terminal updater evidence kind");
  assertEqual(receipt.cutoverEligible, true, "terminal updater cutover eligibility");
  assertEqual(receipt.platform, input.platform, "terminal updater platform");
  assertEqual(receipt.transitionKind, input.transition, "terminal updater transition kind");
  const challengeWindow = assertChallenge(
    receipt.challenge,
    input.expectedChallenge,
    input.expectedChallengeWindow,
    receipt.completedAt,
    input.now
  );
  assertProducer(receipt.producer, input.provenance, input.candidate);
  assertSource(receipt.source, input);
  assertTarget(receipt.target, input);
  assertExactRecord(receipt.trust, {
    updaterPublicKeySha256: input.candidate.receipt.publicKeySha256
  }, "terminal updater trust");
  assertTransaction(
    receipt.transaction,
    input.expectedChallenge.nonceSha256,
    input.transition,
    input.platform,
    receipt.source
  );
  assertEqual(
    receipt.transaction.targetRunningImageSha256,
    input.candidate.receipt.platforms[input.platform].blackBox.executable.sha256,
    "target running image canonical executable SHA-256"
  );
  assertPreservation(receipt.preservation, input.expectedChallenge.nonceSha256);
  assertNativeRuntime(receipt.nativeRuntime, input.platform, input.candidate.version);
  assertExactKeys(receipt.attachments, ATTACHMENT_NAMES, "terminal updater attachment map");
  for (const name of ATTACHMENT_NAMES) requiredDigest(receipt.attachments[name], `${name} SHA-256`);
  requiredRfc3339(receipt.completedAt, "terminal updater completion time");
  return challengeWindow;
}

function assertChallenge(challenge, expected, expectedWindow, completedAt, now) {
  assertExactKeys(challenge, ["expiresAt", "id", "issuedAt", "nonceSha256"], "evidence challenge");
  assertEqual(challenge.id, expected.id, "evidence challenge ID");
  assertEqual(challenge.nonceSha256, expected.nonceSha256, "evidence challenge nonce SHA-256");
  const issuedAt = requiredRfc3339(challenge.issuedAt, "evidence challenge issued-at");
  const expiresAt = requiredRfc3339(challenge.expiresAt, "evidence challenge expires-at");
  const completed = requiredRfc3339(completedAt, "terminal updater completion time");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_CHALLENGE_LIFETIME_MS) {
    throw new Error("The evidence challenge lifetime must be positive and no longer than 24 hours.");
  }
  if (completed < issuedAt || completed > expiresAt) {
    throw new Error("The terminal updater receipt completed outside its evidence challenge window.");
  }
  if (now.getTime() + CLOCK_SKEW_MS < issuedAt || now.getTime() > expiresAt) {
    throw new Error("The evidence challenge is not current at readiness verification time.");
  }
  if (expectedWindow) {
    assertEqual(challenge.issuedAt, expectedWindow.issuedAt,
      "shared evidence challenge issued-at");
    assertEqual(challenge.expiresAt, expectedWindow.expiresAt,
      "shared evidence challenge expires-at");
  }
  return Object.freeze({ expiresAt: challenge.expiresAt, issuedAt: challenge.issuedAt });
}

function assertProducer(producer, provenance, candidate) {
  assertExactKeys(producer, [
    "artifactName",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "workflow"
  ], "terminal evidence producer");
  assertEqual(producer.repository, provenance.repository, "evidence producer repository");
  assertEqual(producer.workflow, ELECTRON_PRODUCTION_EVIDENCE_WORKFLOW, "evidence producer workflow");
  assertEqual(producer.runId, provenance.evidenceRunId, "evidence producer run ID");
  assertEqual(producer.runAttempt, provenance.evidenceRunAttempt, "evidence producer run attempt");
  assertEqual(producer.sourceSha, candidate.sourceSha, "evidence producer source SHA");
  assertEqual(
    producer.artifactName,
    `electron-production-updater-terminal-evidence-${candidate.version}-${candidate.sourceSha}-attempt-${provenance.evidenceRunAttempt}`,
    "evidence producer artifact name"
  );
}

function assertSource(source, input) {
  const isTauri = input.transition === "tauri-v22-to-electron-v23";
  assertExactKeys(source, [
    "artifactName",
    "artifactSha256",
    ...(isTauri ? [] : ["candidateReceiptSha256"]),
    ...(isTauri ? ["defaultUpdaterEndpoint"] : ["embeddedUpdaterEndpoint"]),
    "lineageKind",
    "manifestName",
    "manifestSha256",
    "releaseSnapshotSha256",
    ...(isTauri ? ["releaseTag"] : []),
    "runningImageSha256",
    "runtime",
    "sourceSha",
    "version"
  ], "terminal updater source");
  assertEqual(source.runtime, isTauri ? "tauri-v22" : "electron-v23", "source runtime");
  assertEqual(
    source.lineageKind,
    isTauri ? "published-release" : "production-candidate",
    "source lineage kind"
  );
  if (isTauri) {
    const lineage = input.expectedTauri.platforms[input.platform];
    assertEqual(source.releaseTag, input.expectedTauri.releaseTag, "Tauri v22 release tag");
    assertEqual(source.sourceSha, input.expectedTauri.sourceSha, "Tauri v22 source SHA");
    assertEqual(source.version, input.expectedTauri.version, "Tauri v22 version");
    assertEqual(source.artifactName, lineage.assets.artifact.name,
      "Tauri v22 public-lineage artifact name");
    assertEqual(source.artifactSha256, lineage.assets.artifact.sha256,
      "Tauri v22 public-lineage artifact SHA-256");
    assertEqual(source.manifestSha256, lineage.assets.manifest.sha256,
      "Tauri v22 public-lineage manifest SHA-256");
    assertEqual(source.runningImageSha256, lineage.runningExecutable.sha256,
      "Tauri v22 public-lineage running executable SHA-256");
    assertEqual(
      source.defaultUpdaterEndpoint,
      TAURI_V22_DEFAULT_UPDATER_ENDPOINT,
      "Tauri v22 default updater endpoint"
    );
  } else {
    const prior = input.expectedPriorCandidate;
    const artifact = prior.receipt.platforms[input.platform].artifact;
    assertEqual(
      source.candidateReceiptSha256,
      prior.receiptSha256,
      "source v23 candidate receipt SHA-256"
    );
    assertEqual(source.sourceSha, prior.sourceSha, "source v23 commit SHA");
    assertEqual(source.version, prior.version, "source v23 version");
    assertEqual(
      source.embeddedUpdaterEndpoint,
      prior.updaterEndpoint,
      "source v23 embedded updater endpoint"
    );
    assertEqual(source.artifactName, artifact.fileName, "source v23 artifact name");
    assertEqual(source.artifactSha256, artifact.sha256, "source v23 artifact SHA-256");
    assertEqual(
      source.runningImageSha256,
      prior.receipt.platforms[input.platform].blackBox.executable.sha256,
      "source v23 running image canonical executable SHA-256"
    );
    assertEqual(
      source.manifestSha256,
      prior.receipt.assets["latest.json"],
      "source v23 manifest SHA-256"
    );
  }
  requiredString(source.artifactName, "source artifact name");
  requiredDigest(source.artifactSha256, "source artifact SHA-256");
  assertEqual(source.manifestName, "latest.json", "source manifest name");
  requiredDigest(source.manifestSha256, "source manifest SHA-256");
  requiredDigest(source.releaseSnapshotSha256, "source release snapshot SHA-256");
  requiredDigest(source.runningImageSha256, "source running image SHA-256");
  assertVersionIsNewer(input.candidate.version, source.version);
}

function assertTarget(target, input) {
  const platform = PLATFORM_TARGETS[input.platform];
  const artifact = input.candidate.receipt.platforms[input.platform].artifact;
  assertExactKeys(target, [
    "artifactName",
    "artifactSha256",
    "candidateReceiptSha256",
    "manifestName",
    "servedManifestSha256",
    "signatureName",
    "signatureSha256",
    "sourceSha",
    "embeddedUpdaterEndpoint",
    "version",
    "runtime"
  ], "terminal updater target");
  assertEqual(target.runtime, "electron-v23", "target runtime");
  assertEqual(target.sourceSha, input.candidate.sourceSha, "target source SHA");
  assertEqual(target.version, input.candidate.version, "target version");
  assertEqual(target.candidateReceiptSha256, input.candidate.receiptSha256, "target candidate receipt SHA-256");
  assertEqual(
    target.embeddedUpdaterEndpoint,
    input.candidate.updaterEndpoint,
    "target embedded updater endpoint"
  );
  assertEqual(target.manifestName, "latest.json", "target manifest name");
  assertEqual(
    target.servedManifestSha256,
    input.candidate.receipt.assets["latest.json"],
    "served target manifest SHA-256"
  );
  assertEqual(target.artifactName, platform.artifactName, "target artifact name");
  assertEqual(target.artifactSha256, artifact.sha256, "target artifact SHA-256");
  assertEqual(target.signatureName, artifact.signatureFileName, "target signature name");
  assertEqual(target.signatureSha256, artifact.signatureSha256, "target signature SHA-256");
}

function assertTransaction(transaction, challengeSha256, transition, platform, source) {
  assertExactKeys(transaction, [
    "dataPreservationObservationSha256",
    "deadlineUsedAsSuccess",
    "endpointObservationSha256",
    "endpointRedirectCount",
    "endpointStatus",
    "evidenceAttemptId",
    "nativeHostObservationSha256",
    "preservedChallengeSha256",
    "productTerminalReceiptSha256",
    "sourceEventStreamSha256",
    "sourceHandoffJournalPhase",
    "sourceHandoffStatus",
    "sourceInstallJournalSha256",
    "sourceInstallAttemptId",
    "sourceFetchEndpoint",
    "sourceFetchFinalUrlSha256",
    "sourceFetchMode",
    "sourceUpdaterInvoked",
    "targetRunningImageSha256",
    "targetTerminalRecordSha256",
    "terminalAuthority",
    "terminalOutcome"
  ], "terminal updater transaction");
  requiredUuid(transaction.evidenceAttemptId, "evidence attempt ID");
  requiredSourceInstallAttemptId(
    transaction.sourceInstallAttemptId,
    "source install attempt ID",
    transition
  );
  assertEqual(transaction.sourceUpdaterInvoked, true, "source updater invocation");
  assertEqual(transaction.sourceFetchMode, "embedded-default", "source updater fetch mode");
  const sourceEndpoint = transition === "tauri-v22-to-electron-v23"
    ? source.defaultUpdaterEndpoint
    : source.embeddedUpdaterEndpoint;
  requiredHttpsUpdaterEndpoint(transaction.sourceFetchEndpoint, "source fetch endpoint");
  assertEqual(transaction.sourceFetchEndpoint, sourceEndpoint, "source fetch endpoint");
  if (transition === "tauri-v22-to-electron-v23") {
    assertNonnegativeInteger(
      transaction.endpointRedirectCount,
      "observed updater endpoint redirect count"
    );
    if (
      transaction.endpointRedirectCount < 1 ||
      transaction.endpointRedirectCount > MAX_TAURI_V22_REDIRECTS
    ) {
      throw new Error(
        `The Tauri v22 updater endpoint must follow between 1 and ${MAX_TAURI_V22_REDIRECTS} redirects.`
      );
    }
    requiredDigest(transaction.sourceFetchFinalUrlSha256, "source fetch final URL SHA-256");
  } else {
    assertEqual(transaction.endpointRedirectCount, 0, "observed updater endpoint redirects");
    assertEqual(
      transaction.sourceFetchFinalUrlSha256,
      sha256Buffer(Buffer.from(transaction.sourceFetchEndpoint, "utf8")),
      "direct source fetch final URL SHA-256"
    );
  }
  assertEqual(
    transaction.sourceHandoffJournalPhase,
    sourceHandoffJournalPhase(platform),
    "source handoff journal phase"
  );
  assertEqual(transaction.sourceHandoffStatus, "restart_pending", "source handoff status");
  assertEqual(
    transaction.terminalAuthority,
    "target-first-boot-journal-reconciliation",
    "terminal updater authority"
  );
  assertEqual(transaction.terminalOutcome, "applied", "terminal updater outcome");
  assertEqual(transaction.deadlineUsedAsSuccess, false, "deadline success policy");
  assertEqual(transaction.endpointStatus, 200, "observed updater endpoint status");
  assertEqual(transaction.preservedChallengeSha256, challengeSha256, "preserved challenge SHA-256");
  for (const field of [
    "dataPreservationObservationSha256",
    "endpointObservationSha256",
    "nativeHostObservationSha256",
    "productTerminalReceiptSha256",
    "sourceEventStreamSha256",
    "sourceInstallJournalSha256",
    "targetRunningImageSha256",
    "targetTerminalRecordSha256"
  ]) requiredDigest(transaction[field], field);
}

function assertPreservation(preservation, challengeSha256) {
  assertExactKeys(preservation, [
    "afterChallengeSha256",
    "beforeChallengeSha256",
    "preserved",
    "userDataIdentitySha256"
  ], "terminal updater preservation");
  assertEqual(preservation.beforeChallengeSha256, challengeSha256, "pre-update challenge SHA-256");
  assertEqual(preservation.afterChallengeSha256, challengeSha256, "post-update challenge SHA-256");
  assertEqual(preservation.preserved, true, "updater data preservation verdict");
  requiredDigest(preservation.userDataIdentitySha256, "user-data identity SHA-256");
}

function assertNativeRuntime(runtime, platform, version) {
  const expected = PLATFORM_TARGETS[platform];
  assertExactKeys(runtime, [
    "nativeHostKind",
    "remoteDebugging",
    "retainedAppKitHost",
    "targetVersionObserved"
  ], "terminal native runtime");
  assertEqual(runtime.nativeHostKind, expected.nativeHostKind, "terminal native host kind");
  assertEqual(runtime.retainedAppKitHost, expected.retainedAppKitHost, "retained AppKit host verdict");
  assertEqual(runtime.remoteDebugging, false, "terminal remote-debugging policy");
  assertEqual(runtime.targetVersionObserved, version, "terminal target version observation");
}

function assertAttachmentSemantics(receipt, sources, input) {
  const sourceJournal = assertSourceInstallJournal(
    parseJsonObject(
      sources["source-install-journal.json"],
      `${input.transition} ${input.platform} source install journal`
    ),
    receipt,
    sources["source-install-journal.json"]
  );
  const productTerminal = assertProductTerminalReceipt(
    parseJsonObject(
      sources["product-terminal-receipt.json"],
      `${input.transition} ${input.platform} product terminal receipt`
    ),
    receipt,
    sourceJournal,
    sources["source-install-journal.json"]
  );
  const sourceSnapshot = assertSourceReleaseSnapshot(
    parseJsonObject(
      sources["source-release-snapshot.json"],
      `${input.transition} ${input.platform} source release snapshot`
    ),
    receipt
  );
  const endpoint = assertEndpointObservation(
    parseJsonObject(
      sources["endpoint-observation.json"],
      `${input.transition} ${input.platform} endpoint observation`
    ),
    receipt
  );
  const preservation = assertDataPreservationObservation(
    parseJsonObject(
      sources["data-preservation-observation.json"],
      `${input.transition} ${input.platform} data-preservation observation`
    ),
    receipt
  );
  const nativeHost = assertNativeHostObservation(
    parseJsonObject(
      sources["native-host-observation.json"],
      `${input.transition} ${input.platform} native-host observation`
    ),
    receipt
  );
  const targetTerminal = assertTargetTerminalRecord(
    parseJsonObject(
      sources["target-terminal-record.json"],
      `${input.transition} ${input.platform} target terminal record`
    ),
    receipt,
    productTerminal
  );
  const events = assertSourceEventStream(
    parseJsonLines(
      sources["source-event-stream.jsonl"],
      `${input.transition} ${input.platform} source event stream`
    ),
    receipt
  );

  if (observationTime(sourceSnapshot.capturedAt, receipt, "source snapshot capture") >
      observationTime(events[0].observedAt, receipt, "source updater invocation")) {
    throw new Error("The source release snapshot must precede source updater invocation.");
  }
  assertSameInstant(
    endpoint.observedAt,
    events[1].observedAt,
    "endpoint observation and manifest event"
  );
  assertSameInstant(
    nativeHost.observedAt,
    events[7].observedAt,
    "native-host observation and target first boot"
  );
  assertSameInstant(
    preservation.observedAt,
    events[8].observedAt,
    "data preservation and terminal event"
  );
  assertSameInstant(
    targetTerminal.recordedAt,
    events[8].observedAt,
    "target terminal record and terminal event"
  );
  assertSameInstant(
    receipt.completedAt,
    events[8].observedAt,
    "terminal receipt completion and terminal event"
  );
  if (
    requiredRfc3339(productTerminal.reconciledAt, "product terminal reconciliation time") >
    requiredRfc3339(targetTerminal.recordedAt, "target terminal record time")
  ) {
    throw new Error("The product terminal receipt must precede its external terminal record.");
  }
}

function assertSourceInstallJournal(document, receipt, source) {
  const label = "source install journal";
  assertExactKeys(document, ["attempt", "schemaVersion"], label);
  assertEqual(document.schemaVersion, 1, `${label} schema version`);
  assertExactKeys(document.attempt, [
    "attemptId",
    "phase",
    "startedAt",
    "targetVersion",
    "updatedAt"
  ], `${label} attempt`);
  assertEqual(
    document.attempt.attemptId,
    receipt.transaction.sourceInstallAttemptId,
    `${label} attempt ID`
  );
  assertEqual(document.attempt.targetVersion, receipt.target.version, `${label} target version`);
  assertEqual(
    document.attempt.phase,
    receipt.transaction.sourceHandoffJournalPhase,
    `${label} source phase`
  );
  requiredRfc3339(document.attempt.startedAt, `${label} start time`);
  requiredRfc3339(document.attempt.updatedAt, `${label} update time`);
  assertEqual(
    sha256Buffer(source),
    receipt.transaction.sourceInstallJournalSha256,
    `${label} raw SHA-256`
  );
  return document;
}

function assertProductTerminalReceipt(document, receipt, sourceJournal, sourceJournalBytes) {
  const label = "product terminal receipt";
  assertExactKeys(document, [
    "attempt",
    "authority",
    "kind",
    "reconciledAt",
    "runningVersion",
    "schemaVersion",
    "sourceJournalBytes",
    "sourceJournalSha256",
    "sourcePhase",
    "terminalOutcome"
  ], label);
  assertEqual(document.schemaVersion, 1, `${label} schema version`);
  assertEqual(document.kind, "rion-updater-install-terminal", `${label} kind`);
  assertEqual(document.authority, receipt.transaction.terminalAuthority, `${label} authority`);
  assertEqual(document.sourceJournalBytes, sourceJournalBytes.length, `${label} source bytes`);
  assertEqual(
    document.sourceJournalSha256,
    receipt.transaction.sourceInstallJournalSha256,
    `${label} source journal SHA-256`
  );
  assertEqual(document.sourcePhase, receipt.transaction.sourceHandoffJournalPhase, `${label} source phase`);
  assertEqual(document.runningVersion, receipt.target.version, `${label} running version`);
  assertEqual(document.terminalOutcome, receipt.transaction.terminalOutcome, `${label} outcome`);
  assertExactKeys(document.attempt, [
    "attemptId",
    "phase",
    "startedAt",
    "targetVersion",
    "updatedAt"
  ], `${label} attempt`);
  assertEqual(
    document.attempt.attemptId,
    receipt.transaction.sourceInstallAttemptId,
    `${label} attempt ID`
  );
  assertEqual(document.attempt.targetVersion, receipt.target.version, `${label} target version`);
  assertEqual(document.attempt.phase, "applied", `${label} attempt phase`);
  assertEqual(
    document.attempt.startedAt,
    sourceJournal.attempt.startedAt,
    `${label} attempt start time`
  );
  assertEqual(document.attempt.updatedAt, document.reconciledAt, `${label} update time`);
  const sourceUpdatedAt = requiredRfc3339(
    sourceJournal.attempt.updatedAt,
    `${label} source journal update time`
  );
  const reconciledAt = observationTime(document.reconciledAt, receipt, `${label} reconciled-at`);
  if (reconciledAt < sourceUpdatedAt) {
    throw new Error("The product terminal reconciliation cannot precede source handoff.");
  }
  return document;
}

function assertSourceReleaseSnapshot(document, receipt) {
  const label = "source release snapshot";
  assertAttachmentContext(document, receipt, label, "rion-production-updater-source-release-snapshot", [
    "capturedAt",
    "source"
  ]);
  const expectedSource = { ...receipt.source };
  delete expectedSource.releaseSnapshotSha256;
  assertExactRecord(document.source, expectedSource, `${label} source`);
  observationTime(document.capturedAt, receipt, `${label} captured-at`);
  return document;
}

function assertEndpointObservation(document, receipt) {
  const label = "endpoint observation";
  assertAttachmentContext(document, receipt, label, "rion-production-updater-endpoint-observation", [
    "endpoint",
    "observedAt"
  ]);
  assertExactKeys(document.endpoint, [
    "artifactName",
    "artifactSha256",
    "final",
    "manifestName",
    "redirectCount",
    "redirects",
    "requestEndpoint",
    "servedManifestSha256",
    "signatureName",
    "signatureSha256",
    "status",
    "targetEmbeddedUpdaterEndpoint",
    "updaterPublicKeySha256"
  ], `${label} result`);
  const expected = {
    artifactName: receipt.target.artifactName,
    artifactSha256: receipt.target.artifactSha256,
    manifestName: receipt.target.manifestName,
    redirectCount: receipt.transaction.endpointRedirectCount,
    servedManifestSha256: receipt.target.servedManifestSha256,
    signatureName: receipt.target.signatureName,
    signatureSha256: receipt.target.signatureSha256,
    status: receipt.transaction.endpointStatus,
    requestEndpoint: receipt.transaction.sourceFetchEndpoint,
    targetEmbeddedUpdaterEndpoint: receipt.target.embeddedUpdaterEndpoint,
    updaterPublicKeySha256: receipt.trust.updaterPublicKeySha256
  };
  for (const [field, value] of Object.entries(expected)) {
    assertEqual(document.endpoint[field], value, `${label} result ${field}`);
  }
  assertEndpointRedirectChain(document.endpoint, receipt);
  observationTime(document.observedAt, receipt, `${label} observed-at`);
  return document;
}

function assertEndpointRedirectChain(endpoint, receipt) {
  const redirects = endpoint.redirects;
  if (!Array.isArray(redirects)) {
    throw new Error("The endpoint observation redirects must be an array.");
  }
  assertEqual(
    redirects.length,
    receipt.transaction.endpointRedirectCount,
    "endpoint observation redirect count"
  );
  const isTauri = receipt.transitionKind === "tauri-v22-to-electron-v23";
  if (!isTauri && redirects.length !== 0) {
    throw new Error("The prior Electron v23 updater endpoint must not redirect.");
  }
  if (isTauri && (redirects.length < 1 || redirects.length > MAX_TAURI_V22_REDIRECTS)) {
    throw new Error(
      `The Tauri v22 updater endpoint must follow between 1 and ${MAX_TAURI_V22_REDIRECTS} redirects.`
    );
  }
  assertExactKeys(endpoint.final, ["host", "scheme", "status", "urlSha256"], "endpoint final response");
  assertEqual(endpoint.final.scheme, "https:", "endpoint final response scheme");
  assertEqual(endpoint.final.status, receipt.transaction.endpointStatus, "endpoint final response status");
  assertEqual(
    endpoint.final.urlSha256,
    receipt.transaction.sourceFetchFinalUrlSha256,
    "endpoint final response URL SHA-256"
  );
  const requestUrl = new URL(receipt.transaction.sourceFetchEndpoint);
  let expectedFromSha256 = sha256Buffer(
    Buffer.from(receipt.transaction.sourceFetchEndpoint, "utf8")
  );
  let expectedFromHost = requestUrl.hostname;
  const observedUrls = new Set([expectedFromSha256]);
  const targetTaggedEndpoint =
    `https://github.com/rion-tw/rion-studio/releases/download/v${receipt.target.version}/latest.json`;
  for (let index = 0; index < redirects.length; index += 1) {
    const redirect = redirects[index];
    const label = `endpoint redirect ${index + 1}`;
    assertExactKeys(redirect, [
      "fromHost",
      "fromScheme",
      "fromUrlSha256",
      "locationUrlSha256",
      "sequence",
      "status",
      "toHost",
      "toScheme"
    ], label);
    assertEqual(redirect.sequence, index + 1, `${label} sequence`);
    assertEqual(redirect.fromScheme, "https:", `${label} source scheme`);
    assertEqual(redirect.toScheme, "https:", `${label} target scheme`);
    assertEqual(redirect.fromHost, expectedFromHost, `${label} source host`);
    assertEqual(redirect.fromUrlSha256, expectedFromSha256, `${label} source URL SHA-256`);
    requiredDigest(redirect.locationUrlSha256, `${label} location URL SHA-256`);
    if (![301, 302, 303, 307, 308].includes(redirect.status)) {
      throw new Error(`The ${label} must use an HTTP redirect status.`);
    }
    if (isTauri && index === 0) {
      assertEqual(redirect.fromHost, "github.com", `${label} source host`);
      assertEqual(redirect.toHost, "github.com", `${label} target host`);
      assertEqual(
        redirect.locationUrlSha256,
        sha256Buffer(Buffer.from(targetTaggedEndpoint, "utf8")),
        `${label} exact target release URL SHA-256`
      );
    } else if (isTauri && index === 1) {
      assertEqual(redirect.fromHost, "github.com", `${label} source host`);
      assertEqual(redirect.toHost, TAURI_V22_RELEASE_ASSET_HOST, `${label} target host`);
    } else if (isTauri) {
      assertEqual(
        redirect.fromHost,
        TAURI_V22_RELEASE_ASSET_HOST,
        `${label} source host`
      );
      assertEqual(redirect.toHost, TAURI_V22_RELEASE_ASSET_HOST, `${label} target host`);
    }
    if (observedUrls.has(redirect.locationUrlSha256)) {
      throw new Error("The endpoint redirect chain must not contain a loop.");
    }
    observedUrls.add(redirect.locationUrlSha256);
    expectedFromSha256 = redirect.locationUrlSha256;
    expectedFromHost = redirect.toHost;
  }
  assertEqual(
    endpoint.final.urlSha256,
    expectedFromSha256,
    "endpoint redirect final URL SHA-256"
  );
  assertEqual(endpoint.final.host, expectedFromHost, "endpoint redirect final host");
  if (!isTauri) {
    assertEqual(endpoint.final.host, requestUrl.hostname, "direct endpoint final host");
  }
}

function assertDataPreservationObservation(document, receipt) {
  const label = "data-preservation observation";
  assertAttachmentContext(
    document,
    receipt,
    label,
    "rion-production-updater-data-preservation-observation",
    ["observedAt", "preservation", "target"]
  );
  assertExactRecord(document.preservation, receipt.preservation, `${label} preservation`);
  assertExactRecord(document.target, receipt.target, `${label} target`);
  observationTime(document.observedAt, receipt, `${label} observed-at`);
  return document;
}

function assertNativeHostObservation(document, receipt) {
  const label = "native-host observation";
  assertAttachmentContext(document, receipt, label, "rion-production-updater-native-host-observation", [
    "capturedAt",
    "observedAt",
    "runtime",
    "target",
    "targetRunningImageSha256"
  ]);
  assertExactRecord(document.runtime, receipt.nativeRuntime, `${label} runtime`);
  assertExactRecord(document.target, receipt.target, `${label} target`);
  assertEqual(
    document.targetRunningImageSha256,
    receipt.transaction.targetRunningImageSha256,
    `${label} target running-image SHA-256`
  );
  const observedAt = observationTime(
    document.observedAt,
    receipt,
    `${label} observed-at`
  );
  const capturedAt = requiredRfc3339(document.capturedAt, `${label} captured-at`);
  if (capturedAt < observedAt) {
    throw new Error(`The ${label} capture precedes the observed target process.`);
  }
  if (capturedAt > requiredRfc3339(
    receipt.challenge.expiresAt,
    "evidence challenge expires-at"
  )) {
    throw new Error(`The ${label} capture exceeds the evidence challenge lifetime.`);
  }
  return document;
}

function assertTargetTerminalRecord(document, receipt, productTerminal) {
  const label = "target terminal record";
  assertAttachmentContext(document, receipt, label, "rion-production-updater-target-terminal-record", [
    "deadlineUsedAsSuccess",
    "firstBoot",
    "journal",
    "productTerminalReceiptSha256",
    "recordedAt",
    "target",
    "targetRunningImageSha256",
    "terminalAuthority",
    "terminalOutcome"
  ]);
  assertEqual(document.firstBoot, true, `${label} first-boot verdict`);
  assertEqual(
    document.productTerminalReceiptSha256,
    receipt.transaction.productTerminalReceiptSha256,
    `${label} product terminal receipt SHA-256`
  );
  assertExactRecord(document.journal, {
    attemptId: receipt.transaction.sourceInstallAttemptId,
    phase: receipt.transaction.terminalOutcome,
    reconciled: true,
    reconciledAt: productTerminal.reconciledAt,
    targetVersion: receipt.target.version
  }, `${label} journal`);
  assertExactRecord(document.target, receipt.target, `${label} target`);
  assertEqual(
    document.targetRunningImageSha256,
    receipt.transaction.targetRunningImageSha256,
    `${label} target running-image SHA-256`
  );
  assertEqual(
    document.terminalAuthority,
    receipt.transaction.terminalAuthority,
    `${label} terminal authority`
  );
  assertEqual(
    document.terminalOutcome,
    receipt.transaction.terminalOutcome,
    `${label} terminal outcome`
  );
  assertEqual(
    document.deadlineUsedAsSuccess,
    receipt.transaction.deadlineUsedAsSuccess,
    `${label} deadline success policy`
  );
  observationTime(document.recordedAt, receipt, `${label} recorded-at`);
  return document;
}

function assertSourceEventStream(events, receipt) {
  if (events.length !== SOURCE_EVENT_SEQUENCE.length) {
    throw new Error(
      `The source event stream must contain exactly ${SOURCE_EVENT_SEQUENCE.length} events.`
    );
  }
  let previousTime;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expected = SOURCE_EVENT_SEQUENCE[index];
    const expectedPhase = expected.phase ?? sourceHandoffJournalPhase(receipt.platform);
    const label = `source event ${index + 1}`;
    assertAttachmentContext(event, receipt, label, "rion-production-updater-source-event", [
      "event",
      "observedAt",
      "phase",
      "sequence",
      "source",
      "target"
    ]);
    assertEqual(event.sequence, index + 1, `${label} sequence`);
    assertEqual(event.event, expected.event, `${label} event`);
    assertEqual(event.phase, expectedPhase, `${label} phase`);
    assertExactRecord(event.source, receipt.source, `${label} source`);
    assertExactRecord(event.target, receipt.target, `${label} target`);
    const observedAt = observationTime(event.observedAt, receipt, `${label} observed-at`);
    if (previousTime !== undefined && observedAt < previousTime) {
      throw new Error("The source event stream timestamps must be monotonically ordered.");
    }
    previousTime = observedAt;
  }
  assertEqual(
    events[6].phase,
    receipt.transaction.sourceHandoffJournalPhase,
    "source handoff event phase"
  );
  assertEqual(
    events[8].phase,
    receipt.transaction.terminalOutcome,
    "target terminal event phase"
  );
  return events;
}
function sourceHandoffJournalPhase(platform) {
  if (platform === "darwin-aarch64") return "restartPending";
  if (platform === "windows-x86_64") return "installerHandoff";
  throw new Error("The source handoff platform is unsupported.");
}
function assertAttachmentContext(document, receipt, label, kind, additionalKeys) {
  assertExactKeys(document, [...ATTACHMENT_CONTEXT_KEYS, ...additionalKeys], label);
  assertEqual(document.schemaVersion, 1, `${label} schema version`);
  assertEqual(document.kind, kind, `${label} kind`);
  assertEqual(
    document.evidenceAttemptId,
    receipt.transaction.evidenceAttemptId,
    `${label} evidence attempt ID`
  );
  assertEqual(
    document.sourceInstallAttemptId,
    receipt.transaction.sourceInstallAttemptId,
    `${label} source install attempt ID`
  );
  assertEqual(document.platform, receipt.platform, `${label} platform`);
  assertEqual(document.transitionKind, receipt.transitionKind, `${label} transition kind`);
  assertExactRecord(document.challenge, receipt.challenge, `${label} challenge`);
}
function observationTime(value, receipt, label) {
  const observedAt = requiredRfc3339(value, label);
  const issuedAt = requiredRfc3339(receipt.challenge.issuedAt, "evidence challenge issued-at");
  const completedAt = requiredRfc3339(receipt.completedAt, "terminal updater completion time");
  if (observedAt < issuedAt || observedAt > completedAt) {
    throw new Error(`The ${label} must fall within the terminal evidence window.`);
  }
  return observedAt;
}
function assertSameInstant(left, right, label) {
  if (requiredRfc3339(left, label) !== requiredRfc3339(right, label)) {
    throw new Error(`The ${label} timestamps do not match.`);
  }
}
function assertCrossPlatformSourceLineage(evidence, expectedTauri, targetVersion) {
  const tauriMac = evidence[TRANSITIONS[0]][PLATFORMS[0]].receipt.source;
  const tauriWindows = evidence[TRANSITIONS[0]][PLATFORMS[1]].receipt.source;
  for (const field of ["releaseTag", "sourceSha", "version", "manifestSha256"]) {
    assertEqual(tauriMac[field], tauriWindows[field], `cross-platform Tauri source ${field}`);
  }
  assertEqual(tauriMac.releaseTag, expectedTauri.releaseTag, "Tauri source release tag");
  const v23Mac = evidence[TRANSITIONS[1]][PLATFORMS[0]].receipt.source;
  const v23Windows = evidence[TRANSITIONS[1]][PLATFORMS[1]].receipt.source;
  for (const field of ["candidateReceiptSha256", "sourceSha", "version", "manifestSha256"]) {
    assertEqual(v23Mac[field], v23Windows[field], `cross-platform v23 source ${field}`);
  }
  assertVersionIsNewer(targetVersion, v23Mac.version);
}
function assertTauriLineageBindings(lineage, expected, candidate, provenance) {
  for (const receipt of [lineage.macos, lineage.windows]) {
    assertEqual(receipt.release.tag, expected.releaseTag, "public-lineage Tauri release tag");
    assertEqual(receipt.release.version, expected.version, "public-lineage Tauri version");
    assertEqual(receipt.sourceTag.peeledCommitSha, expected.sourceSha,
      "public-lineage Tauri source SHA");
    assertEqual(receipt.targetSourceSha, candidate.sourceSha,
      "public-lineage target candidate SHA");
    assertEqual(receipt.trust.updaterPublicKeySha256, candidate.receipt.publicKeySha256,
      "public-lineage updater public-key SHA-256");
    assertEqual(receipt.producer.runId, provenance.tauriLineageRunId,
      "public-lineage producer run ID");
    assertEqual(receipt.producer.runAttempt, provenance.tauriLineageRunAttempt,
      "public-lineage producer run attempt");
  }
}
function summarizeTauriLineage(lineage, receiptDigests, provenance) {
  const platforms = {};
  for (const [platform, receipt] of [
    ["darwin-aarch64", lineage.macos],
    ["windows-x86_64", lineage.windows]
  ]) {
    platforms[platform] = {
      receiptSha256: receiptDigests[platform],
      artifact: receipt.assets.artifact,
      manifest: receipt.assets.manifest,
      runningExecutable: receipt.runningExecutable,
      releaseObservedAt: receipt.release.observedAt,
      sourceTagObservedAt: receipt.sourceTag.observedAt,
      producedAt: receipt.producer.producedAt
    };
  }
  return {
    release: {
      repository: lineage.macos.release.repository,
      id: lineage.macos.release.id,
      tag: lineage.macos.release.tag,
      version: lineage.macos.release.version,
      publishedAt: lineage.macos.release.publishedAt
    },
    sourceSha: lineage.macos.sourceTag.peeledCommitSha,
    targetSourceSha: lineage.macos.targetSourceSha,
    updaterPublicKeySha256: lineage.macos.trust.updaterPublicKeySha256,
    producer: {
      repository: lineage.macos.producer.repository,
      workflow: lineage.macos.producer.workflow,
      runId: provenance.tauriLineageRunId,
      runAttempt: provenance.tauriLineageRunAttempt
    },
    platforms
  };
}
function summarizeEvidence(evidence) {
  const result = {};
  for (const transition of TRANSITIONS) {
    result[transition] = {};
    for (const platform of PLATFORMS) {
      const verified = evidence[transition][platform];
      result[transition][platform] = {
        receiptSha256: verified.receiptSha256,
        evidenceAttemptId: verified.receipt.transaction.evidenceAttemptId,
        sourceInstallAttemptId: verified.receipt.transaction.sourceInstallAttemptId,
        completedAt: verified.receipt.completedAt,
        source: verified.receipt.source,
        target: verified.receipt.target,
        producer: verified.receipt.producer,
        attachments: verified.receipt.attachments,
        sourceFetchEndpoint: verified.receipt.transaction.sourceFetchEndpoint,
        sourceFetchFinalUrlSha256: verified.receipt.transaction.sourceFetchFinalUrlSha256,
        sourceFetchMode: verified.receipt.transaction.sourceFetchMode,
        terminalOutcome: verified.receipt.transaction.terminalOutcome
      };
    }
  }
  return result;
}
function validateProvenance(value) {
  assertExactKeys(value, [
    "candidateRunControlSha",
    "candidateRunAttempt",
    "candidateRunId",
    "evidenceRunControlSha",
    "evidenceRunAttempt",
    "evidenceRunId",
    "priorCandidateRunControlSha",
    "priorCandidateRunAttempt",
    "priorCandidateRunId",
    "provisionalPublicationRunControlSha",
    "provisionalPublicationRunAttempt",
    "provisionalPublicationRunId",
    "readinessControlSha",
    "repository",
    "tauriLineageRunControlSha",
    "tauriLineageRunAttempt",
    "tauriLineageRunId"
  ], "readiness run provenance");
  assertEqual(value.repository, "rion-tw/rion-studio-source", "readiness repository");
  requiredRunId(value.candidateRunId, "candidate run ID");
  requiredRunId(value.evidenceRunId, "evidence run ID");
  requiredRunId(value.priorCandidateRunId, "prior candidate run ID");
  requiredRunId(value.provisionalPublicationRunId, "provisional publication run ID");
  requiredRunId(value.tauriLineageRunId, "Tauri lineage run ID");
  assertPositiveInteger(value.candidateRunAttempt, "candidate run attempt");
  assertPositiveInteger(value.evidenceRunAttempt, "evidence run attempt");
  assertPositiveInteger(value.priorCandidateRunAttempt, "prior candidate run attempt");
  assertPositiveInteger(
    value.provisionalPublicationRunAttempt,
    "provisional publication run attempt"
  );
  assertPositiveInteger(value.tauriLineageRunAttempt, "Tauri lineage run attempt");
  requiredCommitSha(value.candidateRunControlSha, "candidate run control SHA");
  requiredCommitSha(value.evidenceRunControlSha, "evidence run control SHA");
  requiredCommitSha(value.priorCandidateRunControlSha, "prior candidate run control SHA");
  requiredCommitSha(value.provisionalPublicationRunControlSha,
    "provisional publication run control SHA");
  requiredCommitSha(value.readinessControlSha, "readiness control SHA");
  requiredCommitSha(value.tauriLineageRunControlSha, "Tauri lineage run control SHA");
  return Object.freeze({ ...value });
}
function assertVersionIsNewer(target, source) {
  if (compareSemanticVersions(target, source) <= 0) {
    throw new Error(`Target version ${target} must be strictly newer than source version ${source}.`);
  }
}
async function requiredDirectory(value, label) {
  const directory = resolveRequiredPath(value, label);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonical = await realpath(directory);
  const canonicalMetadata = await lstat(canonical);
  if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink() ||
      canonicalMetadata.dev !== metadata.dev || canonicalMetadata.ino !== metadata.ino) {
    throw new Error(`The ${label} changed while it was being resolved.`);
  }
  return canonical;
}
async function readBoundedRegularFile(filePath, maximumBytes, label) {
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error(`The ${label} must be a bounded, nonempty regular file.`);
    }
    const source = await handle.readFile();
    const after = await handle.stat();
    assertStableFileIdentity(before, after, label);
    return source;
  } finally {
    await handle.close();
  }
}
async function resolveCreateNewOutputPath(value, label) {
  const requested = resolveRequiredPath(value, label);
  const parent = await requiredDirectory(dirname(requested), `${label} parent directory`);
  const canonical = join(parent, basename(requested));
  try {
    await lstat(canonical);
  } catch (error) {
    if (error?.code === "ENOENT") return canonical;
    throw error;
  }
  throw new Error(`The ${label} must not already exist.`);
}
function assertStableFileIdentity(before, after, label) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`The ${label} changed while it was being verified.`);
  }
}
function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is not valid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must contain one JSON object.`);
  }
  return value;
}
function parseJsonLines(source, label) {
  const text = source.toString("utf8");
  if (!text.endsWith("\n")) {
    throw new Error(`The ${label} must end with one newline.`);
  }
  const lines = text.slice(0, -1).split(/\r?\n/u);
  if (lines.length === 0 || lines.some((line) => !line)) {
    throw new Error(`The ${label} must contain nonempty JSON lines without gaps.`);
  }
  return lines.map((line, index) =>
    parseJsonObject(Buffer.from(line, "utf8"), `${label} line ${index + 1}`)
  );
}
function assertPathOutside(filePath, directory, label) {
  const relation = relative(directory, filePath);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    throw new Error(`The readiness receipt output must stay outside the ${label}.`);
  }
}
function resolveRequiredPath(value, label) {
  return resolve(requiredString(value, label));
}
function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}
