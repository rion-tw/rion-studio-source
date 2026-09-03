import type {
  ElectronProductionUpdaterEvidenceDarwinProcessIdentity,
  ElectronProductionUpdaterEvidenceNativeHostDependencies,
  ElectronProductionUpdaterEvidenceNativeHostObservationBindings,
  ElectronProductionUpdaterEvidenceNativeHostObservationFile,
  ElectronProductionUpdaterEvidenceWindowsProcessIdentity
} from "./electronProductionUpdaterEvidenceNativeHostObservation.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TARGET_PROCESS_OBSERVATION_KIND:
  "rion-electron-production-updater-target-process-observation";

export interface ElectronProductionUpdaterTargetProcessObservationDependencies
  extends ElectronProductionUpdaterEvidenceNativeHostDependencies {
  readonly discoverDarwinTarget?: (input: Readonly<{
    expectedExecutablePath: string;
    inventoryExecutablePath: string;
    launchedAfterMilliseconds: number;
    signal: AbortSignal;
  }>) => Promise<Readonly<{
    arguments: readonly string[];
    identity: ElectronProductionUpdaterEvidenceDarwinProcessIdentity;
  }>>;
  readonly discoverWindowsTarget?: (input: Readonly<{
    expectedExecutablePath: string;
    launchedAfterMilliseconds: number;
    signal: AbortSignal;
  }>) => Promise<Readonly<{
    arguments: readonly string[];
    identity: ElectronProductionUpdaterEvidenceWindowsProcessIdentity;
  }>>;
  readonly observeNativeHost?:
    typeof import("./electronProductionUpdaterEvidenceNativeHostObservation.mjs")["observeElectronProductionUpdaterEvidenceNativeHost"];
}

export function discoverAndObserveElectronProductionUpdaterTargetProcess(
  input: Readonly<{
    bindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings;
    expectedExecutablePath: string;
    launchArgumentsOutputPath: string;
    launchedAfterMilliseconds: number;
    nativeHostObservationOutputPath: string;
    platformProcess: Readonly<{
      inventoryExecutablePath?: string;
      inventoryExecutableSha256?: string;
    }>;
    signal: AbortSignal;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterTargetProcessObservationDependencies
): Promise<Readonly<{
  schemaVersion: 1;
  kind: "rion-electron-production-updater-target-process-observation";
  platform: "darwin-aarch64" | "windows-x86_64";
  process:
    | ElectronProductionUpdaterEvidenceDarwinProcessIdentity
    | ElectronProductionUpdaterEvidenceWindowsProcessIdentity;
  launchArguments: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  nativeHostObservation:
    ElectronProductionUpdaterEvidenceNativeHostObservationFile["observationIdentity"];
}>>;
