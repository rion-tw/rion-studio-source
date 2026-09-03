import type {
  DarwinPackagedProcessOperations,
  DarwinPackagedProcessOwnership,
  DarwinPrivateBundleProcessContainment
} from
  "./packagedElectronDarwinProcessOwnership.mjs";
import type { DarwinPrivatePackagedElectronBundle } from
  "./packagedElectronDarwinPrivateBundle.mjs";

export type PackagedElectronPlatform = "darwin" | "win32";

export const PACKAGED_ELECTRON_PROCESS_CLEANUP_MILLISECONDS: number;

export function createPackagedElectronProcessCleanupDeadline(): number;

export interface PackagedElectronChildProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: string, listener: (...argumentsList: unknown[]) => void): this;
}

interface PackagedElectronProcessOwnerBase {
  readonly child: PackagedElectronChildProcess;
  readonly executablePath: string;
  readonly executableRoot: string;
  readonly processId: number;
  readonly spawnedAtMilliseconds: number;
}

export interface WindowsPackagedElectronRootIdentity {
  readonly creationMilliseconds: number;
  readonly executablePath: string;
  readonly processId: number;
}

export interface DarwinPackagedElectronProcessOwner
  extends PackagedElectronProcessOwnerBase {
  readonly darwinOwnership: DarwinPackagedProcessOwnership;
  readonly platform: "darwin";
  readonly processGroupId: number;
  readonly windowsRootIdentity: undefined;
}

export interface WindowsPackagedElectronProcessOwner
  extends PackagedElectronProcessOwnerBase {
  readonly darwinOwnership: undefined;
  readonly platform: "win32";
  readonly processGroupId: undefined;
  readonly windowsRootIdentity: Promise<WindowsPackagedElectronRootIdentity>;
}

export type PackagedElectronProcessOwner =
  | DarwinPackagedElectronProcessOwner
  | WindowsPackagedElectronProcessOwner;

export interface PackagedElectronPrivateBundleContainment {
  readonly child: PackagedElectronChildProcess;
  readonly darwinContainment: DarwinPrivateBundleProcessContainment;
  readonly platform: "darwin";
  readonly processId: number;
}

export interface WindowsOwnedProcessEntry {
  readonly creationMilliseconds?: number;
  readonly depth: number;
  readonly executablePath?: string;
  readonly parentProcessId?: number;
  readonly processId: number;
}

export interface PackagedElectronProcessOperations {
  now(): number;
  readWindowsOwnedTree(
    owner: PackagedElectronProcessOwner
  ): Promise<readonly WindowsOwnedProcessEntry[]>;
  sleep(milliseconds: number): Promise<void>;
  terminateWindowsTree(processId: number): Promise<unknown>;
}

export function packagedElectronSpawnOptions(
  platform: "darwin"
): Readonly<{ detached: true }>;
export function packagedElectronSpawnOptions(
  platform: "win32"
): Readonly<{ detached: false }>;
export function packagedElectronSpawnOptions(
  platform?: NodeJS.Platform
): Readonly<{ detached: boolean }>;

export function buildDarwinPackagedProcessInventory(
  outputDirectory: string
): Promise<string>;

export function createPackagedElectronProcessOwner(input: {
  child: PackagedElectronChildProcess;
  executablePath: string;
  inventoryExecutablePath: string;
  platform: "darwin";
  privateBundle: DarwinPrivatePackagedElectronBundle;
  spawnedAtMilliseconds: number;
}, darwinOperations?: DarwinPackagedProcessOperations): DarwinPackagedElectronProcessOwner;
export function createPackagedElectronProcessOwner(input: {
  child: PackagedElectronChildProcess;
  executablePath: string;
  platform: "win32";
  spawnedAtMilliseconds: number;
}, darwinOperations?: undefined): WindowsPackagedElectronProcessOwner;
export function createPackagedElectronProcessOwner(input: {
  child: PackagedElectronChildProcess;
  executablePath: string;
  inventoryExecutablePath?: string;
  platform: PackagedElectronPlatform;
  privateBundle?: DarwinPrivatePackagedElectronBundle;
  spawnedAtMilliseconds: number;
}, darwinOperations?: DarwinPackagedProcessOperations): PackagedElectronProcessOwner;
export function createPackagedElectronProcessOwner(input: {
  child: PackagedElectronChildProcess;
  executablePath: string;
  inventoryExecutablePath?: string;
  platform: string;
  privateBundle?: DarwinPrivatePackagedElectronBundle;
  spawnedAtMilliseconds: number;
}, darwinOperations?: DarwinPackagedProcessOperations): PackagedElectronProcessOwner;

export function createPackagedElectronPrivateBundleContainment(input: {
  child: PackagedElectronChildProcess;
  inventoryExecutablePath: string;
  platform: "darwin";
  privateBundle: DarwinPrivatePackagedElectronBundle;
  spawnedAtMilliseconds: number;
}): PackagedElectronPrivateBundleContainment;

export function waitForPackagedElectronProcessOwnership(
  owner: PackagedElectronProcessOwner
): Promise<void>;

export function waitForPackagedElectronProcessClose(
  owner: PackagedElectronProcessOwner,
  deadlineMilliseconds: number
): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>>;

export function assertPackagedElectronProcessTreeGone(
  owner: PackagedElectronProcessOwner,
  operations?: PackagedElectronProcessOperations
): Promise<void>;

export function assertPackagedElectronProcessContainmentGone(
  owner: PackagedElectronProcessOwner,
  operations?: PackagedElectronProcessOperations
): Promise<void>;

export function terminatePackagedElectronProcessTree(
  owner: PackagedElectronProcessOwner,
  operations?: PackagedElectronProcessOperations,
  deadlineMilliseconds?: number
): Promise<void>;

export function terminatePackagedElectronPrivateBundleContainment(
  containment: PackagedElectronPrivateBundleContainment,
  deadlineMilliseconds?: number
): Promise<void>;

export function packagedSmokeFailure<Primary>(
  primaryError: Primary,
  cleanupErrors: readonly []
): Primary;
export function packagedSmokeFailure(
  primaryError: unknown,
  cleanupErrors: readonly [unknown, ...unknown[]]
): AggregateError;
export function packagedSmokeFailure<Primary>(
  primaryError: Primary,
  cleanupErrors: readonly unknown[]
): Primary | AggregateError;
