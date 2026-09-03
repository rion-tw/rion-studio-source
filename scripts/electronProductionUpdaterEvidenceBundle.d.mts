export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_KIND:
  "rion-production-updater-terminal-transaction";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME:
  "terminal-receipt.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW:
  ".github/workflows/electron-production-updater-evidence.yml";

export type ElectronProductionUpdaterEvidenceAttachmentName =
  | "data-preservation-observation.json"
  | "endpoint-observation.json"
  | "native-host-observation.json"
  | "product-terminal-receipt.json"
  | "source-event-stream.jsonl"
  | "source-install-journal.json"
  | "source-release-snapshot.json"
  | "target-terminal-record.json";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES:
  readonly ElectronProductionUpdaterEvidenceAttachmentName[];

export type ElectronProductionUpdaterEvidencePlatform =
  | "darwin-aarch64"
  | "windows-x86_64";
export type ElectronProductionUpdaterEvidenceTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";

export interface ElectronProductionUpdaterTauriSourceBinding {
  artifactName: string;
  artifactSha256: string;
  defaultUpdaterEndpoint: string;
  lineageKind: "published-release";
  manifestName: "latest.json";
  manifestSha256: string;
  releaseTag: string;
  runningImageSha256: string;
  runtime: "tauri-v22";
  sourceSha: string;
  version: string;
}

export interface ElectronProductionUpdaterElectronSourceBinding {
  artifactName: string;
  artifactSha256: string;
  candidateReceiptSha256: string;
  embeddedUpdaterEndpoint: string;
  lineageKind: "production-candidate";
  manifestName: "latest.json";
  manifestSha256: string;
  runningImageSha256: string;
  runtime: "electron-v23";
  sourceSha: string;
  version: string;
}

export type ElectronProductionUpdaterSourceBinding =
  | ElectronProductionUpdaterTauriSourceBinding
  | ElectronProductionUpdaterElectronSourceBinding;

export interface ElectronProductionUpdaterTargetBinding {
  artifactName: string;
  artifactSha256: string;
  candidateReceiptSha256: string;
  embeddedUpdaterEndpoint: string;
  manifestName: "latest.json";
  runtime: "electron-v23";
  servedManifestSha256: string;
  signatureName: string;
  signatureSha256: string;
  sourceSha: string;
  targetRunningImageSha256: string;
  updaterPublicKeySha256: string;
  version: string;
}

export interface ElectronProductionUpdaterEvidenceProvenance {
  artifactName: string;
  repository: "rion-tw/rion-studio-source";
  runAttempt: number;
  runId: string;
  sourceSha: string;
  workflow: ".github/workflows/electron-production-updater-evidence.yml";
}

export interface ElectronProductionUpdaterEvidenceReceipt {
  readonly schemaVersion: 1;
  readonly evidenceKind: "rion-production-updater-terminal-transaction";
  readonly cutoverEligible: true;
  readonly platform: ElectronProductionUpdaterEvidencePlatform;
  readonly transitionKind: ElectronProductionUpdaterEvidenceTransition;
  readonly challenge: Readonly<{
    expiresAt: string;
    id: string;
    issuedAt: string;
    nonceSha256: string;
  }>;
  readonly source: Readonly<ElectronProductionUpdaterSourceBinding & {
    releaseSnapshotSha256: string;
  }>;
  readonly target: Readonly<Omit<
    ElectronProductionUpdaterTargetBinding,
    "targetRunningImageSha256" | "updaterPublicKeySha256"
  >>;
  readonly trust: Readonly<{ updaterPublicKeySha256: string }>;
  readonly transaction: Readonly<Record<string, unknown>>;
  readonly preservation: Readonly<Record<string, unknown>>;
  readonly nativeRuntime: Readonly<Record<string, unknown>>;
  readonly producer: Readonly<ElectronProductionUpdaterEvidenceProvenance>;
  readonly attachments: Readonly<Record<
    ElectronProductionUpdaterEvidenceAttachmentName,
    string
  >>;
  readonly completedAt: string;
}

export interface ElectronProductionUpdaterEvidenceBundle {
  readonly attachments: Readonly<Record<
    ElectronProductionUpdaterEvidenceAttachmentName,
    Readonly<{ bytes: number; sha256: string }>
  >>;
  readonly outputRoot: string;
  readonly receipt: Readonly<ElectronProductionUpdaterEvidenceReceipt>;
  readonly receiptSha256: string;
}

export function assembleElectronProductionUpdaterEvidenceBundle(input: Readonly<{
  attachments: Readonly<Record<ElectronProductionUpdaterEvidenceAttachmentName, string>>;
  outputRoot: string;
  provenance: Readonly<ElectronProductionUpdaterEvidenceProvenance>;
  sourceBinding: Readonly<ElectronProductionUpdaterSourceBinding>;
  targetBinding: Readonly<ElectronProductionUpdaterTargetBinding>;
}>): Promise<Readonly<ElectronProductionUpdaterEvidenceBundle>>;

export function readElectronProductionUpdaterEvidenceBundle(input: Readonly<{
  expectedReceiptSha256?: string;
  outputRoot: string;
}>): Promise<Readonly<ElectronProductionUpdaterEvidenceBundle>>;
