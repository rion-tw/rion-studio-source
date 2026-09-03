import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicationRecoveryOutcomeChainProof,
  ElectronProductionPublicationRecoveryDiscoveryTarget
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import type {
  ElectronProductionPublicationRecoveryRunIdentity,
  ElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteOperationReceipt,
  ElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import type {
  ElectronProductionRecoveryStoreReadbackFoundation
} from "./electronProductionRecoveryStoreReadbackFoundationCli.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_KIND:
  "rion-electron-production-publication-recovery-lease-release-intent";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_KIND:
  "rion-electron-production-publication-recovery-lease-release-authorization";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE:
  "electron-production-publication-recovery-lease-release-intent.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE:
  "electron-production-publication-recovery-lease-release-authorization.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES:
  number;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_AUTHORIZATION_BYTES:
  number;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_HISTORY_BYTES:
  number;

export interface ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-lease-release-intent-history";
  readonly status: "verified-exact-create-and-reachable-path-history";
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly path: string;
  readonly initialHeadCommitSha: string;
  readonly intentCommit: Readonly<{
    readonly commitSha: string;
    readonly treeSha: string;
    readonly parentCommitSha: string;
    readonly blobSha: string;
  }>;
  readonly currentObservation: Readonly<{
    readonly headCommitSha: string;
    readonly treeSha: string;
    readonly parentCommitShas: readonly string[];
  }>;
  readonly pathHistory: Readonly<{
    readonly reachableFromHeadCommitSha: string;
    readonly commitSha: string;
    readonly resultCount: 1;
    readonly nextPage: false;
  }>;
  readonly observedAt: string;
}

export interface ElectronProductionPublicationRecoveryLeaseReleaseIntent {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-lease-release-intent";
  readonly status: "durable-pre-public-release-authority";
  readonly transactionId: string;
  readonly heldLease: Readonly<{
    readonly leaseId: string;
    readonly generation: number;
    readonly revision: number;
    readonly eventSha256: string;
    readonly fileSha256: string;
    readonly sourceStateSha256: string;
    readonly targetStateSha256: string;
  }>;
  readonly foundation: Readonly<{
    readonly storeSealSha256: string;
    readonly sourceSnapshotSha256: string;
    readonly targetSnapshotSha256: string;
    readonly temporalFloor: Readonly<{
      readonly storeSealedAt: string;
      readonly previousOutcomeDeterminedAt: string | null;
    }>;
    readonly capsule: Readonly<{
      readonly path: string;
      readonly fileName:
        "electron-production-publication-recovery-capsule.capsule.json";
      readonly byteLength: number;
      readonly sha256: string;
    }>;
    readonly storeSeal: Readonly<{
      readonly path: string;
      readonly fileName:
        "electron-production-publication-recovery-store-seal.json";
      readonly sha256: string;
    }>;
  }>;
  readonly privateStore: Readonly<{
    readonly target:
      Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
    readonly path: string;
    readonly expectedHeadCommitSha: string;
  }>;
  readonly outcomeChain: Readonly<{
    readonly sha256: string;
    readonly proof:
      Readonly<ElectronProductionPublicationRecoveryOutcomeChainProof>;
  }>;
  readonly publicLatest: Readonly<{
    readonly repository: "rion-tw/rion-studio";
    readonly ref: "main";
    readonly path: "releases/electron-production-public-latest-lease.json";
    readonly requiredTerminalObservation: "source";
    readonly operations: readonly [
      "rollback-public-latest",
      "release-held-lease"
    ];
    readonly overtakePolicy: "forbidden-until-terminal-outcome";
  }>;
  readonly recoveryRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & {
      readonly startedAt: string;
    }
  >;
  readonly authorizedAt: string;
}

export interface ElectronProductionPublicationRecoveryLeaseReleaseAuthorization {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-lease-release-authorization";
  readonly status: "verified-durable-release-authority";
  readonly transactionId: string;
  readonly currentRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & {
      readonly startedAt: string;
    }
  >;
  readonly authority: Readonly<{
    readonly intent:
      Readonly<ElectronProductionPublicationRecoveryLeaseReleaseIntent>;
    readonly sha256: string;
  }>;
  readonly evidence: Readonly<{
    readonly createOperation: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;
      readonly sha256: string;
    }> | null;
    readonly intentHistoryProof: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory>;
      readonly sha256: string;
    }> | null;
    readonly intentReadOperation: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;
      readonly sha256: string;
    }>;
    readonly freshChainProof: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionPublicationRecoveryOutcomeChainProof>;
      readonly sha256: string;
    }>;
    readonly foundationReadback:
      Readonly<ElectronProductionRecoveryStoreReadbackFoundation>;
  }>;
  readonly headTransition: Readonly<{
    readonly mode: "created-now" | "resumed-existing";
    readonly initialHeadCommitSha: string;
    readonly currentHeadCommitSha: string;
    readonly intentCommitSha: string | null;
    readonly treeSha: string;
    readonly parentCommitShas: readonly string[];
    readonly intentBlobSha: string;
  }>;
  readonly verifiedAt: string;
}

export interface ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
  Value
> {
  readonly value: Readonly<Value>;
  readonly valueIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName: string;
    readonly sha256: string;
  }>;
  readonly valuePath: string;
}

export function electronProductionPublicationRecoveryLeaseReleaseIntentPath(
  input: Readonly<{ transactionId: string }>
): string;

export function createElectronProductionPublicationRecoveryLeaseReleaseIntent(
  input: Readonly<{
    authorizedAt: string;
    chainProof: ElectronProductionPublicationRecoveryOutcomeChainProof;
    chainProofSha256: string;
    heldLease: ElectronProductionPublicLatestLease;
    heldLeaseSha256: string;
    recoveryRun: ElectronProductionPublicationRecoveryRunIdentity & {
      startedAt: string;
    };
    storeSeal: ElectronProductionPublicationRecoveryStoreSeal;
    storeSealSha256: string;
  }>
): Readonly<ElectronProductionPublicationRecoveryLeaseReleaseIntent>;

export function assertElectronProductionPublicationRecoveryLeaseReleaseIntent(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryLeaseReleaseIntent>;

export function createElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  input: Readonly<{
    currentRun: Readonly<
      ElectronProductionPublicationRecoveryRunIdentity & {
        readonly startedAt: string;
      }
    >;
    createOperation:
      ElectronProductionRecoveryStoreRemoteOperationReceipt | null;
    createOperationSha256: string | null;
    foundationReadback: ElectronProductionRecoveryStoreReadbackFoundation;
    freshChainProof: ElectronProductionPublicationRecoveryOutcomeChainProof;
    freshChainProofSha256: string;
    intentHistoryProof:
      ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory | null;
    intentHistoryProofSha256: string | null;
    intent: ElectronProductionPublicationRecoveryLeaseReleaseIntent;
    intentReadOperation:
      ElectronProductionRecoveryStoreRemoteReadOperationReceipt;
    intentReadOperationSha256: string;
    intentSha256: string;
    verifiedAt: string;
  }>
): Readonly<ElectronProductionPublicationRecoveryLeaseReleaseAuthorization>;

export function createElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input: Readonly<{
    currentObservation: Readonly<{
      headCommitSha: string;
      treeSha: string;
      parentCommitShas: readonly string[];
    }>;
    initialHeadCommitSha: string;
    intentBlobSha: string;
    intentCommitSha: string;
    intentTreeSha: string;
    observedAt: string;
    path: string;
    pathHistory: Readonly<{
      reachableFromHeadCommitSha: string;
      commitSha: string;
      resultCount: 1;
      nextPage: false;
    }>;
    target: ElectronProductionPublicationRecoveryDiscoveryTarget;
  }>
): Readonly<ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory>;

export function assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory>;

export function assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryLeaseReleaseAuthorization>;

export function serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(
  value: unknown
): Buffer;

export function serializeElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  value: unknown
): Buffer;

export function serializeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  value: unknown
): Buffer;

export function electronProductionPublicationRecoveryLeaseReleaseIntentSha256(
  value: unknown
): string;

export function electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
  value: unknown
): string;

export function electronProductionPublicationRecoveryLeaseReleaseIntentHistorySha256(
  value: unknown
): string;

export function writeElectronProductionPublicationRecoveryLeaseReleaseIntent(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryLeaseReleaseIntent;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
    ElectronProductionPublicationRecoveryLeaseReleaseIntent
  >
>>;

export function readElectronProductionPublicationRecoveryLeaseReleaseIntent(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
    ElectronProductionPublicationRecoveryLeaseReleaseIntent
  >
>>;

export function writeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
    ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
  >
>>;

export function readElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
    ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
  >
>>;

export function writeElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryLeaseReleaseAuthorization;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
    ElectronProductionPublicationRecoveryLeaseReleaseAuthorization
  >
>>;

export function readElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseContractFile<
    ElectronProductionPublicationRecoveryLeaseReleaseAuthorization
  >
>>;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_KIND:
  "rion-electron-production-publication-recovery-lease-release-intent-history";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE:
  "electron-production-publication-recovery-lease-release-intent-history.json";
