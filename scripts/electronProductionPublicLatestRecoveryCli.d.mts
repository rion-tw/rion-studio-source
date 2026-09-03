import type {
  ElectronProductionPublicLatestRecoveryFetch
} from "./electronProductionPublicLatestRecoveryRemote.mjs";
import type {
  ElectronProductionPublicLatestLeaseRemoteFetch
} from "./electronProductionPublicLatestLeaseRemote.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND:
  "rion-electron-production-public-latest-recovery-cli-summary";

export interface ElectronProductionPublicLatestRecoveryCliIdentity {
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface ElectronProductionPublicLatestRecoveryObservationCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-public-latest-recovery-cli-summary";
  readonly command: "observe" | "rollback";
  readonly status: "recorded";
  readonly outputs: Readonly<{
    observation: Readonly<ElectronProductionPublicLatestRecoveryCliIdentity>;
    rollback: Readonly<ElectronProductionPublicLatestRecoveryCliIdentity> | null;
  }>;
  readonly evidence: Readonly<{
    observation: "source" | "target" | "foreign" | "unknown";
    observationTransport: "observed" | "rejected" | "indeterminate";
    rollbackAcknowledgement: "confirmed" | "rejected" | "unknown" | null;
  }>;
}

export interface ElectronProductionPublicLatestRecoveryLeaseReleaseCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-public-latest-recovery-cli-summary";
  readonly command: "release-lease" | "reconcile-lease-release";
  readonly status: "recorded";
  readonly outputs: Readonly<{
    operation: Readonly<ElectronProductionPublicLatestRecoveryCliIdentity>;
    releasedLease:
      Readonly<ElectronProductionPublicLatestRecoveryCliIdentity> | null;
  }>;
  readonly evidence: Readonly<{
    acknowledgement: "confirmed" | "rejected" | "unknown";
  }>;
}

export interface ElectronProductionPublicLatestRecoveryLeaseRouteCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-public-latest-recovery-cli-summary";
  readonly command: "route-lease-release";
  readonly status: "recorded";
  readonly outputs: Readonly<{
    observation: Readonly<ElectronProductionPublicLatestRecoveryCliIdentity>;
  }>;
  readonly evidence: Readonly<{
    observation: "source" | "target" | "foreign" | "unknown";
    observationTransport: "observed" | "rejected" | "indeterminate";
    leaseObservation:
      | "not-read"
      | "held"
      | "released"
      | "foreign"
      | "indeterminate";
    route:
      | "release-held"
      | "reconcile-released"
      | "reconcile-pending"
      | "blocked";
    reason:
      | "public-latest-not-source"
      | "released-before-intent"
      | "released-at-foreign-time"
      | "exact-direct-successor"
      | "unknown-attempt-still-held"
      | "resumed-empty-chain"
      | "exact-held"
      | "lease-observation-indeterminate"
      | "lease-conflict";
  }>;
}

export type ElectronProductionPublicLatestRecoveryCliSummary =
  | ElectronProductionPublicLatestRecoveryObservationCliSummary
  | ElectronProductionPublicLatestRecoveryLeaseReleaseCliSummary
  | ElectronProductionPublicLatestRecoveryLeaseRouteCliSummary;

export class ElectronProductionPublicLatestRecoveryCliFailure extends Error {
  readonly summary: Readonly<ElectronProductionPublicLatestRecoveryCliSummary>;
  constructor(summary: ElectronProductionPublicLatestRecoveryCliSummary);
}

export function runElectronProductionPublicLatestRecoveryCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    fetchImpl?:
      | ElectronProductionPublicLatestRecoveryFetch
      | ElectronProductionPublicLatestLeaseRemoteFetch;
    setExitCode?: (code: number) => void;
    writeStdout?: (source: Buffer) => void | Promise<void>;
  }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryCliSummary>>;
