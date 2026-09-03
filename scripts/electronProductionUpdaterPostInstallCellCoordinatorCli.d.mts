import type {
  ElectronProductionUpdaterPostInstallCellCoordinatorDependencies
} from "./electronProductionUpdaterPostInstallCellCoordinator.mjs";

export const ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CELL_CLI_SUMMARY_KIND:
  "rion-electron-production-updater-post-install-cell-cli-summary";

export interface ElectronProductionUpdaterPostInstallCellCoordinatorCliDependencies {
  readonly coordinate?:
    typeof import("./electronProductionUpdaterPostInstallCellCoordinator.mjs")["coordinateElectronProductionUpdaterPostInstallCell"];
  readonly coordinatorDependencies?:
    ElectronProductionUpdaterPostInstallCellCoordinatorDependencies;
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterPostInstallCellCoordinatorCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterPostInstallCellCoordinatorCliDependencies
): Promise<Readonly<{
  schemaVersion: 1;
  kind: "rion-electron-production-updater-post-install-cell-cli-summary";
  status: "bundled";
  artifact: Readonly<{ fileName: "terminal-receipt.json"; sha256: string }>;
  outputRoot: string;
}>>;
