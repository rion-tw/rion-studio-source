import type {
  ElectronProductionUpdaterTargetProcessObservationDependencies
} from "./electronProductionUpdaterTargetProcessObservation.mjs";

export interface ElectronProductionUpdaterTargetProcessObservationCliDependencies {
  readonly observe?:
    typeof import("./electronProductionUpdaterTargetProcessObservation.mjs")["discoverAndObserveElectronProductionUpdaterTargetProcess"];
  readonly observerDependencies?:
    ElectronProductionUpdaterTargetProcessObservationDependencies;
  readonly readBindings?:
    typeof import("./electronProductionUpdaterEvidenceNativeHostObservation.mjs")["readElectronProductionUpdaterEvidenceNativeHostBindings"];
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterTargetProcessObservationCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterTargetProcessObservationCliDependencies
): ReturnType<typeof import("./electronProductionUpdaterTargetProcessObservation.mjs")["discoverAndObserveElectronProductionUpdaterTargetProcess"]>;
