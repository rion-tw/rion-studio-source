import type {
  ElectronProductionUpdaterEvidenceAttachmentName,
  ElectronProductionUpdaterEvidencePlatform,
  ElectronProductionUpdaterEvidenceTransition
} from "./electronProductionUpdaterEvidenceBundle.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND:
  "rion-production-updater-evidence-attachment-finalization";

export interface ElectronProductionUpdaterEvidenceAttachmentFinalization {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-evidence-attachment-finalization";
  readonly attemptPlanSha256: string;
  readonly bindingsSha256: string;
  readonly cell: Readonly<{
    evidenceAttemptId: string;
    platform: ElectronProductionUpdaterEvidencePlatform;
    transitionKind: ElectronProductionUpdaterEvidenceTransition;
  }>;
  readonly journalTraceSha256: string;
  readonly outputRoot: string;
  readonly attachments: Readonly<Record<
    ElectronProductionUpdaterEvidenceAttachmentName,
    Readonly<{ bytes: number; fileName: string; sha256: string }>
  >>;
}

export function finalizeElectronProductionUpdaterEvidenceAttachments(
  input: Readonly<{
    attemptPlanPath: string;
    bindingsPath: string;
    capturedAttachments: Readonly<{
      dataPreservation: string;
      endpointObservation: string;
      nativeHostObservation: string;
      productTerminalReceipt: string;
      sourceInstallJournal: string;
    }>;
    checkActionPath: string;
    expectedAttemptPlanSha256: string;
    expectedJournalTraceSha256: string;
    installActionPath: string;
    journalTracePath: string;
    outputRoot: string;
    platform: ElectronProductionUpdaterEvidencePlatform;
    transitionKind: ElectronProductionUpdaterEvidenceTransition;
  }>,
  dependencyOverrides?: Readonly<{ now?: () => Date }>
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttachmentFinalization>>;
