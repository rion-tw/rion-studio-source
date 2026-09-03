import type {
  ElectronProductionRecoveryCapsuleBinding
} from "./electronProductionRecoveryCapsule.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_CLI_OPERATION_KIND:
  "rion-electron-production-recovery-capsule-cli-operation";

export type ElectronProductionRecoveryCapsuleCliCommand =
  | "create"
  | "materialize"
  | "verify";

export interface ElectronProductionRecoveryCapsuleCliIdentity {
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface ElectronProductionRecoveryCapsuleCliOperationSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-capsule-cli-operation";
  readonly command: ElectronProductionRecoveryCapsuleCliCommand;
  readonly capsule: Readonly<ElectronProductionRecoveryCapsuleCliIdentity & {
    fileName: "electron-production-publication-recovery-capsule.capsule.json";
  }>;
  readonly manifest: Readonly<ElectronProductionRecoveryCapsuleCliIdentity & {
    fileName: "electron-production-publication-recovery-capsule-manifest.json";
  }>;
  readonly intent: Readonly<ElectronProductionRecoveryCapsuleCliIdentity & {
    fileName: "electron-production-publication-intent-receipt.json";
  }>;
}

export interface ElectronProductionRecoveryCapsuleCliDependencies {
  readonly createCapsule?: (input: Readonly<{
    binding: ElectronProductionRecoveryCapsuleBinding;
    capsulePath: string;
    sourceRoot: string;
  }>) => Promise<Readonly<ElectronProductionRecoveryCapsuleCliReadResult & {
    manifestPath: string;
  }>>;
  readonly materializeCapsule?: (input: Readonly<{
    binding: ElectronProductionRecoveryCapsuleBinding;
    capsulePath: string;
    expectedCapsuleSha256: string;
    expectedManifestSha256: string;
    outputRoot: string;
  }>) => Promise<Readonly<ElectronProductionRecoveryCapsuleCliReadResult & {
    materializedRoot: string;
  }>>;
  readonly readCapsule?: (input: Readonly<{
    binding: ElectronProductionRecoveryCapsuleBinding;
    capsulePath: string;
    expectedCapsuleSha256: string;
  }>) => Promise<Readonly<ElectronProductionRecoveryCapsuleCliReadResult>>;
  readonly readDirectory?: (input: Readonly<{
    binding: ElectronProductionRecoveryCapsuleBinding;
    expectedManifestSha256: string;
    sourceRoot: string;
  }>) => Promise<Readonly<{
    files: ElectronProductionRecoveryCapsuleCliReadResult["files"];
    manifest: ElectronProductionRecoveryCapsuleCliReadResult["manifest"];
    manifestIdentity: ElectronProductionRecoveryCapsuleCliReadResult["manifestIdentity"];
    sourceRoot: string;
  }>>;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export interface ElectronProductionRecoveryCapsuleCliReadResult {
  readonly capsuleIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule.capsule.json";
    sha256: string;
  }>;
  readonly files: Readonly<Record<string, Readonly<{
    bytes: number;
    sha256: string;
  }>>>;
  readonly manifest: object;
  readonly manifestIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule-manifest.json";
    sha256: string;
  }>;
}

export function runElectronProductionRecoveryCapsuleCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionRecoveryCapsuleCliDependencies
): Promise<Readonly<ElectronProductionRecoveryCapsuleCliOperationSummary>>;
