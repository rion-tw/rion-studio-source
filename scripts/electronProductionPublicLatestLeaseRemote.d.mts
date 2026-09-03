import type {
  ElectronProductionPublicLatestLease,
  ElectronProductionPublicLatestLeaseHolder,
  ElectronProductionPublicLatestLeasePurpose,
  ElectronProductionPublicLatestLeaseState
} from "./electronProductionPublicLatestLease.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY:
  "rion-tw/rion-studio";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF: "main";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH:
  "releases/electron-production-public-latest-lease.json";

export interface ElectronProductionPublicLatestLeaseRemoteRequestInit {
  readonly method: "GET" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "error";
}

export interface ElectronProductionPublicLatestLeaseRemoteBodyReader {
  cancel(): Promise<void>;
  read(): Promise<Readonly<{
    done: boolean;
    value?: Uint8Array;
  }>>;
}

export interface ElectronProductionPublicLatestLeaseRemoteBody {
  getReader(): ElectronProductionPublicLatestLeaseRemoteBodyReader;
}

export interface ElectronProductionPublicLatestLeaseRemoteHeaders {
  get(name: string): string | null;
}

export interface ElectronProductionPublicLatestLeaseRemoteResponse {
  readonly body: ElectronProductionPublicLatestLeaseRemoteBody | null;
  readonly headers: ElectronProductionPublicLatestLeaseRemoteHeaders;
  readonly status: number;
}

export type ElectronProductionPublicLatestLeaseRemoteFetch = (
  url: string,
  init: ElectronProductionPublicLatestLeaseRemoteRequestInit
) => Promise<ElectronProductionPublicLatestLeaseRemoteResponse>;

export interface ElectronProductionPublicLatestLeaseRemoteDependencies {
  readonly fetchImpl: ElectronProductionPublicLatestLeaseRemoteFetch;
  readonly token: string;
}

export type ElectronProductionPublicLatestLeaseRemoteRejectedReason =
  | "conflict"
  | "github-rejected"
  | "held"
  | "malformed-record";

export type ElectronProductionPublicLatestLeaseRemoteIndeterminateReason =
  | "server-error"
  | "transport"
  | "unauthoritative-absence"
  | "unexpected-response"
  | "unknown-acknowledgement"
  | "verification-failed";

export interface ElectronProductionPublicLatestLeaseRemoteRejected {
  readonly outcome: "rejected";
  readonly reason: ElectronProductionPublicLatestLeaseRemoteRejectedReason;
  readonly status: number | null;
}

export interface ElectronProductionPublicLatestLeaseRemoteIndeterminate {
  readonly outcome: "indeterminate";
  readonly reason: ElectronProductionPublicLatestLeaseRemoteIndeterminateReason;
  readonly status: number | null;
}

export type ElectronProductionPublicLatestLeaseRemoteFailure =
  | ElectronProductionPublicLatestLeaseRemoteRejected
  | ElectronProductionPublicLatestLeaseRemoteIndeterminate;

export interface ElectronProductionPublicLatestLeaseRemotePresent {
  readonly outcome: "present";
  readonly blobSha: string;
  readonly bytes: number;
  readonly lease: Readonly<ElectronProductionPublicLatestLease>;
}

export interface ElectronProductionPublicLatestLeaseRemoteVacant {
  readonly outcome: "vacant";
  readonly headSha: string;
}

export type ElectronProductionPublicLatestLeaseRemoteReadResult =
  | ElectronProductionPublicLatestLeaseRemotePresent
  | ElectronProductionPublicLatestLeaseRemoteVacant
  | ElectronProductionPublicLatestLeaseRemoteFailure;

export interface ElectronProductionPublicLatestLeaseRemoteApplied {
  readonly outcome: "applied";
  readonly blobSha: string;
  readonly bytes: number;
  readonly lease: Readonly<ElectronProductionPublicLatestLease>;
}

export interface ElectronProductionPublicLatestLeaseRemoteObserved {
  readonly outcome: "observed";
  readonly blobSha: string;
  readonly bytes: number;
  readonly lease: Readonly<ElectronProductionPublicLatestLease>;
}

export interface ElectronProductionPublicLatestLeaseRemoteAcquisitionRequest {
  readonly holder: ElectronProductionPublicLatestLeaseHolder;
  readonly leaseId: string;
  readonly purpose: ElectronProductionPublicLatestLeasePurpose;
  readonly recordedAt: string;
  readonly source: Readonly<ElectronProductionPublicLatestLeaseState>;
  readonly target: ElectronProductionPublicLatestLeaseState;
  readonly transactionId: string;
}

export interface ElectronProductionPublicLatestLeaseRemoteReleaseRequest {
  readonly generation: number;
  readonly leaseId: string;
  readonly recordedAt: string;
  readonly sourceStateSha256: string;
  readonly targetStateSha256: string;
  readonly transactionId: string;
}

export function readElectronProductionPublicLatestLeaseRemote(
  input: Readonly<ElectronProductionPublicLatestLeaseRemoteDependencies>
): Promise<ElectronProductionPublicLatestLeaseRemoteReadResult>;

export function acquireElectronProductionPublicLatestLeaseRemote(
  input: Readonly<
    ElectronProductionPublicLatestLeaseRemoteDependencies & {
      readonly acquisition:
        ElectronProductionPublicLatestLeaseRemoteAcquisitionRequest;
    }
  >
): Promise<
  ElectronProductionPublicLatestLeaseRemoteApplied |
  ElectronProductionPublicLatestLeaseRemoteFailure
>;

export function observeElectronProductionPublicLatestLeaseRemote(
  input: Readonly<
    ElectronProductionPublicLatestLeaseRemoteDependencies & {
      readonly expected: unknown;
    }
  >
): Promise<
  ElectronProductionPublicLatestLeaseRemoteObserved |
  ElectronProductionPublicLatestLeaseRemoteFailure
>;

export function releaseElectronProductionPublicLatestLeaseRemote(
  input: Readonly<
    ElectronProductionPublicLatestLeaseRemoteDependencies & {
      readonly expected: unknown;
      readonly release: ElectronProductionPublicLatestLeaseRemoteReleaseRequest;
    }
  >
): Promise<
  ElectronProductionPublicLatestLeaseRemoteApplied |
  ElectronProductionPublicLatestLeaseRemoteFailure
>;

export function observeElectronProductionPublicLatestLeaseReleasedRemote(
  input: Readonly<
    ElectronProductionPublicLatestLeaseRemoteDependencies & {
      readonly expected: unknown;
      readonly release: ElectronProductionPublicLatestLeaseRemoteReleaseRequest;
    }
  >
): Promise<
  ElectronProductionPublicLatestLeaseRemoteObserved |
  ElectronProductionPublicLatestLeaseRemoteFailure
>;

export function observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote(
  input: Readonly<
    ElectronProductionPublicLatestLeaseRemoteDependencies & {
      readonly expected: unknown;
    }
  >
): Promise<
  ElectronProductionPublicLatestLeaseRemoteObserved |
  ElectronProductionPublicLatestLeaseRemoteFailure
>;
