export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_KIND:
  "rion-electron-production-updater-source-runtime-preparation";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_KIND:
  "rion-electron-production-updater-source-runtime-launch";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_FILE:
  "source-runtime-preparation.json";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_FILE:
  "source-runtime-launch.json";

export interface ElectronProductionUpdaterSourceRuntimeDependencies {
  readonly captureFile?: (
    filePath: string,
    maximumBytes: number,
    label: string
  ) => Promise<Readonly<{ bytes: number; sha256: string }>>;
  readonly expectedUserDataDirectory?: (
    platform: "darwin-aarch64" | "windows-x86_64"
  ) => string;
  readonly extractDarwin?: (input: Readonly<{
    archivePath: string;
    archiveRoot: "Rion Studio.app";
    destinationPath: string;
  }>) => Promise<Readonly<{ destinationPath: string }>>;
  readonly hostPlatform?: "darwin" | "win32";
  readonly installWindows?: (input: Readonly<{
    artifactPath: string;
    installRoot: string;
    runtime: "tauri-v22" | "electron-v23";
    signal: AbortSignal;
  }>) => Promise<Readonly<{
    applicationPath: string;
    executablePath: string;
    installKind: "silent-current-user-nsis";
  }>>;
  readonly launchProcess?: (input: Readonly<{
    arguments: readonly [];
    environment: NodeJS.ProcessEnv;
    executablePath: string;
    signal: AbortSignal;
  }>) => Promise<Readonly<{
    processId: number;
    terminate: () => void;
    unref: () => void;
  }>>;
  readonly now?: () => Date;
  readonly runtimeEnvironment?: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

export interface ElectronProductionUpdaterSourceRuntimePreparation {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-updater-source-runtime-preparation";
  readonly platform: "darwin-aarch64" | "windows-x86_64";
  readonly transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
  readonly bindingsSha256: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly artifact: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  readonly installation: Readonly<{
    applicationPath: string;
    executablePath: string;
    installKind: "safe-tar-extraction" | "silent-current-user-nsis";
    installRoot: string;
    userDataDirectory: string;
  }>;
  readonly runningImage: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly launchPolicy: Readonly<{
    arguments: readonly [];
    embeddedUpdaterEndpointOnly: true;
    privateUpdaterMaterialPresent: false;
    remoteDebugging: false;
    userDataOverrideUsed: false;
  }>;
  readonly preparedAt: string;
}

export interface ElectronProductionUpdaterSourceRuntimeLaunch {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-updater-source-runtime-launch";
  readonly platform: "darwin-aarch64" | "windows-x86_64";
  readonly transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
  readonly preparationSha256: string;
  readonly executablePath: string;
  readonly arguments: readonly [];
  readonly launchedAfterMilliseconds: number;
  readonly launchedAt: string;
  readonly processId: number;
  readonly remoteDebugging: false;
  readonly userDataOverrideUsed: false;
}

export function prepareElectronProductionUpdaterSourceRuntime(
  input: Readonly<{
    artifactPath: string;
    bindingsPath: string;
    installRoot: string;
    outputPath: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    signal: AbortSignal;
    transitionKind:
      | "tauri-v22-to-electron-v23"
      | "electron-v23-to-electron-v23";
    userDataDirectory: string;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterSourceRuntimeDependencies
): Promise<Readonly<{
  receipt: ElectronProductionUpdaterSourceRuntimePreparation;
  preparationIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  preparationPath: string;
  installRoot: string;
  userDataDirectory: string;
}>>;

export function launchElectronProductionUpdaterSourceRuntime(
  input: Readonly<{
    expectedPreparationSha256: string;
    outputPath: string;
    preparationPath: string;
    signal: AbortSignal;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterSourceRuntimeDependencies
): Promise<Readonly<{
  launch: ElectronProductionUpdaterSourceRuntimeLaunch;
  launchIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  launchPath: string;
}>>;
