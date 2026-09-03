export const ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND:
  "rion-production-updater-product-terminal-receipt-capture";
export const ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME:
  "product-terminal-receipt.json";

export interface ElectronProductionUpdaterTerminalReceiptCapture {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-product-terminal-receipt-capture";
  readonly authority: "target-first-boot-journal-reconciliation";
  readonly platform: "darwin-aarch64" | "windows-x86_64";
  readonly reconciledAt: string;
  readonly sourceInstallAttemptId: string;
  readonly terminalOutcome: "applied";
  readonly receipt: Readonly<{
    bytes: number;
    fileName: "product-terminal-receipt.json";
    sha256: string;
  }>;
}

export interface ElectronProductionUpdaterTerminalReceiptObserverDependencies {
  readonly readFile?: (
    filePath: string,
    maximumBytes: number,
    label: string
  ) => Promise<Readonly<{ bytes: number; sha256: string; source: Buffer }>>;
  readonly watchDirectory?: (
    directory: string,
    options: Readonly<{ recursive: true; signal: AbortSignal }>
  ) => AsyncIterable<Readonly<{ filename?: string | Buffer; eventType?: string }>>;
}

export function observeElectronProductionUpdaterTerminalReceipt(
  input: Readonly<{
    outputPath: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    signal: AbortSignal;
    sourceJournalPath: string;
    targetUserDataDirectory: string;
    targetVersion: string;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterTerminalReceiptObserverDependencies
): Promise<Readonly<ElectronProductionUpdaterTerminalReceiptCapture>>;

export function readElectronProductionUpdaterTerminalReceiptCapture(
  input: Readonly<{
    expectedSha256: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    receiptPath: string;
    sourceJournalPath: string;
    targetVersion: string;
  }>,
  dependencyOverrides?: Pick<
    ElectronProductionUpdaterTerminalReceiptObserverDependencies,
    "readFile"
  >
): Promise<Readonly<ElectronProductionUpdaterTerminalReceiptCapture>>;
