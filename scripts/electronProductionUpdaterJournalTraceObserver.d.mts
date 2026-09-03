export const ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND:
  "rion-production-updater-source-journal-trace";
export const ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_NAME:
  "source-journal-trace.json";

export interface ElectronProductionUpdaterJournalTraceObservation {
  readonly sequence: number;
  readonly phase:
    | "accepted"
    | "preparing"
    | "installing"
    | "draining"
    | "restartPending"
    | "installerHandoff";
  readonly observedAt: string;
  readonly sourceInstallAttemptId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly journal: Readonly<{ bytes: number; sha256: string }>;
}

export interface ElectronProductionUpdaterJournalTrace {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-source-journal-trace";
  readonly platform: "darwin-aarch64" | "windows-x86_64";
  readonly transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
  readonly targetVersion: string;
  readonly visibleInstallInvokedAt: string;
  readonly sourceInstallAttemptId: string;
  readonly observations: readonly Readonly<ElectronProductionUpdaterJournalTraceObservation>[];
}

export interface ElectronProductionUpdaterJournalTraceDependencies {
  readonly now?: () => Date;
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

export function observeElectronProductionUpdaterJournalTrace(
  input: Readonly<{
    journalPath: string;
    outputPath: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    signal: AbortSignal;
    targetVersion: string;
    transitionKind:
      | "tauri-v22-to-electron-v23"
      | "electron-v23-to-electron-v23";
    visibleInstallInvokedAt: string;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterJournalTraceDependencies
): Promise<Readonly<{
  trace: Readonly<ElectronProductionUpdaterJournalTrace>;
  traceIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  tracePath: string;
}>>;

export function assertElectronProductionUpdaterJournalTrace(
  value: unknown
): Readonly<ElectronProductionUpdaterJournalTrace>;

export function readElectronProductionUpdaterJournalTrace(
  input: Readonly<{
    expectedSha256?: string;
    tracePath: string;
  }>
): Promise<Readonly<{
  trace: Readonly<ElectronProductionUpdaterJournalTrace>;
  traceIdentity: Readonly<{ bytes: number; fileName: string; sha256: string }>;
  tracePath: string;
}>>;
