import type { ElectronUpdaterMacosPackageVerification } from
  "./electronUpdaterMacosPackageVerification.mjs";

export const ELECTRON_UPDATER_PREPARED_INPUT_KIND:
  "rion-electron-updater-prepared-probe-input";
export const ELECTRON_UPDATER_PREPARED_INPUT_NAME:
  "prepared-updater-probe-input.json";

export interface ElectronUpdaterPreparedProbeFileIdentity {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

interface ElectronUpdaterPreparedProbeInputReceiptBase {
  readonly schemaVersion: 2;
  readonly kind: typeof ELECTRON_UPDATER_PREPARED_INPUT_KIND;
  readonly version: string;
  readonly artifact: ElectronUpdaterPreparedProbeFileIdentity;
  readonly artifactSignature: ElectronUpdaterPreparedProbeFileIdentity;
  readonly companion: ElectronUpdaterPreparedProbeFileIdentity;
  readonly companionSignature: ElectronUpdaterPreparedProbeFileIdentity;
  readonly manifest: ElectronUpdaterPreparedProbeFileIdentity;
}

export type ElectronUpdaterPreparedProbeInputReceipt =
  | Readonly<ElectronUpdaterPreparedProbeInputReceiptBase & {
    readonly architecture: "arm64";
    readonly macosPackageVerification:
      ElectronUpdaterMacosPackageVerification;
    readonly platform: "darwin";
  }>
  | Readonly<ElectronUpdaterPreparedProbeInputReceiptBase & {
    readonly architecture: "x64";
    readonly macosPackageVerification: null;
    readonly platform: "win32";
  }>;

export interface ElectronUpdaterPreparedProbeInput {
  artifact: string;
  artifactSignature: string;
  companion: string;
  companionSignature: string;
  manifest: string;
  receipt: ElectronUpdaterPreparedProbeInputReceipt;
  receiptIdentity: ElectronUpdaterPreparedProbeFileIdentity;
  receiptPath: string;
}

export function prepareElectronUpdaterProbeInput(input: Readonly<{
  artifactPath: string;
  architecture: "arm64" | "x64";
  environment: NodeJS.ProcessEnv;
  fixtureRoot: string;
  platform: "darwin" | "win32";
  referenceApplicationPath?: string;
  version: string;
  workingDirectory?: string;
}>): Promise<ElectronUpdaterPreparedProbeInput>;

export function readElectronUpdaterPreparedProbeInput(input: Readonly<{
  artifactPath: string;
  architecture: "arm64" | "x64";
  environment: NodeJS.ProcessEnv;
  fixtureRoot: string;
  platform: "darwin" | "win32";
  receiptPath: string;
  version: string;
}>): Promise<ElectronUpdaterPreparedProbeInput>;

export function assertUpdaterPrivateEnvironmentAbsent(
  environment: NodeJS.ProcessEnv
): void;
