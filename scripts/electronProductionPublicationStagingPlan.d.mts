import type { ElectronProductionCandidateVerification } from
  "./electronProductionCandidateVerifier.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_KIND:
  "rion-electron-production-publication-staging-plan";
export const ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_RECEIPT:
  "electron-production-publication-staging-plan-receipt.json";
export const ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL:
  "STAGE ELECTRON PRODUCTION PUBLICATION";
export const ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW:
  ".github/workflows/electron-production-candidate.yml";

export type ElectronProductionPublicationPlatform =
  | "darwin-aarch64"
  | "windows-x86_64";

export type ElectronProductionPublicationAssetName =
  | "Rion.Studio-mac.app.tar.gz"
  | "Rion.Studio-mac.app.tar.gz.sig"
  | "Rion.Studio-mac.dmg"
  | "Rion.Studio-win.exe"
  | "Rion.Studio-win.exe.sig"
  | "SHA256SUMS.txt"
  | "latest.json";

export interface ElectronProductionPublicationRunProvenanceInput {
  readonly headSha: string;
  readonly repository: "rion-tw/rion-studio-source";
  readonly runAttempt: number;
  readonly runId: string;
  readonly workflow: string;
}

export type ElectronProductionPublicationTargetCandidateInput =
  | Readonly<{
      kind: "verified-summary";
      verification: ElectronProductionCandidateVerification;
    }>
  | Readonly<{
      kind: "bundle";
      candidateDirectory: string;
      candidateReceiptPath: string;
      candidateReceiptSha256: string;
      macDirectory: string;
      publicKey: string;
      sourceSha: string;
      version: string;
      windowsDirectory: string;
    }>;

export interface ElectronProductionPublicationStagingPlan {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-publication-staging-plan";
  readonly status: "verified-pre-publication-staging-plan";
  readonly terminal: false;
  readonly publicationMutationAllowed: false;
  readonly ownerGate: Readonly<{
    approval: "STAGE ELECTRON PRODUCTION PUBLICATION";
    environment: "electron-production-release";
  }>;
  readonly transaction: Readonly<{ id: string }>;
  readonly lease: Readonly<{ generation: number; id: string }>;
  readonly source: Readonly<{
    runtime: "tauri-v22";
    repository: "rion-tw/rion-studio";
    releaseId: string;
    releaseTag: string;
    version: string;
    sourceSha: string;
    manifest: Readonly<{ fileName: "latest.json"; sha256: string }>;
    snapshot: Readonly<{
      bytes: number;
      fileName: string;
      fileSha256: string;
      stateSha256: string;
      snapshotSha256: string;
    }>;
    lineage: Readonly<{
      kind: "rion-tauri-v22-public-source-lineage";
      targetSourceSha: string;
      updaterPublicKeySha256: string;
      receipts: Readonly<Record<
        ElectronProductionPublicationPlatform,
        Readonly<{
          fileName: "tauri-v22-public-lineage-receipt.json";
          sha256: string;
        }>
      >>;
    }>;
  }>;
  readonly target: Readonly<{
    runtime: "electron-v23";
    repository: "rion-tw/rion-studio";
    releaseTag: string;
    version: string;
    sourceSha: string;
    candidateReceipt: Readonly<{
      fileName: "electron-production-candidate-receipt.json";
      sha256: string;
    }>;
    assets: Readonly<Record<ElectronProductionPublicationAssetName, string>>;
    updater: Readonly<{
      baseUrl: string;
      endpoint:
        "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
      publicKeySha256: string;
    }>;
  }>;
  readonly provenance: Readonly<{
    candidate: Readonly<{
      artifactName: string;
      event: "workflow_dispatch";
      headSha: string;
      repository: "rion-tw/rion-studio-source";
      runAttempt: number;
      runId: string;
      workflow: ".github/workflows/electron-production-candidate.yml";
    }>;
    lineage: Readonly<{
      artifacts: Readonly<Record<ElectronProductionPublicationPlatform, string>>;
      event: "workflow_dispatch";
      headSha: string;
      repository: "rion-tw/rion-studio-source";
      runAttempt: number;
      runId: string;
      workflow:
        ".github/workflows/electron-updater-tauri-v22-compatibility.yml";
    }>;
  }>;
  readonly createdAt: string;
}

export interface ElectronProductionPublicationStagingPlanFile {
  readonly plan: Readonly<ElectronProductionPublicationStagingPlan>;
  readonly receiptIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-publication-staging-plan-receipt.json";
    sha256: string;
  }>;
  readonly receiptPath: string;
}

export function assembleElectronProductionPublicationStagingPlan(input: Readonly<{
  createdAt: string;
  lease: Readonly<{ generation: number; id: string }>;
  lineage: Readonly<Record<
    ElectronProductionPublicationPlatform,
    Readonly<{ path: string; sha256: string }>
  >>;
  outputPath: string;
  ownerApproval: string;
  provenance: Readonly<{
    candidate: ElectronProductionPublicationRunProvenanceInput;
    lineage: ElectronProductionPublicationRunProvenanceInput;
  }>;
  sourceSnapshot: Readonly<{ path: string; sha256: string }>;
  targetCandidate: ElectronProductionPublicationTargetCandidateInput;
  transaction: Readonly<{ id: string }>;
}>): Promise<Readonly<ElectronProductionPublicationStagingPlanFile>>;

export function assertElectronProductionPublicationStagingPlan(
  value: unknown
): Readonly<ElectronProductionPublicationStagingPlan>;

export function serializeElectronProductionPublicationStagingPlan(
  value: unknown
): Buffer;

export function readElectronProductionPublicationStagingPlan(input: Readonly<{
  expectedSha256: string;
  receiptPath: string;
}>): Promise<Readonly<ElectronProductionPublicationStagingPlanFile>>;
