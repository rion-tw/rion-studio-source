import path from "node:path";

import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE,
  electronProductionPublicationRecoveryOutcomeAttemptFileName
} from "./electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "./electronProductionRecoveryCapsule.mjs";
import {
  assertExactKeys
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_TRANSACTION_PATHS_KIND =
  "rion-electron-production-recovery-store-transaction-paths";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_PATHS_KIND =
  "rion-electron-production-recovery-store-outcome-paths";

const TRANSACTION_ROOT = "transactions";
const RECOVERY_OUTCOMES_DIRECTORY = "recovery-outcomes";

export function electronProductionRecoveryStoreTransactionPaths(input) {
  assertExactKeys(
    input,
    ["transactionId"],
    "recovery-store transaction-path input"
  );
  const transactionId = requiredUuid(
    input.transactionId,
    "recovery-store transaction ID"
  );
  const transactionRoot = path.posix.join(TRANSACTION_ROOT, transactionId);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_TRANSACTION_PATHS_KIND,
    transactionId,
    capsulePath: path.posix.join(
      transactionRoot,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
    ),
    storeSealPath: path.posix.join(
      transactionRoot,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
    ),
    recoveryOutcomeTerminalPath: path.posix.join(
      transactionRoot,
      RECOVERY_OUTCOMES_DIRECTORY,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    )
  });
}

export function electronProductionRecoveryStoreOutcomePaths(input) {
  assertExactKeys(
    input,
    ["recoveryRun", "transactionId"],
    "recovery-store outcome-path input"
  );
  const transaction = electronProductionRecoveryStoreTransactionPaths({
    transactionId: input.transactionId
  });
  const fileName =
    electronProductionPublicationRecoveryOutcomeAttemptFileName(
      input.recoveryRun
    );
  if (
    input.recoveryRun.runId.length > 30 ||
    input.recoveryRun.runAttempt > 999_999 ||
    !/^electron-production-publication-recovery-outcome-run-[1-9][0-9]{0,29}-attempt-[0-9]{6}\.json$/u
      .test(fileName)
  ) {
    throw new Error(
      "The recovery-store outcome run ID or attempt exceeds path bounds."
    );
  }
  const outcomeRoot = path.posix.dirname(
    transaction.recoveryOutcomeTerminalPath
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_PATHS_KIND,
    transactionId: transaction.transactionId,
    recoveryRun: {
      runId: input.recoveryRun.runId,
      runAttempt: input.recoveryRun.runAttempt
    },
    attemptPath: path.posix.join(outcomeRoot, fileName),
    terminalPath: transaction.recoveryOutcomeTerminalPath
  });
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)
  ) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
