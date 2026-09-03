import type {
  ElectronProductionUpdaterTerminalReceiptObserverDependencies
} from "./electronProductionUpdaterTerminalReceiptObserver.mjs";

export const ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_OBSERVER_CLI_SUMMARY_KIND:
  "rion-production-updater-terminal-receipt-observer-cli-summary";

export interface ElectronProductionUpdaterTerminalReceiptObserverCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-production-updater-terminal-receipt-observer-cli-summary";
  readonly command: "observe" | "verify";
  readonly status: "captured" | "verified";
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

export interface ElectronProductionUpdaterTerminalReceiptObserverCliDependencies
  extends ElectronProductionUpdaterTerminalReceiptObserverDependencies {
  readonly signal?: AbortSignal;
  readonly writeStdout?: (source: Buffer) => boolean | void | Promise<boolean | void>;
}

export function runElectronProductionUpdaterTerminalReceiptObserverCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: Readonly<
    ElectronProductionUpdaterTerminalReceiptObserverCliDependencies
  >
): Promise<Readonly<ElectronProductionUpdaterTerminalReceiptObserverCliSummary>>;
