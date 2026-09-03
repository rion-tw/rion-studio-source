export const ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_CAPTURE_KIND:
  "rion-production-updater-source-journal-capture";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_NAME:
  "source-install-journal.json";

export interface ElectronProductionUpdaterSourceJournalCapture {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-source-journal-capture";
  readonly platform: "darwin-aarch64" | "windows-x86_64";
  readonly sourceInstallAttemptId: string;
  readonly phase: "restartPending" | "installerHandoff";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly journal: Readonly<{
    bytes: number;
    fileName: "source-install-journal.json";
    sha256: string;
  }>;
}

export interface ElectronProductionUpdaterSourceJournalObserverDependencies {
  readonly onWatchStarted?: () => void;
  readonly readFile?: (
    filePath: string,
    maximumBytes: number,
    label: string
  ) => Promise<Readonly<{ bytes: number; sha256: string; source: Buffer }>>;
  readonly watchDirectory?: (
    directory: string,
    options: Readonly<{ signal: AbortSignal }>
  ) => AsyncIterable<Readonly<{ filename?: string | Buffer; eventType?: string }>>;
}

export function observeElectronProductionUpdaterSourceJournal(
  input: Readonly<{
    journalPath: string;
    outputPath: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    signal: AbortSignal;
    targetVersion: string;
    visibleInstallInvokedAt: string;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterSourceJournalObserverDependencies
): Promise<Readonly<ElectronProductionUpdaterSourceJournalCapture>>;
