import { randomUUID } from "node:crypto";
import { CoreAddonClient, type RawNodeApiCoreBinding, type RawNodeApiCoreFactory } from "../core/coreAddonClient";

export interface RecoverySourceBinding extends RawNodeApiCoreBinding {
  seedRoleSessionRecoveryForDesktopE2e: (roleId: string, partial: boolean) => Promise<string>;
}

export async function markRecoveryExportFailed<Options>(factory: RawNodeApiCoreFactory<Options>, options: Options, roleId: string, transferId: string): Promise<void> {
  const target = await CoreAddonClient.create(factory, options);
  try {
    const importing = await target.beginRoleSessionMigrationImportInternal({ roleId, transferId, expectedJournalRevision: 2 });
    await target.transitionRoleSessionMigrationTargetInternal({
      roleId, transferId, transitionId: randomUUID(), expectedPhase: "importing",
      expectedJournalRevision: importing.journalRevision, nextPhase: "failed", outcome: "failed",
      stableErrorCode: "RECOVERY_SYNTHETIC_INTERRUPTED_IMPORT", occurredAt: new Date().toISOString()
    });
  } finally { await target.shutdown(); }
}
