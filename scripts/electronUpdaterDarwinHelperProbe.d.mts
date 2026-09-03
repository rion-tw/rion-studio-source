import type {
  ElectronUpdaterDarwinProcessIsolationEvidence,
  ElectronUpdaterDarwinProcessSupervisor
} from "./electronUpdaterDarwinProcessSupervisor.mjs";

export interface ElectronUpdaterDarwinHelperResult {
  readonly attemptId: string;
  readonly currentApp: string;
  readonly helperProcessId: number;
  readonly journal: string;
  readonly marker: string;
  readonly sourceRuntime: "tauri-v22";
  readonly sourceVersion: string;
  readonly targetVersion: string;
  readonly userData: string;
  readonly cargoProcessGroupId: number;
  readonly cargoProcessGroupOutcome: "active-zero";
  readonly childSandbox: "seatbelt-v1";
  readonly isolationEvidence: ElectronUpdaterDarwinProcessIsolationEvidence;
}

export interface ElectronUpdaterDarwinCargoOwner {
  readonly close: Promise<unknown>;
  readonly completion: Promise<unknown>;
  readonly processGroupId: number;
  release(): void;
}

export interface ElectronUpdaterDarwinHelperProbeOperations {
  assertSupervisorGone(
    supervisor: ElectronUpdaterDarwinProcessSupervisor
  ): Promise<void>;
  buildProcessInventory(outputDirectory: string): Promise<string>;
  completeSupervisorIsolationEvidence(
    supervisor: ElectronUpdaterDarwinProcessSupervisor
  ): Promise<ElectronUpdaterDarwinProcessIsolationEvidence>;
  createSupervisor(input: Readonly<{
    applicationPath: string;
    helperProcessId: number;
    inventoryExecutablePath: string;
    launchedAfterMilliseconds: number;
    platform: "darwin";
    runtimeRoot: string;
  }>): Promise<ElectronUpdaterDarwinProcessSupervisor>;
  epochMilliseconds(): number;
  isProcessGroupAlive(processGroupId: number): boolean;
  now(): number;
  releaseCargoOwner(owner: ElectronUpdaterDarwinCargoOwner): void;
  signalProcessGroup(
    processGroupId: number,
    signal: "SIGTERM" | "SIGKILL"
  ): void;
  sleep(milliseconds: number): Promise<void>;
  spawnCargoProbe(input: Readonly<{
    environment: NodeJS.ProcessEnv;
    testName: string;
    workingDirectory: string;
  }>): Promise<ElectronUpdaterDarwinCargoOwner>;
  terminateSupervisor(
    supervisor: ElectronUpdaterDarwinProcessSupervisor
  ): Promise<void>;
  waitForCargoClose(owner: ElectronUpdaterDarwinCargoOwner): Promise<void>;
  waitForSupervisorAdmission(
    supervisor: ElectronUpdaterDarwinProcessSupervisor
  ): Promise<unknown>;
  writeAdmissionAcknowledgement(path: string, source: string): Promise<void>;
}

export function runElectronUpdaterDarwinHelperProbe(
  input: Readonly<{
    environment: NodeJS.ProcessEnv;
    fixtureRoot: string;
    platform: "darwin";
    workingDirectory: string;
  }>,
  operationOverrides?: Partial<ElectronUpdaterDarwinHelperProbeOperations>
): Promise<ElectronUpdaterDarwinHelperResult>;
