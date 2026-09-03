import type {
  ElectronProductionPublicLatestLeaseRemoteFetch,
  ElectronProductionPublicLatestLeaseRemoteIndeterminateReason,
  ElectronProductionPublicLatestLeaseRemoteRejectedReason
} from "./electronProductionPublicLatestLeaseRemote.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND:
  "rion-electron-production-public-latest-lease-remote-operation";

export type ElectronProductionPublicLatestLeaseRemoteCliCommand =
  | "acquire"
  | "observe"
  | "observe-release"
  | "release";

export type ElectronProductionPublicLatestLeaseRemoteCliOutcome =
  | "applied"
  | "observed"
  | "rejected"
  | "indeterminate";

export type ElectronProductionPublicLatestLeaseRemoteCliReason =
  | ElectronProductionPublicLatestLeaseRemoteRejectedReason
  | ElectronProductionPublicLatestLeaseRemoteIndeterminateReason
  | "local-output-failed"
  | null;

export interface ElectronProductionPublicLatestLeaseRemoteOperationSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-public-latest-lease-remote-operation";
  readonly command: ElectronProductionPublicLatestLeaseRemoteCliCommand;
  readonly request: Readonly<{
    expectedHeld: Readonly<{
      transactionId: string;
      leaseId: string;
      purpose:
        | "electron-v23-provisional-publication"
        | "tauri-v22-latest-restore";
      holder: Readonly<{
        repository: "rion-tw/rion-studio";
        workflow:
          | "publish-electron-production-provisional.yml"
          | "restore-public-latest.yml";
        runId: string;
        runAttempt: number;
        headSha: string;
      }>;
      source: Readonly<{
        runtime: "tauri-v22" | "electron-v23";
        version: string;
        stateSha256: string;
      }>;
      target: Readonly<{
        runtime: "tauri-v22" | "electron-v23";
        version: string;
        stateSha256: string;
      }>;
      recordedAt: string;
    }>;
  }> | Readonly<{
    attemptedAt: string;
    held: Readonly<{
      transactionId: string;
      leaseId: string;
      generation: number;
      revision: number;
      eventSha256: string;
      sourceStateSha256: string;
      targetStateSha256: string;
    }>;
  }> | null;
  readonly outcome: ElectronProductionPublicLatestLeaseRemoteCliOutcome;
  readonly reason: ElectronProductionPublicLatestLeaseRemoteCliReason;
  readonly httpStatus: number | null;
  readonly remote: Readonly<{
    repository: "rion-tw/rion-studio";
    ref: "main";
    path: "releases/electron-production-public-latest-lease.json";
    blobSha: string | null;
  }>;
  readonly lease: Readonly<{
    transactionId: string;
    leaseId: string;
    generation: number;
    revision: number;
    status: "held" | "released";
    eventSha256: string;
  }> | null;
  readonly output: Readonly<{
    bytes: number;
    fileName: "electron-production-public-latest-lease.json";
    sha256: string;
  }> | null;
}

export interface ElectronProductionPublicLatestLeaseRemoteCliDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ElectronProductionPublicLatestLeaseRemoteFetch;
  readonly setExitCode?: (code: 1) => void;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export class ElectronProductionPublicLatestLeaseRemoteCliFailure extends Error {
  readonly summary: Readonly<
    ElectronProductionPublicLatestLeaseRemoteOperationSummary
  >;
  constructor(
    summary: Readonly<ElectronProductionPublicLatestLeaseRemoteOperationSummary>
  );
}

export function runElectronProductionPublicLatestLeaseRemoteCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionPublicLatestLeaseRemoteCliDependencies
): Promise<Readonly<ElectronProductionPublicLatestLeaseRemoteOperationSummary>>;

export function assertElectronProductionPublicLatestLeaseRemoteOperationSummary(
  value: unknown
): Readonly<ElectronProductionPublicLatestLeaseRemoteOperationSummary>;
