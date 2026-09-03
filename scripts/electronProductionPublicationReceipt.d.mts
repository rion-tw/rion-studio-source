export const ELECTRON_PRODUCTION_PUBLICATION_KIND:
  "rion-electron-production-publication-transaction";
export const ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY:
  "rion-tw/rion-studio";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT:
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES: Readonly<{
  intent: "electron-production-publication-intent-receipt.json";
  provisional: "electron-production-publication-provisional-receipt.json";
  "recovery-required": "electron-production-publication-recovery-required-receipt.json";
  terminal: "electron-production-publication-recovery-receipt.json";
}>;

export type ElectronProductionPublicationPhase =
  | "intent"
  | "provisional"
  | "recovery-required"
  | "terminal";
export type ElectronProductionPublicationTerminalOutcome =
  | "aborted"
  | "rolled-back"
  | "indeterminate";
export type ElectronProductionPublicationAcknowledgement =
  | "not-submitted"
  | "confirmed"
  | "rejected"
  | "unknown";
export type ElectronProductionRollbackAcknowledgement =
  | "confirmed"
  | "rejected"
  | "unknown";
export type ElectronProductionPublishedState =
  | "baseline"
  | "target"
  | "foreign"
  | "unknown";
export type ElectronProductionPublicationLeaseStatus =
  | "held"
  | "lost"
  | "foreign";
export type ElectronProductionPublicationRecoveryReason =
  | "publication-not-submitted"
  | "publication-rejected"
  | "source-snapshot-restored"
  | "foreign-lease-observed"
  | "foreign-state-observed"
  | "lease-lost"
  | "publication-acknowledgement-unknown"
  | "publication-readback-mismatch"
  | "published-state-unknown"
  | "rollback-acknowledgement-unknown"
  | "rollback-not-attempted"
  | "rollback-readback-mismatch"
  | "rollback-rejected";

export interface ElectronProductionPublicationBaseline {
  readonly manifestSha256: string;
  readonly releaseTag: string;
  readonly runtime: "tauri-v22";
  readonly sourceSha: string;
  readonly stateSha256: string;
  readonly version: string;
}

export interface ElectronProductionPublicationTarget {
  readonly candidateReceiptSha256: string;
  readonly manifestSha256: string;
  readonly releaseTag: string;
  readonly runtime: "electron-v23";
  readonly sourceSha: string;
  readonly stateSha256: string;
  readonly version: string;
}

export interface ElectronProductionPublicationLease {
  readonly id: string;
  readonly generation: number;
  readonly status: ElectronProductionPublicationLeaseStatus;
  readonly foreignLeaseId: string | null;
  readonly foreignLeaseGeneration: number | null;
}

export interface ElectronProductionPublicationResult {
  readonly acknowledgement: ElectronProductionPublicationAcknowledgement | null;
  readonly observedState: ElectronProductionPublishedState;
  readonly observedStateSha256: string | null;
}

export interface ElectronProductionPublicationRecovery {
  readonly rollbackAllowed: boolean;
  readonly rollbackAttempted: boolean;
  readonly acknowledgement: ElectronProductionRollbackAcknowledgement | null;
  readonly observedStateBeforeRollback: ElectronProductionPublishedState | null;
  readonly observedStateBeforeRollbackSha256: string | null;
  readonly finalState: ElectronProductionPublishedState | null;
  readonly finalStateSha256: string | null;
  readonly reason: ElectronProductionPublicationRecoveryReason | null;
}

export interface ElectronProductionPublicationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-publication-transaction";
  readonly transactionId: string;
  readonly revision: number;
  readonly previousEventSha256: string | null;
  readonly phase: ElectronProductionPublicationPhase;
  readonly terminal: boolean;
  readonly outcome: ElectronProductionPublicationTerminalOutcome | null;
  readonly channel: Readonly<{
    repository: "rion-tw/rion-studio";
    updaterEndpoint:
      "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
  }>;
  readonly baseline: ElectronProductionPublicationBaseline;
  readonly target: ElectronProductionPublicationTarget;
  readonly lease: ElectronProductionPublicationLease;
  readonly publication: ElectronProductionPublicationResult;
  readonly recovery: ElectronProductionPublicationRecovery;
  readonly recordedAt: string;
}

export interface ElectronProductionPublicationLeaseObservation {
  readonly id: string;
  readonly generation: number;
  readonly status: ElectronProductionPublicationLeaseStatus;
  readonly foreignLeaseId: string | null;
  readonly foreignLeaseGeneration: number | null;
}

export type ElectronProductionPublicationTransition =
  | Readonly<{
      kind: "publication-result";
      recordedAt: string;
      lease: ElectronProductionPublicationLeaseObservation;
      acknowledgement: ElectronProductionPublicationAcknowledgement;
      observedState: ElectronProductionPublishedState;
      observedStateSha256: string | null;
    }>
  | Readonly<{
      kind: "recovery-result";
      recordedAt: string;
      lease: ElectronProductionPublicationLeaseObservation;
      observedState: ElectronProductionPublishedState;
      observedStateSha256: string | null;
      rollbackAttempted: boolean;
      rollbackAcknowledgement: ElectronProductionRollbackAcknowledgement | null;
      finalState: ElectronProductionPublishedState;
      finalStateSha256: string | null;
    }>;

export interface ElectronProductionPublicationReceiptFile {
  readonly receipt: Readonly<ElectronProductionPublicationReceipt>;
  readonly receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly receiptPath: string;
}

export function createElectronProductionPublicationIntent(input: Readonly<{
  baseline: ElectronProductionPublicationBaseline;
  lease: Readonly<{ id: string; generation: number }>;
  recordedAt: string;
  target: ElectronProductionPublicationTarget;
  transactionId: string;
}>): Readonly<ElectronProductionPublicationReceipt>;

export function transitionElectronProductionPublication(
  previous: Readonly<ElectronProductionPublicationReceipt>,
  transition: ElectronProductionPublicationTransition
): Readonly<ElectronProductionPublicationReceipt>;

export function electronProductionPublicationEventSha256(
  receipt: Readonly<ElectronProductionPublicationReceipt>
): string;

export function assertElectronProductionPublicationReceipt(
  value: unknown
): Readonly<ElectronProductionPublicationReceipt>;

export function writeElectronProductionPublicationReceipt(input: Readonly<{
  outputPath: string;
  receipt: Readonly<ElectronProductionPublicationReceipt>;
}>): Promise<Readonly<ElectronProductionPublicationReceiptFile>>;

export function readElectronProductionPublicationReceipt(input: Readonly<{
  expectedSha256: string;
  receiptPath: string;
}>): Promise<Readonly<ElectronProductionPublicationReceiptFile>>;
