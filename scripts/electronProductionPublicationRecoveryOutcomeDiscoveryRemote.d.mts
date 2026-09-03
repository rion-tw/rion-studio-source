import type {
  ElectronProductionRecoveryStoreRemoteFetch
} from "./electronProductionRecoveryStoreRemote.mjs";
import type {
  ElectronProductionPublicationRecoveryOutcomeDiscovery
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";

export interface ElectronProductionPublicationRecoveryOutcomeDiscoveryRemoteInput {
  readonly fetchImpl: ElectronProductionRecoveryStoreRemoteFetch;
  readonly observedAt: string;
  readonly target: Readonly<{
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
    readonly repositoryPolicy: Readonly<{
      readonly defaultBranch: string;
      readonly visibility: "private";
    }>;
  }>;
  readonly token: string;
  readonly transactionId: string;
}

export function discoverElectronProductionPublicationRecoveryOutcomes(
  input: Readonly<
    ElectronProductionPublicationRecoveryOutcomeDiscoveryRemoteInput
  >
): Promise<Readonly<ElectronProductionPublicationRecoveryOutcomeDiscovery>>;
