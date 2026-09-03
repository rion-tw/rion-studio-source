export interface ElectronPackageLayout {
  executablePath: string;
  resourcesPath: string;
}

export interface ElectronArchiveSource {
  path: string;
  source: Buffer | string;
}

export interface ElectronArchiveVerification {
  archivePath: string;
  entryCount: number;
  packageVersion: string;
  runtimeSourceBytes: number;
  runtimeSourceCount: number;
}

export function assertProductionElectronFuses(
  fuseWire: Record<number, number>
): void;
export function assertProductionElectronArchiveSources(
  sources: readonly ElectronArchiveSource[]
): void;
export function assertElectronNativeAddonInventory(
  entryPaths: readonly string[]
): void;
export function assertWindowsAuthenticodeStatus(output: string): void;
export function verifyProductionElectronArchive(
  archivePath: string
): ElectronArchiveVerification;
export function resolveElectronPackageLayout(
  applicationPath: string
): ElectronPackageLayout;
export function resolveMacosElectronFrameworkBinaryPath(
  applicationPath: string
): string;
export function assertMacosElectronBundleInfo(
  info: Readonly<Record<string, unknown>>,
  expectedVersion: string
): void;
export function assertMacosElectronFrameworkArchitectures(
  output: string
): void;
export function verifyPackagedElectron(
  applicationPath: string
): Promise<ElectronPackageLayout>;
