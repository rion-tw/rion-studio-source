import type {
  ElectronProductionUpdaterEvidenceBundle,
  ElectronProductionUpdaterEvidenceProvenance,
  ElectronProductionUpdaterEvidenceTransition,
  ElectronProductionUpdaterEvidencePlatform
} from "./electronProductionUpdaterEvidenceBundle.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_REPOSITORY:
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_TRANSITIONS:
  readonly ElectronProductionUpdaterEvidenceTransition[];
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_PLATFORMS:
  readonly ElectronProductionUpdaterEvidencePlatform[];

export interface ElectronProductionUpdaterEvidenceChallenge {
  readonly expiresAt: string;
  readonly id: string;
  readonly issuedAt: string;
  readonly nonceSha256: string;
}

export interface ElectronProductionUpdaterEvidenceAggregate {
  readonly aggregateRoot: string;
  readonly bundles: Readonly<Record<
    ElectronProductionUpdaterEvidenceTransition,
    Readonly<Record<
      ElectronProductionUpdaterEvidencePlatform,
      Readonly<ElectronProductionUpdaterEvidenceBundle>
    >>
  >>;
  readonly challenge: Readonly<ElectronProductionUpdaterEvidenceChallenge>;
  readonly cells: Readonly<Record<
    ElectronProductionUpdaterEvidenceTransition,
    Readonly<Record<ElectronProductionUpdaterEvidencePlatform, string>>
  >>;
  readonly evidenceAttemptIds: readonly string[];
  readonly producer: Readonly<ElectronProductionUpdaterEvidenceProvenance>;
  readonly sources: Readonly<{
    priorV23: Readonly<{
      candidateReceiptSha256: string;
      sourceSha: string;
      version: string;
    }>;
    tauriV22: Readonly<{ sourceSha: string; version: string }>;
  }>;
  readonly receiptSha256: Readonly<Record<
    ElectronProductionUpdaterEvidenceTransition,
    Readonly<Record<ElectronProductionUpdaterEvidencePlatform, string>>
  >>;
  readonly target: Readonly<Record<string, unknown>>;
  readonly trust: Readonly<{ updaterPublicKeySha256: string }>;
}

export function readElectronProductionUpdaterEvidenceAggregate(input: Readonly<{
  aggregateRoot: string;
  expectedChallenge: ElectronProductionUpdaterEvidenceChallenge;
  expectedCells: readonly Readonly<{
    evidenceAttemptId: string;
    platform: ElectronProductionUpdaterEvidencePlatform;
    transitionKind: ElectronProductionUpdaterEvidenceTransition;
  }>[];
  expectedProvenance: ElectronProductionUpdaterEvidenceProvenance;
  expectedSources: Readonly<{
    priorV23: Readonly<{
      candidateReceiptSha256: string;
      sourceSha: string;
      version: string;
    }>;
    tauriV22: Readonly<{ sourceSha: string; version: string }>;
  }>;
  expectedTarget: Readonly<{
    candidateReceiptSha256: string;
    sourceSha: string;
    version: string;
  }>;
}>): Promise<Readonly<ElectronProductionUpdaterEvidenceAggregate>>;
