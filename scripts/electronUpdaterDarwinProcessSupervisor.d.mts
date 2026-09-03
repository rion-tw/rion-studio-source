import type {
  DarwinPackagedProcessOperations,
  DarwinProcessInventoryRecord
} from "./packagedElectronDarwinProcessOwnership.mjs";

export const ELECTRON_UPDATER_DARWIN_ISOLATION_EVIDENCE_KIND:
  "rion-electron-updater-darwin-supervisor-isolation";

export interface ElectronUpdaterDarwinProcessSupervisor {
  readonly applicationPath: string;
  readonly helperProcessId: number;
  readonly inventoryExecutablePath: string;
  readonly launchedAfterMilliseconds: number;
  readonly mainExecutablePath: string;
  readonly runtimeRoot: string;
}

export interface ElectronUpdaterDarwinProcessIsolationEvidence {
  readonly admittedIdentity: DarwinProcessInventoryRecord;
  readonly applicationPath: string;
  readonly bundleRoot: string;
  readonly helperProcessId: number;
  readonly inventoryExecutablePath: string;
  readonly kind: typeof ELECTRON_UPDATER_DARWIN_ISOLATION_EVIDENCE_KIND;
  readonly launchedAfterMilliseconds: number;
  readonly mainExecutablePath: string;
  readonly outcome: "active-zero";
}

export function buildElectronUpdaterDarwinProcessInventory(
  outputDirectory: string
): Promise<string>;

export function createElectronUpdaterDarwinProcessSupervisor(
  input: Readonly<{
    applicationPath: string;
    helperProcessId: number;
    inventoryExecutablePath: string;
    launchedAfterMilliseconds: number;
    platform: "darwin";
    runtimeRoot: string;
  }>,
  operations?: DarwinPackagedProcessOperations
): Promise<ElectronUpdaterDarwinProcessSupervisor>;

export function waitForElectronUpdaterDarwinProcessSupervisorAdmission(
  supervisor: ElectronUpdaterDarwinProcessSupervisor,
  deadlineMilliseconds?: number
): Promise<DarwinProcessInventoryRecord>;

export function terminateElectronUpdaterDarwinProcessSupervisor(
  supervisor: ElectronUpdaterDarwinProcessSupervisor,
  deadlineMilliseconds?: number
): Promise<void>;

export function assertElectronUpdaterDarwinProcessTreeGone(
  supervisor: ElectronUpdaterDarwinProcessSupervisor,
  deadlineMilliseconds?: number
): Promise<void>;

export function completeElectronUpdaterDarwinProcessIsolationEvidence(
  supervisor: ElectronUpdaterDarwinProcessSupervisor
): Promise<ElectronUpdaterDarwinProcessIsolationEvidence>;

export function requireElectronUpdaterDarwinProcessIsolationEvidence(
  value: unknown
): ElectronUpdaterDarwinProcessIsolationEvidence;
