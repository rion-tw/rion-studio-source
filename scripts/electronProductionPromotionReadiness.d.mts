import type {
  TauriV22PublicLineageAsset,
  TauriV22PublicLineageReceipt
} from "./tauriV22PublicLineage.mjs";
import type {
  ElectronProductionPublicationBaseline,
  ElectronProductionPublicationLease,
  ElectronProductionPublicationResult,
  ElectronProductionPublicationTarget
} from "./electronProductionPublicationReceipt.mjs";

export const ELECTRON_PRODUCTION_PROMOTION_READINESS_APPROVAL: string;
export const ELECTRON_PRODUCTION_PROMOTION_READINESS_RECEIPT: string;
export const ELECTRON_PRODUCTION_EVIDENCE_WORKFLOW: string;
export const ELECTRON_PRODUCTION_PROVISIONAL_PUBLICATION_WORKFLOW: string;

export type ElectronProductionTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";
export type ElectronProductionPlatform = "darwin-aarch64" | "windows-x86_64";

export interface ElectronProductionPromotionReadinessReceipt {
  schemaVersion: 4;
  kind: "rion-electron-production-promotion-readiness";
  status: "verified-terminal-evidence";
  publication: Readonly<{
    allowedByThisWorkflow: false;
    status: "externally-served-terminal-evidence-observed";
    terminalPromotionReceipt: false;
  }>;
  ownerGate: Readonly<{
    approval: string;
    environment: "electron-production-release";
  }>;
  candidate: Readonly<{
    receiptFileName: "electron-production-candidate-receipt.json";
    receiptSha256: string;
    trustedControlReceiptSha256: string;
    sourceSha: string;
    version: string;
    updaterBaseUrl: string;
    updaterEndpoint: string;
    publicKeySha256: string;
    assets: Readonly<Record<string, string>>;
  }>;
  priorElectronCandidate: Readonly<{
    receiptSha256: string;
    trustedControlReceiptSha256: string;
    sourceSha: string;
    version: string;
    updaterEndpoint: string;
    publicKeySha256: string;
    assets: Readonly<Record<string, string>>;
  }>;
  provisionalPublication: Readonly<{
    receiptFileName: "electron-production-publication-provisional-receipt.json";
    receiptSha256: string;
    transactionId: string;
    revision: number;
    previousEventSha256: string;
    phase: "provisional";
    terminal: false;
    outcome: null;
    baseline: Readonly<ElectronProductionPublicationBaseline>;
    target: Readonly<ElectronProductionPublicationTarget>;
    lease: Readonly<ElectronProductionPublicationLease>;
    publication: Readonly<ElectronProductionPublicationResult & {
      acknowledgement: "confirmed";
      observedState: "target";
      observedStateSha256: string;
    }>;
    recordedAt: string;
    producer: Readonly<{
      artifactName: string;
      repository: "rion-tw/rion-studio-source";
      workflow: ".github/workflows/electron-production-provisional-publish.yml";
      runId: string;
      runAttempt: number;
      sourceSha: string;
    }>;
  }>;
  tauriV22PublicLineage: Readonly<{
    release: Readonly<{
      repository: "rion-tw/rion-studio";
      id: string;
      tag: string;
      version: string;
      publishedAt: string;
    }>;
    sourceSha: string;
    targetSourceSha: string;
    updaterPublicKeySha256: string;
    producer: Readonly<{
      repository: "rion-tw/rion-studio-source";
      workflow: string;
      runId: string;
      runAttempt: number;
    }>;
    platforms: Readonly<Record<ElectronProductionPlatform, Readonly<{
      receiptSha256: string;
      artifact: TauriV22PublicLineageAsset;
      manifest: TauriV22PublicLineageAsset;
      runningExecutable: TauriV22PublicLineageReceipt["runningExecutable"];
      releaseObservedAt: string;
      sourceTagObservedAt: string;
      producedAt: string;
    }>>>;
  }>;
  provenance: Readonly<{
    candidateRunControlSha: string;
    candidateRunAttempt: number;
    candidateRunId: string;
    evidenceRunControlSha: string;
    evidenceRunAttempt: number;
    evidenceRunId: string;
    priorCandidateRunControlSha: string;
    priorCandidateRunAttempt: number;
    priorCandidateRunId: string;
    provisionalPublicationRunControlSha: string;
    provisionalPublicationRunAttempt: number;
    provisionalPublicationRunId: string;
    readinessControlSha: string;
    repository: "rion-tw/rion-studio-source";
    tauriLineageRunControlSha: string;
    tauriLineageRunAttempt: number;
    tauriLineageRunId: string;
  }>;
  challenge: Readonly<{
    id: string;
    nonceSha256: string;
    issuedAt: string;
    expiresAt: string;
  }>;
  evidence: Readonly<Record<
    ElectronProductionTransition,
    Readonly<Record<ElectronProductionPlatform, Readonly<Record<string, unknown>>>>
  >>;
  compatibility: Readonly<{
    macosAppKitRetained: true;
    stableTauriReleasePath: "retained-as-rollback-source-until-terminal-promotion";
    windowsEvidenceIndependent: true;
  }>;
  verifiedAt: string;
}

export function verifyElectronProductionPromotionReadiness(input: Readonly<{
  candidateDirectory: string;
  candidateReceiptPath: string;
  candidateReceiptSha256: string;
  candidateTrustedControlReceiptPath: string;
  challengeId: string;
  challengeNonceSha256: string;
  evidenceDirectory: string;
  evidenceReceiptSha256: Readonly<Record<
    ElectronProductionTransition,
    Readonly<Record<ElectronProductionPlatform, string>>
  >>;
  macDirectory: string;
  now?: Date;
  outputPath: string;
  ownerApproval: string;
  provenance: Readonly<{
    candidateRunControlSha: string;
    candidateRunAttempt: number;
    candidateRunId: string;
    evidenceRunControlSha: string;
    evidenceRunAttempt: number;
    evidenceRunId: string;
    priorCandidateRunControlSha: string;
    priorCandidateRunAttempt: number;
    priorCandidateRunId: string;
    provisionalPublicationRunControlSha: string;
    provisionalPublicationRunAttempt: number;
    provisionalPublicationRunId: string;
    readinessControlSha: string;
    repository: "rion-tw/rion-studio-source";
    tauriLineageRunControlSha: string;
    tauriLineageRunAttempt: number;
    tauriLineageRunId: string;
  }>;
  publicKey: string;
  priorCandidateDirectory: string;
  priorCandidateReceiptPath: string;
  priorCandidateReceiptSha256: string;
  priorCandidateTrustedControlReceiptPath: string;
  provisionalPublicationReceiptPath: string;
  provisionalPublicationReceiptSha256: string;
  priorElectronSourceSha: string;
  priorElectronVersion: string;
  priorMacDirectory: string;
  priorWindowsDirectory: string;
  sourceSha: string;
  tauriReleaseTag: string;
  tauriLineageReceiptPath: Readonly<Record<ElectronProductionPlatform, string>>;
  tauriLineageReceiptSha256: Readonly<Record<ElectronProductionPlatform, string>>;
  tauriSourceSha: string;
  tauriVersion: string;
  version: string;
  windowsDirectory: string;
}>): Promise<Readonly<ElectronProductionPromotionReadinessReceipt>>;
