import type {
  ElectronProductionUpdaterJournalTraceDependencies
} from "./electronProductionUpdaterJournalTraceObserver.mjs";
import type {
  ElectronProductionUpdaterSourceJournalObserverDependencies
} from "./electronProductionUpdaterSourceJournalObserver.mjs";
import type {
  ElectronProductionUpdaterVisibleUiDependencies,
  ElectronProductionUpdaterVisibleUiInput,
  ElectronProductionUpdaterVisibleUiActionReceipt
} from "./electronProductionUpdaterVisibleUi.mjs";

export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_INSTALL_OBSERVATION_KIND:
  "rion-production-updater-visible-install-observation";

export interface ElectronProductionUpdaterVisibleInstallCoordinatorDependencies {
  readonly now?: () => Date;
  readonly observeJournalTrace?: (
    input: Parameters<typeof import("./electronProductionUpdaterJournalTraceObserver.mjs")["observeElectronProductionUpdaterJournalTrace"]>[0],
    dependencies?: ElectronProductionUpdaterJournalTraceDependencies
  ) => ReturnType<typeof import("./electronProductionUpdaterJournalTraceObserver.mjs")["observeElectronProductionUpdaterJournalTrace"]>;
  readonly observeSourceJournal?: (
    input: Parameters<typeof import("./electronProductionUpdaterSourceJournalObserver.mjs")["observeElectronProductionUpdaterSourceJournal"]>[0],
    dependencies?: ElectronProductionUpdaterSourceJournalObserverDependencies
  ) => ReturnType<typeof import("./electronProductionUpdaterSourceJournalObserver.mjs")["observeElectronProductionUpdaterSourceJournal"]>;
  readonly pressInstall?: (
    input: ElectronProductionUpdaterVisibleUiInput,
    dependencies?: ElectronProductionUpdaterVisibleUiDependencies
  ) => Promise<Readonly<ElectronProductionUpdaterVisibleUiActionReceipt>>;
  readonly readFile?: ElectronProductionUpdaterJournalTraceDependencies["readFile"];
  readonly runMacos?: ElectronProductionUpdaterVisibleUiDependencies["runMacos"];
  readonly runWindows?: ElectronProductionUpdaterVisibleUiDependencies["runWindows"];
  readonly watchDirectory?: ElectronProductionUpdaterJournalTraceDependencies["watchDirectory"];
}

export function coordinateElectronProductionUpdaterVisibleInstall(
  input: Readonly<{
    installActionOutputPath: string;
    journalPath: string;
    journalTraceOutputPath: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    processId: number;
    signal: AbortSignal;
    sourceJournalOutputPath: string;
    targetVersion: string;
    transitionKind:
      | "tauri-v22-to-electron-v23"
      | "electron-v23-to-electron-v23";
  }>,
  dependencyOverrides?: ElectronProductionUpdaterVisibleInstallCoordinatorDependencies
): Promise<Readonly<{
  schemaVersion: 1;
  kind: "rion-production-updater-visible-install-observation";
  platform: "darwin-aarch64" | "windows-x86_64";
  transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
  sourceInstallAttemptId: string;
  artifacts: Readonly<{
    installAction: Readonly<{ bytes: number; fileName: string; sha256: string }>;
    journalTrace: Readonly<{ bytes: number; fileName: string; sha256: string }>;
    sourceJournal: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  }>;
}>>;
