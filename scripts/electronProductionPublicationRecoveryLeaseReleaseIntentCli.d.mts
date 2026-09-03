import type {
  ElectronProductionRecoveryStoreRemoteFetch
} from "./electronProductionRecoveryStoreRemote.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_CLI_SUMMARY_KIND:
  "rion-electron-production-publication-recovery-lease-release-intent-cli-summary";

export interface ElectronProductionPublicationRecoveryLeaseReleaseIntentCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-lease-release-intent-cli-summary";
  readonly command:
    "materialize-intent" | "prove-existing-intent-history" | "authorize";
  readonly status: "created";
  readonly transactionId: string;
  readonly artifact: Readonly<{
    readonly bytes: number;
    readonly fileName: string;
    readonly sha256: string;
  }>;
}

export interface ElectronProductionPublicationRecoveryLeaseReleaseIntentCliDependencies {
  readonly fetchImpl?: ElectronProductionRecoveryStoreRemoteFetch;
  readonly readToken?: () => string;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionPublicationRecoveryLeaseReleaseIntentCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionPublicationRecoveryLeaseReleaseIntentCliDependencies
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseIntentCliSummary
>>;
