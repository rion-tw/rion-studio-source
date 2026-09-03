import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestRecoveryObservation,
  ElectronProductionPublicLatestRecoveryRollback
} from "./electronProductionPublicLatestRecovery.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_API_ROOT:
  "https://api.github.com";

export class ElectronProductionPublicLatestRollbackNotSubmittedError
  extends Error {}

export interface ElectronProductionPublicLatestRecoveryResponseHeaders {
  get(name: string): string | null;
}

export interface ElectronProductionPublicLatestRecoveryResponseBodyReader {
  read(): Promise<Readonly<{
    done: boolean;
    value?: Uint8Array;
  }>>;
  cancel(): Promise<void>;
}

export interface ElectronProductionPublicLatestRecoveryResponseBody {
  getReader(): ElectronProductionPublicLatestRecoveryResponseBodyReader;
}

export interface ElectronProductionPublicLatestRecoveryResponse {
  readonly status: number;
  readonly headers: ElectronProductionPublicLatestRecoveryResponseHeaders;
  readonly body: ElectronProductionPublicLatestRecoveryResponseBody | null;
}

export interface ElectronProductionPublicLatestRecoveryRequestInit {
  readonly method: "GET" | "PATCH";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly cache: "no-store";
  readonly redirect: "error" | "follow";
}

export type ElectronProductionPublicLatestRecoveryFetch = (
  url: string,
  init: ElectronProductionPublicLatestRecoveryRequestInit
) => Promise<ElectronProductionPublicLatestRecoveryResponse>;

export function observeElectronProductionPublicLatestRecoveryRemote(
  input: Readonly<{
    fetchImpl: ElectronProductionPublicLatestRecoveryFetch;
    observedAt: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
    token: string;
  }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryObservation>>;

export function observeElectronProductionPublicLatestRecoveryRemoteAtResult(
  input: Readonly<{
    fetchImpl: ElectronProductionPublicLatestRecoveryFetch;
    recordObservedAt: () => string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
    token: string;
  }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryObservation>>;

export function rollbackElectronProductionPublicLatestRecoveryRemote(
  input: Readonly<{
    fetchImpl: ElectronProductionPublicLatestRecoveryFetch;
    finalObservedAt: string;
    heldLease: ElectronProductionPublicLatestLease;
    preObservation: ElectronProductionPublicLatestRecoveryObservation;
    preObservationSha256: string;
    resultRecordedAt: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    submittedAt: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
    token: string;
  }>
): Promise<Readonly<{
  finalObservation: Readonly<ElectronProductionPublicLatestRecoveryObservation>;
  preObservation: Readonly<ElectronProductionPublicLatestRecoveryObservation>;
  rollback: Readonly<ElectronProductionPublicLatestRecoveryRollback>;
}>>;

export function rollbackElectronProductionPublicLatestRecoveryRemoteAtResult(
  input: Readonly<{
    fetchImpl: ElectronProductionPublicLatestRecoveryFetch;
    heldLease: ElectronProductionPublicLatestLease;
    preObservation: ElectronProductionPublicLatestRecoveryObservation;
    preObservationSha256: string;
    recordTime: () => string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    submissionNotBefore: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
    token: string;
  }>
): Promise<Readonly<{
  finalObservation: Readonly<ElectronProductionPublicLatestRecoveryObservation>;
  preObservation: Readonly<ElectronProductionPublicLatestRecoveryObservation>;
  rollback: Readonly<ElectronProductionPublicLatestRecoveryRollback>;
}>>;
