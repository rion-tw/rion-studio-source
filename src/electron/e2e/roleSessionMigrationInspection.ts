import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ElectronDesktopE2eRoleBrowserDataClearReceipt,
  ElectronDesktopE2eRoleSessionMigrationInspection,
  ElectronDesktopE2eRoleSessionMigrationJournal
} from "./desktopE2eBridge";

interface MigrationJournalRow {
  cleanFlushReceiptId: string | null;
  firstVerifiedLaunchAt: string | null;
  journalRevision: number;
  outcome: ElectronDesktopE2eRoleSessionMigrationJournal["outcome"];
  phase: ElectronDesktopE2eRoleSessionMigrationJournal["phase"];
  platform: ElectronDesktopE2eRoleSessionMigrationJournal["platform"];
  resetReceiptId: string | null;
  roleId: string;
  sourceEngine: ElectronDesktopE2eRoleSessionMigrationJournal["sourceEngine"];
  sourceRevision: number;
  targetEngine: "chromium";
  targetRevision: number | null;
  transferId: string;
}

function migrationJournal(
  row: MigrationJournalRow | undefined
): ElectronDesktopE2eRoleSessionMigrationJournal | null {
  if (!row) return null;
  return Object.freeze({
    cleanFlushReceiptId: row.cleanFlushReceiptId,
    firstVerifiedLaunchAt: row.firstVerifiedLaunchAt,
    journalRevision: Number(row.journalRevision),
    outcome: row.outcome,
    phase: row.phase,
    platform: row.platform,
    resetReceiptId: row.resetReceiptId,
    roleId: row.roleId,
    sourceEngine: row.sourceEngine,
    sourceRevision: Number(row.sourceRevision),
    targetEngine: row.targetEngine,
    targetRevision: row.targetRevision === null ? null : Number(row.targetRevision),
    transferId: row.transferId
  });
}

export function readElectronDesktopE2eRoleSessionMigration(input: Readonly<{
  receipt: ElectronDesktopE2eRoleBrowserDataClearReceipt | null;
  roleId: string;
  userDataDirectory: string;
}>): ElectronDesktopE2eRoleSessionMigrationInspection {
  const database = new DatabaseSync(
    join(input.userDataDirectory, "rion-studio.sqlite3"),
    { readOnly: true }
  );
  let transactionOpen = false;
  try {
    database.exec("BEGIN");
    transactionOpen = true;
    const roleExists = database.prepare(
      "SELECT 1 AS present FROM roles WHERE id = ?1"
    ).get(input.roleId) !== undefined;
    const row = database.prepare(`
      SELECT
        role_id AS roleId,
        transfer_id AS transferId,
        phase,
        journal_revision AS journalRevision,
        platform,
        source_engine AS sourceEngine,
        target_engine AS targetEngine,
        source_revision AS sourceRevision,
        target_revision AS targetRevision,
        outcome,
        first_verified_launch_at AS firstVerifiedLaunchAt,
        clean_flush_receipt_id AS cleanFlushReceiptId,
        reset_receipt_id AS resetReceiptId
      FROM role_session_migrations
      WHERE role_id = ?1
    `).get(input.roleId) as MigrationJournalRow | undefined;
    const pending = database.prepare(`
      SELECT COUNT(*) AS count
      FROM operation_journal
      WHERE kind = 'role_browser_data_clear_v1'
    `).get() as { count: number };
    database.exec("COMMIT");
    transactionOpen = false;
    return Object.freeze({
      journal: migrationJournal(row),
      pendingRoleBrowserDataClearOperations: Number(pending.count),
      receipt: input.receipt,
      roleExists,
      roleId: input.roleId
    });
  } finally {
    if (transactionOpen) database.exec("ROLLBACK");
    database.close();
  }
}
