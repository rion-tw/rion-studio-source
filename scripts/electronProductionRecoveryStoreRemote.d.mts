export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES: number;

export interface ElectronProductionRecoveryStoreRemoteTarget {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
  readonly repositoryPolicy: Readonly<{
    readonly defaultBranch: string;
    readonly visibility: "private";
  }>;
}

export function assertElectronProductionRecoveryStoreRemoteTarget(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreRemoteTarget>;

export interface ElectronProductionRecoveryStoreRemoteRequestInit {
  readonly method: "GET" | "POST" | "PATCH";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "error";
}

export interface ElectronProductionRecoveryStoreRemoteBodyReader {
  cancel(): Promise<void>;
  read(): Promise<Readonly<{
    done: boolean;
    value?: Uint8Array;
  }>>;
}

export interface ElectronProductionRecoveryStoreRemoteBody {
  getReader(): ElectronProductionRecoveryStoreRemoteBodyReader;
}

export interface ElectronProductionRecoveryStoreRemoteHeaders {
  get(name: string): string | null;
}

export interface ElectronProductionRecoveryStoreRemoteResponse {
  readonly body: ElectronProductionRecoveryStoreRemoteBody | null;
  readonly headers: ElectronProductionRecoveryStoreRemoteHeaders;
  readonly status: number;
}

export type ElectronProductionRecoveryStoreRemoteFetch = (
  url: string,
  init: ElectronProductionRecoveryStoreRemoteRequestInit
) => Promise<ElectronProductionRecoveryStoreRemoteResponse>;

export interface ElectronProductionRecoveryStoreRemoteDependencies {
  readonly fetchImpl: ElectronProductionRecoveryStoreRemoteFetch;
  readonly target: Readonly<ElectronProductionRecoveryStoreRemoteTarget>;
  readonly token: string;
}

export type ElectronProductionRecoveryStoreRemoteRejectedReason =
  | "conflict"
  | "github-rejected"
  | "malformed-record"
  | "not-found"
  | "path-conflict"
  | "path-exists"
  | "repository-policy-mismatch";

export type ElectronProductionRecoveryStoreRemoteIndeterminateReason =
  | "server-error"
  | "transport"
  | "unexpected-response"
  | "unknown-acknowledgement"
  | "verification-failed";

export interface ElectronProductionRecoveryStoreRemoteRejected {
  readonly outcome: "rejected";
  readonly reason: ElectronProductionRecoveryStoreRemoteRejectedReason;
  readonly status: number | null;
}

export interface ElectronProductionRecoveryStoreRemoteIndeterminate {
  readonly outcome: "indeterminate";
  readonly reason: ElectronProductionRecoveryStoreRemoteIndeterminateReason;
  readonly status: number | null;
}

export type ElectronProductionRecoveryStoreRemoteFailure =
  | ElectronProductionRecoveryStoreRemoteRejected
  | ElectronProductionRecoveryStoreRemoteIndeterminate;

export interface ElectronProductionRecoveryStoreRemoteAbsent {
  readonly outcome: "absent";
  readonly commitMessage: string;
  readonly headSha: string;
  readonly parentShas: readonly string[];
  readonly treeSha: string;
}

export interface ElectronProductionRecoveryStoreRemotePresent {
  readonly outcome: "present";
  readonly blobSha: string;
  readonly byteLength: number;
  readonly commitMessage: string;
  readonly contentBase64: string;
  readonly headSha: string;
  readonly parentShas: readonly string[];
  readonly treeSha: string;
}

export type ElectronProductionRecoveryStoreRemoteReadResult =
  | ElectronProductionRecoveryStoreRemoteAbsent
  | ElectronProductionRecoveryStoreRemotePresent
  | ElectronProductionRecoveryStoreRemoteFailure;

export interface ElectronProductionRecoveryStoreRemoteApplied {
  readonly outcome: "applied";
  readonly blobSha: string;
  readonly byteLength: number;
  readonly commitSha: string;
  readonly parentSha: string;
  readonly treeSha: string;
}

export interface ElectronProductionRecoveryStoreRemoteAtomicPairApplied
  extends ElectronProductionRecoveryStoreRemoteApplied {
  readonly paths: readonly [string, string];
}

export function readElectronProductionRecoveryStoreRemote(
  input: Readonly<ElectronProductionRecoveryStoreRemoteDependencies>
): Promise<ElectronProductionRecoveryStoreRemoteReadResult>;

export function createElectronProductionRecoveryStoreRemote(
  input: Readonly<
    ElectronProductionRecoveryStoreRemoteDependencies & {
      readonly commitMessage: string;
      readonly content: Uint8Array;
      readonly expectedHeadSha: string;
    }
  >
): Promise<
  ElectronProductionRecoveryStoreRemoteApplied |
  ElectronProductionRecoveryStoreRemoteFailure
>;

export function createElectronProductionRecoveryStoreRemoteAtomicPair(
  input: Readonly<{
    readonly commitMessage: string;
    readonly content: Uint8Array;
    readonly expectedHeadSha: string;
    readonly fetchImpl: ElectronProductionRecoveryStoreRemoteFetch;
    readonly targets: readonly [
      Readonly<ElectronProductionRecoveryStoreRemoteTarget>,
      Readonly<ElectronProductionRecoveryStoreRemoteTarget>
    ];
    readonly token: string;
  }>
): Promise<
  ElectronProductionRecoveryStoreRemoteAtomicPairApplied |
  ElectronProductionRecoveryStoreRemoteFailure
>;
