use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::transition_authority::{FIRST_CHROMIUM_TARGET_REVISION, TransitionAuthority};
use super::{
    RoleSessionMigrationPhase, RoleSessionMigrationPlatform, RoleSessionMigrationRecord,
    RoleSessionMigrationTransitionInput, database_error, domain_error, invalid_input_error,
    migration_not_found_error, read_stored, sqlite_integer, transfer_stale_error,
    transition_in_transaction, validate_transition_syntax,
};
use crate::error::CoreResult;

/// Privileged v23-startup request that admits one exact exported transfer into
/// its first Chromium target revision. Rust creates the transition identity and
/// timestamp so the target shell cannot manufacture a target revision or
/// rewrite the source export evidence.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionMigrationImportBeginInput {
    pub role_id: String,
    pub transfer_id: String,
    pub expected_journal_revision: u64,
}

/// Atomically admits one exact source export into its first Chromium import.
///
/// The transfer ID separates target revisions across re-armed v22 exports. An
/// exported journal is required to have no target revision, so the checked
/// `None -> 1` allocation below is both deterministic and Rust-owned. Replaying
/// the same request after an unknown acknowledgement returns the already
/// committed importing record without advancing it again.
pub(crate) fn begin_role_session_migration_import(
    connection: &mut Connection,
    expected_platform: RoleSessionMigrationPlatform,
    runtime_contract_version: u32,
    input: RoleSessionMigrationImportBeginInput,
) -> CoreResult<RoleSessionMigrationRecord> {
    validate_uuid_and_revision(&input)?;
    let replay_revision = input
        .expected_journal_revision
        .checked_add(1)
        .ok_or_else(invalid_input_error)?;
    sqlite_integer(replay_revision)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    if runtime_contract_version < crate::app::CHROMIUM_RUNTIME_CONTRACT_VERSION {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_IMPORT_ADMISSION_UNAVAILABLE",
            "Role session import admission requires runtime contract v23 or later.",
        ));
    }
    let current =
        read_stored(&transaction, &input.role_id)?.ok_or_else(migration_not_found_error)?;
    if current.record.transfer_id != input.transfer_id {
        return Err(transfer_stale_error());
    }
    if current.record.platform != expected_platform {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
            "The role session migration journal does not match the target shell platform.",
        ));
    }
    if current.record.phase == RoleSessionMigrationPhase::Importing
        && current.record.journal_revision == replay_revision
        && current.record.target_revision == Some(FIRST_CHROMIUM_TARGET_REVISION)
    {
        let replay = current.record;
        transaction.commit().map_err(database_error)?;
        return Ok(replay);
    }
    if current.record.phase != RoleSessionMigrationPhase::Exported {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_PHASE_STALE",
            "The role session migration phase is no longer current.",
        ));
    }
    if current.record.journal_revision != input.expected_journal_revision {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_REVISION_STALE",
            "The role session migration revision is no longer current.",
        ));
    }

    let target_revision = current
        .record
        .target_revision
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(invalid_input_error)?;
    if target_revision != FIRST_CHROMIUM_TARGET_REVISION {
        return Err(invalid_input_error());
    }
    let mut transition = RoleSessionMigrationTransitionInput {
        role_id: current.record.role_id.clone(),
        transfer_id: current.record.transfer_id.clone(),
        transition_id: Uuid::new_v4().to_string(),
        expected_phase: RoleSessionMigrationPhase::Exported,
        expected_journal_revision: current.record.journal_revision,
        next_phase: RoleSessionMigrationPhase::Importing,
        target_revision: Some(target_revision),
        envelope_sha256: current.record.envelope_sha256.clone(),
        inventory_sha256: current.record.inventory_sha256.clone(),
        cookie_count: current.record.cookie_count,
        local_storage_origin_count: current.record.local_storage_origin_count,
        local_storage_entry_count: current.record.local_storage_entry_count,
        stable_error_code: None,
        outcome: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    validate_transition_syntax(&mut transition)?;
    let committed = transition_in_transaction(
        &transaction,
        transition,
        TransitionAuthority::ImportAdmission { expected_platform },
    )?;
    transaction.commit().map_err(database_error)?;
    Ok(committed)
}

fn validate_uuid_and_revision(input: &RoleSessionMigrationImportBeginInput) -> CoreResult<()> {
    super::validate_uuid(&input.role_id)?;
    super::validate_uuid(&input.transfer_id)?;
    if input.expected_journal_revision == 0 {
        return Err(invalid_input_error());
    }
    sqlite_integer(input.expected_journal_revision)?;
    Ok(())
}
