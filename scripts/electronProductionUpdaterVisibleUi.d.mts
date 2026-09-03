export type ElectronProductionUpdaterVisibleUiPlatform = "darwin" | "win32";
export type ElectronProductionUpdaterVisibleUiAction =
  | "settings"
  | "updates"
  | "check"
  | "install";

export interface ElectronProductionUpdaterVisibleUiActionReceipt {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-visible-ui-action";
  readonly action: ElectronProductionUpdaterVisibleUiAction;
  readonly controlName: string;
  readonly interaction: "visible-os-accessibility-press";
  readonly invokedAt: string;
  readonly completedAt: string;
  readonly platform: ElectronProductionUpdaterVisibleUiPlatform;
  readonly processId: number;
  readonly remoteDebugging: false;
}

export interface ElectronProductionUpdaterVisibleUiDependencies {
  readonly now?: () => Date;
  readonly runMacos?: (processId: number, controlName: string) => Promise<void>;
  readonly runWindows?: (processId: number, controlName: string) => Promise<void>;
}

export interface ElectronProductionUpdaterVisibleUiInput {
  readonly platform: ElectronProductionUpdaterVisibleUiPlatform;
  readonly processId: number;
}

export function openVisibleProductionUpdaterSettings(
  input: ElectronProductionUpdaterVisibleUiInput,
  dependencyOverrides?: ElectronProductionUpdaterVisibleUiDependencies
): Promise<Readonly<{
  schemaVersion: 1;
  interaction: "visible-os-accessibility-press";
  platform: ElectronProductionUpdaterVisibleUiPlatform;
  processId: number;
  remoteDebugging: false;
  controls: readonly Readonly<ElectronProductionUpdaterVisibleUiActionReceipt>[];
}>>;

export function pressVisibleProductionUpdaterCheck(
  input: ElectronProductionUpdaterVisibleUiInput,
  dependencyOverrides?: ElectronProductionUpdaterVisibleUiDependencies
): Promise<Readonly<ElectronProductionUpdaterVisibleUiActionReceipt>>;

export function pressVisibleProductionUpdaterInstall(
  input: ElectronProductionUpdaterVisibleUiInput,
  dependencyOverrides?: ElectronProductionUpdaterVisibleUiDependencies
): Promise<Readonly<ElectronProductionUpdaterVisibleUiActionReceipt>>;
