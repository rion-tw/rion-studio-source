import type {
  ElectronUpdaterDarwinProcessIsolationEvidence
} from "./electronUpdaterDarwinProcessSupervisor.mjs";

export const ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND:
  "rion-electron-updater-darwin-process-isolation-result";
export const ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME:
  "macos-updater-process-isolation-result.json";

export interface ElectronUpdaterDarwinExecutableIdentity {
  readonly bytes: number;
  readonly fileName: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ElectronUpdaterDarwinProcessIsolationResult {
  readonly schemaVersion: 1;
  readonly kind: typeof ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND;
  readonly platform: "darwin";
  readonly attemptNonce: string;
  readonly commandInvocationSha256: string;
  readonly helperAttemptId: string;
  readonly containment: {
    readonly kind: "darwin-seatbelt-detached-cargo-process-group-v1";
    readonly childSandbox: "seatbelt-v1";
    readonly sandboxProfileSha256: string;
    readonly cargoProcessGroupId: number;
    readonly cargoProcessGroupOutcome: "active-zero";
  };
  readonly supervisor: {
    readonly kind: "rion-electron-updater-darwin-supervisor-isolation";
    readonly outcome: "active-zero";
    readonly applicationPath: string;
    readonly bundleRoot: string;
    readonly mainExecutable: ElectronUpdaterDarwinExecutableIdentity;
    readonly inventoryExecutable: ElectronUpdaterDarwinExecutableIdentity;
    readonly helperProcessId: number;
    readonly launchedAfterMilliseconds: number;
    readonly admittedIdentity: ElectronUpdaterDarwinProcessIsolationEvidence["admittedIdentity"];
  };
  readonly activeProcessesAfterCleanup: 0;
  readonly cleanupVerified: true;
  readonly completedAt: string;
}

export interface ElectronUpdaterDarwinProcessIsolationResultIdentity {
  readonly bytes: number;
  readonly fileName: typeof ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME;
  readonly sha256: string;
}

export function writeElectronUpdaterDarwinProcessIsolationResult(
  input: Readonly<{
    attemptNonce: string;
    cargoProcessGroupId: number;
    cargoProcessGroupOutcome: "active-zero";
    childOutputRoot: string;
    childSandbox: "seatbelt-v1";
    cleanupVerified: true;
    commandInvocationSha256: string;
    completedAt?: string;
    helperAttemptId: string;
    isolationEvidence: ElectronUpdaterDarwinProcessIsolationEvidence;
    outputPath: string;
    sandboxProfileSha256: string;
  }>
): Promise<Readonly<{
  result: ElectronUpdaterDarwinProcessIsolationResult;
  resultIdentity: ElectronUpdaterDarwinProcessIsolationResultIdentity;
  resultPath: string;
}>>;

export function readElectronUpdaterDarwinProcessIsolationResult(
  input: Readonly<{
    childOutputRoot: string;
    expected: Readonly<{
      attemptNonce: string;
      commandInvocationSha256: string;
      resultSha256: string;
      sandboxProfileSha256: string;
    }>;
    resultPath: string;
  }>
): Promise<Readonly<{
  result: ElectronUpdaterDarwinProcessIsolationResult;
  resultIdentity: ElectronUpdaterDarwinProcessIsolationResultIdentity;
}>>;

export function assertElectronUpdaterDarwinProcessIsolationResult(
  value: unknown
): ElectronUpdaterDarwinProcessIsolationResult;
