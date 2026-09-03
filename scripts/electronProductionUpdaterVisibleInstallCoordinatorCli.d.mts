import type {
  ElectronProductionUpdaterVisibleInstallCoordinatorDependencies
} from "./electronProductionUpdaterVisibleInstallCoordinator.mjs";

export interface ElectronProductionUpdaterVisibleInstallCoordinatorCliDependencies {
  readonly coordinate?: typeof import("./electronProductionUpdaterVisibleInstallCoordinator.mjs")["coordinateElectronProductionUpdaterVisibleInstall"];
  readonly coordinatorDependencies?: ElectronProductionUpdaterVisibleInstallCoordinatorDependencies;
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterVisibleInstallCoordinatorCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterVisibleInstallCoordinatorCliDependencies
): ReturnType<typeof import("./electronProductionUpdaterVisibleInstallCoordinator.mjs")["coordinateElectronProductionUpdaterVisibleInstall"]>;
