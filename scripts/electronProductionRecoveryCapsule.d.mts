export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_KIND:
  "rion-electron-production-publication-recovery-capsule";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND:
  "rion-electron-production-publication-recovery-capsule-package";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME:
  "electron-production-publication-recovery-capsule-manifest.json";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME:
  "electron-production-publication-recovery-capsule.capsule.json";

export type ElectronProductionRecoveryCapsulePayloadPath =
  | "electron-production-candidate-receipt.json"
  | "electron-production-prior-candidate-receipt.json"
  | "electron-production-prior-candidate-trusted-control-receipt.json"
  | "electron-production-prior-candidate-verification.json"
  | "electron-production-public-latest-held-lease-evidence.json"
  | "electron-production-public-latest-lease-acquire-operation.json"
  | "electron-production-public-latest-lease.json"
  | "electron-production-publication-intent-receipt.json"
  | "electron-production-publication-staging-plan-receipt.json"
  | "electron-production-target-candidate-trusted-control-receipt.json"
  | "electron-production-target-candidate-verification.json"
  | "source-public-latest-snapshot.json"
  | "staged-target-public-release-snapshot.json"
  | "target-public-latest-projection.json"
  | "tauri-lineage/darwin-aarch64/tauri-v22-public-lineage-receipt.json"
  | "tauri-lineage/windows-x86_64/tauri-v22-public-lineage-receipt.json";

export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS:
  readonly ElectronProductionRecoveryCapsulePayloadPath[];
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS: Readonly<{
  maximumJsonDepth: number;
  maximumJsonNodes: number;
  maximumManifestBytes: number;
  maximumPackageBytes: number;
  maximumPayloadFileBytes: number;
  maximumTotalPayloadBytes: number;
  packedFileCount: 17;
  payloadFileCount: 16;
}>;

export interface ElectronProductionRecoveryCapsuleCandidateBinding {
  readonly controlSha: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly sourceSha: string;
  readonly version: string;
}

export interface ElectronProductionRecoveryCapsuleBinding {
  readonly transaction: Readonly<{ id: string }>;
  readonly lease: Readonly<{
    eventSha256: string;
    generation: number;
    id: string;
  }>;
  readonly control: Readonly<{
    event: "workflow_dispatch";
    headSha: string;
    repository: "rion-tw/rion-studio-source";
    runAttempt: number;
    runId: string;
    workflow: ".github/workflows/electron-production-provisional-publish.yml";
  }>;
  readonly candidate: Readonly<ElectronProductionRecoveryCapsuleCandidateBinding>;
  readonly priorCandidate: Readonly<ElectronProductionRecoveryCapsuleCandidateBinding>;
}

export interface ElectronProductionRecoveryCapsuleFileIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ElectronProductionRecoveryCapsuleManifest {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-publication-recovery-capsule";
  readonly status: "attested-pre-mutation-intent";
  readonly terminal: false;
  readonly publicationMutationOccurred: false;
  readonly recoveryRequiredOnUnknownCompletion: true;
  readonly transaction: Readonly<{ id: string }>;
  readonly lease: Readonly<Record<string, unknown>>;
  readonly control: ElectronProductionRecoveryCapsuleBinding["control"];
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly priorCandidate: Readonly<Record<string, unknown>>;
  readonly source: Readonly<Record<string, unknown>>;
  readonly target: Readonly<Record<string, unknown>>;
  readonly stagingPlanSha256: string;
  readonly intentSha256: string;
  readonly payloadCount: 16;
  readonly payloadBytes: number;
  readonly files: Readonly<Record<
    ElectronProductionRecoveryCapsulePayloadPath,
    ElectronProductionRecoveryCapsuleFileIdentity
  >>;
}

export interface ElectronProductionRecoveryCapsuleReadResult {
  readonly binding: Readonly<ElectronProductionRecoveryCapsuleBinding>;
  readonly capsule: Readonly<{
    encoding: "base64";
    fileCount: 17;
    intent: Readonly<Record<string, unknown>>;
    kind: "rion-electron-production-publication-recovery-capsule-package";
    manifest: Readonly<Record<string, unknown>>;
    schemaVersion: 1;
    totalFileBytes: number;
  }>;
  readonly capsuleIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule.capsule.json";
    sha256: string;
  }>;
  readonly capsulePath: string;
  readonly files: Readonly<Record<string, ElectronProductionRecoveryCapsuleFileIdentity>>;
  readonly foundation: Readonly<{
    intent: Readonly<ElectronProductionPublicationReceipt>;
    lease: Readonly<ElectronProductionPublicLatestLease>;
    sourceSnapshot: Readonly<ElectronProductionPublicLatestSnapshot>;
    stagedSnapshot: Readonly<ElectronProductionPublicLatestSnapshot>;
    targetProjection: Readonly<ElectronProductionPublicLatestSnapshot>;
  }>;
  readonly manifest: Readonly<ElectronProductionRecoveryCapsuleManifest>;
  readonly manifestIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule-manifest.json";
    sha256: string;
  }>;
  readonly payloads: Readonly<Record<
    ElectronProductionRecoveryCapsulePayloadPath,
    Readonly<ElectronProductionRecoveryCapsuleFileIdentity & {
      contentBase64: string;
    }>
  >>;
}

export function createElectronProductionRecoveryCapsule(input: Readonly<{
  binding: ElectronProductionRecoveryCapsuleBinding;
  capsulePath: string;
  sourceRoot: string;
}>): Promise<Readonly<ElectronProductionRecoveryCapsuleReadResult & {
  manifestPath: string;
}>>;

export function readElectronProductionRecoveryCapsule(input: Readonly<{
  binding: ElectronProductionRecoveryCapsuleBinding;
  capsulePath: string;
  expectedCapsuleSha256: string;
}>): Promise<Readonly<ElectronProductionRecoveryCapsuleReadResult>>;

export function readElectronProductionRecoveryCapsuleSelfBound(
  input: Readonly<{
    capsulePath: string;
    expectedCapsuleSha256: string;
  }>
): Promise<Readonly<{
  binding: Readonly<ElectronProductionRecoveryCapsuleBinding>;
  capsule: Readonly<ElectronProductionRecoveryCapsuleReadResult>;
}>>;

export function readElectronProductionRecoveryCapsuleDirectory(input: Readonly<{
  binding: ElectronProductionRecoveryCapsuleBinding;
  expectedManifestSha256: string;
  sourceRoot: string;
}>): Promise<Readonly<{
  files: Readonly<Record<string, ElectronProductionRecoveryCapsuleFileIdentity>>;
  manifest: Readonly<ElectronProductionRecoveryCapsuleManifest>;
  manifestIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-recovery-capsule-manifest.json";
    sha256: string;
  }>;
  sourceRoot: string;
}>>;

export interface ElectronProductionRecoveryCapsuleMaterializationDependencies {
  readonly readDirectory?: typeof readElectronProductionRecoveryCapsuleDirectory;
  readonly writeFile?: (
    filePath: string,
    source: Buffer
  ) => void | Promise<void>;
}

export function materializeElectronProductionRecoveryCapsule(
  input: Readonly<{
    binding: ElectronProductionRecoveryCapsuleBinding;
    capsulePath: string;
    expectedCapsuleSha256: string;
    expectedManifestSha256: string;
    outputRoot: string;
  }>,
  dependencyOverrides?:
    ElectronProductionRecoveryCapsuleMaterializationDependencies
): Promise<Readonly<ElectronProductionRecoveryCapsuleReadResult & {
  materializedRoot: string;
}>>;
import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";
