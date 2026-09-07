use super::error;
use crate::{RoleSessionMigrationPhase, RoleSessionMigrationRecord, error::CoreResult};
use rusqlite::{Connection, TransactionBehavior, params};

pub(crate) struct Admission {
    pub previous: Option<RoleSessionMigrationRecord>,
    pub exported: RoleSessionMigrationRecord,
    pub isolated: RoleSessionMigrationRecord,
}

/// Separate source-recovery authority: never callable through a renderer
/// transition. Atomic compare-and-swap preserves other roles and rejects a
/// previously launched target, including explicit-reset sessions.
pub(crate) fn admit(
    connection: &mut Connection,
    admission: Admission,
) -> CoreResult<RoleSessionMigrationRecord> {
    let Admission {
        previous,
        exported,
        isolated,
    } = admission;
    if isolated.phase != RoleSessionMigrationPhase::V23Ready
        || isolated.outcome != Some(crate::RoleSessionMigrationOutcome::Verified)
        || isolated.clean_flush_receipt_id.is_none()
        || isolated.role_id != exported.role_id
        || isolated.transfer_id != exported.transfer_id
        || isolated.platform != exported.platform
        || isolated.source_engine != exported.source_engine
        || isolated.target_engine != exported.target_engine
        || isolated.source_revision != exported.source_revision
        || isolated.cookie_count != exported.cookie_count
        || isolated.local_storage_origin_count != exported.local_storage_origin_count
        || isolated.local_storage_entry_count != exported.local_storage_entry_count
        || isolated.inventory_sha256 != exported.inventory_sha256
        || isolated.envelope_sha256 != exported.envelope_sha256
        || exported.phase != RoleSessionMigrationPhase::Exported
        || exported.target_revision.is_some()
        || exported.first_verified_launch_at.is_some()
    {
        return Err(error("RECOVERY_ISOLATED_EVIDENCE_INVALID"));
    }
    crate::session_migration::validate_recovery_clean_receipt(&isolated)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| error("RECOVERY_DATABASE_FAILED"))?;
    let current = crate::session_migration::read(&transaction, &exported.role_id)?;
    if current != previous {
        return Err(error("RECOVERY_JOURNAL_STALE"));
    }
    if current.as_ref().is_some_and(|record| {
        record.phase != RoleSessionMigrationPhase::Failed
            || record.first_verified_launch_at.is_some()
            || record.transfer_id == exported.transfer_id
    }) {
        return Err(error("RECOVERY_JOURNAL_NOT_ELIGIBLE"));
    }
    transaction.execute("INSERT INTO role_session_migrations(role_id,transfer_id,phase,journal_revision,platform,source_engine,target_engine,source_revision,envelope_sha256,inventory_sha256,cookie_count,local_storage_origin_count,local_storage_entry_count,started_at,phase_changed_at,updated_at)
        VALUES(?1,?2,'exported',2,?3,?4,'chromium',?5,?6,?7,?8,?9,?10,?11,?12,?12)
        ON CONFLICT(role_id) DO UPDATE SET transfer_id=excluded.transfer_id,phase='exported',journal_revision=2,platform=excluded.platform,source_engine=excluded.source_engine,target_engine='chromium',source_revision=excluded.source_revision,target_revision=NULL,envelope_sha256=excluded.envelope_sha256,inventory_sha256=excluded.inventory_sha256,cookie_count=excluded.cookie_count,local_storage_origin_count=excluded.local_storage_origin_count,local_storage_entry_count=excluded.local_storage_entry_count,started_at=excluded.started_at,phase_changed_at=excluded.phase_changed_at,updated_at=excluded.updated_at,stable_error_code=NULL,outcome=NULL,outcome_at=NULL,first_verified_launch_at=NULL,clean_flush_receipt_id=NULL,reset_receipt_id=NULL,last_transition_id=NULL,last_transition_request_sha256=NULL",
        params![exported.role_id,exported.transfer_id,match exported.platform {crate::RoleSessionMigrationPlatform::Macos=>"macos",crate::RoleSessionMigrationPlatform::Windows=>"windows"},match exported.source_engine {crate::RoleSessionMigrationEngine::Wkwebview=>"wkwebview",crate::RoleSessionMigrationEngine::Webview2=>"webview2", crate::RoleSessionMigrationEngine::Chromium=>return Err(error("RECOVERY_SOURCE_ENGINE_INVALID"))},i64::try_from(exported.source_revision).map_err(|_|error("RECOVERY_REVISION_EXHAUSTED"))?,exported.envelope_sha256,exported.inventory_sha256,exported.cookie_count.map(i64::try_from).transpose().map_err(|_|error("RECOVERY_COUNT_INVALID"))?,exported.local_storage_origin_count.map(i64::try_from).transpose().map_err(|_|error("RECOVERY_COUNT_INVALID"))?,exported.local_storage_entry_count.map(i64::try_from).transpose().map_err(|_|error("RECOVERY_COUNT_INVALID"))?,exported.started_at,exported.updated_at]).map_err(|_|error("RECOVERY_EXPORT_COMMIT_FAILED"))?;
    let record = crate::session_migration::read(&transaction, &exported.role_id)?
        .ok_or_else(|| error("RECOVERY_EXPORT_COMMIT_FAILED"))?;
    transaction
        .commit()
        .map_err(|_| error("RECOVERY_EXPORT_COMMIT_FAILED"))?;
    Ok(record)
}
