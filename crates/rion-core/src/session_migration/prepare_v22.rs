use rusqlite::{Connection, TransactionBehavior, params};
use uuid::Uuid;

use super::{
    RoleSessionMigrationEngine, RoleSessionMigrationPhase, RoleSessionMigrationPlatform,
    RoleSessionMigrationRecord, database_error, domain_error, list, now_timestamp, read_stored,
    sqlite_integer, validate_uuid,
};
use crate::error::CoreResult;

/// Atomically gives every retained role on the stable v22 shell an explicit
/// source-authoritative journal. A matching v22-ready journal is replayed
/// byte-for-byte. Any later, not-yet-launched v23 phase is rearmed with a fresh
/// transfer identity so subsequent v22 writes can never be mistaken for the
/// older Chromium target snapshot. Once a v23 launch fence was armed, downgrade
/// is unsafe and the entire startup preparation fails atomically.
pub(crate) fn prepare_v22_role_journals(
    connection: &mut Connection,
    platform: RoleSessionMigrationPlatform,
) -> CoreResult<Vec<RoleSessionMigrationRecord>> {
    let source_engine = match platform {
        RoleSessionMigrationPlatform::Macos => RoleSessionMigrationEngine::Wkwebview,
        RoleSessionMigrationPlatform::Windows => RoleSessionMigrationEngine::Webview2,
    };
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let role_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM roles ORDER BY ordinal ASC, id ASC")
            .map_err(database_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?
    };
    let timestamp = now_timestamp();
    for role_id in role_ids {
        validate_uuid(&role_id)?;
        if let Some(existing) = read_stored(&transaction, &role_id)? {
            if existing.record.platform != platform
                || existing.record.source_engine != source_engine
                || existing.record.target_engine != RoleSessionMigrationEngine::Chromium
            {
                return Err(domain_error(
                    "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
                    "Existing role session migration journal does not match the stable shell platform.",
                ));
            }
            if existing.record.first_verified_launch_at.is_some() {
                return Err(domain_error(
                    "ROLE_SESSION_MIGRATION_DOWNGRADE_UNSAFE",
                    "This role has admitted Chromium navigation and cannot safely return to the stable System WebView shell.",
                ));
            }
            if existing.record.phase != RoleSessionMigrationPhase::V22Ready {
                let next_source_revision = existing
                    .record
                    .source_revision
                    .checked_add(1)
                    .ok_or_else(|| {
                        domain_error(
                            "ROLE_SESSION_MIGRATION_SOURCE_REVISION_EXHAUSTED",
                            "The stable role-session source revision cannot advance.",
                        )
                    })?;
                let changed = transaction
                    .execute(
                        "UPDATE role_session_migrations SET
                           transfer_id=?2, phase='v22Ready', journal_revision=1,
                           source_revision=?3, target_revision=NULL,
                           envelope_sha256=NULL, inventory_sha256=NULL,
                           cookie_count=NULL, local_storage_origin_count=NULL,
                           local_storage_entry_count=NULL, stable_error_code=NULL,
                           outcome=NULL, started_at=?4, phase_changed_at=?4,
                           updated_at=?4, outcome_at=NULL,
                           first_verified_launch_at=NULL,
                           clean_flush_receipt_id=NULL, reset_receipt_id=NULL,
                           last_transition_id=NULL,
                           last_transition_request_sha256=NULL
                         WHERE role_id=?1 AND transfer_id=?5 AND journal_revision=?6",
                        params![
                            role_id,
                            Uuid::new_v4().to_string(),
                            sqlite_integer(next_source_revision)?,
                            timestamp,
                            existing.record.transfer_id,
                            sqlite_integer(existing.record.journal_revision)?,
                        ],
                    )
                    .map_err(database_error)?;
                if changed != 1 {
                    return Err(domain_error(
                        "ROLE_SESSION_MIGRATION_REVISION_STALE",
                        "The role session migration revision is no longer current.",
                    ));
                }
            }
            continue;
        }
        transaction
            .execute(
                "INSERT INTO role_session_migrations(
                   role_id, transfer_id, phase, journal_revision, platform,
                   source_engine, target_engine, source_revision,
                   started_at, phase_changed_at, updated_at
                 ) VALUES (?1, ?2, 'v22Ready', 1, ?3, ?4, 'chromium', 0, ?5, ?5, ?5)",
                params![
                    role_id,
                    Uuid::new_v4().to_string(),
                    platform.as_str(),
                    source_engine.as_str(),
                    timestamp,
                ],
            )
            .map_err(database_error)?;
    }
    let records = list(&transaction)?
        .into_iter()
        .filter(|record| record.platform == platform)
        .collect::<Vec<_>>();
    transaction.commit().map_err(database_error)?;
    Ok(records)
}
