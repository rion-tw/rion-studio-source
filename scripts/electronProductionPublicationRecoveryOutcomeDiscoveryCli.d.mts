import type {
  ElectronProductionRecoveryStoreRemoteFetch
} from "./electronProductionRecoveryStoreRemote.mjs";
import type {
  ElectronProductionPublicationRecoveryCurrentObservation,
  ElectronProductionPublicationRecoveryDiscoveryTarget,
  ElectronProductionPublicationRecoveryOutcomeDirectory,
  ElectronProductionPublicationRecoveryOutcomeFileIdentity,
  ElectronProductionPublicationRecoveryOutcomeDiscovery
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import type {
  ElectronProductionPublicationRecoveryOutcomeDiscoveryRemoteInput
} from "./electronProductionPublicationRecoveryOutcomeDiscoveryRemote.mjs";

export interface ElectronProductionPublicationRecoveryOutcomeDiscoveryCliIdentity {
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeDiscoveryCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-outcome-discovery-cli-summary";
  readonly command: "discover" | "verify-chain" | "verify-continuity";
  readonly status: "materialized" | "verified";
  readonly output:
    Readonly<ElectronProductionPublicationRecoveryOutcomeDiscoveryCliIdentity>;
  readonly latestOutcome:
    Readonly<ElectronProductionPublicationRecoveryOutcomeDiscoveryCliIdentity> |
    null;
  readonly transactionId: string;
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly currentObservation:
    Readonly<ElectronProductionPublicationRecoveryCurrentObservation>;
  readonly outcomeDirectory:
    Readonly<ElectronProductionPublicationRecoveryOutcomeDirectory>;
  readonly terminal:
    Readonly<ElectronProductionPublicationRecoveryOutcomeFileIdentity> | null;
}

export interface ElectronProductionPublicationRecoveryOutcomeDiscoveryCliDependencies {
  readonly discoverRemote?: (
    input: Readonly<
      ElectronProductionPublicationRecoveryOutcomeDiscoveryRemoteInput
    >
  ) => Promise<
    Readonly<ElectronProductionPublicationRecoveryOutcomeDiscovery>
  >;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ElectronProductionRecoveryStoreRemoteFetch;
  readonly rereadLatestFile?: (
    filePath: string,
    maximumBytes: number,
    label: string
  ) => Promise<Readonly<{ bytes: number; sha256: string; source: Buffer }>>;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionPublicationRecoveryOutcomeDiscoveryCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionPublicationRecoveryOutcomeDiscoveryCliDependencies
): Promise<
  Readonly<ElectronProductionPublicationRecoveryOutcomeDiscoveryCliSummary>
>;
