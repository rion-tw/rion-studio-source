import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  readElectronProductionPublicLatestLease,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicLatestRecoveryObservation,
  assertElectronProductionPublicLatestRecoveryObservationBindings,
  electronProductionPublicLatestRecoveryObservationSha256,
  readElectronProductionPublicLatestRecoveryObservation
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  readElectronProductionPublicLatestSnapshot,
  serializeElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertElectronProductionPublicLatestLeaseRemoteOperationSummary
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import {
  assertElectronProductionPublicationReceipt,
  electronProductionPublicationEventSha256,
  readElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";
import {
  assertElectronProductionPublicationSnapshotBindings
} from "./electronProductionPublicationTransaction.mjs";
import {
  assertPositiveInteger,
  requiredHttpsUpdaterEndpoint,
  requiredRfc3339,
  requiredRunId,
  requiredSemanticVersion,
  requiredString,
  requiredUuid
} from "./electronProductionPromotionReadinessValidation.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredCommitSha,
  requiredDigest,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL =
  "FINALIZE ELECTRON PRODUCTION PROMOTION";
export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_KIND =
  "rion-electron-production-terminal-promotion";
export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT =
  "electron-production-terminal-promotion-receipt.json";
export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_WORKFLOW =
  ".github/workflows/electron-production-terminal-promotion.yml";

const READINESS_KIND = "rion-electron-production-promotion-readiness";
const READINESS_RECEIPT =
  "electron-production-promotion-readiness-receipt.json";
const PUBLIC_REPOSITORY = "rion-tw/rion-studio";
const SOURCE_REPOSITORY = "rion-tw/rion-studio-source";
const PUBLIC_LATEST_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const RECEIPT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);

export function createElectronProductionTerminalPromotion(input) {
  assertExactKeys(input, [
    "finalObservation",
    "finalizedAt",
    "heldLease",
    "heldLeaseFileSha256",
    "leaseReleaseResolvedAt",
    "leaseRemoteOperation",
    "ownerApproval",
    "preReleaseObservation",
    "producer",
    "provisionalPublicationReceipt",
    "provisionalPublicationReceiptSha256",
    "readinessReceipt",
    "readinessReceiptIdentity",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "terminal promotion input");
  assertEqual(
    input.ownerApproval,
    ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL,
    "terminal promotion owner approval"
  );

  const readiness = assertPromotionReadinessReceipt(input.readinessReceipt);
  const readinessIdentity = assertReadinessIdentity(
    input.readinessReceiptIdentity
  );
  const provisional =
    assertElectronProductionPublicationReceipt(
      input.provisionalPublicationReceipt
    );
  const provisionalReceiptSha256 = requiredDigest(
    input.provisionalPublicationReceiptSha256,
    "provisional publication receipt SHA-256"
  );
  assertEqual(
    provisionalReceiptSha256,
    sha256(serializeCanonicalJson(provisional)),
    "provisional publication receipt SHA-256"
  );
  assertProvisionalReadinessBinding(readiness, provisional, provisionalReceiptSha256);

  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const targetSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  const sourceSnapshotFileSha256 = assertSnapshotFileDigest(
    sourceSnapshot,
    input.sourceSnapshotFileSha256,
    "source public-latest snapshot"
  );
  const targetSnapshotFileSha256 = assertSnapshotFileDigest(
    targetSnapshot,
    input.targetSnapshotFileSha256,
    "target public-latest snapshot"
  );
  assertElectronProductionPublicationSnapshotBindings({
    receipt: provisional,
    sourceSnapshot,
    targetSnapshot
  });
  assertReadinessSnapshotBindings(readiness, sourceSnapshot, targetSnapshot);

  const heldLease = assertHeldLease(input.heldLease);
  const heldLeaseFileSha256 = requiredDigest(
    input.heldLeaseFileSha256,
    "held public-latest lease file SHA-256"
  );
  assertEqual(
    heldLeaseFileSha256,
    sha256(serializeElectronProductionPublicLatestLease(heldLease)),
    "held public-latest lease file SHA-256"
  );
  assertLeaseBindings(heldLease, provisional, sourceSnapshot, targetSnapshot);

  const preReleaseObservation = assertBoundTargetObservation({
    label: "pre-release public-latest observation",
    observation: input.preReleaseObservation,
    sourceSnapshot,
    sourceSnapshotFileSha256,
    targetSnapshot,
    targetSnapshotFileSha256
  });
  assertTimeOrder(
    readiness.verifiedAt,
    preReleaseObservation.receipt.observedAt,
    "The terminal pre-release observation cannot precede readiness verification."
  );

  const leaseReleaseResolvedAt = requiredRfc3339(
    input.leaseReleaseResolvedAt,
    "terminal lease release resolution time"
  );
  const leaseRelease = assertConfirmedLeaseRelease({
    heldLease,
    preReleaseObservation: preReleaseObservation.receipt,
    remoteOperation: input.leaseRemoteOperation,
    resolvedAt: input.leaseReleaseResolvedAt
  });

  const finalObservation = assertBoundTargetObservation({
    label: "final public-latest observation",
    observation: input.finalObservation,
    sourceSnapshot,
    sourceSnapshotFileSha256,
    targetSnapshot,
    targetSnapshotFileSha256
  });
  assertTimeOrder(
    new Date(leaseReleaseResolvedAt).toISOString(),
    finalObservation.receipt.observedAt,
    "The final public-latest observation cannot precede lease release resolution."
  );
  const finalizedAt = requiredRfc3339(
    input.finalizedAt,
    "terminal promotion finalization time"
  );
  assertTimeOrder(
    finalObservation.receipt.observedAt,
    input.finalizedAt,
    "Terminal promotion finalization cannot precede the final observation."
  );
  const producer = assertProducer(input.producer, input.finalizedAt);

  return assertElectronProductionTerminalPromotion({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_KIND,
    status: "terminal-promotion-recorded",
    terminal: true,
    outcome: "promoted",
    ownerGate: {
      approval: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL,
      environment: "electron-production-release"
    },
    channel: {
      repository: PUBLIC_REPOSITORY,
      updaterEndpoint: PUBLIC_LATEST_ENDPOINT
    },
    candidate: {
      receiptSha256: readiness.candidate.receiptSha256,
      sourceSha: readiness.candidate.sourceSha,
      version: readiness.candidate.version,
      releaseTag: targetSnapshot.release.tag,
      manifestSha256: targetSnapshot.latestJson.sha256
    },
    readiness: {
      receiptFileName: READINESS_RECEIPT,
      bytes: readinessIdentity.bytes,
      sha256: readinessIdentity.sha256,
      verifiedAt: readiness.verifiedAt,
      controlSha: readiness.provenance.readinessControlSha
    },
    publication: {
      transactionId: provisional.transactionId,
      provisionalReceiptSha256,
      provisionalRevision: provisional.revision,
      provisionalEventSha256:
        electronProductionPublicationEventSha256(provisional),
      source: snapshotIdentity(
        sourceSnapshot,
        sourceSnapshotFileSha256,
        "tauri-v22"
      ),
      target: snapshotIdentity(
        targetSnapshot,
        targetSnapshotFileSha256,
        "electron-v23"
      ),
      preReleaseObservation,
      finalObservation
    },
    lease: {
      held: {
        transactionId: heldLease.transactionId,
        leaseId: heldLease.leaseId,
        generation: heldLease.generation,
        revision: heldLease.revision,
        eventSha256: electronProductionPublicLatestLeaseEventSha256(heldLease),
        fileSha256: heldLeaseFileSha256
      },
      release: leaseRelease
    },
    compatibility: {
      macosAppKitRetained: true,
      stableTauriReleasePath: "retained-as-rollback-source-through-finalization",
      windowsEvidenceIndependent: true
    },
    producer,
    finalizedAt: new Date(finalizedAt).toISOString()
  });
}

export async function finalizeElectronProductionTerminalPromotion(input) {
  assertExactKeys(input, [
    "finalObservationPath",
    "finalObservationSha256",
    "finalizedAt",
    "heldLeasePath",
    "heldLeaseSha256",
    "leaseReleaseResolvedAt",
    "leaseRemoteOperationPath",
    "leaseRemoteOperationSha256",
    "outputPath",
    "ownerApproval",
    "preReleaseObservationPath",
    "preReleaseObservationSha256",
    "producer",
    "provisionalPublicationReceiptPath",
    "provisionalPublicationReceiptSha256",
    "readinessReceiptPath",
    "readinessReceiptSha256",
    "sourceSnapshotPath",
    "sourceSnapshotSha256",
    "targetSnapshotPath",
    "targetSnapshotSha256"
  ], "terminal promotion finalization input");
  const [
    readiness,
    provisional,
    source,
    target,
    heldLease,
    preReleaseObservation,
    remoteOperation,
    finalObservation
  ] = await Promise.all([
    readPromotionReadinessReceipt({
      expectedSha256: input.readinessReceiptSha256,
      receiptPath: input.readinessReceiptPath
    }),
    readElectronProductionPublicationReceipt({
      expectedSha256: input.provisionalPublicationReceiptSha256,
      receiptPath: input.provisionalPublicationReceiptPath
    }),
    readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: input.sourceSnapshotSha256,
      snapshotPath: input.sourceSnapshotPath
    }),
    readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: input.targetSnapshotSha256,
      snapshotPath: input.targetSnapshotPath
    }),
    readElectronProductionPublicLatestLease({
      expectedSha256: input.heldLeaseSha256,
      leasePath: input.heldLeasePath
    }),
    readElectronProductionPublicLatestRecoveryObservation({
      expectedSha256: input.preReleaseObservationSha256,
      receiptPath: input.preReleaseObservationPath
    }),
    readLeaseRemoteOperation({
      expectedSha256: input.leaseRemoteOperationSha256,
      operationPath: input.leaseRemoteOperationPath
    }),
    readElectronProductionPublicLatestRecoveryObservation({
      expectedSha256: input.finalObservationSha256,
      receiptPath: input.finalObservationPath
    })
  ]);
  const receipt = createElectronProductionTerminalPromotion({
    finalObservation: finalObservation.receipt,
    finalizedAt: input.finalizedAt,
    heldLease: heldLease.lease,
    heldLeaseFileSha256: heldLease.leaseIdentity.sha256,
    leaseReleaseResolvedAt: input.leaseReleaseResolvedAt,
    leaseRemoteOperation: remoteOperation.operation,
    ownerApproval: input.ownerApproval,
    preReleaseObservation: preReleaseObservation.receipt,
    producer: input.producer,
    provisionalPublicationReceipt: provisional.receipt,
    provisionalPublicationReceiptSha256:
      provisional.receiptIdentity.sha256,
    readinessReceipt: readiness.receipt,
    readinessReceiptIdentity: {
      bytes: readiness.receiptIdentity.bytes,
      sha256: readiness.receiptIdentity.sha256
    },
    sourceSnapshot: source.snapshot,
    sourceSnapshotFileSha256: source.file.sha256,
    targetSnapshot: target.snapshot,
    targetSnapshotFileSha256: target.file.sha256
  });
  return writeElectronProductionTerminalPromotion({
    outputPath: input.outputPath,
    receipt
  });
}

export function assertElectronProductionTerminalPromotion(value) {
  assertExactKeys(value, [
    "candidate",
    "channel",
    "compatibility",
    "finalizedAt",
    "kind",
    "lease",
    "outcome",
    "ownerGate",
    "producer",
    "publication",
    "readiness",
    "schemaVersion",
    "status",
    "terminal"
  ], "terminal promotion receipt");
  assertEqual(value.schemaVersion, 1, "terminal promotion schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_TERMINAL_PROMOTION_KIND,
    "terminal promotion kind"
  );
  assertEqual(
    value.status,
    "terminal-promotion-recorded",
    "terminal promotion status"
  );
  assertEqual(value.terminal, true, "terminal promotion terminality");
  assertEqual(value.outcome, "promoted", "terminal promotion outcome");
  assertExactRecord(value.ownerGate, {
    approval: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL,
    environment: "electron-production-release"
  }, "terminal promotion owner gate");
  assertExactRecord(value.channel, {
    repository: PUBLIC_REPOSITORY,
    updaterEndpoint: PUBLIC_LATEST_ENDPOINT
  }, "terminal promotion channel");
  const candidate = assertCandidate(value.candidate);
  const readiness = assertReadinessReference(value.readiness);
  const publication = assertPublicationReference(value.publication, candidate);
  const lease = assertLeaseReference(value.lease, publication);
  const compatibility = assertCompatibility(value.compatibility);
  const finalizedAt = requiredRfc3339(
    value.finalizedAt,
    "terminal promotion finalization time"
  );
  const producer = assertProducer(value.producer, value.finalizedAt);
  assertTimeOrder(
    publication.finalObservation.receipt.observedAt,
    value.finalizedAt,
    "Terminal promotion finalization cannot precede the final observation."
  );
  assertTimeOrder(
    lease.release.resolvedAt,
    publication.finalObservation.receipt.observedAt,
    "The terminal promotion final observation cannot precede lease release."
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_KIND,
    status: "terminal-promotion-recorded",
    terminal: true,
    outcome: "promoted",
    ownerGate: { ...value.ownerGate },
    channel: { ...value.channel },
    candidate,
    readiness,
    publication,
    lease,
    compatibility,
    producer,
    finalizedAt: new Date(finalizedAt).toISOString()
  });
}

export function assertElectronProductionTerminalPromotionBindings(input) {
  assertExactKeys(input, [
    "heldLease",
    "provisionalPublicationReceipt",
    "receipt",
    "readinessReceiptSha256",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "terminal promotion receipt bindings");
  const receipt = assertElectronProductionTerminalPromotion(input.receipt);
  const provisional = assertElectronProductionPublicationReceipt(
    input.provisionalPublicationReceipt
  );
  const source = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const target = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  const heldLease = assertHeldLease(input.heldLease);
  assertEqual(
    receipt.readiness.sha256,
    requiredDigest(input.readinessReceiptSha256, "readiness receipt SHA-256"),
    "terminal promotion readiness receipt binding"
  );
  assertEqual(
    receipt.publication.provisionalEventSha256,
    electronProductionPublicationEventSha256(provisional),
    "terminal promotion provisional event binding"
  );
  assertDeepEqual(
    receipt.publication.source,
    snapshotIdentity(
      source,
      requiredDigest(input.sourceSnapshotFileSha256, "source snapshot SHA-256"),
      "tauri-v22"
    ),
    "terminal promotion source snapshot binding"
  );
  assertDeepEqual(
    receipt.publication.target,
    snapshotIdentity(
      target,
      requiredDigest(input.targetSnapshotFileSha256, "target snapshot SHA-256"),
      "electron-v23"
    ),
    "terminal promotion target snapshot binding"
  );
  assertEqual(
    receipt.lease.held.eventSha256,
    electronProductionPublicLatestLeaseEventSha256(heldLease),
    "terminal promotion held lease binding"
  );
  return receipt;
}

export function serializeElectronProductionTerminalPromotion(value) {
  return serializeCanonicalJson(
    assertElectronProductionTerminalPromotion(value)
  );
}

export function electronProductionTerminalPromotionSha256(value) {
  return sha256(serializeElectronProductionTerminalPromotion(value));
}

export async function writeElectronProductionTerminalPromotion(input) {
  assertExactKeys(input, ["outputPath", "receipt"],
    "terminal promotion receipt write input");
  const receipt = assertElectronProductionTerminalPromotion(input.receipt);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT,
    "terminal promotion receipt"
  );
  await writeExclusive(
    outputPath,
    serializeElectronProductionTerminalPromotion(receipt)
  );
  return readElectronProductionTerminalPromotion({
    expectedSha256: electronProductionTerminalPromotionSha256(receipt),
    receiptPath: outputPath
  });
}

export async function readElectronProductionTerminalPromotion(input) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "terminal promotion receipt read input");
  assertEqual(
    path.basename(input.receiptPath),
    ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT,
    "terminal promotion receipt filename"
  );
  const file = await readCanonicalJsonFile(
    input.receiptPath,
    RECEIPT_MAXIMUM_BYTES,
    "terminal promotion receipt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256, "terminal promotion receipt SHA-256"),
    "terminal promotion receipt SHA-256"
  );
  const receipt = assertElectronProductionTerminalPromotion(file.value);
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(input.receiptPath, file),
    receiptPath: input.receiptPath
  });
}

async function readPromotionReadinessReceipt(input) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "promotion-readiness receipt read input");
  assertEqual(path.basename(input.receiptPath), READINESS_RECEIPT,
    "promotion-readiness receipt filename");
  const file = await readStableFile(
    input.receiptPath,
    RECEIPT_MAXIMUM_BYTES,
    "promotion-readiness receipt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256,
      "promotion-readiness receipt SHA-256"),
    "promotion-readiness receipt SHA-256"
  );
  let value;
  try {
    value = JSON.parse(file.source.toString("utf8"));
  } catch (error) {
    throw new Error("The promotion-readiness receipt is invalid JSON.", {
      cause: error
    });
  }
  const receipt = assertPromotionReadinessReceipt(value);
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(input.receiptPath, file),
    receiptPath: input.receiptPath
  });
}

async function readLeaseRemoteOperation(input) {
  assertExactKeys(input, ["expectedSha256", "operationPath"],
    "terminal lease remote operation read input");
  const file = await readCanonicalJsonFile(
    input.operationPath,
    RECEIPT_MAXIMUM_BYTES,
    "terminal lease remote operation"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256,
      "terminal lease remote operation SHA-256"),
    "terminal lease remote operation SHA-256"
  );
  return deepFreeze({
    operation:
      assertElectronProductionPublicLatestLeaseRemoteOperationSummary(
        file.value
      ),
    operationIdentity: publicIdentity(input.operationPath, file),
    operationPath: input.operationPath
  });
}

function assertPromotionReadinessReceipt(value) {
  assertExactKeys(value, [
    "candidate",
    "challenge",
    "compatibility",
    "evidence",
    "kind",
    "ownerGate",
    "priorElectronCandidate",
    "provenance",
    "provisionalPublication",
    "publication",
    "schemaVersion",
    "status",
    "tauriV22PublicLineage",
    "verifiedAt"
  ], "promotion-readiness receipt");
  assertEqual(value.schemaVersion, 4, "promotion-readiness schema version");
  assertEqual(value.kind, READINESS_KIND, "promotion-readiness kind");
  assertEqual(value.status, "verified-terminal-evidence",
    "promotion-readiness status");
  assertExactRecord(value.publication, {
    allowedByThisWorkflow: false,
    status: "externally-served-terminal-evidence-observed",
    terminalPromotionReceipt: false
  }, "promotion-readiness publication");
  assertExactRecord(value.ownerGate, {
    approval: "VERIFY ELECTRON PRODUCTION PROMOTION READINESS",
    environment: "electron-production-release"
  }, "promotion-readiness owner gate");
  const candidate = assertReadinessCandidate(value.candidate, "candidate");
  const priorElectronCandidate = assertReadinessCandidate(
    value.priorElectronCandidate,
    "prior Electron candidate",
    false
  );
  const provisionalPublication = assertReadinessProvisional(
    value.provisionalPublication
  );
  const provenance = assertReadinessProvenance(value.provenance);
  const challenge = assertReadinessChallenge(value.challenge);
  const evidence = assertReadinessEvidence(value.evidence, candidate);
  const compatibility = assertReadinessCompatibility(value.compatibility);
  const verifiedAt = requiredRfc3339(
    value.verifiedAt,
    "promotion-readiness verification time"
  );
  if (Date.parse(value.verifiedAt) > Date.parse(challenge.expiresAt)) {
    throw new Error("Promotion readiness must be verified within its evidence challenge.");
  }
  if (candidate.version === priorElectronCandidate.version) {
    throw new Error("Promotion readiness must bind a distinct prior Electron candidate.");
  }
  if (!value.tauriV22PublicLineage || typeof value.tauriV22PublicLineage !== "object") {
    throw new Error("Promotion readiness must bind the public Tauri v22 lineage.");
  }
  return deepFreeze({
    ...value,
    candidate,
    priorElectronCandidate,
    provisionalPublication,
    provenance,
    challenge,
    evidence,
    compatibility,
    verifiedAt: new Date(verifiedAt).toISOString()
  });
}

function assertReadinessIdentity(value) {
  assertExactKeys(value, ["bytes", "sha256"], "promotion-readiness file identity");
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
      value.bytes > RECEIPT_MAXIMUM_BYTES) {
    throw new Error("The promotion-readiness receipt byte length is invalid.");
  }
  return {
    bytes: value.bytes,
    sha256: requiredDigest(value.sha256, "promotion-readiness receipt SHA-256")
  };
}

function assertReadinessCandidate(value, label, requireFileName = true) {
  const keys = [
    "assets",
    "publicKeySha256",
    "receiptSha256",
    "sourceSha",
    "trustedControlReceiptSha256",
    "updaterEndpoint",
    "version"
  ];
  if (requireFileName) keys.push("receiptFileName", "updaterBaseUrl");
  assertExactKeys(value, keys, `promotion-readiness ${label}`);
  if (requireFileName) {
    assertEqual(value.receiptFileName,
      "electron-production-candidate-receipt.json",
      `promotion-readiness ${label} receipt filename`);
    requiredString(value.updaterBaseUrl,
      `promotion-readiness ${label} updater base URL`);
  }
  if (!value.assets || typeof value.assets !== "object" || Array.isArray(value.assets)) {
    throw new Error(`The promotion-readiness ${label} assets are invalid.`);
  }
  return {
    ...(requireFileName ? {
      receiptFileName: "electron-production-candidate-receipt.json",
      updaterBaseUrl: value.updaterBaseUrl
    } : {}),
    receiptSha256: requiredDigest(value.receiptSha256,
      `promotion-readiness ${label} receipt SHA-256`),
    trustedControlReceiptSha256: requiredDigest(
      value.trustedControlReceiptSha256,
      `promotion-readiness ${label} trusted-control SHA-256`
    ),
    sourceSha: requiredCommitSha(value.sourceSha,
      `promotion-readiness ${label} source SHA`),
    version: requiredSemanticVersion(value.version,
      `promotion-readiness ${label} version`),
    updaterEndpoint: requiredHttpsUpdaterEndpoint(
      value.updaterEndpoint,
      `promotion-readiness ${label} updater endpoint`
    ),
    publicKeySha256: requiredDigest(value.publicKeySha256,
      `promotion-readiness ${label} updater-key SHA-256`),
    assets: deepFreeze({ ...value.assets })
  };
}

function assertReadinessProvisional(value) {
  assertExactKeys(value, [
    "baseline",
    "lease",
    "outcome",
    "phase",
    "previousEventSha256",
    "producer",
    "publication",
    "receiptFileName",
    "receiptSha256",
    "recordedAt",
    "revision",
    "target",
    "terminal",
    "transactionId"
  ], "promotion-readiness provisional publication");
  assertEqual(value.receiptFileName,
    "electron-production-publication-provisional-receipt.json",
    "promotion-readiness provisional receipt filename");
  assertEqual(value.phase, "provisional",
    "promotion-readiness provisional phase");
  assertEqual(value.terminal, false,
    "promotion-readiness provisional terminality");
  assertEqual(value.outcome, null,
    "promotion-readiness provisional outcome");
  assertPositiveInteger(value.revision,
    "promotion-readiness provisional revision");
  requiredUuid(value.transactionId,
    "promotion-readiness provisional transaction ID");
  requiredRfc3339(value.recordedAt,
    "promotion-readiness provisional recorded time");
  requiredDigest(value.previousEventSha256,
    "promotion-readiness provisional previous event SHA-256");
  assertExactRecord(value.lease, {
    id: requiredUuid(value.lease?.id, "promotion-readiness provisional lease ID"),
    generation: value.lease?.generation,
    status: "held",
    foreignLeaseId: null,
    foreignLeaseGeneration: null
  }, "promotion-readiness provisional lease");
  assertPositiveInteger(value.lease.generation,
    "promotion-readiness provisional lease generation");
  assertExactRecord(value.publication, {
    acknowledgement: "confirmed",
    observedState: "target",
    observedStateSha256: value.target?.stateSha256
  }, "promotion-readiness provisional publication result");
  requiredDigest(value.publication.observedStateSha256,
    "promotion-readiness provisional target readback");
  if (!value.baseline || !value.target || !value.producer) {
    throw new Error("Promotion readiness has incomplete provisional bindings.");
  }
  return deepFreeze({ ...value });
}

function assertReadinessProvenance(value) {
  const keys = [
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
  ];
  assertExactKeys(value, keys, "promotion-readiness provenance");
  assertEqual(value.repository, SOURCE_REPOSITORY,
    "promotion-readiness provenance repository");
  for (const key of keys.filter((key) => key.endsWith("ControlSha"))) {
    requiredCommitSha(value[key], `promotion-readiness ${key}`);
  }
  for (const key of keys.filter((key) => key.endsWith("RunId"))) {
    requiredRunId(value[key], `promotion-readiness ${key}`);
  }
  for (const key of keys.filter((key) => key.endsWith("RunAttempt"))) {
    assertPositiveInteger(value[key], `promotion-readiness ${key}`);
  }
  return deepFreeze({ ...value });
}

function assertReadinessChallenge(value) {
  assertExactKeys(value, ["expiresAt", "id", "issuedAt", "nonceSha256"],
    "promotion-readiness challenge");
  const issuedAt = requiredRfc3339(value.issuedAt,
    "promotion-readiness challenge issue time");
  const expiresAt = requiredRfc3339(value.expiresAt,
    "promotion-readiness challenge expiry time");
  if (expiresAt <= issuedAt) {
    throw new Error("The promotion-readiness challenge expiry must follow issue time.");
  }
  return {
    id: requiredUuid(value.id, "promotion-readiness challenge ID"),
    nonceSha256: requiredDigest(value.nonceSha256,
      "promotion-readiness challenge nonce SHA-256"),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function assertReadinessEvidence(value, candidate) {
  assertExactKeys(value, TRANSITIONS, "promotion-readiness evidence matrix");
  const normalized = {};
  for (const transition of TRANSITIONS) {
    assertExactKeys(value[transition], PLATFORMS,
      `promotion-readiness ${transition} evidence`);
    normalized[transition] = {};
    for (const platform of PLATFORMS) {
      const cell = value[transition][platform];
      assertExactKeys(cell, [
        "attachments",
        "completedAt",
        "evidenceAttemptId",
        "producer",
        "receiptSha256",
        "source",
        "sourceFetchEndpoint",
        "sourceFetchFinalUrlSha256",
        "sourceFetchMode",
        "sourceInstallAttemptId",
        "target",
        "terminalOutcome"
      ], `promotion-readiness ${transition} ${platform} evidence`);
      assertEqual(cell.terminalOutcome, "applied",
        `promotion-readiness ${transition} ${platform} outcome`);
      requiredDigest(cell.receiptSha256,
        `promotion-readiness ${transition} ${platform} receipt SHA-256`);
      requiredUuid(cell.evidenceAttemptId,
        `promotion-readiness ${transition} ${platform} evidence attempt ID`);
      requiredString(cell.sourceInstallAttemptId,
        `promotion-readiness ${transition} ${platform} source attempt ID`);
      requiredRfc3339(cell.completedAt,
        `promotion-readiness ${transition} ${platform} completion time`);
      if (cell.target?.version !== candidate.version ||
          cell.target?.sourceSha !== candidate.sourceSha) {
        throw new Error(
          `Promotion-readiness ${transition} ${platform} target does not match the candidate.`
        );
      }
      normalized[transition][platform] = deepFreeze({ ...cell });
    }
  }
  return deepFreeze(normalized);
}

function assertReadinessCompatibility(value) {
  assertExactRecord(value, {
    macosAppKitRetained: true,
    stableTauriReleasePath: "retained-as-rollback-source-until-terminal-promotion",
    windowsEvidenceIndependent: true
  }, "promotion-readiness compatibility");
  return { ...value };
}

function assertProvisionalReadinessBinding(readiness, provisional, digest) {
  const summary = readiness.provisionalPublication;
  for (const [actual, expected, label] of [
    [summary.receiptSha256, digest, "receipt SHA-256"],
    [summary.transactionId, provisional.transactionId, "transaction ID"],
    [summary.revision, provisional.revision, "revision"],
    [summary.previousEventSha256, provisional.previousEventSha256,
      "previous event SHA-256"],
    [summary.recordedAt, provisional.recordedAt, "recorded time"],
    [summary.target.stateSha256, provisional.target.stateSha256,
      "target state SHA-256"],
    [summary.baseline.stateSha256, provisional.baseline.stateSha256,
      "baseline state SHA-256"]
  ]) assertEqual(actual, expected, `promotion-readiness provisional ${label}`);
  assertEqual(provisional.phase, "provisional", "provisional publication phase");
  assertEqual(provisional.terminal, false,
    "provisional publication terminality");
  assertEqual(provisional.publication.acknowledgement, "confirmed",
    "provisional publication acknowledgement");
  assertEqual(provisional.publication.observedState, "target",
    "provisional publication observed state");
}

function assertReadinessSnapshotBindings(readiness, source, target) {
  const candidate = readiness.candidate;
  for (const [actual, expected, label] of [
    [readiness.provisionalPublication.baseline.stateSha256,
      source.stateSha256, "source state SHA-256"],
    [readiness.provisionalPublication.target.stateSha256,
      target.stateSha256, "target state SHA-256"],
    [candidate.receiptSha256, target.candidateReceipt?.sha256,
      "candidate receipt SHA-256"],
    [candidate.sourceSha, target.candidateReceipt?.sourceSha,
      "candidate source SHA"],
    [candidate.version, target.latestJson.version, "candidate version"],
    [candidate.assets["latest.json"], target.latestJson.sha256,
      "candidate manifest SHA-256"]
  ]) assertEqual(actual, expected, `promotion-readiness ${label}`);
}

function assertSnapshotFileDigest(snapshot, expectedValue, label) {
  const expected = requiredDigest(expectedValue, `${label} file SHA-256`);
  assertEqual(
    expected,
    sha256(serializeElectronProductionPublicLatestSnapshot(snapshot)),
    `${label} file SHA-256`
  );
  return expected;
}

function assertHeldLease(value) {
  const lease = assertElectronProductionPublicLatestLease(value);
  assertEqual(lease.status, "held", "terminal promotion lease status");
  assertEqual(lease.purpose, "electron-v23-provisional-publication",
    "terminal promotion lease purpose");
  return lease;
}

function assertLeaseBindings(lease, provisional, source, target) {
  for (const [actual, expected, label] of [
    [lease.transactionId, provisional.transactionId, "transaction ID"],
    [lease.leaseId, provisional.lease.id, "lease ID"],
    [lease.generation, provisional.lease.generation, "lease generation"],
    [lease.source.stateSha256, source.stateSha256, "source state SHA-256"],
    [lease.source.version, source.latestJson.version, "source version"],
    [lease.target.stateSha256, target.stateSha256, "target state SHA-256"],
    [lease.target.version, target.latestJson.version, "target version"]
  ]) assertEqual(actual, expected, `terminal promotion lease ${label}`);
}

function assertBoundTargetObservation(input) {
  const receipt = assertElectronProductionPublicLatestRecoveryObservationBindings({
    observation: input.observation,
    sourceSnapshot: input.sourceSnapshot,
    sourceSnapshotFileSha256: input.sourceSnapshotFileSha256,
    targetSnapshot: input.targetSnapshot,
    targetSnapshotFileSha256: input.targetSnapshotFileSha256
  });
  if (receipt.transport.outcome !== "observed" ||
      receipt.observation.classification !== "target" ||
      receipt.observation.snapshot?.stateSha256 !==
        input.targetSnapshot.stateSha256) {
    throw new Error(`The ${input.label} must be an exact target observation.`);
  }
  return observationReference(receipt);
}

function observationReference(value) {
  const receipt = assertElectronProductionPublicLatestRecoveryObservation(value);
  return deepFreeze({
    sha256: electronProductionPublicLatestRecoveryObservationSha256(receipt),
    receipt
  });
}

function assertConfirmedLeaseRelease(input) {
  const remote =
    assertElectronProductionPublicLatestLeaseRemoteOperationSummary(
      input.remoteOperation
    );
  if (remote.command !== "release" && remote.command !== "observe-release") {
    throw new Error("Terminal promotion requires a lease release operation.");
  }
  const confirmed =
    (remote.command === "release" && remote.outcome === "applied") ||
    (remote.command === "observe-release" && remote.outcome === "observed");
  if (!confirmed || remote.reason !== null || remote.httpStatus !== 200) {
    throw new Error("Terminal promotion requires a confirmed lease release acknowledgement.");
  }
  const attemptedAt = requiredRfc3339(
    remote.request?.attemptedAt,
    "terminal promotion lease release attempt time"
  );
  const resolvedAt = requiredRfc3339(
    input.resolvedAt,
    "terminal promotion lease release resolution time"
  );
  if (resolvedAt < attemptedAt) {
    throw new Error("Lease release resolution cannot precede its attempt.");
  }
  if (remote.command === "release") {
    assertTimeOrder(
      input.preReleaseObservation.observedAt,
      remote.request.attemptedAt,
      "Lease release cannot precede the exact target observation."
    );
  } else {
    assertTimeOrder(
      input.preReleaseObservation.observedAt,
      input.resolvedAt,
      "Lease release reconciliation cannot precede the exact target observation."
    );
  }
  const held = heldLeaseIdentity(input.heldLease);
  assertDeepEqual(remote.request?.held, held,
    "terminal promotion remote held lease binding");
  const released = releaseElectronProductionPublicLatestLease(input.heldLease, {
    transactionId: input.heldLease.transactionId,
    leaseId: input.heldLease.leaseId,
    generation: input.heldLease.generation,
    sourceStateSha256: input.heldLease.source.stateSha256,
    targetStateSha256: input.heldLease.target.stateSha256,
    recordedAt: remote.request.attemptedAt
  });
  const releasedSource = serializeElectronProductionPublicLatestLease(released);
  const releasedEventSha256 =
    electronProductionPublicLatestLeaseEventSha256(released);
  for (const [actual, expected, label] of [
    [remote.lease?.transactionId, released.transactionId, "transaction ID"],
    [remote.lease?.leaseId, released.leaseId, "lease ID"],
    [remote.lease?.generation, released.generation, "generation"],
    [remote.lease?.revision, released.revision, "revision"],
    [remote.lease?.status, "released", "status"],
    [remote.lease?.eventSha256, releasedEventSha256, "event SHA-256"],
    [remote.output?.bytes, releasedSource.length, "output bytes"],
    [remote.output?.sha256, sha256(releasedSource), "output SHA-256"],
    [remote.output?.fileName, "electron-production-public-latest-lease.json",
      "output filename"],
    [remote.remote.blobSha, gitBlobSha(releasedSource), "remote blob SHA"]
  ]) assertEqual(actual, expected, `terminal promotion released lease ${label}`);
  return deepFreeze({
    command: remote.command,
    attemptedAt: new Date(attemptedAt).toISOString(),
    resolvedAt: new Date(resolvedAt).toISOString(),
    acknowledgement: "confirmed",
    remoteOperationSha256: sha256(serializeCanonicalJson(remote)),
    successor: {
      revision: released.revision,
      eventSha256: releasedEventSha256,
      fileSha256: sha256(releasedSource),
      blobSha: remote.remote.blobSha
    }
  });
}

function heldLeaseIdentity(lease) {
  return {
    transactionId: lease.transactionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    revision: lease.revision,
    eventSha256: electronProductionPublicLatestLeaseEventSha256(lease),
    sourceStateSha256: lease.source.stateSha256,
    targetStateSha256: lease.target.stateSha256
  };
}

function snapshotIdentity(snapshot, fileSha256, runtime) {
  return {
    runtime,
    version: snapshot.latestJson.version,
    releaseId: snapshot.release.id,
    releaseTag: snapshot.release.tag,
    stateSha256: snapshot.stateSha256,
    snapshotSha256: snapshot.snapshotSha256,
    fileSha256
  };
}

function assertCandidate(value) {
  assertExactKeys(value, [
    "manifestSha256",
    "receiptSha256",
    "releaseTag",
    "sourceSha",
    "version"
  ], "terminal promotion candidate");
  return {
    receiptSha256: requiredDigest(value.receiptSha256,
      "terminal promotion candidate receipt SHA-256"),
    sourceSha: requiredCommitSha(value.sourceSha,
      "terminal promotion candidate source SHA"),
    version: requiredSemanticVersion(value.version,
      "terminal promotion candidate version"),
    releaseTag: requiredString(value.releaseTag,
      "terminal promotion candidate release tag"),
    manifestSha256: requiredDigest(value.manifestSha256,
      "terminal promotion candidate manifest SHA-256")
  };
}

function assertReadinessReference(value) {
  assertExactKeys(value, [
    "bytes",
    "controlSha",
    "receiptFileName",
    "sha256",
    "verifiedAt"
  ], "terminal promotion readiness reference");
  assertEqual(value.receiptFileName, READINESS_RECEIPT,
    "terminal promotion readiness filename");
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
      value.bytes > RECEIPT_MAXIMUM_BYTES) {
    throw new Error("The terminal promotion readiness byte length is invalid.");
  }
  return {
    receiptFileName: READINESS_RECEIPT,
    bytes: value.bytes,
    sha256: requiredDigest(value.sha256,
      "terminal promotion readiness SHA-256"),
    verifiedAt: new Date(requiredRfc3339(value.verifiedAt,
      "terminal promotion readiness verification time")).toISOString(),
    controlSha: requiredCommitSha(value.controlSha,
      "terminal promotion readiness control SHA")
  };
}

function assertPublicationReference(value, candidate) {
  assertExactKeys(value, [
    "finalObservation",
    "preReleaseObservation",
    "provisionalEventSha256",
    "provisionalReceiptSha256",
    "provisionalRevision",
    "source",
    "target",
    "transactionId"
  ], "terminal promotion publication reference");
  const source = assertSnapshotReference(value.source, "tauri-v22", "source");
  const target = assertSnapshotReference(value.target, "electron-v23", "target");
  assertEqual(target.version, candidate.version,
    "terminal promotion target candidate version");
  assertEqual(target.releaseTag, candidate.releaseTag,
    "terminal promotion target candidate release tag");
  const preReleaseObservation = assertObservationReference(
    value.preReleaseObservation,
    target,
    "pre-release"
  );
  const finalObservation = assertObservationReference(
    value.finalObservation,
    target,
    "final"
  );
  assertTimeOrder(
    preReleaseObservation.receipt.observedAt,
    finalObservation.receipt.observedAt,
    "The terminal promotion final observation cannot precede its pre-release observation."
  );
  assertPositiveInteger(value.provisionalRevision,
    "terminal promotion provisional revision");
  return {
    transactionId: requiredUuid(value.transactionId,
      "terminal promotion transaction ID"),
    provisionalReceiptSha256: requiredDigest(
      value.provisionalReceiptSha256,
      "terminal promotion provisional receipt SHA-256"
    ),
    provisionalRevision: value.provisionalRevision,
    provisionalEventSha256: requiredDigest(
      value.provisionalEventSha256,
      "terminal promotion provisional event SHA-256"
    ),
    source,
    target,
    preReleaseObservation,
    finalObservation
  };
}

function assertSnapshotReference(value, runtime, label) {
  assertExactKeys(value, [
    "fileSha256",
    "releaseId",
    "releaseTag",
    "runtime",
    "snapshotSha256",
    "stateSha256",
    "version"
  ], `terminal promotion ${label} snapshot`);
  assertEqual(value.runtime, runtime,
    `terminal promotion ${label} runtime`);
  return {
    runtime,
    version: requiredSemanticVersion(value.version,
      `terminal promotion ${label} version`),
    releaseId: requiredString(value.releaseId,
      `terminal promotion ${label} release ID`),
    releaseTag: requiredString(value.releaseTag,
      `terminal promotion ${label} release tag`),
    stateSha256: requiredDigest(value.stateSha256,
      `terminal promotion ${label} state SHA-256`),
    snapshotSha256: requiredDigest(value.snapshotSha256,
      `terminal promotion ${label} snapshot SHA-256`),
    fileSha256: requiredDigest(value.fileSha256,
      `terminal promotion ${label} file SHA-256`)
  };
}

function assertObservationReference(value, target, label) {
  assertExactKeys(value, ["receipt", "sha256"],
    `terminal promotion ${label} observation reference`);
  const receipt = assertElectronProductionPublicLatestRecoveryObservation(
    value.receipt
  );
  assertEqual(value.sha256,
    electronProductionPublicLatestRecoveryObservationSha256(receipt),
    `terminal promotion ${label} observation SHA-256`);
  if (receipt.transport.outcome !== "observed" ||
      receipt.observation.classification !== "target") {
    throw new Error(`The terminal promotion ${label} observation must be target.`);
  }
  assertEqual(receipt.observation.snapshot?.stateSha256, target.stateSha256,
    `terminal promotion ${label} target state SHA-256`);
  return observationReference(receipt);
}

function assertLeaseReference(value, publication) {
  assertExactKeys(value, ["held", "release"], "terminal promotion lease");
  assertExactKeys(value.held, [
    "eventSha256",
    "fileSha256",
    "generation",
    "leaseId",
    "revision",
    "transactionId"
  ], "terminal promotion held lease");
  assertEqual(value.held.transactionId, publication.transactionId,
    "terminal promotion held lease transaction ID");
  assertPositiveInteger(value.held.generation,
    "terminal promotion held lease generation");
  assertPositiveInteger(value.held.revision,
    "terminal promotion held lease revision");
  const held = {
    transactionId: requiredUuid(value.held.transactionId,
      "terminal promotion held transaction ID"),
    leaseId: requiredUuid(value.held.leaseId,
      "terminal promotion held lease ID"),
    generation: value.held.generation,
    revision: value.held.revision,
    eventSha256: requiredDigest(value.held.eventSha256,
      "terminal promotion held lease event SHA-256"),
    fileSha256: requiredDigest(value.held.fileSha256,
      "terminal promotion held lease file SHA-256")
  };
  const release = assertLeaseReleaseReference(value.release, held);
  return { held, release };
}

function assertLeaseReleaseReference(value, held) {
  assertExactKeys(value, [
    "acknowledgement",
    "attemptedAt",
    "command",
    "remoteOperationSha256",
    "resolvedAt",
    "successor"
  ], "terminal promotion lease release");
  if (value.command !== "release" && value.command !== "observe-release") {
    throw new Error("The terminal promotion lease release command is invalid.");
  }
  assertEqual(value.acknowledgement, "confirmed",
    "terminal promotion lease release acknowledgement");
  const attemptedAt = requiredRfc3339(value.attemptedAt,
    "terminal promotion lease release attempt time");
  const resolvedAt = requiredRfc3339(value.resolvedAt,
    "terminal promotion lease release resolution time");
  if (resolvedAt < attemptedAt) {
    throw new Error("Terminal promotion lease release resolution precedes its attempt.");
  }
  assertExactKeys(value.successor, [
    "blobSha",
    "eventSha256",
    "fileSha256",
    "revision"
  ], "terminal promotion released lease successor");
  assertEqual(value.successor.revision, held.revision + 1,
    "terminal promotion released lease revision");
  return {
    command: value.command,
    attemptedAt: new Date(attemptedAt).toISOString(),
    resolvedAt: new Date(resolvedAt).toISOString(),
    acknowledgement: "confirmed",
    remoteOperationSha256: requiredDigest(
      value.remoteOperationSha256,
      "terminal promotion remote lease operation SHA-256"
    ),
    successor: {
      revision: value.successor.revision,
      eventSha256: requiredDigest(value.successor.eventSha256,
        "terminal promotion released lease event SHA-256"),
      fileSha256: requiredDigest(value.successor.fileSha256,
        "terminal promotion released lease file SHA-256"),
      blobSha: requiredCommitSha(value.successor.blobSha,
        "terminal promotion released lease blob SHA")
    }
  };
}

function assertCompatibility(value) {
  assertExactRecord(value, {
    macosAppKitRetained: true,
    stableTauriReleasePath: "retained-as-rollback-source-through-finalization",
    windowsEvidenceIndependent: true
  }, "terminal promotion compatibility");
  return { ...value };
}

function assertProducer(value, finalizedAt) {
  assertExactKeys(value, [
    "controlSha",
    "event",
    "producedAt",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "terminal promotion producer");
  assertEqual(value.repository, SOURCE_REPOSITORY,
    "terminal promotion producer repository");
  assertEqual(value.workflow, ELECTRON_PRODUCTION_TERMINAL_PROMOTION_WORKFLOW,
    "terminal promotion producer workflow");
  assertEqual(value.event, "workflow_dispatch",
    "terminal promotion producer event");
  assertEqual(value.producedAt, finalizedAt,
    "terminal promotion producer time");
  assertPositiveInteger(value.runAttempt,
    "terminal promotion producer run attempt");
  return {
    repository: SOURCE_REPOSITORY,
    workflow: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_WORKFLOW,
    event: "workflow_dispatch",
    runId: requiredRunId(value.runId,
      "terminal promotion producer run ID"),
    runAttempt: value.runAttempt,
    controlSha: requiredCommitSha(value.controlSha,
      "terminal promotion producer control SHA"),
    producedAt: new Date(requiredRfc3339(value.producedAt,
      "terminal promotion producer time")).toISOString()
  };
}

function assertExactRecord(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(actual[key], value, `${label} ${key}`);
  }
}

function assertTimeOrder(previous, next, message) {
  const previousTime = requiredRfc3339(previous, "previous event time");
  const nextTime = requiredRfc3339(next, "next event time");
  if (nextTime < previousTime) throw new Error(message);
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
