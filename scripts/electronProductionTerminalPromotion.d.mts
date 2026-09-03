import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestRecoveryObservation
} from "./electronProductionPublicLatestRecovery.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicLatestLeaseRemoteOperationSummary
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import type {
  ElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";

export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL:
  "FINALIZE ELECTRON PRODUCTION PROMOTION";
export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_KIND:
  "rion-electron-production-terminal-promotion";
export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT:
  "electron-production-terminal-promotion-receipt.json";
export const ELECTRON_PRODUCTION_TERMINAL_PROMOTION_WORKFLOW:
  ".github/workflows/electron-production-terminal-promotion.yml";

export interface ElectronProductionTerminalPromotionReceipt {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-terminal-promotion";
  readonly status: "terminal-promotion-recorded";
  readonly terminal: true;
  readonly outcome: "promoted";
  readonly ownerGate: Readonly<{
    approval: "FINALIZE ELECTRON PRODUCTION PROMOTION";
    environment: "electron-production-release";
  }>;
  readonly channel: Readonly<{
    repository: "rion-tw/rion-studio";
    updaterEndpoint:
      "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
  }>;
  readonly candidate: Readonly<{
    receiptSha256: string;
    sourceSha: string;
    version: string;
    releaseTag: string;
    manifestSha256: string;
  }>;
  readonly readiness: Readonly<{
    receiptFileName:
      "electron-production-promotion-readiness-receipt.json";
    bytes: number;
    sha256: string;
    verifiedAt: string;
    controlSha: string;
  }>;
  readonly publication: Readonly<{
    transactionId: string;
    provisionalReceiptSha256: string;
    provisionalRevision: number;
    provisionalEventSha256: string;
    source: Readonly<ElectronProductionTerminalPromotionSnapshotReference>;
    target: Readonly<ElectronProductionTerminalPromotionSnapshotReference>;
    preReleaseObservation:
      Readonly<ElectronProductionTerminalPromotionObservationReference>;
    finalObservation:
      Readonly<ElectronProductionTerminalPromotionObservationReference>;
  }>;
  readonly lease: Readonly<{
    held: Readonly<{
      transactionId: string;
      leaseId: string;
      generation: number;
      revision: number;
      eventSha256: string;
      fileSha256: string;
    }>;
    release: Readonly<{
      command: "release" | "observe-release";
      attemptedAt: string;
      resolvedAt: string;
      acknowledgement: "confirmed";
      remoteOperationSha256: string;
      successor: Readonly<{
        revision: number;
        eventSha256: string;
        fileSha256: string;
        blobSha: string;
      }>;
    }>;
  }>;
  readonly compatibility: Readonly<{
    macosAppKitRetained: true;
    stableTauriReleasePath:
      "retained-as-rollback-source-through-finalization";
    windowsEvidenceIndependent: true;
  }>;
  readonly producer: Readonly<{
    repository: "rion-tw/rion-studio-source";
    workflow:
      ".github/workflows/electron-production-terminal-promotion.yml";
    event: "workflow_dispatch";
    runId: string;
    runAttempt: number;
    controlSha: string;
    producedAt: string;
  }>;
  readonly finalizedAt: string;
}

export interface ElectronProductionTerminalPromotionSnapshotReference {
  readonly runtime: "tauri-v22" | "electron-v23";
  readonly version: string;
  readonly releaseId: string;
  readonly releaseTag: string;
  readonly stateSha256: string;
  readonly snapshotSha256: string;
  readonly fileSha256: string;
}

export interface ElectronProductionTerminalPromotionObservationReference {
  readonly sha256: string;
  readonly receipt:
    Readonly<ElectronProductionPublicLatestRecoveryObservation>;
}

export interface ElectronProductionTerminalPromotionInput {
  readonly finalObservation:
    ElectronProductionPublicLatestRecoveryObservation;
  readonly finalizedAt: string;
  readonly heldLease: ElectronProductionPublicLatestLease;
  readonly heldLeaseFileSha256: string;
  readonly leaseReleaseResolvedAt: string;
  readonly leaseRemoteOperation:
    ElectronProductionPublicLatestLeaseRemoteOperationSummary;
  readonly ownerApproval: string;
  readonly preReleaseObservation:
    ElectronProductionPublicLatestRecoveryObservation;
  readonly producer: ElectronProductionTerminalPromotionReceipt["producer"];
  readonly provisionalPublicationReceipt:
    ElectronProductionPublicationReceipt;
  readonly provisionalPublicationReceiptSha256: string;
  readonly readinessReceipt: Readonly<Record<string, unknown>>;
  readonly readinessReceiptIdentity: Readonly<{
    bytes: number;
    sha256: string;
  }>;
  readonly sourceSnapshot: ElectronProductionPublicLatestSnapshot;
  readonly sourceSnapshotFileSha256: string;
  readonly targetSnapshot: ElectronProductionPublicLatestSnapshot;
  readonly targetSnapshotFileSha256: string;
}

export function createElectronProductionTerminalPromotion(
  input: Readonly<ElectronProductionTerminalPromotionInput>
): Readonly<ElectronProductionTerminalPromotionReceipt>;

export function finalizeElectronProductionTerminalPromotion(
  input: Readonly<{
    finalObservationPath: string;
    finalObservationSha256: string;
    finalizedAt: string;
    heldLeasePath: string;
    heldLeaseSha256: string;
    leaseReleaseResolvedAt: string;
    leaseRemoteOperationPath: string;
    leaseRemoteOperationSha256: string;
    outputPath: string;
    ownerApproval: string;
    preReleaseObservationPath: string;
    preReleaseObservationSha256: string;
    producer: ElectronProductionTerminalPromotionReceipt["producer"];
    provisionalPublicationReceiptPath: string;
    provisionalPublicationReceiptSha256: string;
    readinessReceiptPath: string;
    readinessReceiptSha256: string;
    sourceSnapshotPath: string;
    sourceSnapshotSha256: string;
    targetSnapshotPath: string;
    targetSnapshotSha256: string;
  }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionTerminalPromotionReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  receiptPath: string;
}>>;

export function assertElectronProductionTerminalPromotion(
  value: unknown
): Readonly<ElectronProductionTerminalPromotionReceipt>;

export function assertElectronProductionTerminalPromotionBindings(
  input: Readonly<{
    heldLease: ElectronProductionPublicLatestLease;
    provisionalPublicationReceipt: ElectronProductionPublicationReceipt;
    receipt: unknown;
    readinessReceiptSha256: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionTerminalPromotionReceipt>;

export function serializeElectronProductionTerminalPromotion(
  value: unknown
): Buffer;

export function electronProductionTerminalPromotionSha256(
  value: unknown
): string;

export function writeElectronProductionTerminalPromotion(
  input: Readonly<{
    outputPath: string;
    receipt: ElectronProductionTerminalPromotionReceipt;
  }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionTerminalPromotionReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  receiptPath: string;
}>>;

export function readElectronProductionTerminalPromotion(
  input: Readonly<{
    expectedSha256: string;
    receiptPath: string;
  }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionTerminalPromotionReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  receiptPath: string;
}>>;
