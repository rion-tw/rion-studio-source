import type {
  ElectronProductionPublicationRecoveryPublicMutationAttemptHistory
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteFetch,
  ElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";

export function proveElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input: Readonly<{
    attemptBlobSha: string;
    currentObservation: Readonly<{
      headCommitSha: string;
      treeSha: string;
      parentCommitShas: readonly [string];
    }>;
    fetchImpl: ElectronProductionRecoveryStoreRemoteFetch;
    initialHeadCommitSha: string;
    observedAt: string;
    target: ElectronProductionRecoveryStoreRemoteTarget;
    token: string;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationAttemptHistory
>>;
