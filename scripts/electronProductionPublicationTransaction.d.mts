import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicationAcknowledgement,
  ElectronProductionPublicationLeaseObservation,
  ElectronProductionPublicationReceipt,
  ElectronProductionRollbackAcknowledgement
} from "./electronProductionPublicationReceipt.mjs";
import type {
  TauriV22PublicLineageReceipt
} from "./tauriV22PublicLineage.mjs";

export interface ElectronProductionBaselineLineage {
  readonly manifestSha256: string;
  readonly releaseTag: string;
  readonly runtime: "tauri-v22";
  readonly sourceSha: string;
  readonly version: string;
}

export function createElectronProductionBaselineLineageFromReceipts(
  input: Readonly<{
    macos: TauriV22PublicLineageReceipt;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    windows: TauriV22PublicLineageReceipt;
  }>
): Readonly<ElectronProductionBaselineLineage>;

export function createElectronProductionPublicationIntentFromSnapshots(
  input: Readonly<{
    baselineLineage: ElectronProductionBaselineLineage;
    lease: Readonly<{ id: string; generation: number }>;
    recordedAt: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    transactionId: string;
  }>
): Readonly<ElectronProductionPublicationReceipt>;

export function recordElectronProductionPublicationResult(input: Readonly<{
  acknowledgement: ElectronProductionPublicationAcknowledgement;
  lease: ElectronProductionPublicationLeaseObservation;
  observedSnapshot: ElectronProductionPublicLatestSnapshot | null;
  previousReceipt: ElectronProductionPublicationReceipt;
  recordedAt: string;
  sourceSnapshot: ElectronProductionPublicLatestSnapshot;
  targetSnapshot: ElectronProductionPublicLatestSnapshot;
}>): Readonly<ElectronProductionPublicationReceipt>;

export function recordElectronProductionPublicationRecovery(input: Readonly<{
  finalSnapshot: ElectronProductionPublicLatestSnapshot | null;
  lease: ElectronProductionPublicationLeaseObservation;
  observedSnapshot: ElectronProductionPublicLatestSnapshot | null;
  previousReceipt: ElectronProductionPublicationReceipt;
  recordedAt: string;
  rollbackAcknowledgement: ElectronProductionRollbackAcknowledgement | null;
  rollbackAttempted: boolean;
  sourceSnapshot: ElectronProductionPublicLatestSnapshot;
  targetSnapshot: ElectronProductionPublicLatestSnapshot;
}>): Readonly<ElectronProductionPublicationReceipt>;

export function assertElectronProductionPublicationSnapshotBindings(
  input: Readonly<{
    receipt: unknown;
    sourceSnapshot: unknown;
    targetSnapshot: unknown;
  }>
): Readonly<ElectronProductionPublicationReceipt>;
