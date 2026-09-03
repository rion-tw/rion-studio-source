import type { DarwinPrivatePackagedElectronBundle } from
  "./packagedElectronDarwinPrivateBundle.mjs";

export interface DarwinProcessInventoryRecord {
  readonly auditToken: string;
  readonly executablePath?: string;
  readonly parentProcessId: number;
  readonly parentProcessUniqueId: string;
  readonly processGroupId: number;
  readonly processId: number;
  readonly processUniqueId: string;
  readonly startMicroseconds: number;
  readonly startSeconds: number;
  readonly userId: number;
}

export interface DarwinPackagedProcessOwnership {
  readonly bundleRoot: string;
  readonly executablePath: string;
  readonly inventoryExecutablePath: string;
  readonly processGroupId: number;
  readonly processId: number;
  readonly rootIdentity: Promise<DarwinProcessInventoryRecord>;
}

export interface DarwinExclusiveBundleProcessContainment {
  readonly bundleRoot: string;
  readonly inventoryExecutablePath: string;
  readonly processId: number;
  readonly spawnedAtMilliseconds: number;
}

export type DarwinPrivateBundleProcessContainment =
  DarwinExclusiveBundleProcessContainment;

export interface DarwinPackagedProcessOperations {
  epochMilliseconds(): number;
  now(): number;
  readInventory(
    executablePath: string,
    fences: Readonly<{
      bundleRoot: string;
      knownProcessFences: readonly Readonly<{
        processId: number;
        startMicroseconds: number;
        startSeconds: number;
      }>[];
      minimumStartSeconds: number;
      rootProcessId: number;
    }>,
    timeoutMilliseconds: number
  ): Promise<readonly DarwinProcessInventoryRecord[]>;
  signalAuditToken(
    executablePath: string,
    auditToken: string,
    signal: "SIGTERM" | "SIGKILL",
    timeoutMilliseconds: number
  ): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

export function buildDarwinPackagedProcessInventory(
  outputDirectory: string
): Promise<string>;

export function createDarwinPackagedProcessOwnership(input: {
  readonly executablePath: string;
  readonly inventoryExecutablePath: string;
  readonly privateBundle: DarwinPrivatePackagedElectronBundle;
  readonly processGroupId: number;
  readonly processId: number;
  readonly spawnedAtMilliseconds: number;
}, operations?: DarwinPackagedProcessOperations): DarwinPackagedProcessOwnership;

export function createDarwinPrivateBundleProcessContainment(input: {
  readonly inventoryExecutablePath: string;
  readonly privateBundle: DarwinPrivatePackagedElectronBundle;
  readonly processId: number;
  readonly spawnedAtMilliseconds: number;
}, operations?: DarwinPackagedProcessOperations): DarwinPrivateBundleProcessContainment;

export function createDarwinExclusiveBundleProcessContainment(input: {
  readonly bundleRoot: string;
  readonly inventoryExecutablePath: string;
  readonly processId: number;
  readonly spawnedAtMilliseconds: number;
}, operations?: DarwinPackagedProcessOperations): DarwinExclusiveBundleProcessContainment;

export function waitForDarwinExclusiveBundleProcessAdmission(
  containment: DarwinExclusiveBundleProcessContainment,
  expectedExecutablePath: string,
  deadlineMilliseconds?: number
): Promise<DarwinProcessInventoryRecord>;

export function waitForDarwinPackagedProcessOwnership(
  ownership: DarwinPackagedProcessOwnership
): Promise<void>;

export function assertDarwinPackagedProcessTreeGone(
  ownership: DarwinPackagedProcessOwnership,
  deadlineMilliseconds?: number
): Promise<void>;

export function assertDarwinExclusiveBundleProcessTreeGone(
  ownership: DarwinExclusiveBundleProcessContainment,
  deadlineMilliseconds?: number
): Promise<void>;

export function terminateDarwinPackagedProcessTree(
  ownership: DarwinPackagedProcessOwnership,
  deadlineMilliseconds?: number
): Promise<void>;

export function terminateDarwinPrivateBundleProcessContainment(
  containment: DarwinPrivateBundleProcessContainment,
  deadlineMilliseconds?: number
): Promise<void>;

export function terminateDarwinExclusiveBundleProcessContainment(
  containment: DarwinExclusiveBundleProcessContainment,
  deadlineMilliseconds?: number
): Promise<void>;

export function parseDarwinProcessInventory(
  source: string
): readonly DarwinProcessInventoryRecord[];
