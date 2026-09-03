import type {
  ElectronProductionUpdaterTrustedControlIntakeDependencies
} from "./electronProductionUpdaterTrustedControlIntake.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_CLI_SUMMARY_KIND:
  "rion-electron-production-updater-trusted-control-intake-cli-summary";

export interface ElectronProductionUpdaterTrustedControlIntakeCliDependencies {
  readonly create?:
    typeof import("./electronProductionUpdaterTrustedControlIntake.mjs")["createElectronProductionUpdaterTrustedControlBindings"];
  readonly intakeDependencies?: ElectronProductionUpdaterTrustedControlIntakeDependencies;
  readonly read?:
    typeof import("./electronProductionUpdaterTrustedControlIntake.mjs")["readElectronProductionUpdaterTrustedControlBindings"];
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterTrustedControlIntakeCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterTrustedControlIntakeCliDependencies
): Promise<Readonly<{
  schemaVersion: 1;
  kind: "rion-electron-production-updater-trusted-control-intake-cli-summary";
  command: "create" | "verify";
  status: "created" | "verified";
  artifact: Readonly<{ bytes: number; fileName: string; sha256: string }>;
}>>;
