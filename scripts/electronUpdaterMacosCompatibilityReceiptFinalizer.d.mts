import type {
  ElectronUpdaterDarwinProcessIsolationResult
} from "./electronUpdaterDarwinIsolationResultContract.mjs";
import type {
  ElectronUpdaterCompatibilityCaseObservation,
  ElectronUpdaterCompatibilityFileIdentity,
  ElectronUpdaterCompatibilityReceiptWriteResult
} from "./electronUpdaterCompatibilityReceiptFinalizer.mjs";
import type {
  TauriV22PublicLineageReceipt
} from "./tauriV22PublicLineage.mjs";
import type {
  ElectronUpdaterMacosPackageVerification
} from "./electronUpdaterMacosPackageVerification.mjs";

export const ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND:
  "rion-electron-updater-compatibility-provisional-observations";
export const ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME:
  "provisional-layout-probe-receipt.json";
export const ELECTRON_UPDATER_MACOS_COMPATIBILITY_TERMINAL_RECEIPT_NAME:
  "terminal-layout-probe-receipt.json";

export interface ElectronUpdaterMacosCompatibilityTerminalCase
  extends ElectronUpdaterCompatibilityCaseObservation {
  readonly isolation?: "darwin-seatbelt-detached-cargo-process-group-v1";
  readonly sourceVersion?: string;
  readonly targetVersion?: string;
}

export interface ElectronUpdaterMacosParentCommandIdentity
  extends ElectronUpdaterCompatibilityFileIdentity {
  readonly path: string;
}

export interface ElectronUpdaterMacosCompatibilityTerminalReceipt {
  readonly schemaVersion: 3;
  readonly evidenceKind:
    "tauri-v22-input-plus-v23-layout-replacement-probe";
  readonly status: "verified-after-parent-isolation";
  readonly cutoverEligible: false;
  readonly platform: "darwin-aarch64";
  readonly source: {
    readonly runtime: "tauri-v22";
    readonly releaseTag: string;
    readonly releaseVersion: string;
    readonly sourceSha: string;
    readonly artifactName: "Rion.Studio-mac.app.tar.gz";
    readonly artifactBytes: number;
    readonly artifactSha256: string;
    readonly signatureName: "Rion.Studio-mac.app.tar.gz.sig";
    readonly signatureSha256: string;
    readonly manifestName: "latest.json";
    readonly manifestSha256: string;
    readonly checksumName: "SHA256SUMS.txt";
    readonly checksumSha256: string;
    readonly inputReceipt: ElectronUpdaterCompatibilityFileIdentity;
    readonly publicLineageReceipt: ElectronUpdaterCompatibilityFileIdentity;
    readonly runningExecutable: TauriV22PublicLineageReceipt["runningExecutable"];
  };
  readonly target: {
    readonly runtime: "electron-v23";
    readonly sourceSha: string;
    readonly version: string;
    readonly artifactName: "Rion.Studio-mac.app.tar.gz";
    readonly artifactBytes: number;
    readonly artifactSha256: string;
    readonly signatureName: "Rion.Studio-mac.app.tar.gz.sig";
    readonly signatureBytes: number;
    readonly signatureSha256: string;
    readonly manifestName: "latest-darwin.json";
    readonly manifestBytes: number;
    readonly manifestSha256: string;
    readonly packageVerification: ElectronUpdaterMacosPackageVerification;
    readonly preparedInputReceipt: ElectronUpdaterCompatibilityFileIdentity;
    readonly updaterEndpoint: string;
  };
  readonly trust: { readonly updaterPublicKeySha256: string };
  readonly transaction: {
    readonly sourceUpdaterInvoked: false;
    readonly terminalOutcome: "applied";
    readonly cases: readonly ElectronUpdaterMacosCompatibilityTerminalCase[];
  };
  readonly provisionalReceipt: ElectronUpdaterCompatibilityFileIdentity & {
    readonly probeCompletedAt: string;
  };
  readonly parentIsolation: {
    readonly commandExitCode: 0;
    readonly commandExecutable: ElectronUpdaterMacosParentCommandIdentity;
    readonly commandHarness: ElectronUpdaterMacosParentCommandIdentity;
    readonly resultIdentity: ElectronUpdaterCompatibilityFileIdentity;
    readonly result: ElectronUpdaterDarwinProcessIsolationResult;
  };
  readonly finalizedAt: string;
}

export { writeElectronUpdaterCompatibilityProvisionalReceipt } from
  "./electronUpdaterCompatibilityReceiptFinalizer.mjs";

export function finalizeMacosElectronUpdaterCompatibilityTerminalReceipt(
  input: Readonly<{
    childOutputRoot: string;
    expected: Readonly<{
      isolationAttemptNonce: string;
      isolationCommandExecutablePath: string;
      isolationCommandExecutableSha256: string;
      isolationCommandHarnessPath: string;
      isolationCommandHarnessSha256: string;
      isolationCommandInvocationSha256: string;
      isolationResultSha256: string;
      preparedInputReceiptSha256: string;
      sandboxProfileSha256: string;
      targetSourceSha: string;
      tauriV22InputReceiptSha256: string;
      tauriV22LineageReceiptSha256: string;
      updaterPublicKeySha256: string;
    }>;
    finalizedAt?: string;
    isolationResultPath: string;
    preparedInput: Readonly<{
      artifactPath: string;
      fixtureRoot: string;
      receiptPath: string;
      version: string;
    }>;
    provisionalReceiptPath: string;
    sealedOutputRoot: string;
    target: Readonly<{
      priorV23Version: string;
      updaterEndpoint: string;
      version: string;
    }>;
    tauriV22: Readonly<{
      assetDirectory: string;
      inputReceiptPath: string;
      lineageReceiptPath: string;
    }>;
  }>
): Promise<ElectronUpdaterCompatibilityReceiptWriteResult<
  ElectronUpdaterMacosCompatibilityTerminalReceipt
>>;
