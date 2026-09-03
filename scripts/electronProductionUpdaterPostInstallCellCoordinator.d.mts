import type {
  ElectronProductionUpdaterDataPreservationObservationFile
} from "./electronProductionUpdaterDataPreservationObserver.mjs";
import type {
  ElectronProductionUpdaterEvidenceBundle,
  ElectronProductionUpdaterEvidencePlatform,
  ElectronProductionUpdaterEvidenceTransition
} from "./electronProductionUpdaterEvidenceBundle.mjs";
import type {
  ElectronProductionUpdaterEvidenceAttachmentFinalization
} from "./electronProductionUpdaterEvidenceAttachmentFinalizer.mjs";
import type {
  ElectronProductionUpdaterTerminalReceiptObserverDependencies
} from "./electronProductionUpdaterTerminalReceiptObserver.mjs";
import type {
  ElectronProductionUpdaterTargetProcessObservationDependencies
} from "./electronProductionUpdaterTargetProcessObservation.mjs";

export const ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CONTEXT_FILE:
  "data-preservation-context.json";

export interface ElectronProductionUpdaterPostInstallCellCoordinatorDependencies {
  readonly assembleBundle?:
    typeof import("./electronProductionUpdaterEvidenceBundle.mjs")["assembleElectronProductionUpdaterEvidenceBundle"];
  readonly finalizeAttachments?: (
    input: Parameters<typeof import("./electronProductionUpdaterEvidenceAttachmentFinalizer.mjs")["finalizeElectronProductionUpdaterEvidenceAttachments"]>[0],
    dependencies?: Readonly<{ now?: () => Date }>
  ) => Promise<Readonly<ElectronProductionUpdaterEvidenceAttachmentFinalization>>;
  readonly finalizeDataPreservation?: (
    input: Parameters<typeof import("./electronProductionUpdaterDataPreservationObserver.mjs")["finalizeElectronProductionUpdaterDataPreservation"]>[0],
    dependencies?: Readonly<{ now?: () => Date }>
  ) => Promise<Readonly<ElectronProductionUpdaterDataPreservationObservationFile>>;
  readonly now?: () => Date;
  readonly observeTargetProcess?:
    typeof import("./electronProductionUpdaterTargetProcessObservation.mjs")["discoverAndObserveElectronProductionUpdaterTargetProcess"];
  readonly observeTerminalReceipt?:
    typeof import("./electronProductionUpdaterTerminalReceiptObserver.mjs")["observeElectronProductionUpdaterTerminalReceipt"];
  readonly readAttemptPlan?:
    typeof import("./electronProductionUpdaterEvidenceAttemptPlan.mjs")["readElectronProductionUpdaterEvidenceAttemptPlan"];
  readonly readBundle?:
    typeof import("./electronProductionUpdaterEvidenceBundle.mjs")["readElectronProductionUpdaterEvidenceBundle"];
  readonly readJournalTrace?:
    typeof import("./electronProductionUpdaterJournalTraceObserver.mjs")["readElectronProductionUpdaterJournalTrace"];
  readonly terminalReceiptDependencies?:
    ElectronProductionUpdaterTerminalReceiptObserverDependencies;
  readonly targetProcessDependencies?:
    ElectronProductionUpdaterTargetProcessObservationDependencies;
}

export function coordinateElectronProductionUpdaterPostInstallCell(
  input: Readonly<{
    attachmentOutputRoot: string;
    attemptPlanPath: string;
    bindingsPath: string;
    bundleOutputRoot: string;
    checkActionPath: string;
    dataPreservationBeforePath: string;
    dataPreservationContextOutputPath: string;
    dataPreservationObservationOutputPath: string;
    endpointObservationPath: string;
    expectedAttemptPlanSha256: string;
    expectedDataPreservationBeforeSha256: string;
    expectedJournalTraceSha256: string;
    installActionPath: string;
    journalTracePath: string;
    nativeHostObservationPath: string;
    platform: ElectronProductionUpdaterEvidencePlatform;
    productTerminalReceiptOutputPath: string;
    signal: AbortSignal;
    sourceInstallJournalPath: string;
    targetExecutablePath: string;
    targetLaunchArgumentsOutputPath: string;
    targetProcess: Readonly<{
      inventoryExecutablePath?: string;
      inventoryExecutableSha256?: string;
    }>;
    targetUserDataDirectory: string;
    transitionKind: ElectronProductionUpdaterEvidenceTransition;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterPostInstallCellCoordinatorDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceBundle>>;
