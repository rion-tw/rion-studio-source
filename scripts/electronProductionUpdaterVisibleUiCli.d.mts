import type {
  ElectronProductionUpdaterVisibleUiDependencies
} from "./electronProductionUpdaterVisibleUi.mjs";

export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_SETTINGS_FILE:
  "visible-settings-actions.json";
export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_CHECK_FILE:
  "check-action.json";
export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_UI_INSTALL_FILE:
  "install-action.json";

export interface ElectronProductionUpdaterVisibleUiCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-visible-ui-cli-result";
  readonly action: "open-settings" | "check" | "install";
  readonly receipt: Readonly<{ bytes: number; fileName: string; sha256: string }>;
}

export interface ElectronProductionUpdaterVisibleUiCliDependencies
  extends ElectronProductionUpdaterVisibleUiDependencies {
  readonly writeStdout?: (source: Buffer) => boolean | void | Promise<boolean | void>;
}

export function runElectronProductionUpdaterVisibleUiCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: Readonly<ElectronProductionUpdaterVisibleUiCliDependencies>
): Promise<Readonly<ElectronProductionUpdaterVisibleUiCliSummary>>;
