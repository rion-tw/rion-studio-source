import type {
  ElectronProductionUpdaterEvidenceCellBindingsDependencies
} from "./electronProductionUpdaterEvidenceCellBindings.mjs";

export interface ElectronProductionUpdaterEvidenceCellBindingsCliDependencies {
  readonly bindingDependencies?:
    ElectronProductionUpdaterEvidenceCellBindingsDependencies;
  readonly create?:
    typeof import("./electronProductionUpdaterEvidenceCellBindings.mjs")["createElectronProductionUpdaterEvidenceCellBindings"];
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterEvidenceCellBindingsCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterEvidenceCellBindingsCliDependencies
): Promise<Readonly<Record<string, unknown>>>;
