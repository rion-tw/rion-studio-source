import type {
  ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteFetch,
  ElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";

export function proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input: Readonly<{
    currentObservation: Readonly<{
      headCommitSha: string;
      treeSha: string;
      parentCommitShas: readonly [string];
    }>;
    fetchImpl: ElectronProductionRecoveryStoreRemoteFetch;
    initialHeadCommitSha: string;
    intentBlobSha: string;
    observedAt: string;
    target: ElectronProductionRecoveryStoreRemoteTarget;
    token: string;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
>>;
