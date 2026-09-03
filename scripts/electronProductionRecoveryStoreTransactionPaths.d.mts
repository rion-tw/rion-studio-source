export const ELECTRON_PRODUCTION_RECOVERY_STORE_TRANSACTION_PATHS_KIND:
  "rion-electron-production-recovery-store-transaction-paths";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_PATHS_KIND:
  "rion-electron-production-recovery-store-outcome-paths";

export interface ElectronProductionRecoveryStoreTransactionPaths {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-transaction-paths";
  readonly transactionId: string;
  readonly capsulePath: string;
  readonly storeSealPath: string;
  readonly recoveryOutcomeTerminalPath: string;
}

export function electronProductionRecoveryStoreTransactionPaths(
  input: Readonly<{ transactionId: string }>
): Readonly<ElectronProductionRecoveryStoreTransactionPaths>;

export interface ElectronProductionRecoveryStoreOutcomePaths {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-outcome-paths";
  readonly transactionId: string;
  readonly recoveryRun: Readonly<{
    runId: string;
    runAttempt: number;
  }>;
  readonly attemptPath: string;
  readonly terminalPath: string;
}

export function electronProductionRecoveryStoreOutcomePaths(
  input: Readonly<{
    transactionId: string;
    recoveryRun: Readonly<{
      repository: string;
      workflow: string;
      runId: string;
      runAttempt: number;
      controlSha: string;
      startedAt: string;
    }>;
  }>
): Readonly<ElectronProductionRecoveryStoreOutcomePaths>;
