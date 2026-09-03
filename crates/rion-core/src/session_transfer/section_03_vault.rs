use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use crate::session_migration::{RoleSessionMigrationPhase, RoleSessionMigrationRecord};

const SESSION_MIGRATION_DIRECTORY: &str = ".session-migrations";
const SESSION_TRANSFER_INVENTORY_FILE: &str = "inventory.enc";

#[derive(Debug)]
struct SessionTransferVaultPaths {
    vault_root: PathBuf,
    role_directory: PathBuf,
    transfer_directory: PathBuf,
    inventory_file: PathBuf,
}

trait SessionTransferProtector {
    fn protect(
        &self,
        platform: rion_platform::Platform,
        context: &[u8],
        plaintext: &[u8],
    ) -> CoreResult<Vec<u8>>;

    fn unprotect(
        &self,
        platform: rion_platform::Platform,
        context: &[u8],
        protected: &[u8],
    ) -> CoreResult<Vec<u8>>;
}

struct Rsp2SessionTransferProtector;

impl SessionTransferProtector for Rsp2SessionTransferProtector {
    fn protect(
        &self,
        platform: rion_platform::Platform,
        context: &[u8],
        plaintext: &[u8],
    ) -> CoreResult<Vec<u8>> {
        rion_platform::protect_session_transfer_v2(platform, context, plaintext)
            .map_err(|_| vault_protection_error())
    }

    fn unprotect(
        &self,
        platform: rion_platform::Platform,
        context: &[u8],
        protected: &[u8],
    ) -> CoreResult<Vec<u8>> {
        rion_platform::unprotect_session_transfer_v2(platform, context, protected)
            .map_err(|_| vault_authentication_error())
    }
}

pub(crate) fn write_session_transfer_vault(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    envelope: &RoleSessionTransferEnvelopeRecord,
) -> CoreResult<RoleSessionTransferJournalEvidence> {
    write_session_transfer_vault_with(
        user_data_dir,
        platform,
        journal,
        envelope,
        &Rsp2SessionTransferProtector,
    )
}

pub(crate) fn read_session_transfer_vault(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
) -> CoreResult<RoleSessionTransferEnvelopeRecord> {
    read_session_transfer_vault_with(
        user_data_dir,
        platform,
        journal,
        true,
        &Rsp2SessionTransferProtector,
    )
}

fn write_session_transfer_vault_with(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    envelope: &RoleSessionTransferEnvelopeRecord,
    protector: &impl SessionTransferProtector,
) -> CoreResult<RoleSessionTransferJournalEvidence> {
    let (canonical, canonical_json, requested_evidence) = canonical_vault_artifacts(envelope)?;
    validate_envelope_journal_identity(platform, journal, &canonical)?;
    let paths =
        session_transfer_vault_paths(user_data_dir, &journal.role_id, &journal.transfer_id)?;
    ensure_vault_directories(user_data_dir, &paths)?;
    clean_orphaned_vault_temps(&paths.transfer_directory)?;

    if path_exists(&paths.inventory_file)? {
        return validate_idempotent_existing_transfer(
            platform,
            journal,
            &canonical_json,
            &requested_evidence,
            protector,
            &paths,
        );
    }
    validate_new_vault_write_journal(journal)?;

    let context = session_transfer_protection_context(platform, journal)?;
    let protected = protector.protect(platform, &context, &canonical_json)?;
    if protected.len() > rion_platform::SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES {
        return Err(vault_size_error());
    }

    let temporary_path = paths.transfer_directory.join(format!(
        ".{SESSION_TRANSFER_INVENTORY_FILE}.{}.tmp",
        Uuid::new_v4()
    ));
    let mut temporary = PendingVaultFile::new(temporary_path);
    write_protected_file(temporary.path(), &protected)?;

    if path_exists(&paths.inventory_file)? {
        return validate_idempotent_existing_transfer(
            platform,
            journal,
            &canonical_json,
            &requested_evidence,
            protector,
            &paths,
        );
    }
    rion_platform::atomic_replace_file(temporary.path(), &paths.inventory_file)
        .map_err(|_| vault_io_error())?;
    temporary.committed = true;
    restrict_file_permissions(&paths.inventory_file)?;
    sync_directory(&paths.transfer_directory)?;

    let persisted =
        read_session_transfer_vault_with_paths(platform, journal, false, protector, &paths)?;
    if persisted.canonical_envelope_json()? != canonical_json {
        return Err(vault_conflict_error());
    }
    Ok(requested_evidence)
}

fn canonical_vault_artifacts(
    envelope: &RoleSessionTransferEnvelopeRecord,
) -> CoreResult<(
    RoleSessionTransferEnvelopeRecord,
    Vec<u8>,
    RoleSessionTransferJournalEvidence,
)> {
    let (canonical, counts) = canonicalize_with_limits(envelope, DEFAULT_VALIDATION_LIMITS)?;
    let inventory_sha256 = sha256_hex(serialize_canonical(&canonical.inventory)?);
    let canonical_json = serialize_canonical(&canonical)?;
    let evidence = RoleSessionTransferJournalEvidence {
        role_id: canonical.metadata.role_id.clone(),
        transfer_id: canonical.metadata.transfer_id.clone(),
        envelope_sha256: sha256_hex(&canonical_json),
        inventory_sha256,
        cookie_count: count_u64(counts.cookies)?,
        local_storage_origin_count: count_u64(counts.local_storage_origins)?,
        local_storage_entry_count: count_u64(counts.local_storage_entries)?,
    };
    Ok((canonical, canonical_json, evidence))
}

fn read_session_transfer_vault_with(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    require_committed_evidence: bool,
    protector: &impl SessionTransferProtector,
) -> CoreResult<RoleSessionTransferEnvelopeRecord> {
    let paths =
        session_transfer_vault_paths(user_data_dir, &journal.role_id, &journal.transfer_id)?;
    validate_existing_vault_directories(user_data_dir, &paths)?;
    read_session_transfer_vault_with_paths(
        platform,
        journal,
        require_committed_evidence,
        protector,
        &paths,
    )
}

fn read_session_transfer_vault_with_paths(
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    require_committed_evidence: bool,
    protector: &impl SessionTransferProtector,
    paths: &SessionTransferVaultPaths,
) -> CoreResult<RoleSessionTransferEnvelopeRecord> {
    let protected = read_protected_file(&paths.inventory_file)?;
    let context = session_transfer_protection_context(platform, journal)?;
    let plaintext = protector.unprotect(platform, &context, &protected)?;
    let envelope = RoleSessionTransferEnvelopeRecord::from_json(&plaintext)?;
    validate_envelope_journal_identity(platform, journal, &envelope)?;
    if require_committed_evidence {
        validate_committed_journal_evidence(journal, &envelope.journal_evidence()?)?;
    }
    Ok(envelope)
}

fn validate_idempotent_existing_transfer(
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    canonical_json: &[u8],
    requested_evidence: &RoleSessionTransferJournalEvidence,
    protector: &impl SessionTransferProtector,
    paths: &SessionTransferVaultPaths,
) -> CoreResult<RoleSessionTransferJournalEvidence> {
    let existing =
        read_session_transfer_vault_with_paths(platform, journal, false, protector, paths)?;
    let existing_json = existing.canonical_envelope_json()?;
    if existing_json != canonical_json {
        return Err(vault_conflict_error());
    }
    if journal_has_any_evidence(journal) {
        validate_committed_journal_evidence(journal, requested_evidence)?;
    } else {
        validate_new_vault_write_journal(journal)?;
    }
    Ok(requested_evidence.clone())
}

fn validate_new_vault_write_journal(journal: &RoleSessionMigrationRecord) -> CoreResult<()> {
    if journal.phase != RoleSessionMigrationPhase::V22Ready || journal_has_any_evidence(journal) {
        return Err(vault_journal_state_error());
    }
    Ok(())
}

fn journal_has_any_evidence(journal: &RoleSessionMigrationRecord) -> bool {
    journal.envelope_sha256.is_some()
        || journal.inventory_sha256.is_some()
        || journal.cookie_count.is_some()
        || journal.local_storage_origin_count.is_some()
        || journal.local_storage_entry_count.is_some()
}

fn validate_committed_journal_evidence(
    journal: &RoleSessionMigrationRecord,
    evidence: &RoleSessionTransferJournalEvidence,
) -> CoreResult<()> {
    let complete = (
        journal.envelope_sha256.as_deref(),
        journal.inventory_sha256.as_deref(),
        journal.cookie_count,
        journal.local_storage_origin_count,
        journal.local_storage_entry_count,
    );
    let (
        Some(envelope_sha256),
        Some(inventory_sha256),
        Some(cookie_count),
        Some(origin_count),
        Some(entry_count),
    ) = complete
    else {
        return Err(vault_journal_evidence_missing_error());
    };
    if evidence.role_id != journal.role_id
        || evidence.transfer_id != journal.transfer_id
        || evidence.envelope_sha256 != envelope_sha256
        || evidence.inventory_sha256 != inventory_sha256
        || evidence.cookie_count != cookie_count
        || evidence.local_storage_origin_count != origin_count
        || evidence.local_storage_entry_count != entry_count
    {
        return Err(vault_journal_evidence_mismatch_error());
    }
    Ok(())
}

fn validate_envelope_journal_identity(
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    envelope: &RoleSessionTransferEnvelopeRecord,
) -> CoreResult<()> {
    let metadata = &envelope.metadata;
    if migration_platform(platform) != journal.platform
        || metadata.role_id != journal.role_id
        || metadata.transfer_id != journal.transfer_id
        || metadata.platform != journal.platform
        || metadata.source_engine != journal.source_engine
        || metadata.target_engine != journal.target_engine
        || metadata.source_revision != journal.source_revision
        || metadata.version != ROLE_SESSION_TRANSFER_VERSION
        || metadata.format != RoleSessionTransferFormat::RionRoleSessionTransfer
    {
        return Err(vault_journal_identity_error());
    }
    Ok(())
}

fn migration_platform(platform: rion_platform::Platform) -> RoleSessionMigrationPlatform {
    match platform {
        rion_platform::Platform::Macos => RoleSessionMigrationPlatform::Macos,
        rion_platform::Platform::Windows => RoleSessionMigrationPlatform::Windows,
    }
}

fn session_transfer_protection_context(
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
) -> CoreResult<Vec<u8>> {
    validate_canonical_uuid(&journal.role_id)?;
    validate_canonical_uuid(&journal.transfer_id)?;
    let platform = match platform {
        rion_platform::Platform::Macos => "macos",
        rion_platform::Platform::Windows => "windows",
    };
    Ok(format!(
        "rion-session-transfer-vault\0format=rion-role-session-transfer\0version={ROLE_SESSION_TRANSFER_VERSION}\0platform={platform}\0role={}\0transfer={}",
        journal.role_id, journal.transfer_id
    )
    .into_bytes())
}
