use serde::{Deserialize, Serialize};

use super::{
    RoleSessionMigrationOutcome, RoleSessionMigrationPhase, RoleSessionMigrationRecord,
    RoleSessionMigrationTransitionInput, domain_error, invalid_transition_error,
};
use crate::error::CoreResult;

/// Narrow native-target-shell transition. Source inventory evidence,
/// target revision, reset evidence, and the first-launch fence are deliberately
/// absent: Rust copies those fields from its durable journal.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSessionMigrationTargetTransitionInput {
    pub role_id: String,
    pub transfer_id: String,
    pub transition_id: String,
    pub expected_phase: RoleSessionMigrationPhase,
    pub expected_journal_revision: u64,
    pub next_phase: RoleSessionMigrationPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RoleSessionMigrationOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_flush_receipt_id: Option<String>,
    pub occurred_at: String,
}

pub(crate) fn expand_target_transition(
    current: &RoleSessionMigrationRecord,
    input: RoleSessionMigrationTargetTransitionInput,
) -> CoreResult<RoleSessionMigrationTransitionInput> {
    if current.role_id != input.role_id || current.transfer_id != input.transfer_id {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_TARGET_IDENTITY_MISMATCH",
            "The Chromium target transition does not match its durable migration identity.",
        ));
    }

    let clean_flush_receipt_id = match (input.expected_phase, input.next_phase) {
        (
            RoleSessionMigrationPhase::Importing | RoleSessionMigrationPhase::Indeterminate,
            RoleSessionMigrationPhase::Verifying,
        ) if input.stable_error_code.is_none() && input.outcome.is_none() => {
            let receipt = input
                .clean_flush_receipt_id
                .as_deref()
                .ok_or_else(invalid_transition_error)?;
            if current
                .clean_flush_receipt_id
                .as_deref()
                .is_some_and(|committed| committed != receipt)
            {
                return Err(invalid_transition_error());
            }
            validate_migration_clean_flush_receipt(current, receipt)?;
            Some(receipt.to_owned())
        }
        (RoleSessionMigrationPhase::Verifying, RoleSessionMigrationPhase::V23Ready)
            if input.stable_error_code.is_none()
                && input.outcome == Some(RoleSessionMigrationOutcome::Verified) =>
        {
            let receipt = input
                .clean_flush_receipt_id
                .as_deref()
                .ok_or_else(invalid_transition_error)?;
            if current.clean_flush_receipt_id.as_deref() != Some(receipt) {
                return Err(invalid_transition_error());
            }
            validate_migration_clean_flush_receipt(current, receipt)?;
            Some(receipt.to_owned())
        }
        (
            RoleSessionMigrationPhase::Importing | RoleSessionMigrationPhase::Verifying,
            RoleSessionMigrationPhase::Failed,
        ) if input.stable_error_code.is_some()
            && input.outcome == Some(RoleSessionMigrationOutcome::Failed)
            && input.clean_flush_receipt_id == current.clean_flush_receipt_id =>
        {
            current.clean_flush_receipt_id.clone()
        }
        (
            RoleSessionMigrationPhase::Importing | RoleSessionMigrationPhase::Verifying,
            RoleSessionMigrationPhase::Indeterminate,
        ) if input.stable_error_code.is_some()
            && input.outcome == Some(RoleSessionMigrationOutcome::Indeterminate)
            && input.clean_flush_receipt_id == current.clean_flush_receipt_id =>
        {
            current.clean_flush_receipt_id.clone()
        }
        _ => return Err(invalid_transition_error()),
    };

    Ok(RoleSessionMigrationTransitionInput {
        role_id: input.role_id,
        transfer_id: input.transfer_id,
        transition_id: input.transition_id,
        expected_phase: input.expected_phase,
        expected_journal_revision: input.expected_journal_revision,
        next_phase: input.next_phase,
        target_revision: current.target_revision,
        envelope_sha256: current.envelope_sha256.clone(),
        inventory_sha256: current.inventory_sha256.clone(),
        cookie_count: current.cookie_count,
        local_storage_origin_count: current.local_storage_origin_count,
        local_storage_entry_count: current.local_storage_entry_count,
        stable_error_code: input.stable_error_code,
        outcome: input.outcome,
        clean_flush_receipt_id,
        reset_receipt_id: current.reset_receipt_id.clone(),
        mark_first_verified_launch: false,
        occurred_at: input.occurred_at,
    })
}

pub(super) fn validate_record_clean_flush_receipt(
    record: &RoleSessionMigrationRecord,
) -> CoreResult<()> {
    let Some(receipt) = record.clean_flush_receipt_id.as_deref() else {
        return Ok(());
    };
    if record.outcome == Some(RoleSessionMigrationOutcome::ExplicitReset) {
        return Ok(());
    }
    if is_atomic_chrome_profile_import_record(record, receipt) {
        return Ok(());
    }
    validate_migration_clean_flush_receipt(record, receipt)
}

fn validate_migration_clean_flush_receipt(
    record: &RoleSessionMigrationRecord,
    receipt: &str,
) -> CoreResult<()> {
    let target_revision = record
        .target_revision
        .ok_or_else(invalid_transition_error)?;
    let has_local_storage = record
        .local_storage_origin_count
        .is_some_and(|count| count > 0)
        || record
            .local_storage_entry_count
            .is_some_and(|count| count > 0);
    // The native target owns the two clean-exit observations used to derive a
    // LocalStorage receipt. Rust validates its closed namespace and canonical
    // digest, then pins that exact value on the first verifying CAS; every
    // subsequent transition or replay must reuse it byte-for-byte.
    let valid = if has_local_storage {
        receipt
            .strip_prefix("chromium-session-fresh:")
            .is_some_and(canonical_sha256)
    } else {
        receipt
            == format!(
                "chromium-cookie-flush:{}:{target_revision}",
                record.transfer_id
            )
    };
    if !valid {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_FLUSH_RECEIPT_INVALID",
            "The Chromium migration receipt does not use the canonical form required by its inventory and target revision.",
        ));
    }
    Ok(())
}

fn is_atomic_chrome_profile_import_record(
    record: &RoleSessionMigrationRecord,
    receipt: &str,
) -> bool {
    record.phase == RoleSessionMigrationPhase::V23Ready
        && matches!(record.journal_revision, 1 | 2)
        && record.source_revision == 0
        && record.target_revision == Some(1)
        && record.outcome == Some(RoleSessionMigrationOutcome::Verified)
        && receipt
            .strip_prefix("chrome-profile-import-fresh:")
            .is_some_and(canonical_uuid)
}

fn canonical_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.hyphenated().to_string() == value)
}
