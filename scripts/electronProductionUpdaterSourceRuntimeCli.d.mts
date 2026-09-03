import type {
  ElectronProductionUpdaterSourceRuntimeDependencies
} from "./electronProductionUpdaterSourceRuntime.mjs";

export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_CLI_SUMMARY_KIND:
  "rion-electron-production-updater-source-runtime-cli-summary";

export interface ElectronProductionUpdaterSourceRuntimeCliDependencies {
  readonly launch?:
    typeof import("./electronProductionUpdaterSourceRuntime.mjs")["launchElectronProductionUpdaterSourceRuntime"];
  readonly prepare?:
    typeof import("./electronProductionUpdaterSourceRuntime.mjs")["prepareElectronProductionUpdaterSourceRuntime"];
  readonly runtimeDependencies?: ElectronProductionUpdaterSourceRuntimeDependencies;
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterSourceRuntimeCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterSourceRuntimeCliDependencies
): Promise<Readonly<Record<string, unknown>>>;
