use super::error;
use crate::{RolePathsRecord, error::CoreResult, session_migration::*, session_transfer::*};
use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct Stage {
    pub root: PathBuf,
    pub journal: RoleSessionMigrationRecord,
    pub paths: RolePathsRecord,
}

pub(crate) fn root(data: &Path, attempt: &str) -> CoreResult<PathBuf> {
    super::uuid(attempt)?;
    Ok(data.join(".session-recovery").join(attempt))
}
pub(crate) fn private_directory(path: &Path) -> CoreResult<()> {
    if path
        .try_exists()
        .map_err(|_| error("RECOVERY_PATH_UNAVAILABLE"))?
    {
        crate::session_source::paths::existing(path).map_err(error)?;
        if !path.is_dir() {
            return Err(error("RECOVERY_PATH_INVALID"));
        }
    } else {
        crate::session_source::paths::existing(
            path.parent()
                .ok_or_else(|| error("RECOVERY_PATH_INVALID"))?,
        )
        .map_err(error)?;
        fs::create_dir(path).map_err(|_| error("RECOVERY_PATH_CREATE_FAILED"))?;
    }
    rion_platform::restrict_directory_to_current_user(path)
        .map_err(|_| error("RECOVERY_PATH_PROTECTION_FAILED"))
}

pub(crate) fn prepare(
    data: &Path,
    attempt: &str,
    platform: rion_platform::Platform,
    mut envelope: RoleSessionTransferEnvelopeRecord,
) -> CoreResult<Stage> {
    private_directory(&data.join(".session-recovery"))?;
    let root = root(data, attempt)?;
    if root.exists() {
        return Err(error("RECOVERY_ATTEMPT_EXISTS"));
    }
    private_directory(&root)?;
    envelope.metadata.transfer_id = uuid::Uuid::new_v4().to_string();
    envelope.metadata.source_revision = envelope
        .metadata
        .source_revision
        .checked_add(1)
        .ok_or_else(|| error("RECOVERY_REVISION_EXHAUSTED"))?;
    let mut connection = Connection::open(root.join("stage.sqlite3"))
        .map_err(|_| error("RECOVERY_DATABASE_FAILED"))?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE roles(id TEXT PRIMARY KEY);").map_err(|_|error("RECOVERY_DATABASE_FAILED"))?;
    connection
        .execute_batch(ROLE_SESSION_MIGRATION_SCHEMA_SQL)
        .map_err(|_| error("RECOVERY_DATABASE_FAILED"))?;
    connection
        .execute("INSERT INTO roles VALUES(?1)", [&envelope.metadata.role_id])
        .map_err(|_| error("RECOVERY_DATABASE_FAILED"))?;
    let source = start(
        &mut connection,
        RoleSessionMigrationStartInput {
            role_id: envelope.metadata.role_id.clone(),
            transfer_id: envelope.metadata.transfer_id.clone(),
            platform: envelope.metadata.platform,
            source_engine: envelope.metadata.source_engine,
            target_engine: envelope.metadata.target_engine,
            source_revision: envelope.metadata.source_revision,
        },
    )?;
    let evidence = write_session_transfer_vault(&root, platform, &source, &envelope)?;
    let mut input = transition_input(&source, RoleSessionMigrationPhase::Exported);
    evidence.apply_to_transition(&mut input)?;
    let exported = transition(
        &mut connection,
        TransitionAuthority::SourceRuntime {
            expected_platform: source.platform,
        },
        input,
    )?;
    let journal = begin_role_session_migration_import(
        &mut connection,
        source.platform,
        crate::CHROMIUM_RUNTIME_CONTRACT_VERSION,
        RoleSessionMigrationImportBeginInput {
            role_id: source.role_id.clone(),
            transfer_id: source.transfer_id,
            expected_journal_revision: exported.journal_revision,
        },
    )?;
    crate::role_browser_data::ensure(&root, &source.role_id)?;
    let paths = crate::role_browser_data::paths(&root, &source.role_id)?;
    private_directory(Path::new(&paths.chromium_user_data_dir))?;
    Ok(Stage {
        root,
        journal,
        paths,
    })
}

pub(crate) fn transition_input(
    record: &RoleSessionMigrationRecord,
    next_phase: RoleSessionMigrationPhase,
) -> RoleSessionMigrationTransitionInput {
    RoleSessionMigrationTransitionInput {
        role_id: record.role_id.clone(),
        transfer_id: record.transfer_id.clone(),
        transition_id: uuid::Uuid::new_v4().to_string(),
        expected_phase: record.phase,
        expected_journal_revision: record.journal_revision,
        next_phase,
        target_revision: record.target_revision,
        envelope_sha256: record.envelope_sha256.clone(),
        inventory_sha256: record.inventory_sha256.clone(),
        cookie_count: record.cookie_count,
        local_storage_origin_count: record.local_storage_origin_count,
        local_storage_entry_count: record.local_storage_entry_count,
        stable_error_code: None,
        outcome: None,
        clean_flush_receipt_id: record.clean_flush_receipt_id.clone(),
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

pub(crate) fn load(data: &Path, attempt: &str, role: &str) -> CoreResult<Stage> {
    super::uuid(role)?;
    let root = root(data, attempt)?;
    crate::session_source::paths::existing(&root.join("stage.sqlite3")).map_err(error)?;
    let connection = Connection::open_with_flags(
        root.join("stage.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| error("RECOVERY_DATABASE_FAILED"))?;
    let journal =
        read(&connection, role)?.ok_or_else(|| error("RECOVERY_ATTEMPT_IDENTITY_MISMATCH"))?;
    let paths = crate::role_browser_data::paths(&root, role)?;
    Ok(Stage {
        root,
        journal,
        paths,
    })
}

pub(crate) fn mark_verified(
    stage: &Stage,
    receipt: &str,
) -> CoreResult<RoleSessionMigrationRecord> {
    let mut connection = Connection::open(stage.root.join("stage.sqlite3"))
        .map_err(|_| error("RECOVERY_DATABASE_FAILED"))?;
    let mut input = transition_input(&stage.journal, RoleSessionMigrationPhase::Verifying);
    input.clean_flush_receipt_id = Some(receipt.to_owned());
    let verifying = transition(
        &mut connection,
        TransitionAuthority::TargetRuntime {
            expected_platform: stage.journal.platform,
        },
        input,
    )?;
    let mut input = transition_input(&verifying, RoleSessionMigrationPhase::V23Ready);
    input.outcome = Some(RoleSessionMigrationOutcome::Verified);
    transition(
        &mut connection,
        TransitionAuthority::TargetRuntime {
            expected_platform: stage.journal.platform,
        },
        input,
    )
}

pub(crate) fn publish_vault(
    data: &Path,
    platform: rion_platform::Platform,
    stage: &Stage,
) -> CoreResult<RoleSessionMigrationRecord> {
    let envelope = read_session_transfer_vault(&stage.root, platform, &stage.journal)?;
    let mut source = stage.journal.clone();
    source.phase = RoleSessionMigrationPhase::V22Ready;
    source.journal_revision = 1;
    source.target_revision = None;
    source.envelope_sha256 = None;
    source.inventory_sha256 = None;
    source.cookie_count = None;
    source.local_storage_origin_count = None;
    source.local_storage_entry_count = None;
    source.clean_flush_receipt_id = None;
    let evidence = write_session_transfer_vault(data, platform, &source, &envelope)?;
    source.phase = RoleSessionMigrationPhase::Exported;
    source.journal_revision = 2;
    source.envelope_sha256 = Some(evidence.envelope_sha256);
    source.inventory_sha256 = Some(evidence.inventory_sha256);
    source.cookie_count = Some(evidence.cookie_count);
    source.local_storage_origin_count = Some(evidence.local_storage_origin_count);
    source.local_storage_entry_count = Some(evidence.local_storage_entry_count);
    Ok(source)
}

pub(crate) fn ensure_target_empty(data: &Path, role: &str) -> CoreResult<RolePathsRecord> {
    let paths = crate::role_browser_data::paths(data, role)?;
    let target = Path::new(&paths.chromium_user_data_dir);
    if target
        .try_exists()
        .map_err(|_| error("RECOVERY_TARGET_UNAVAILABLE"))?
    {
        crate::session_source::paths::existing(target).map_err(error)?;
        if fs::read_dir(target)
            .map_err(|_| error("RECOVERY_TARGET_UNAVAILABLE"))?
            .next()
            .is_some()
        {
            return Err(error("RECOVERY_TARGET_DATA_CONFLICT"));
        }
    }
    Ok(paths)
}
