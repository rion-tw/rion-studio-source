import type { CoreEffectRequest, RolePathsRecord, RoleSessionMigrationRecord } from "../../shared/generated";
import type { CoreAddonClient } from "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import { ChromiumSessionMigrationFreshCoordinator } from "./chromiumSessionMigrationFreshCoordinator";

function invalid(): never {
  throw new RionBridgeError({ code: "RECOVERY_NATIVE_DESCRIPTOR_INVALID", message: "The active Rust recovery descriptor is invalid." });
}

/** Only Rust can resolve a recovery identity to its private vault and target. */
export class ChromiumSessionRecoveryExecutor {
  constructor(private readonly core: Pick<CoreAddonClient, "readRoleSessionRecoveryInternal" | "launchChromeProfileImportHelperInternal">) {}

  async execute(effect: CoreEffectRequest, signal?: AbortSignal): Promise<unknown> {
    const action = effect.action;
    if (action.type !== "roleSessionRecoveryImport") return invalid();
    const bytes = await this.core.readRoleSessionRecoveryInternal(action.roleId, action.attemptId, action.transferId);
    let envelope: Buffer | undefined;
    try {
      const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
        journal: RoleSessionMigrationRecord; rolePaths: RolePathsRecord; envelopeJson: string;
      };
      const journal = decoded.journal;
      if (journal.roleId !== action.roleId || journal.transferId !== action.transferId || journal.phase !== "importing" ||
        journal.targetRevision == null || journal.envelopeSha256 == null || journal.inventorySha256 == null ||
        journal.cookieCount == null || journal.localStorageOriginCount == null || journal.localStorageEntryCount == null ||
        typeof decoded.envelopeJson !== "string") return invalid();
      envelope = Buffer.from(decoded.envelopeJson, "utf8");
      const coordinator = new ChromiumSessionMigrationFreshCoordinator(this.core);
      const receipt = await coordinator.applyAndVerify({
        roleId: action.roleId, transferId: action.transferId, platform: journal.platform,
        expectedJournalRevision: journal.journalRevision, targetRevision: journal.targetRevision,
        sourceRevision: journal.sourceRevision, phase: "importing", rolePaths: decoded.rolePaths,
        envelopeSha256: journal.envelopeSha256, inventorySha256: journal.inventorySha256,
        cookieCount: journal.cookieCount, localStorageOriginCount: journal.localStorageOriginCount,
        localStorageEntryCount: journal.localStorageEntryCount,
        cookiePolicy: action.bestEffortCookies ? "bestEffort" : "exact"
      }, envelope, async () => {
        const current = await this.core.readRoleSessionRecoveryInternal(action.roleId, action.attemptId, action.transferId);
        try { if (!current.equals(bytes)) invalid(); } finally { current.fill(0); }
      }, signal);
      return {
        roleId: action.roleId,
        attemptId: action.attemptId,
        transferId: action.transferId,
        cleanFlushReceiptId:
          journal.localStorageOriginCount > 0 || journal.localStorageEntryCount > 0
            ? receipt.cleanFlushReceiptId
            : `chromium-cookie-flush:${action.transferId}:${journal.targetRevision}`,
        cookieCount: receipt.cookieCount,
        cookieSkippedCount: receipt.cookieSkippedCount
      };
    } finally { bytes.fill(0); envelope?.fill(0); }
  }
}
