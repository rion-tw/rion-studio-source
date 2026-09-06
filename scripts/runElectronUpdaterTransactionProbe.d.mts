export type ElectronUpdaterCompatibilityProbePlatform = "darwin" | "win32";

export interface ElectronUpdaterCompatibilityCaseObservation {
  readonly outcome: "applied";
  readonly probe:
    | "packaged-artifact-manifest-fail-closed"
    | "macos-bundle-replacement"
    | "macos-helper-handoff-and-relaunch"
    | "windows-installed-layout-replacement-and-relaunch";
  readonly sourceRuntime: "electron-v23" | "tauri-v22";
  readonly sourceVersion?: string;
  readonly targetVersion?: string;
}

export interface ElectronUpdaterCompatibilityProvisionalReceipt {
  readonly schemaVersion: 2;
  readonly kind: "rion-electron-updater-compatibility-provisional-observations";
  readonly status: "provisional-awaiting-parent-isolation";
  readonly platform: ElectronUpdaterCompatibilityProbePlatform;
  readonly cases: readonly ElectronUpdaterCompatibilityCaseObservation[];
  readonly probeCompletedAt: string;
}

export interface ElectronUpdaterTransactionProbeResult {
  readonly artifact: string;
  readonly manifest: string;
  readonly platform: NodeJS.Platform;
  readonly receipt: ElectronUpdaterCompatibilityProvisionalReceipt | null;
  readonly version: string;
}

export function runElectronUpdaterTransactionProbe(
  argumentsList: string[],
  environment?: NodeJS.ProcessEnv
): Promise<ElectronUpdaterTransactionProbeResult>;

export function macosUpdaterProbeToolchainHomes(
  environment: NodeJS.ProcessEnv,
  defaultHome: string
): { CARGO_HOME: string; RUSTUP_HOME: string };

export function verifyElectronUpdaterCompatibilityInput(input: Readonly<{
  fixtureRoot: string;
  inputReceiptPath: string;
  outputPath: string;
  platform: ElectronUpdaterCompatibilityProbePlatform;
  publicKey: string;
  targetSha: string;
}>): Promise<void>;
