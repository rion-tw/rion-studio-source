import type { WindowsIsolatedProfileResult } from
  "./windowsIsolatedProfileResultContract.mjs";

export const ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND:
  "rion-electron-updater-compatibility-provisional-observations";
export const ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME:
  "provisional-layout-probe-receipt.json";
export const ELECTRON_UPDATER_COMPATIBILITY_TERMINAL_RECEIPT_NAME:
  "terminal-layout-probe-receipt.json";

export type ElectronUpdaterCompatibilityProbePlatform = "darwin" | "win32";

export interface ElectronUpdaterCompatibilityCaseObservation {
  readonly outcome: "applied";
  readonly probe:
    | "packaged-artifact-manifest-fail-closed"
    | "macos-bundle-replacement"
    | "macos-helper-handoff-and-relaunch"
    | "windows-installed-layout-replacement-and-relaunch";
  readonly sourceRuntime: "tauri-v22" | "electron-v23";
  readonly sourceVersion?: string;
  readonly targetVersion?: string;
}

export interface ElectronUpdaterCompatibilityProvisionalReceipt {
  readonly schemaVersion: 2;
  readonly kind:
    "rion-electron-updater-compatibility-provisional-observations";
  readonly status: "provisional-awaiting-parent-isolation";
  readonly platform: ElectronUpdaterCompatibilityProbePlatform;
  readonly cases: readonly ElectronUpdaterCompatibilityCaseObservation[];
  readonly probeCompletedAt: string;
}

export interface ElectronUpdaterCompatibilityFileIdentity {
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface ElectronUpdaterCompatibilityReceiptWriteResult<Receipt> {
  readonly receipt: Readonly<Receipt>;
  readonly receiptIdentity: ElectronUpdaterCompatibilityFileIdentity;
  readonly receiptPath: string;
}

export interface ElectronUpdaterCompatibilityTerminalCase
  extends ElectronUpdaterCompatibilityCaseObservation {
  readonly isolation?: "temporary-local-windows-user-profile-v1";
  readonly sourceVersion?: string;
  readonly targetVersion?: string;
}

export interface ElectronUpdaterCompatibilityTerminalReceipt {
  readonly schemaVersion: 2;
  readonly evidenceKind:
    "tauri-v22-input-plus-v23-layout-replacement-probe";
  readonly status: "verified-after-parent-isolation";
  readonly cutoverEligible: false;
  readonly platform: "windows-x86_64";
  readonly source: {
    readonly runtime: "tauri-v22";
    readonly releaseTag: string;
    readonly releaseVersion: string;
    readonly sourceSha: string;
    readonly artifactName: "Rion.Studio-win.exe";
    readonly artifactBytes: number;
    readonly artifactSha256: string;
    readonly signatureName: "Rion.Studio-win.exe.sig";
    readonly signatureSha256: string;
    readonly manifestName: "latest.json";
    readonly manifestSha256: string;
    readonly checksumName: "SHA256SUMS.txt";
    readonly checksumSha256: string;
    readonly inputReceipt: ElectronUpdaterCompatibilityFileIdentity;
    readonly publicLineageReceipt: ElectronUpdaterCompatibilityFileIdentity;
    readonly runningExecutable: {
      readonly derivation: "windows-isolated-current-user-nsis-install";
      readonly relativePath: "rion-tauri.exe";
      readonly fileName: "rion-tauri.exe";
      readonly bytes: number;
      readonly sha256: string;
      readonly derivedFromArtifactSha256: string;
    };
  };
  readonly target: {
    readonly runtime: "electron-v23";
    readonly sourceSha: string;
    readonly version: string;
    readonly artifactName: "Rion.Studio-win.exe";
    readonly artifactBytes: number;
    readonly artifactSha256: string;
    readonly signatureName: "Rion.Studio-win.exe.sig";
    readonly signatureBytes: number;
    readonly signatureSha256: string;
    readonly manifestName: "latest-win32.json";
    readonly manifestBytes: number;
    readonly manifestSha256: string;
    readonly preparedInputReceipt: ElectronUpdaterCompatibilityFileIdentity;
    readonly updaterEndpoint: string;
  };
  readonly trust: {
    readonly updaterPublicKeySha256: string;
  };
  readonly transaction: {
    readonly sourceUpdaterInvoked: false;
    readonly terminalOutcome: "applied";
    readonly cases: readonly ElectronUpdaterCompatibilityTerminalCase[];
  };
  readonly provisionalReceipt: ElectronUpdaterCompatibilityFileIdentity & {
    readonly probeCompletedAt: string;
  };
  readonly parentIsolation: {
    readonly resultIdentity: ElectronUpdaterCompatibilityFileIdentity;
    readonly result: WindowsIsolatedProfileResult;
  };
  readonly finalizedAt: string;
}

export function writeElectronUpdaterCompatibilityProvisionalReceipt(
  input: Readonly<{
    cases: readonly ElectronUpdaterCompatibilityCaseObservation[];
    outputPath: string;
    platform: ElectronUpdaterCompatibilityProbePlatform;
    probeCompletedAt?: string;
  }>
): Promise<ElectronUpdaterCompatibilityReceiptWriteResult<
  ElectronUpdaterCompatibilityProvisionalReceipt
>>;

export function finalizeWindowsElectronUpdaterCompatibilityTerminalReceipt(
  input: Readonly<{
    childOutputRoot: string;
    expected: Readonly<{
      isolationAttemptNonce: string;
      isolationCommandExecutablePath: string;
      isolationCommandExecutableSha256: string;
      isolationCommandHarnessPath: string;
      isolationCommandHarnessSha256: string;
      isolationCommandInvocationSha256: string;
      preparedInputReceiptSha256: string;
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
  ElectronUpdaterCompatibilityTerminalReceipt
>>;
