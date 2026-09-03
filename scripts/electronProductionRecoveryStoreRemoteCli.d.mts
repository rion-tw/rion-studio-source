import type {
  ElectronProductionRecoveryStoreRemoteFetch
} from "./electronProductionRecoveryStoreRemote.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteOperationReceipt,
  ElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import type {
  ElectronProductionRecoveryStoreAtomicPairOperationReceipt
} from "./electronProductionRecoveryStoreRemoteAtomicPairOperation.mjs";

export type ElectronProductionRecoveryStoreRemoteCliReceipt =
  | ElectronProductionRecoveryStoreRemoteOperationReceipt
  | ElectronProductionRecoveryStoreRemoteReadOperationReceipt
  | ElectronProductionRecoveryStoreAtomicPairOperationReceipt;

export interface ElectronProductionRecoveryStoreRemoteCliSummary {
  readonly receipt:
    Readonly<ElectronProductionRecoveryStoreRemoteCliReceipt>;
  readonly receiptIdentity: Readonly<{
    bytes: number;
    fileName:
      | "electron-production-recovery-store-remote-operation.json"
      | "electron-production-recovery-store-remote-read-operation.json"
      | "electron-production-recovery-store-remote-atomic-pair-operation.json";
    sha256: string;
  }> | null;
  readonly localFailure:
    | "receipt-output-failed"
    | "stdout-output-failed"
    | null;
}

export interface ElectronProductionRecoveryStoreRemoteCliDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ElectronProductionRecoveryStoreRemoteFetch;
  readonly rereadContentFile?: (
    filePath: string,
    maximumBytes: number,
    label: string
  ) => Promise<Readonly<{
    bytes: number;
    sha256: string;
    source: Buffer;
  }>>;
  readonly setExitCode?: (code: 1) => void;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export class ElectronProductionRecoveryStoreRemoteCliFailure extends Error {
  readonly summary: Readonly<ElectronProductionRecoveryStoreRemoteCliSummary>;
  constructor(summary: Readonly<ElectronProductionRecoveryStoreRemoteCliSummary>);
}

export function runElectronProductionRecoveryStoreRemoteCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionRecoveryStoreRemoteCliDependencies
): Promise<Readonly<ElectronProductionRecoveryStoreRemoteCliSummary>>;
