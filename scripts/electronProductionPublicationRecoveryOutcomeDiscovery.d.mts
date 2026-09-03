import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicationRecoveryOutcome,
  ElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_KIND:
  "rion-electron-production-publication-recovery-outcome-discovery";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND:
  "rion-electron-production-publication-recovery-outcome-chain-proof";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND:
  "rion-electron-production-publication-recovery-outcome-continuity";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE:
  "electron-production-publication-recovery-outcome-discovery.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE:
  "electron-production-publication-recovery-outcome-chain-proof.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE:
  "electron-production-publication-recovery-outcome-continuity.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES:
  128;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES: number;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_TOTAL_OUTCOME_BYTES:
  number;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES:
  number;

export interface ElectronProductionPublicationRecoveryDiscoveryTarget {
  readonly repository: string;
  readonly ref: string;
  readonly repositoryPolicy: Readonly<{
    readonly defaultBranch: string;
    readonly visibility: "private";
  }>;
}

export interface ElectronProductionPublicationRecoveryCurrentObservation {
  readonly headCommitSha: string;
  readonly treeSha: string;
  readonly parentCommitShas: readonly string[];
}

export type ElectronProductionPublicationRecoveryOutcomeDirectoryStatus =
  | "transactions-directory-absent"
  | "transaction-directory-absent"
  | "outcome-directory-absent"
  | "present";

export interface ElectronProductionPublicationRecoveryOutcomeDirectory {
  readonly path: string;
  readonly status: ElectronProductionPublicationRecoveryOutcomeDirectoryStatus;
  readonly treeSha: string | null;
}

export interface ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry {
  readonly role: "attempt" | "terminal";
  readonly path: string;
  readonly fileName: string;
  readonly mode: "100644";
  readonly type: "blob";
  readonly blobSha: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeDiscovery {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-outcome-discovery";
  readonly status: "same-head-canonical-discovery";
  readonly transactionId: string;
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly outcomeDirectory:
    Readonly<ElectronProductionPublicationRecoveryOutcomeDirectory>;
  readonly entries:
    readonly Readonly<ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry>[];
  readonly observedAt: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeFoundationIdentity {
  readonly transactionId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly heldLeaseEventSha256: string;
  readonly heldLeaseSha256: string;
  readonly storeSealSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly targetSnapshotSha256: string;
  readonly sourceStateSha256: string;
  readonly targetStateSha256: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeFileIdentity {
  readonly path: string;
  readonly fileName: string;
  readonly blobSha: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeIdentity
  extends ElectronProductionPublicationRecoveryOutcomeFileIdentity {
  readonly leaseRelease:
    ElectronProductionPublicationRecoveryOutcome["leaseRelease"];
  readonly mutation: ElectronProductionPublicationRecoveryOutcome["mutation"];
  readonly observation: ElectronProductionPublicationRecoveryOutcome["observation"];
  readonly previousOutcomeSha256: string | null;
  readonly recoveryOperation:
    ElectronProductionPublicationRecoveryOutcome["recoveryOperation"];
  readonly recoveryRun:
    ElectronProductionPublicationRecoveryOutcome["recoveryRun"];
  readonly terminal: boolean;
  readonly determinedAt: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeChainProof {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-outcome-chain-proof";
  readonly status: "empty" | "open" | "terminal";
  readonly transactionId: string;
  readonly discoveryReceiptSha256: string;
  readonly foundation:
    Readonly<ElectronProductionPublicationRecoveryOutcomeFoundationIdentity>;
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly outcomeDirectory:
    Readonly<ElectronProductionPublicationRecoveryOutcomeDirectory>;
  readonly terminal:
    Readonly<ElectronProductionPublicationRecoveryOutcomeFileIdentity> | null;
  readonly latestOutcome:
    Readonly<ElectronProductionPublicationRecoveryOutcomeIdentity> | null;
  readonly outcomes:
    readonly Readonly<ElectronProductionPublicationRecoveryOutcomeIdentity>[];
}

export interface ElectronProductionPublicationRecoveryOutcomeContinuityProof {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-outcome-continuity";
  readonly status: "verified-same-head-chain";
  readonly transactionId: string;
  readonly discoveryReceipts: Readonly<{
    readonly initialSha256: string;
    readonly freshSha256: string;
  }>;
  readonly foundation:
    Readonly<ElectronProductionPublicationRecoveryOutcomeFoundationIdentity>;
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly outcomeDirectory:
    Readonly<ElectronProductionPublicationRecoveryOutcomeDirectory>;
  readonly terminal:
    Readonly<ElectronProductionPublicationRecoveryOutcomeFileIdentity> | null;
  readonly latestOutcome:
    Readonly<ElectronProductionPublicationRecoveryOutcomeIdentity> | null;
  readonly outcomes:
    readonly Readonly<ElectronProductionPublicationRecoveryOutcomeIdentity>[];
}

export interface ElectronProductionPublicationRecoveryOutcomeFoundationInput {
  readonly heldLease: ElectronProductionPublicLatestLease;
  readonly heldLeaseSha256: string;
  readonly sourceSnapshot: ElectronProductionPublicLatestSnapshot;
  readonly sourceSnapshotSha256: string;
  readonly storeSeal: ElectronProductionPublicationRecoveryStoreSeal;
  readonly storeSealSha256: string;
  readonly targetSnapshot: ElectronProductionPublicLatestSnapshot;
  readonly targetSnapshotSha256: string;
}

export interface ElectronProductionPublicationRecoveryDiscoveryFile<Value> {
  readonly value: Readonly<Value>;
  readonly valueIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName: string;
    readonly sha256: string;
  }>;
  readonly valuePath: string;
}

export function createElectronProductionPublicationRecoveryOutcomeDiscovery(
  input: Readonly<{
    transactionId: string;
    target: ElectronProductionPublicationRecoveryDiscoveryTarget;
    currentObservation: ElectronProductionPublicationRecoveryCurrentObservation;
    outcomeDirectory: ElectronProductionPublicationRecoveryOutcomeDirectory;
    entries: readonly ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry[];
    observedAt: string;
  }>
): Readonly<ElectronProductionPublicationRecoveryOutcomeDiscovery>;

export function assertElectronProductionPublicationRecoveryOutcomeDiscovery(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryOutcomeDiscovery>;

export function verifyElectronProductionPublicationRecoveryOutcomeChain(
  input: Readonly<
    ElectronProductionPublicationRecoveryOutcomeFoundationInput & {
      readonly discovery: ElectronProductionPublicationRecoveryOutcomeDiscovery;
      readonly discoverySha256: string;
    }
  >
): Readonly<ElectronProductionPublicationRecoveryOutcomeChainProof>;

export function verifyElectronProductionPublicationRecoveryOutcomeContinuity(
  input: Readonly<
    ElectronProductionPublicationRecoveryOutcomeFoundationInput & {
      readonly initialDiscovery:
        ElectronProductionPublicationRecoveryOutcomeDiscovery;
      readonly initialDiscoverySha256: string;
      readonly freshDiscovery:
        ElectronProductionPublicationRecoveryOutcomeDiscovery;
      readonly freshDiscoverySha256: string;
    }
  >
): Readonly<ElectronProductionPublicationRecoveryOutcomeContinuityProof>;

export function assertElectronProductionPublicationRecoveryOutcomeChainProof(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryOutcomeChainProof>;

export function assertElectronProductionPublicationRecoveryOutcomeContinuityProof(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryOutcomeContinuityProof>;

export function electronProductionPublicationRecoveryOutcomeDiscoverySha256(
  value: unknown
): string;

export function serializeElectronProductionPublicationRecoveryOutcomeDiscovery(
  value: unknown
): Buffer;

export function serializeElectronProductionPublicationRecoveryOutcomeChainProof(
  value: unknown
): Buffer;

export function serializeElectronProductionPublicationRecoveryOutcomeContinuityProof(
  value: unknown
): Buffer;

export function writeElectronProductionPublicationRecoveryOutcomeDiscovery(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryOutcomeDiscovery;
  }>
): Promise<Readonly<ElectronProductionPublicationRecoveryDiscoveryFile<
  ElectronProductionPublicationRecoveryOutcomeDiscovery
>>>;

export function readElectronProductionPublicationRecoveryOutcomeDiscovery(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionPublicationRecoveryDiscoveryFile<
  ElectronProductionPublicationRecoveryOutcomeDiscovery
>>>;

export function writeElectronProductionPublicationRecoveryOutcomeChainProof(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryOutcomeChainProof;
  }>
): Promise<Readonly<ElectronProductionPublicationRecoveryDiscoveryFile<
  ElectronProductionPublicationRecoveryOutcomeChainProof
>>>;

export function readElectronProductionPublicationRecoveryOutcomeChainProof(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionPublicationRecoveryDiscoveryFile<
  ElectronProductionPublicationRecoveryOutcomeChainProof
>>>;

export function writeElectronProductionPublicationRecoveryOutcomeContinuityProof(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryOutcomeContinuityProof;
  }>
): Promise<Readonly<ElectronProductionPublicationRecoveryDiscoveryFile<
  ElectronProductionPublicationRecoveryOutcomeContinuityProof
>>>;

export function readElectronProductionPublicationRecoveryOutcomeContinuityProof(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionPublicationRecoveryDiscoveryFile<
  ElectronProductionPublicationRecoveryOutcomeContinuityProof
>>>;

export function electronProductionPublicationRecoveryLatestOutcomeSource(
  discovery: unknown,
  proof: ElectronProductionPublicationRecoveryOutcomeChainProof |
    ElectronProductionPublicationRecoveryOutcomeContinuityProof
): Buffer | null;
