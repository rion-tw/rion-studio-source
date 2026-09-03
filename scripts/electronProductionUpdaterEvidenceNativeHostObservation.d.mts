export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND:
  "rion-production-updater-native-host-observation";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND:
  "rion-production-updater-native-host-observation-bindings";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND:
  "rion-production-updater-native-host-launch-arguments";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE:
  "native-host-observation.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE:
  "native-host-launch-arguments.json";

export type ElectronProductionUpdaterEvidenceNativeHostPlatform =
  | "darwin-aarch64"
  | "windows-x86_64";
export type ElectronProductionUpdaterEvidenceNativeHostTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";

export interface ElectronProductionUpdaterEvidenceNativeHostChallenge {
  readonly expiresAt: string;
  readonly id: string;
  readonly issuedAt: string;
  readonly nonceSha256: string;
}

export interface ElectronProductionUpdaterEvidenceNativeHostContext {
  readonly challenge: ElectronProductionUpdaterEvidenceNativeHostChallenge;
  readonly evidenceAttemptId: string;
  readonly platform: ElectronProductionUpdaterEvidenceNativeHostPlatform;
  readonly sourceInstallAttemptId: string;
  readonly transitionKind: ElectronProductionUpdaterEvidenceNativeHostTransition;
}

export interface ElectronProductionUpdaterEvidenceNativeHostTarget {
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly candidateReceiptSha256: string;
  readonly embeddedUpdaterEndpoint: string;
  readonly manifestName: "latest.json";
  readonly runtime: "electron-v23";
  readonly servedManifestSha256: string;
  readonly signatureName: string;
  readonly signatureSha256: string;
  readonly sourceSha: string;
  readonly version: string;
}

export interface ElectronProductionUpdaterEvidenceNativeHostObservationBindings {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-native-host-observation-bindings";
  readonly context: ElectronProductionUpdaterEvidenceNativeHostContext;
  readonly target: ElectronProductionUpdaterEvidenceNativeHostTarget;
  readonly targetRunningImageSha256: string;
}

export interface ElectronProductionUpdaterEvidenceDarwinProcessIdentity {
  readonly auditToken: string;
  readonly executablePath: string;
  readonly parentProcessId: number;
  readonly parentProcessUniqueId: string;
  readonly processGroupId: number;
  readonly processId: number;
  readonly processUniqueId: string;
  readonly startMicroseconds: number;
  readonly startSeconds: number;
  readonly userId: number;
}

export interface ElectronProductionUpdaterEvidenceWindowsProcessIdentity {
  readonly creationMilliseconds: number;
  readonly executablePath: string;
  readonly processId: number;
}

export interface ElectronProductionUpdaterEvidenceNativeHostLaunchArguments {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-native-host-launch-arguments";
  readonly arguments: readonly string[];
  readonly context: ElectronProductionUpdaterEvidenceNativeHostContext;
  readonly executablePath: string;
  readonly hostClaim: Readonly<{
    browserWindowOnlySubstitute: false;
    htmlChromeSubstitute: false;
    nativeHostKind: "appkit-chromium" | "bundled-chromium";
    retainedAppKitHost: boolean;
  }>;
  readonly process:
    | ElectronProductionUpdaterEvidenceDarwinProcessIdentity
    | ElectronProductionUpdaterEvidenceWindowsProcessIdentity;
  readonly target: Readonly<{
    candidateReceiptSha256: string;
    sourceSha: string;
    version: string;
  }>;
  readonly targetRunningImageSha256: string;
}

export type ElectronProductionUpdaterEvidenceNativeHostProcessBinding =
  | Readonly<{
      inventoryExecutablePath: string;
      inventoryExecutableSha256: string;
      launchedAfterMilliseconds: number;
      platform: "darwin";
      processId: number;
    }>
  | Readonly<{
      creationMilliseconds: number;
      platform: "win32";
      processId: number;
    }>;

export interface ElectronProductionUpdaterEvidenceNativeHostObservation
  extends ElectronProductionUpdaterEvidenceNativeHostContext {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-native-host-observation";
  readonly capturedAt: string;
  readonly observedAt: string;
  readonly runtime: Readonly<{
    nativeHostKind: "appkit-chromium" | "bundled-chromium";
    remoteDebugging: false;
    retainedAppKitHost: boolean;
    targetVersionObserved: string;
  }>;
  readonly target: ElectronProductionUpdaterEvidenceNativeHostTarget;
  readonly targetRunningImageSha256: string;
}

export interface ElectronProductionUpdaterEvidenceNativeHostObservationFile {
  readonly observation: ElectronProductionUpdaterEvidenceNativeHostObservation;
  readonly observationIdentity: Readonly<{
    bytes: number;
    fileName: "native-host-observation.json";
    sha256: string;
  }>;
  readonly observationPath: string;
}

export interface ElectronProductionUpdaterEvidenceNativeHostDependencies {
  readonly hostPlatform?: "darwin" | "win32";
  readonly now?: () => Date;
  readonly observeDarwinProcess?: (
    input: Readonly<{
      expectedExecutablePath: string;
      inventoryExecutablePath: string;
      launchedAfterMilliseconds: number;
      processId: number;
      signal: AbortSignal;
    }>
  ) => Promise<ElectronProductionUpdaterEvidenceDarwinProcessIdentity>;
  readonly queryWindowsProcess?: (
    input: Readonly<{
      processId: number;
      signal: AbortSignal;
    }>
  ) => Promise<ElectronProductionUpdaterEvidenceWindowsProcessIdentity>;
}

export function observeElectronProductionUpdaterEvidenceNativeHost(
  input: Readonly<{
    bindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings;
    expectedExecutablePath: string;
    launchArgumentsPath: string;
    launchArgumentsSha256: string;
    outputPath: string;
    process: ElectronProductionUpdaterEvidenceNativeHostProcessBinding;
    signal: AbortSignal;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterEvidenceNativeHostDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceNativeHostObservationFile>>;

export function readElectronProductionUpdaterEvidenceNativeHostObservation(
  input: Readonly<{
    bindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings;
    expectedSha256?: string;
    observationPath: string;
  }>
): Promise<Readonly<ElectronProductionUpdaterEvidenceNativeHostObservationFile>>;

export function readElectronProductionUpdaterEvidenceNativeHostBindings(
  bindingsPath: string
): Promise<Readonly<{
  bindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings;
  bindingsIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  bindingsPath: string;
}>>;

export function assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
  value: unknown
): Readonly<ElectronProductionUpdaterEvidenceNativeHostObservationBindings>;

export function assertElectronProductionUpdaterEvidenceNativeHostObservation(
  value: unknown,
  bindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings
): Readonly<ElectronProductionUpdaterEvidenceNativeHostObservation>;
