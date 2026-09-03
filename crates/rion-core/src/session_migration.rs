//! Durable metadata journal for the System WebView to Chromium role-session migration.
//!
//! This journal stores only identities, revisions, digests, counts, stable outcomes, and receipts.
//! Encrypted cookie and storage values never enter SQLite or validation errors in this module.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};

mod begin_import;
mod prepare_v22;
mod target_transition;
mod transition_authority;
pub use begin_import::RoleSessionMigrationImportBeginInput;
pub(crate) use begin_import::begin_role_session_migration_import;
pub(crate) use prepare_v22::prepare_v22_role_journals;
pub use target_transition::RoleSessionMigrationTargetTransitionInput;
pub(crate) use target_transition::expand_target_transition;
use target_transition::validate_record_clean_flush_receipt;
pub(crate) use transition_authority::TransitionAuthority;
use transition_authority::{
    AuthoritativeMigrationFields, authoritative_transition_fields, authorize_transition,
    validate_transition_platform,
};

pub(crate) const ROLE_SESSION_MIGRATION_SCHEMA_SQL: &str = r#"
CREATE TABLE role_session_migrations (
  role_id TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
  transfer_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK(phase IN (
    'v22Ready', 'exported', 'importing', 'verifying',
    'v23Ready', 'failed', 'indeterminate'
  )),
  journal_revision INTEGER NOT NULL CHECK(journal_revision > 0),
  platform TEXT NOT NULL CHECK(platform IN ('macos', 'windows')),
  source_engine TEXT NOT NULL CHECK(source_engine IN ('wkwebview', 'webview2')),
  target_engine TEXT NOT NULL CHECK(target_engine = 'chromium'),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  target_revision INTEGER CHECK(target_revision IS NULL OR target_revision >= 0),
  envelope_sha256 TEXT CHECK(
    envelope_sha256 IS NULL OR
    (length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  inventory_sha256 TEXT CHECK(
    inventory_sha256 IS NULL OR
    (length(inventory_sha256) = 64 AND inventory_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  cookie_count INTEGER CHECK(cookie_count IS NULL OR cookie_count >= 0),
  local_storage_origin_count INTEGER CHECK(
    local_storage_origin_count IS NULL OR local_storage_origin_count >= 0
  ),
  local_storage_entry_count INTEGER CHECK(
    local_storage_entry_count IS NULL OR local_storage_entry_count >= 0
  ),
  stable_error_code TEXT,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN (
    'verified', 'explicitReset', 'failed', 'indeterminate'
  )),
  started_at TEXT NOT NULL CHECK(length(started_at) > 0),
  phase_changed_at TEXT NOT NULL CHECK(length(phase_changed_at) > 0),
  updated_at TEXT NOT NULL CHECK(length(updated_at) > 0),
  outcome_at TEXT,
  first_verified_launch_at TEXT,
  clean_flush_receipt_id TEXT,
  reset_receipt_id TEXT,
  last_transition_id TEXT UNIQUE,
  last_transition_request_sha256 TEXT CHECK(
    last_transition_request_sha256 IS NULL OR
    (length(last_transition_request_sha256) = 64 AND
     last_transition_request_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK(
    (platform = 'macos' AND source_engine = 'wkwebview') OR
    (platform = 'windows' AND source_engine = 'webview2')
  ),
  CHECK(
    (cookie_count IS NULL AND local_storage_origin_count IS NULL AND
     local_storage_entry_count IS NULL) OR
    (cookie_count IS NOT NULL AND local_storage_origin_count IS NOT NULL AND
     local_storage_entry_count IS NOT NULL)
  ),
  CHECK(
    (last_transition_id IS NULL AND last_transition_request_sha256 IS NULL) OR
    (last_transition_id IS NOT NULL AND last_transition_request_sha256 IS NOT NULL)
  )
);
CREATE INDEX role_session_migrations_phase_idx
  ON role_session_migrations(phase, started_at, role_id);
"#;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum RoleSessionMigrationPhase {
    #[serde(rename = "v22Ready")]
    V22Ready,
    #[serde(rename = "exported")]
    Exported,
    #[serde(rename = "importing")]
    Importing,
    #[serde(rename = "verifying")]
    Verifying,
    #[serde(rename = "v23Ready")]
    V23Ready,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "indeterminate")]
    Indeterminate,
}

impl RoleSessionMigrationPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::V22Ready => "v22Ready",
            Self::Exported => "exported",
            Self::Importing => "importing",
            Self::Verifying => "verifying",
            Self::V23Ready => "v23Ready",
            Self::Failed => "failed",
            Self::Indeterminate => "indeterminate",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "v22Ready" => Some(Self::V22Ready),
            "exported" => Some(Self::Exported),
            "importing" => Some(Self::Importing),
            "verifying" => Some(Self::Verifying),
            "v23Ready" => Some(Self::V23Ready),
            "failed" => Some(Self::Failed),
            "indeterminate" => Some(Self::Indeterminate),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum RoleSessionMigrationOutcome {
    Verified,
    ExplicitReset,
    Failed,
    Indeterminate,
}

impl RoleSessionMigrationOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::ExplicitReset => "explicitReset",
            Self::Failed => "failed",
            Self::Indeterminate => "indeterminate",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "verified" => Some(Self::Verified),
            "explicitReset" => Some(Self::ExplicitReset),
            "failed" => Some(Self::Failed),
            "indeterminate" => Some(Self::Indeterminate),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum RoleSessionMigrationPlatform {
    Macos,
    Windows,
}

impl RoleSessionMigrationPlatform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "macos" => Some(Self::Macos),
            "windows" => Some(Self::Windows),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum RoleSessionMigrationEngine {
    Wkwebview,
    Webview2,
    Chromium,
}

impl RoleSessionMigrationEngine {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wkwebview => "wkwebview",
            Self::Webview2 => "webview2",
            Self::Chromium => "chromium",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "wkwebview" => Some(Self::Wkwebview),
            "webview2" => Some(Self::Webview2),
            "chromium" => Some(Self::Chromium),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleSessionMigrationStartInput {
    pub role_id: String,
    pub transfer_id: String,
    pub platform: RoleSessionMigrationPlatform,
    pub source_engine: RoleSessionMigrationEngine,
    pub target_engine: RoleSessionMigrationEngine,
    #[ts(type = "number")]
    pub source_revision: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleSessionMigrationTransitionInput {
    pub role_id: String,
    pub transfer_id: String,
    pub transition_id: String,
    pub expected_phase: RoleSessionMigrationPhase,
    #[ts(type = "number")]
    pub expected_journal_revision: u64,
    pub next_phase: RoleSessionMigrationPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub target_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub envelope_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inventory_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cookie_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub local_storage_origin_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub local_storage_entry_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stable_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<RoleSessionMigrationOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clean_flush_receipt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reset_receipt_id: Option<String>,
    #[serde(default)]
    pub mark_first_verified_launch: bool,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleSessionMigrationRecord {
    pub role_id: String,
    pub transfer_id: String,
    pub phase: RoleSessionMigrationPhase,
    #[ts(type = "number")]
    pub journal_revision: u64,
    pub platform: RoleSessionMigrationPlatform,
    pub source_engine: RoleSessionMigrationEngine,
    pub target_engine: RoleSessionMigrationEngine,
    #[ts(type = "number")]
    pub source_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub target_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub envelope_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inventory_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cookie_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub local_storage_origin_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub local_storage_entry_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stable_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<RoleSessionMigrationOutcome>,
    pub started_at: String,
    pub phase_changed_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_verified_launch_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clean_flush_receipt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reset_receipt_id: Option<String>,
}

/// Core-private evidence for a role whose empty Chromium store and durable
/// v23-ready journal are created as one role-creation operation. This never
/// crosses the renderer/shared contract boundary.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct V23RoleInitializationEvidence {
    pub role_id: String,
    pub transfer_id: String,
    pub transition_id: String,
    pub platform: RoleSessionMigrationPlatform,
    pub source_engine: RoleSessionMigrationEngine,
    pub target_engine: RoleSessionMigrationEngine,
    pub source_revision: u64,
    pub target_revision: u64,
    pub clean_flush_receipt_id: String,
    pub reset_receipt_id: String,
    pub occurred_at: String,
}

/// Core-private evidence that one user-authorized role-data clear produced an
/// empty Chromium store and may replace any prior migration outcome. The
/// expected journal identity is optional only when no journal existed before
/// the clear began; the database commit rechecks that absence atomically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct V23RoleExplicitResetEvidence {
    pub role_id: String,
    pub transfer_id: String,
    pub transition_id: String,
    pub platform: RoleSessionMigrationPlatform,
    pub source_engine: RoleSessionMigrationEngine,
    pub expected_journal_revision: Option<u64>,
    pub target_revision: u64,
    pub clean_flush_receipt_id: String,
    pub reset_receipt_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct V23ChromeProfileImportReadyEvidence {
    pub role_id: String,
    pub transaction_id: String,
    pub transition_id: String,
    pub platform: RoleSessionMigrationPlatform,
    pub staging_sha256: String,
    pub inventory_sha256: String,
    pub cookie_count: u32,
    pub local_storage_count: u32,
    pub occurred_at: String,
}

#[derive(Debug)]
struct StoredRoleSessionMigration {
    record: RoleSessionMigrationRecord,
    last_transition_id: Option<String>,
    last_transition_request_sha256: Option<String>,
}

pub(crate) fn read(
    connection: &Connection,
    role_id: &str,
) -> CoreResult<Option<RoleSessionMigrationRecord>> {
    validate_uuid(role_id)?;
    read_stored(connection, role_id).map(|stored| stored.map(|stored| stored.record))
}

pub(crate) fn list(connection: &Connection) -> CoreResult<Vec<RoleSessionMigrationRecord>> {
    let mut statement = connection
        .prepare(&format!(
            "{} ORDER BY started_at, role_id",
            ROLE_SESSION_MIGRATION_SELECT
        ))
        .map_err(database_error)?;
    let rows = statement.query_map([], read_raw).map_err(database_error)?;
    rows.map(|row| {
        let raw = row.map_err(database_error)?;
        decode_stored(raw).map(|stored| stored.record)
    })
    .collect()
}

pub(crate) fn start(
    connection: &mut Connection,
    input: RoleSessionMigrationStartInput,
) -> CoreResult<RoleSessionMigrationRecord> {
    validate_start_input(&input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    if let Some(existing) = read_stored(&transaction, &input.role_id)? {
        validate_start_replay(&existing.record, &input)?;
        transaction.commit().map_err(database_error)?;
        return Ok(existing.record);
    }
    let role_exists = transaction
        .query_row("SELECT 1 FROM roles WHERE id=?1", [&input.role_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(database_error)?
        .is_some();
    if !role_exists {
        return Err(domain_error(
            "ROLE_NOT_FOUND",
            "Role not found for session migration.",
        ));
    }
    let transfer_exists = transaction
        .query_row(
            "SELECT 1 FROM role_session_migrations WHERE transfer_id=?1",
            [&input.transfer_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(database_error)?
        .is_some();
    if transfer_exists {
        return Err(transfer_stale_error());
    }
    let timestamp = now_timestamp();
    transaction
        .execute(
            "INSERT INTO role_session_migrations(
               role_id, transfer_id, phase, journal_revision, platform,
               source_engine, target_engine, source_revision,
               started_at, phase_changed_at, updated_at
             ) VALUES (?1, ?2, 'v22Ready', 1, ?3, ?4, ?5, ?6, ?7, ?7, ?7)",
            params![
                input.role_id,
                input.transfer_id,
                input.platform.as_str(),
                input.source_engine.as_str(),
                input.target_engine.as_str(),
                sqlite_integer(input.source_revision)?,
                timestamp,
            ],
        )
        .map_err(database_error)?;
    let record = read_stored(&transaction, &input.role_id)?
        .ok_or_else(database_corruption_error)?
        .record;
    transaction.commit().map_err(database_error)?;
    Ok(record)
}

pub(crate) fn insert_v23_role_initialization(
    transaction: &Transaction<'_>,
    evidence: &V23RoleInitializationEvidence,
) -> CoreResult<RoleSessionMigrationRecord> {
    validate_v23_role_initialization(evidence)?;
    let request_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(evidence).map_err(|_| invalid_input_error())?)
    );
    let record = RoleSessionMigrationRecord {
        role_id: evidence.role_id.clone(),
        transfer_id: evidence.transfer_id.clone(),
        phase: RoleSessionMigrationPhase::V23Ready,
        journal_revision: 1,
        platform: evidence.platform,
        source_engine: evidence.source_engine,
        target_engine: evidence.target_engine,
        source_revision: evidence.source_revision,
        target_revision: Some(evidence.target_revision),
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: None,
        outcome: Some(RoleSessionMigrationOutcome::ExplicitReset),
        started_at: evidence.occurred_at.clone(),
        phase_changed_at: evidence.occurred_at.clone(),
        updated_at: evidence.occurred_at.clone(),
        outcome_at: Some(evidence.occurred_at.clone()),
        first_verified_launch_at: None,
        clean_flush_receipt_id: Some(evidence.clean_flush_receipt_id.clone()),
        reset_receipt_id: Some(evidence.reset_receipt_id.clone()),
    };
    validate_record(&record)?;
    transaction
        .execute(
            "INSERT INTO role_session_migrations(
               role_id, transfer_id, phase, journal_revision, platform,
               source_engine, target_engine, source_revision, target_revision,
               outcome, started_at, phase_changed_at, updated_at, outcome_at,
               clean_flush_receipt_id, reset_receipt_id, last_transition_id,
               last_transition_request_sha256
             ) VALUES (
               ?1, ?2, 'v23Ready', 1, ?3, ?4, ?5, ?6, ?7, 'explicitReset',
               ?8, ?8, ?8, ?8, ?9, ?10, ?11, ?12
             )",
            params![
                evidence.role_id,
                evidence.transfer_id,
                evidence.platform.as_str(),
                evidence.source_engine.as_str(),
                evidence.target_engine.as_str(),
                sqlite_integer(evidence.source_revision)?,
                sqlite_integer(evidence.target_revision)?,
                evidence.occurred_at,
                evidence.clean_flush_receipt_id,
                evidence.reset_receipt_id,
                evidence.transition_id,
                request_sha256,
            ],
        )
        .map_err(database_error)?;
    read_stored(transaction, &evidence.role_id)?
        .map(|stored| stored.record)
        .ok_or_else(database_corruption_error)
}

pub(crate) fn insert_v23_chrome_profile_import_ready(
    transaction: &Transaction<'_>,
    evidence: &V23ChromeProfileImportReadyEvidence,
) -> CoreResult<RoleSessionMigrationRecord> {
    validate_uuid(&evidence.role_id)?;
    validate_uuid(&evidence.transaction_id)?;
    validate_uuid(&evidence.transition_id)?;
    validate_optional_digest(Some(&evidence.staging_sha256))?;
    validate_optional_digest(Some(&evidence.inventory_sha256))?;
    validate_timestamp(&evidence.occurred_at)?;
    let source_engine = match evidence.platform {
        RoleSessionMigrationPlatform::Macos => RoleSessionMigrationEngine::Wkwebview,
        RoleSessionMigrationPlatform::Windows => RoleSessionMigrationEngine::Webview2,
    };
    let clean_flush_receipt_id = format!("chrome-profile-import-fresh:{}", evidence.transition_id);
    let local_storage_origin_count = u64::from(evidence.local_storage_count > 0);
    let record = RoleSessionMigrationRecord {
        role_id: evidence.role_id.clone(),
        transfer_id: evidence.transaction_id.clone(),
        phase: RoleSessionMigrationPhase::V23Ready,
        journal_revision: 1,
        platform: evidence.platform,
        source_engine,
        target_engine: RoleSessionMigrationEngine::Chromium,
        source_revision: 0,
        target_revision: Some(1),
        envelope_sha256: Some(evidence.staging_sha256.clone()),
        inventory_sha256: Some(evidence.inventory_sha256.clone()),
        cookie_count: Some(u64::from(evidence.cookie_count)),
        local_storage_origin_count: Some(local_storage_origin_count),
        local_storage_entry_count: Some(u64::from(evidence.local_storage_count)),
        stable_error_code: None,
        outcome: Some(RoleSessionMigrationOutcome::Verified),
        started_at: evidence.occurred_at.clone(),
        phase_changed_at: evidence.occurred_at.clone(),
        updated_at: evidence.occurred_at.clone(),
        outcome_at: Some(evidence.occurred_at.clone()),
        first_verified_launch_at: None,
        clean_flush_receipt_id: Some(clean_flush_receipt_id.clone()),
        reset_receipt_id: None,
    };
    validate_record(&record)?;
    let request_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(evidence).map_err(|_| invalid_input_error())?)
    );
    transaction
        .execute(
            "INSERT INTO role_session_migrations(
               role_id, transfer_id, phase, journal_revision, platform,
               source_engine, target_engine, source_revision, target_revision,
               envelope_sha256, inventory_sha256, cookie_count,
               local_storage_origin_count, local_storage_entry_count,
               outcome, started_at, phase_changed_at, updated_at, outcome_at,
               clean_flush_receipt_id, last_transition_id,
               last_transition_request_sha256
             ) VALUES (
               ?1, ?2, 'v23Ready', 1, ?3, ?4, 'chromium', 0, 1,
               ?5, ?6, ?7, ?8, ?9, 'verified', ?10, ?10, ?10, ?10,
               ?11, ?12, ?13
             )",
            params![
                evidence.role_id,
                evidence.transaction_id,
                evidence.platform.as_str(),
                source_engine.as_str(),
                evidence.staging_sha256,
                evidence.inventory_sha256,
                sqlite_integer(u64::from(evidence.cookie_count))?,
                sqlite_integer(local_storage_origin_count)?,
                sqlite_integer(u64::from(evidence.local_storage_count))?,
                evidence.occurred_at,
                clean_flush_receipt_id,
                evidence.transition_id,
                request_sha256,
            ],
        )
        .map_err(database_error)?;
    read_stored(transaction, &evidence.role_id)?
        .map(|stored| stored.record)
        .ok_or_else(database_corruption_error)
}

pub(crate) fn new_v23_explicit_reset_evidence(
    role_id: String,
    platform: rion_platform::Platform,
    current: Option<&RoleSessionMigrationRecord>,
    clean_flush_receipt_id: String,
    reset_receipt_id: String,
) -> CoreResult<V23RoleExplicitResetEvidence> {
    validate_uuid(&role_id)?;
    let (platform, source_engine) = match platform {
        rion_platform::Platform::Macos => (
            RoleSessionMigrationPlatform::Macos,
            RoleSessionMigrationEngine::Wkwebview,
        ),
        rion_platform::Platform::Windows => (
            RoleSessionMigrationPlatform::Windows,
            RoleSessionMigrationEngine::Webview2,
        ),
    };
    if current.is_some_and(|record| {
        record.role_id != role_id
            || record.platform != platform
            || record.source_engine != source_engine
            || record.target_engine != RoleSessionMigrationEngine::Chromium
    }) {
        return Err(invalid_input_error());
    }
    let target_revision = current
        .and_then(|record| record.target_revision)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(invalid_input_error)?;
    let evidence = V23RoleExplicitResetEvidence {
        role_id,
        transfer_id: current.map_or_else(
            || Uuid::new_v4().to_string(),
            |record| record.transfer_id.clone(),
        ),
        transition_id: Uuid::new_v4().to_string(),
        platform,
        source_engine,
        expected_journal_revision: current.map(|record| record.journal_revision),
        target_revision,
        clean_flush_receipt_id,
        reset_receipt_id,
        occurred_at: now_timestamp(),
    };
    validate_v23_explicit_reset(&evidence)?;
    Ok(evidence)
}

pub(crate) fn commit_v23_explicit_reset(
    transaction: &Transaction<'_>,
    evidence: &V23RoleExplicitResetEvidence,
) -> CoreResult<RoleSessionMigrationRecord> {
    validate_v23_explicit_reset(evidence)?;
    let current = read_stored(transaction, &evidence.role_id)?;
    if current.is_none()
        && evidence.expected_journal_revision.is_none()
        && evidence.target_revision != 1
    {
        return Err(invalid_transition_error());
    }
    match (current.as_ref(), evidence.expected_journal_revision) {
        (None, None) => {
            let role_exists = transaction
                .query_row(
                    "SELECT 1 FROM roles WHERE id=?1",
                    [&evidence.role_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(database_error)?
                .is_some();
            if !role_exists {
                return Err(domain_error(
                    "ROLE_NOT_FOUND",
                    "Role not found for session migration.",
                ));
            }
            let transfer_exists = transaction
                .query_row(
                    "SELECT 1 FROM role_session_migrations WHERE transfer_id=?1",
                    [&evidence.transfer_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(database_error)?
                .is_some();
            if transfer_exists {
                return Err(transfer_stale_error());
            }
            transaction
                .execute(
                    "INSERT INTO role_session_migrations(
                       role_id, transfer_id, phase, journal_revision, platform,
                       source_engine, target_engine, source_revision, target_revision,
                       outcome, started_at, phase_changed_at, updated_at, outcome_at,
                       clean_flush_receipt_id, reset_receipt_id, last_transition_id,
                       last_transition_request_sha256
                     ) VALUES (
                       ?1, ?2, 'v23Ready', 1, ?3, ?4, 'chromium', 0, ?5,
                       'explicitReset', ?6, ?6, ?6, ?6, ?7, ?8, ?9, ?10
                     )",
                    params![
                        evidence.role_id,
                        evidence.transfer_id,
                        evidence.platform.as_str(),
                        evidence.source_engine.as_str(),
                        sqlite_integer(evidence.target_revision)?,
                        evidence.occurred_at,
                        evidence.clean_flush_receipt_id,
                        evidence.reset_receipt_id,
                        evidence.transition_id,
                        explicit_reset_request_sha256(evidence)?,
                    ],
                )
                .map_err(database_error)?;
        }
        (Some(current), Some(expected_revision))
            if current.record.transfer_id == evidence.transfer_id
                && current.record.journal_revision == expected_revision
                && current.record.platform == evidence.platform
                && current.record.source_engine == evidence.source_engine
                && current.record.target_engine == RoleSessionMigrationEngine::Chromium
                && current.record.target_revision.unwrap_or(0).checked_add(1)
                    == Some(evidence.target_revision) =>
        {
            let next_revision = expected_revision
                .checked_add(1)
                .ok_or_else(invalid_input_error)?;
            let changed = transaction
                .execute(
                    "UPDATE role_session_migrations SET
                       phase='v23Ready', journal_revision=?4, target_revision=?5,
                       envelope_sha256=NULL, inventory_sha256=NULL, cookie_count=NULL,
                       local_storage_origin_count=NULL, local_storage_entry_count=NULL,
                       stable_error_code=NULL, outcome='explicitReset',
                       phase_changed_at=?6, updated_at=?6, outcome_at=?6,
                       first_verified_launch_at=NULL, clean_flush_receipt_id=?7,
                       reset_receipt_id=?8, last_transition_id=?9,
                       last_transition_request_sha256=?10
                     WHERE role_id=?1 AND transfer_id=?2 AND journal_revision=?3",
                    params![
                        evidence.role_id,
                        evidence.transfer_id,
                        sqlite_integer(expected_revision)?,
                        sqlite_integer(next_revision)?,
                        sqlite_integer(evidence.target_revision)?,
                        evidence.occurred_at,
                        evidence.clean_flush_receipt_id,
                        evidence.reset_receipt_id,
                        evidence.transition_id,
                        explicit_reset_request_sha256(evidence)?,
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
        _ => {
            return Err(domain_error(
                "ROLE_SESSION_MIGRATION_REVISION_STALE",
                "The role session migration revision is no longer current.",
            ));
        }
    }
    let committed = read_stored(transaction, &evidence.role_id)?
        .ok_or_else(database_corruption_error)?
        .record;
    validate_record(&committed)?;
    Ok(committed)
}

pub(crate) fn transition(
    connection: &mut Connection,
    authority: TransitionAuthority,
    mut input: RoleSessionMigrationTransitionInput,
) -> CoreResult<RoleSessionMigrationRecord> {
    validate_transition_syntax(&mut input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let committed = transition_in_transaction(&transaction, input, authority)?;
    transaction.commit().map_err(database_error)?;
    Ok(committed)
}

fn transition_in_transaction(
    transaction: &Transaction<'_>,
    input: RoleSessionMigrationTransitionInput,
    authority: TransitionAuthority,
) -> CoreResult<RoleSessionMigrationRecord> {
    let request_sha256 = transition_request_sha256(&input)?;
    let current =
        read_stored(transaction, &input.role_id)?.ok_or_else(migration_not_found_error)?;
    if current.record.transfer_id != input.transfer_id {
        return Err(transfer_stale_error());
    }
    validate_transition_platform(current.record.platform, authority)?;
    if current.last_transition_id.as_deref() == Some(input.transition_id.as_str()) {
        authorize_transition(input.expected_phase, input.next_phase, authority)?;
        if current.last_transition_request_sha256.as_deref() == Some(request_sha256.as_str()) {
            return Ok(current.record);
        }
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_REPLAY_CONFLICT",
            "The role session migration transition replay does not match the committed request.",
        ));
    }
    if current.record.phase != input.expected_phase {
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
    authorize_transition(current.record.phase, input.next_phase, authority)?;
    let fields = authoritative_transition_fields(&current.record, &input, authority)?;
    let next = build_next_record(&current.record, &input, fields)?;
    validate_record(&next)?;
    let changed = transaction
        .execute(
            "UPDATE role_session_migrations SET
               phase=?5, journal_revision=?6, target_revision=?7,
               envelope_sha256=?8, inventory_sha256=?9, cookie_count=?10,
               local_storage_origin_count=?11, local_storage_entry_count=?12,
               stable_error_code=?13, outcome=?14, phase_changed_at=?15,
               updated_at=?16, outcome_at=?17, first_verified_launch_at=?18,
               clean_flush_receipt_id=?19, reset_receipt_id=?20,
               last_transition_id=?21, last_transition_request_sha256=?22
             WHERE role_id=?1 AND transfer_id=?2 AND phase=?3 AND journal_revision=?4",
            params![
                input.role_id,
                input.transfer_id,
                input.expected_phase.as_str(),
                sqlite_integer(input.expected_journal_revision)?,
                next.phase.as_str(),
                sqlite_integer(next.journal_revision)?,
                optional_sqlite_integer(next.target_revision)?,
                next.envelope_sha256,
                next.inventory_sha256,
                optional_sqlite_integer(next.cookie_count)?,
                optional_sqlite_integer(next.local_storage_origin_count)?,
                optional_sqlite_integer(next.local_storage_entry_count)?,
                next.stable_error_code,
                next.outcome.map(RoleSessionMigrationOutcome::as_str),
                next.phase_changed_at,
                next.updated_at,
                next.outcome_at,
                next.first_verified_launch_at,
                next.clean_flush_receipt_id,
                next.reset_receipt_id,
                input.transition_id,
                request_sha256,
            ],
        )
        .map_err(database_error)?;
    if changed != 1 {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_REVISION_STALE",
            "The role session migration revision is no longer current.",
        ));
    }
    let committed = read_stored(transaction, &next.role_id)?
        .ok_or_else(database_corruption_error)?
        .record;
    Ok(committed)
}

fn build_next_record(
    current: &RoleSessionMigrationRecord,
    input: &RoleSessionMigrationTransitionInput,
    fields: AuthoritativeMigrationFields,
) -> CoreResult<RoleSessionMigrationRecord> {
    let same_phase = current.phase == input.next_phase;
    if input.mark_first_verified_launch
        && (!same_phase
            || input.next_phase != RoleSessionMigrationPhase::V23Ready
            || current.first_verified_launch_at.is_some())
    {
        return Err(invalid_transition_error());
    }
    if same_phase && !input.mark_first_verified_launch {
        return Err(invalid_transition_error());
    }
    let terminal = matches!(
        input.next_phase,
        RoleSessionMigrationPhase::V23Ready
            | RoleSessionMigrationPhase::Failed
            | RoleSessionMigrationPhase::Indeterminate
    );
    let next_revision = current
        .journal_revision
        .checked_add(1)
        .ok_or_else(invalid_input_error)?;
    Ok(RoleSessionMigrationRecord {
        role_id: current.role_id.clone(),
        transfer_id: current.transfer_id.clone(),
        phase: input.next_phase,
        journal_revision: next_revision,
        platform: current.platform,
        source_engine: current.source_engine,
        target_engine: current.target_engine,
        source_revision: current.source_revision,
        target_revision: fields.target_revision,
        envelope_sha256: fields.envelope_sha256,
        inventory_sha256: fields.inventory_sha256,
        cookie_count: fields.cookie_count,
        local_storage_origin_count: fields.local_storage_origin_count,
        local_storage_entry_count: fields.local_storage_entry_count,
        stable_error_code: input.stable_error_code.clone(),
        outcome: input.outcome,
        started_at: current.started_at.clone(),
        phase_changed_at: if same_phase {
            current.phase_changed_at.clone()
        } else {
            input.occurred_at.clone()
        },
        updated_at: input.occurred_at.clone(),
        outcome_at: if terminal {
            if same_phase {
                current.outcome_at.clone()
            } else {
                Some(input.occurred_at.clone())
            }
        } else {
            None
        },
        first_verified_launch_at: if input.mark_first_verified_launch {
            Some(input.occurred_at.clone())
        } else {
            current.first_verified_launch_at.clone()
        },
        clean_flush_receipt_id: fields.clean_flush_receipt_id,
        reset_receipt_id: fields.reset_receipt_id,
    })
}

fn validate_start_input(input: &RoleSessionMigrationStartInput) -> CoreResult<()> {
    validate_uuid(&input.role_id)?;
    validate_uuid(&input.transfer_id)?;
    sqlite_integer(input.source_revision)?;
    let source_matches_platform = matches!(
        (input.platform, input.source_engine),
        (
            RoleSessionMigrationPlatform::Macos,
            RoleSessionMigrationEngine::Wkwebview
        ) | (
            RoleSessionMigrationPlatform::Windows,
            RoleSessionMigrationEngine::Webview2
        )
    );
    if !source_matches_platform || input.target_engine != RoleSessionMigrationEngine::Chromium {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn validate_v23_role_initialization(evidence: &V23RoleInitializationEvidence) -> CoreResult<()> {
    validate_uuid(&evidence.role_id)?;
    validate_uuid(&evidence.transfer_id)?;
    validate_uuid(&evidence.transition_id)?;
    validate_optional_opaque_id(Some(&evidence.clean_flush_receipt_id))?;
    validate_optional_opaque_id(Some(&evidence.reset_receipt_id))?;
    if evidence.source_revision != 0
        || evidence.target_revision != 0
        || evidence.target_engine != RoleSessionMigrationEngine::Chromium
        || !matches!(
            (evidence.platform, evidence.source_engine),
            (
                RoleSessionMigrationPlatform::Macos,
                RoleSessionMigrationEngine::Wkwebview
            ) | (
                RoleSessionMigrationPlatform::Windows,
                RoleSessionMigrationEngine::Webview2
            )
        )
        || normalize_timestamp(&evidence.occurred_at)? != evidence.occurred_at
    {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn validate_v23_explicit_reset(evidence: &V23RoleExplicitResetEvidence) -> CoreResult<()> {
    validate_uuid(&evidence.role_id)?;
    validate_uuid(&evidence.transfer_id)?;
    validate_uuid(&evidence.transition_id)?;
    validate_optional_opaque_id(Some(&evidence.clean_flush_receipt_id))?;
    validate_optional_opaque_id(Some(&evidence.reset_receipt_id))?;
    optional_sqlite_integer(evidence.expected_journal_revision)?;
    sqlite_integer(evidence.target_revision)?;
    let source_matches_platform = matches!(
        (evidence.platform, evidence.source_engine),
        (
            RoleSessionMigrationPlatform::Macos,
            RoleSessionMigrationEngine::Wkwebview
        ) | (
            RoleSessionMigrationPlatform::Windows,
            RoleSessionMigrationEngine::Webview2
        )
    );
    if !source_matches_platform
        || evidence.target_revision == 0
        || normalize_timestamp(&evidence.occurred_at)? != evidence.occurred_at
    {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn explicit_reset_request_sha256(evidence: &V23RoleExplicitResetEvidence) -> CoreResult<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(evidence).map_err(|_| invalid_input_error())?)
    ))
}

fn validate_start_replay(
    current: &RoleSessionMigrationRecord,
    input: &RoleSessionMigrationStartInput,
) -> CoreResult<()> {
    if current.transfer_id != input.transfer_id {
        return Err(transfer_stale_error());
    }
    if current.role_id != input.role_id
        || current.platform != input.platform
        || current.source_engine != input.source_engine
        || current.target_engine != input.target_engine
        || current.source_revision != input.source_revision
    {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_REPLAY_CONFLICT",
            "The role session migration start replay does not match the committed request.",
        ));
    }
    Ok(())
}

fn validate_transition_syntax(input: &mut RoleSessionMigrationTransitionInput) -> CoreResult<()> {
    validate_uuid(&input.role_id)?;
    validate_uuid(&input.transfer_id)?;
    validate_uuid(&input.transition_id)?;
    if input.expected_journal_revision == 0 {
        return Err(invalid_input_error());
    }
    sqlite_integer(input.expected_journal_revision)?;
    optional_sqlite_integer(input.target_revision)?;
    optional_sqlite_integer(input.cookie_count)?;
    optional_sqlite_integer(input.local_storage_origin_count)?;
    optional_sqlite_integer(input.local_storage_entry_count)?;
    normalize_optional_digest(&mut input.envelope_sha256)?;
    normalize_optional_digest(&mut input.inventory_sha256)?;
    validate_optional_stable_code(input.stable_error_code.as_deref())?;
    validate_optional_opaque_id(input.clean_flush_receipt_id.as_deref())?;
    validate_optional_opaque_id(input.reset_receipt_id.as_deref())?;
    input.occurred_at = normalize_timestamp(&input.occurred_at)?;
    Ok(())
}

fn validate_record(record: &RoleSessionMigrationRecord) -> CoreResult<()> {
    validate_uuid(&record.role_id)?;
    validate_uuid(&record.transfer_id)?;
    if record.journal_revision == 0 {
        return Err(invalid_input_error());
    }
    sqlite_integer(record.journal_revision)?;
    sqlite_integer(record.source_revision)?;
    optional_sqlite_integer(record.target_revision)?;
    optional_sqlite_integer(record.cookie_count)?;
    optional_sqlite_integer(record.local_storage_origin_count)?;
    optional_sqlite_integer(record.local_storage_entry_count)?;
    validate_optional_digest(record.envelope_sha256.as_deref())?;
    validate_optional_digest(record.inventory_sha256.as_deref())?;
    validate_optional_stable_code(record.stable_error_code.as_deref())?;
    validate_optional_opaque_id(record.clean_flush_receipt_id.as_deref())?;
    validate_optional_opaque_id(record.reset_receipt_id.as_deref())?;
    validate_record_clean_flush_receipt(record)?;
    validate_timestamp(&record.started_at)?;
    validate_timestamp(&record.phase_changed_at)?;
    validate_timestamp(&record.updated_at)?;
    if let Some(value) = &record.outcome_at {
        validate_timestamp(value)?;
    }
    if let Some(value) = &record.first_verified_launch_at {
        validate_timestamp(value)?;
    }
    if record.target_engine != RoleSessionMigrationEngine::Chromium
        || !matches!(
            (record.platform, record.source_engine),
            (
                RoleSessionMigrationPlatform::Macos,
                RoleSessionMigrationEngine::Wkwebview
            ) | (
                RoleSessionMigrationPlatform::Windows,
                RoleSessionMigrationEngine::Webview2
            )
        )
    {
        return Err(invalid_input_error());
    }
    let counts_are_complete = record.cookie_count.is_some()
        && record.local_storage_origin_count.is_some()
        && record.local_storage_entry_count.is_some();
    let counts_are_empty = record.cookie_count.is_none()
        && record.local_storage_origin_count.is_none()
        && record.local_storage_entry_count.is_none();
    if !counts_are_complete && !counts_are_empty {
        return Err(invalid_input_error());
    }
    let has_complete_export = record.envelope_sha256.is_some()
        && record.inventory_sha256.is_some()
        && counts_are_complete;
    let has_no_export =
        record.envelope_sha256.is_none() && record.inventory_sha256.is_none() && counts_are_empty;
    if !has_complete_export && !has_no_export {
        return Err(invalid_transition_error());
    }
    match record.phase {
        RoleSessionMigrationPhase::V22Ready => {
            require_nonterminal(record)?;
            if !has_no_export
                || record.target_revision.is_some()
                || record.clean_flush_receipt_id.is_some()
                || record.reset_receipt_id.is_some()
            {
                return Err(invalid_transition_error());
            }
        }
        RoleSessionMigrationPhase::Exported => {
            require_nonterminal(record)?;
            if !has_complete_export
                || record.target_revision.is_some()
                || record.clean_flush_receipt_id.is_some()
                || record.reset_receipt_id.is_some()
            {
                return Err(invalid_transition_error());
            }
        }
        RoleSessionMigrationPhase::Importing => {
            require_nonterminal(record)?;
            if !has_complete_export
                || record.target_revision.is_none()
                || record.clean_flush_receipt_id.is_some()
                || record.reset_receipt_id.is_some()
            {
                return Err(invalid_transition_error());
            }
        }
        RoleSessionMigrationPhase::Verifying => {
            require_nonterminal(record)?;
            if !has_complete_export
                || record.target_revision.is_none()
                || record.clean_flush_receipt_id.is_none()
                || record.reset_receipt_id.is_some()
            {
                return Err(invalid_transition_error());
            }
        }
        RoleSessionMigrationPhase::V23Ready => {
            if record.stable_error_code.is_some()
                || record.outcome_at.is_none()
                || record.target_revision.is_none()
                || record.clean_flush_receipt_id.is_none()
            {
                return Err(invalid_transition_error());
            }
            match record.outcome {
                Some(RoleSessionMigrationOutcome::Verified)
                    if has_complete_export && record.reset_receipt_id.is_none() => {}
                Some(RoleSessionMigrationOutcome::ExplicitReset)
                    if has_no_export && record.reset_receipt_id.is_some() => {}
                _ => return Err(invalid_transition_error()),
            }
        }
        RoleSessionMigrationPhase::Failed => {
            require_terminal_error(record, RoleSessionMigrationOutcome::Failed)?;
        }
        RoleSessionMigrationPhase::Indeterminate => {
            require_terminal_error(record, RoleSessionMigrationOutcome::Indeterminate)?;
        }
    }
    if record.phase != RoleSessionMigrationPhase::V23Ready
        && record.first_verified_launch_at.is_some()
    {
        return Err(invalid_transition_error());
    }
    Ok(())
}

fn require_nonterminal(record: &RoleSessionMigrationRecord) -> CoreResult<()> {
    if record.stable_error_code.is_some()
        || record.outcome.is_some()
        || record.outcome_at.is_some()
        || record.first_verified_launch_at.is_some()
    {
        return Err(invalid_transition_error());
    }
    Ok(())
}

fn require_terminal_error(
    record: &RoleSessionMigrationRecord,
    outcome: RoleSessionMigrationOutcome,
) -> CoreResult<()> {
    if record.stable_error_code.is_none()
        || record.outcome != Some(outcome)
        || record.outcome_at.is_none()
        || record.reset_receipt_id.is_some()
        || record.first_verified_launch_at.is_some()
    {
        return Err(invalid_transition_error());
    }
    Ok(())
}

const ROLE_SESSION_MIGRATION_SELECT: &str =
    "SELECT role_id, transfer_id, phase, journal_revision, platform,
            source_engine, target_engine, source_revision, target_revision,
            envelope_sha256, inventory_sha256, cookie_count,
            local_storage_origin_count, local_storage_entry_count,
            stable_error_code, outcome, started_at, phase_changed_at, updated_at,
            outcome_at, first_verified_launch_at, clean_flush_receipt_id,
            reset_receipt_id, last_transition_id, last_transition_request_sha256
     FROM role_session_migrations";

#[derive(Debug)]
struct RawRoleSessionMigration {
    role_id: String,
    transfer_id: String,
    phase: String,
    journal_revision: i64,
    platform: String,
    source_engine: String,
    target_engine: String,
    source_revision: i64,
    target_revision: Option<i64>,
    envelope_sha256: Option<String>,
    inventory_sha256: Option<String>,
    cookie_count: Option<i64>,
    local_storage_origin_count: Option<i64>,
    local_storage_entry_count: Option<i64>,
    stable_error_code: Option<String>,
    outcome: Option<String>,
    started_at: String,
    phase_changed_at: String,
    updated_at: String,
    outcome_at: Option<String>,
    first_verified_launch_at: Option<String>,
    clean_flush_receipt_id: Option<String>,
    reset_receipt_id: Option<String>,
    last_transition_id: Option<String>,
    last_transition_request_sha256: Option<String>,
}

fn read_stored(
    connection: &Connection,
    role_id: &str,
) -> CoreResult<Option<StoredRoleSessionMigration>> {
    let raw = connection
        .query_row(
            &format!("{} WHERE role_id=?1", ROLE_SESSION_MIGRATION_SELECT),
            [role_id],
            read_raw,
        )
        .optional()
        .map_err(database_error)?;
    raw.map(decode_stored).transpose()
}

fn read_raw(row: &Row<'_>) -> rusqlite::Result<RawRoleSessionMigration> {
    Ok(RawRoleSessionMigration {
        role_id: row.get(0)?,
        transfer_id: row.get(1)?,
        phase: row.get(2)?,
        journal_revision: row.get(3)?,
        platform: row.get(4)?,
        source_engine: row.get(5)?,
        target_engine: row.get(6)?,
        source_revision: row.get(7)?,
        target_revision: row.get(8)?,
        envelope_sha256: row.get(9)?,
        inventory_sha256: row.get(10)?,
        cookie_count: row.get(11)?,
        local_storage_origin_count: row.get(12)?,
        local_storage_entry_count: row.get(13)?,
        stable_error_code: row.get(14)?,
        outcome: row.get(15)?,
        started_at: row.get(16)?,
        phase_changed_at: row.get(17)?,
        updated_at: row.get(18)?,
        outcome_at: row.get(19)?,
        first_verified_launch_at: row.get(20)?,
        clean_flush_receipt_id: row.get(21)?,
        reset_receipt_id: row.get(22)?,
        last_transition_id: row.get(23)?,
        last_transition_request_sha256: row.get(24)?,
    })
}

fn decode_stored(raw: RawRoleSessionMigration) -> CoreResult<StoredRoleSessionMigration> {
    let record = RoleSessionMigrationRecord {
        role_id: raw.role_id,
        transfer_id: raw.transfer_id,
        phase: RoleSessionMigrationPhase::parse(&raw.phase)
            .ok_or_else(database_corruption_error)?,
        journal_revision: decode_integer(raw.journal_revision)?,
        platform: RoleSessionMigrationPlatform::parse(&raw.platform)
            .ok_or_else(database_corruption_error)?,
        source_engine: RoleSessionMigrationEngine::parse(&raw.source_engine)
            .ok_or_else(database_corruption_error)?,
        target_engine: RoleSessionMigrationEngine::parse(&raw.target_engine)
            .ok_or_else(database_corruption_error)?,
        source_revision: decode_integer(raw.source_revision)?,
        target_revision: decode_optional_integer(raw.target_revision)?,
        envelope_sha256: raw.envelope_sha256,
        inventory_sha256: raw.inventory_sha256,
        cookie_count: decode_optional_integer(raw.cookie_count)?,
        local_storage_origin_count: decode_optional_integer(raw.local_storage_origin_count)?,
        local_storage_entry_count: decode_optional_integer(raw.local_storage_entry_count)?,
        stable_error_code: raw.stable_error_code,
        outcome: match raw.outcome.as_deref() {
            Some(value) => Some(
                RoleSessionMigrationOutcome::parse(value).ok_or_else(database_corruption_error)?,
            ),
            None => None,
        },
        started_at: raw.started_at,
        phase_changed_at: raw.phase_changed_at,
        updated_at: raw.updated_at,
        outcome_at: raw.outcome_at,
        first_verified_launch_at: raw.first_verified_launch_at,
        clean_flush_receipt_id: raw.clean_flush_receipt_id,
        reset_receipt_id: raw.reset_receipt_id,
    };
    if validate_record(&record).is_err()
        || raw
            .last_transition_id
            .as_deref()
            .is_some_and(|value| validate_uuid(value).is_err())
        || raw
            .last_transition_request_sha256
            .as_deref()
            .is_some_and(|value| validate_digest(value).is_err())
        || raw.last_transition_id.is_some() != raw.last_transition_request_sha256.is_some()
    {
        return Err(database_corruption_error());
    }
    Ok(StoredRoleSessionMigration {
        record,
        last_transition_id: raw.last_transition_id,
        last_transition_request_sha256: raw.last_transition_request_sha256,
    })
}

fn transition_request_sha256(input: &RoleSessionMigrationTransitionInput) -> CoreResult<String> {
    let bytes = serde_json::to_vec(input).map_err(|_| invalid_input_error())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_uuid(value: &str) -> CoreResult<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| invalid_input_error())?;
    if parsed.to_string() != value {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn validate_optional_digest(value: Option<&str>) -> CoreResult<()> {
    value.map(validate_digest).transpose().map(|_| ())
}

fn normalize_optional_digest(value: &mut Option<String>) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid_input_error());
    }
    value.make_ascii_lowercase();
    Ok(())
}

fn validate_digest(value: &str) -> CoreResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn validate_optional_stable_code(value: Option<&str>) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty()
        || value.len() > 96
        || !value.as_bytes()[0].is_ascii_uppercase()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn validate_optional_opaque_id(value: Option<&str>) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(invalid_input_error());
    }
    Ok(())
}

fn normalize_timestamp(value: &str) -> CoreResult<String> {
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|_| invalid_input_error())?;
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn validate_timestamp(value: &str) -> CoreResult<()> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| invalid_input_error())
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn sqlite_integer(value: u64) -> CoreResult<i64> {
    i64::try_from(value).map_err(|_| invalid_input_error())
}

fn optional_sqlite_integer(value: Option<u64>) -> CoreResult<Option<i64>> {
    value.map(sqlite_integer).transpose()
}

fn decode_integer(value: i64) -> CoreResult<u64> {
    u64::try_from(value).map_err(|_| database_corruption_error())
}

fn decode_optional_integer(value: Option<i64>) -> CoreResult<Option<u64>> {
    value.map(decode_integer).transpose()
}

fn invalid_input_error() -> CoreError {
    CoreError::InvalidInput("Role session migration input is invalid.".to_owned())
}

fn invalid_transition_error() -> CoreError {
    domain_error(
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID",
        "The role session migration transition is invalid.",
    )
}

fn migration_not_found_error() -> CoreError {
    domain_error(
        "ROLE_SESSION_MIGRATION_NOT_FOUND",
        "Role session migration was not found.",
    )
}

fn transfer_stale_error() -> CoreError {
    domain_error(
        "ROLE_SESSION_MIGRATION_TRANSFER_STALE",
        "The role session migration transfer is no longer current.",
    )
}

fn domain_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn database_error(error: rusqlite::Error) -> CoreError {
    CoreError::StateDatabase(error.to_string())
}

fn database_corruption_error() -> CoreError {
    CoreError::StateDatabase("stored role session migration metadata is invalid".to_owned())
}

#[cfg(test)]
mod tests;
