import type {
  ElectronProductionPublicationRecoveryDiscoveryTarget,
  ElectronProductionPublicationRecoveryCurrentObservation
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteFetch,
  ElectronProductionRecoveryStoreRemoteReadResult
} from "./electronProductionRecoveryStoreRemote.mjs";
import type {
  ElectronProductionPublicationRecoveryPublicMutationOperation
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_KIND:
  "rion-electron-production-recovery-store-optional-intent-observation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_FILE:
  "electron-production-recovery-store-optional-intent-observation.json";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_KIND:
  "rion-electron-production-recovery-store-optional-public-mutation-attempt-observation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_FILE:
  "electron-production-recovery-store-optional-public-mutation-attempt-observation.json";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_MAX_OPTIONAL_INTENT_OBSERVATION_BYTES:
  number;

export type ElectronProductionRecoveryStoreOptionalIntentState =
  | Readonly<{ status: "absent-at-head" }>
  | Readonly<{
      status: "present-at-head";
      blobSha: string;
      file: Readonly<{
        fileName:
          "electron-production-publication-recovery-lease-release-intent.json";
        byteLength: number;
        sha256: string;
      }>;
    }>;

export interface ElectronProductionRecoveryStoreOptionalIntentObservation {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-optional-intent-observation";
  readonly status: "same-head-optional-intent-observation";
  readonly transactionId: string;
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly path: string;
  readonly discoveryReceiptSha256: string;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly intent: ElectronProductionRecoveryStoreOptionalIntentState;
  readonly observedAt: string;
}

interface ElectronProductionRecoveryStoreOptionalIntentObservationSummaryBase {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-optional-intent-observation-cli-summary";
  readonly status: "verified";
  readonly transactionId: string;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly intent: ElectronProductionRecoveryStoreOptionalIntentState;
}

export interface ElectronProductionRecoveryStoreOptionalIntentIdentitySummary
  extends ElectronProductionRecoveryStoreOptionalIntentObservationSummaryBase {
  readonly command: "observe" | "verify";
  readonly output: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
}

export interface ElectronProductionRecoveryStoreOptionalIntentContinuitySummary
  extends ElectronProductionRecoveryStoreOptionalIntentObservationSummaryBase {
  readonly command: "verify-continuity";
  readonly output: Readonly<{
    initialObservationSha256: string;
    freshObservationSha256: string;
    outcomeContinuitySha256: string;
  }>;
}

export type ElectronProductionRecoveryStoreOptionalIntentObservationSummary =
  | ElectronProductionRecoveryStoreOptionalIntentIdentitySummary
  | ElectronProductionRecoveryStoreOptionalIntentContinuitySummary;

export type ElectronProductionRecoveryStoreOptionalPublicMutationAttemptState =
  | Readonly<{ status: "absent-at-head" }>
  | Readonly<{
      status: "present-at-head";
      blobSha: string;
      operation:
        ElectronProductionPublicationRecoveryPublicMutationOperation;
      file: Readonly<{
        fileName: string;
        byteLength: number;
        sha256: string;
      }>;
    }>;

export interface ElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-optional-public-mutation-attempt-observation";
  readonly status:
    "same-head-optional-public-mutation-attempt-observation";
  readonly transactionId: string;
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly path: string;
  readonly predecessorOutcomeSha256: string | null;
  readonly discoveryReceiptSha256: string;
  readonly outcomeChainProofSha256: string;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly attempt:
    ElectronProductionRecoveryStoreOptionalPublicMutationAttemptState;
  readonly observedAt: string;
}

export interface ElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservationSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-optional-public-mutation-attempt-observation-cli-summary";
  readonly command:
    "observe-mutation-attempt" | "verify-mutation-attempt";
  readonly status: "verified";
  readonly transactionId: string;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly predecessorOutcomeSha256: string | null;
  readonly attempt:
    ElectronProductionRecoveryStoreOptionalPublicMutationAttemptState;
  readonly output: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
}

export interface ElectronProductionRecoveryStoreOptionalIntentObservationDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ElectronProductionRecoveryStoreRemoteFetch;
  readonly readRemote?: (input: Readonly<{
    fetchImpl: ElectronProductionRecoveryStoreRemoteFetch;
    target: Readonly<{
      owner: string;
      repo: string;
      ref: string;
      path: string;
      repositoryPolicy: Readonly<{
        defaultBranch: string;
        visibility: "private";
      }>;
    }>;
    token: string;
  }>) => Promise<ElectronProductionRecoveryStoreRemoteReadResult>;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function assertElectronProductionRecoveryStoreOptionalIntentObservation(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreOptionalIntentObservation>;
export function serializeElectronProductionRecoveryStoreOptionalIntentObservation(
  value: unknown
): Buffer;
export function readElectronProductionRecoveryStoreOptionalIntentObservation(
  input: Readonly<{ expectedSha256: string; observationPath: string }>
): Promise<Readonly<{
  value: Readonly<ElectronProductionRecoveryStoreOptionalIntentObservation>;
  valueIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  valuePath: string;
}>>;
export function assertElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
  value: unknown
): Readonly<
  ElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation
>;
export function serializeElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
  value: unknown
): Buffer;
export function readElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
  input: Readonly<{ expectedSha256: string; observationPath: string }>
): Promise<Readonly<{
  value: Readonly<
    ElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation
  >;
  valueIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  valuePath: string;
}>>;
export function runElectronProductionRecoveryStoreOptionalIntentObservationCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionRecoveryStoreOptionalIntentObservationDependencies
): Promise<Readonly<
  ElectronProductionRecoveryStoreOptionalIntentObservationSummary |
    ElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservationSummary
>>;
