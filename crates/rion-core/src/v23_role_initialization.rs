//! Private, filesystem-bound evidence for roles created after the v23 cutover.
//!
//! The marker contains identities and revisions only. It is never exported to
//! shared contracts or the renderer, and it is not a general browser-store API.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

use chrono::{SecondsFormat, Utc};
use uuid::Uuid;

use crate::{
    CoreError, CoreResult, RoleSessionMigrationEngine, RoleSessionMigrationOutcome,
    RoleSessionMigrationPlatform, RoleSessionMigrationRecord,
    session_migration::V23RoleInitializationEvidence,
};

const MARKER_FILE_NAME: &str = ".v23-role-initialization.json";
const MARKER_MAX_BYTES: u64 = 4_096;
const RESET_RECEIPT_PREFIX: &str = "v23-role-create:";
const FLUSH_RECEIPT_PREFIX: &str = "v23-empty-store:";

pub(crate) fn new_evidence(
    role_id: String,
    platform: rion_platform::Platform,
) -> V23RoleInitializationEvidence {
    let transfer_id = Uuid::new_v4().to_string();
    let transition_id = Uuid::new_v4().to_string();
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
    V23RoleInitializationEvidence {
        role_id,
        transfer_id,
        clean_flush_receipt_id: format!("{FLUSH_RECEIPT_PREFIX}{transition_id}"),
        reset_receipt_id: format!("{RESET_RECEIPT_PREFIX}{transition_id}"),
        transition_id,
        platform,
        source_engine,
        target_engine: RoleSessionMigrationEngine::Chromium,
        source_revision: 0,
        target_revision: 0,
        occurred_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}

pub(crate) fn prepare_empty_store(
    user_data_dir: &Path,
    evidence: &V23RoleInitializationEvidence,
) -> CoreResult<()> {
    validate_evidence_identity(evidence)?;
    require_real_directory(user_data_dir)?;
    let roles = user_data_dir.join("roles");
    ensure_roles_directory(&roles)?;
    let stage = roles.join(format!(
        ".v23-role-initializing-{}-{}",
        evidence.role_id, evidence.transition_id
    ));
    let destination = roles.join(&evidence.role_id);
    require_absent(&stage)?;
    require_absent(&destination)?;

    let outcome = (|| {
        fs::create_dir(&stage).map_err(initialization_io)?;
        let browser = stage.join("browser");
        fs::create_dir(&browser).map_err(initialization_io)?;
        for name in ["system", "webview2", "chromium"] {
            fs::create_dir(browser.join(name)).map_err(initialization_io)?;
        }
        let marker = stage.join(MARKER_FILE_NAME);
        write_marker(&marker, evidence)?;
        rion_platform::restrict_directory_to_current_user(&stage)
            .map_err(|_| initialization_error())?;
        verify_tree(&stage, evidence, true)?;
        fs::rename(&stage, &destination).map_err(initialization_io)?;
        sync_directory(&roles)?;
        verify_tree(&destination, evidence, true)
    })();

    if outcome.is_err() {
        remove_exact_tree(&stage);
        if verify_tree(&destination, evidence, true).is_ok() {
            remove_exact_tree(&destination);
        }
    }
    outcome
}

pub(crate) fn rollback_empty_store(user_data_dir: &Path, evidence: &V23RoleInitializationEvidence) {
    if validate_evidence_identity(evidence).is_err() {
        return;
    }
    let directory = user_data_dir.join("roles").join(&evidence.role_id);
    if verify_tree(&directory, evidence, true).is_ok() {
        remove_exact_tree(&directory);
    }
}

pub(crate) fn launch_evidence_matches(
    user_data_dir: &Path,
    journal: &RoleSessionMigrationRecord,
) -> bool {
    let Some(reset_receipt_id) = journal.reset_receipt_id.as_deref() else {
        return journal.outcome == Some(RoleSessionMigrationOutcome::Verified);
    };
    if !reset_receipt_id.starts_with(RESET_RECEIPT_PREFIX) {
        // Other explicit-reset receipts are committed by their privileged
        // reset coordinator and remain governed by the journal CAS contract.
        return journal.outcome == Some(RoleSessionMigrationOutcome::ExplicitReset);
    }
    let directory = user_data_dir.join("roles").join(&journal.role_id);
    let Ok(evidence) = read_marker(&directory.join(MARKER_FILE_NAME)) else {
        return false;
    };
    evidence_matches_journal(&evidence, journal)
        && verify_tree(&directory, &evidence, false).is_ok()
}

fn evidence_matches_journal(
    evidence: &V23RoleInitializationEvidence,
    journal: &RoleSessionMigrationRecord,
) -> bool {
    Uuid::parse_str(&evidence.transition_id)
        .is_ok_and(|value| value.to_string() == evidence.transition_id)
        && evidence.role_id == journal.role_id
        && evidence.transfer_id == journal.transfer_id
        && evidence.platform == journal.platform
        && evidence.source_engine == journal.source_engine
        && evidence.target_engine == journal.target_engine
        && evidence.source_revision == journal.source_revision
        && journal.target_revision == Some(evidence.target_revision)
        && journal.outcome == Some(RoleSessionMigrationOutcome::ExplicitReset)
        && journal.clean_flush_receipt_id.as_deref()
            == Some(evidence.clean_flush_receipt_id.as_str())
        && journal.reset_receipt_id.as_deref() == Some(evidence.reset_receipt_id.as_str())
        && evidence.clean_flush_receipt_id
            == format!("{FLUSH_RECEIPT_PREFIX}{}", evidence.transition_id)
        && evidence.reset_receipt_id == format!("{RESET_RECEIPT_PREFIX}{}", evidence.transition_id)
        && journal.started_at == evidence.occurred_at
        && journal.phase_changed_at == evidence.occurred_at
        && journal.outcome_at.as_deref() == Some(evidence.occurred_at.as_str())
}

fn validate_evidence_identity(evidence: &V23RoleInitializationEvidence) -> CoreResult<()> {
    for value in [
        evidence.role_id.as_str(),
        evidence.transfer_id.as_str(),
        evidence.transition_id.as_str(),
    ] {
        if !Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value) {
            return Err(initialization_error());
        }
    }
    if evidence.clean_flush_receipt_id
        != format!("{FLUSH_RECEIPT_PREFIX}{}", evidence.transition_id)
        || evidence.reset_receipt_id != format!("{RESET_RECEIPT_PREFIX}{}", evidence.transition_id)
    {
        return Err(initialization_error());
    }
    Ok(())
}

fn ensure_roles_directory(path: &Path) -> CoreResult<()> {
    match fs::create_dir(path) {
        Ok(()) => rion_platform::restrict_directory_to_current_user(path)
            .map_err(|_| initialization_error())?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(initialization_io(error)),
    }
    require_real_directory(path)
}

fn write_marker(path: &Path, evidence: &V23RoleInitializationEvidence) -> CoreResult<()> {
    let bytes = serde_json::to_vec(evidence).map_err(|_| initialization_error())?;
    if bytes.is_empty() || bytes.len() as u64 > MARKER_MAX_BYTES {
        return Err(initialization_error());
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(initialization_io)?;
    file.write_all(&bytes).map_err(initialization_io)?;
    file.sync_all().map_err(initialization_io)
}

fn read_marker(path: &Path) -> CoreResult<V23RoleInitializationEvidence> {
    let mut file = open_marker_without_following(path)?;
    let metadata = file.metadata().map_err(initialization_io)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MARKER_MAX_BYTES {
        return Err(initialization_error());
    }
    rion_platform::verify_open_file_identity(path, &file).map_err(|_| initialization_error())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(initialization_io)?;
    rion_platform::verify_open_file_identity(path, &file).map_err(|_| initialization_error())?;
    serde_json::from_slice(&bytes).map_err(|_| initialization_error())
}

fn verify_tree(
    directory: &Path,
    evidence: &V23RoleInitializationEvidence,
    require_empty_stores: bool,
) -> CoreResult<()> {
    require_real_directory(directory)?;
    let browser = directory.join("browser");
    require_real_directory(&browser)?;
    for name in ["system", "webview2", "chromium"] {
        let store = browser.join(name);
        require_real_directory(&store)?;
        if require_empty_stores
            && fs::read_dir(&store)
                .map_err(initialization_io)?
                .next()
                .is_some()
        {
            return Err(initialization_error());
        }
    }
    let stored = read_marker(&directory.join(MARKER_FILE_NAME))?;
    if &stored != evidence {
        return Err(initialization_error());
    }
    Ok(())
}

fn require_real_directory(path: &Path) -> CoreResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(initialization_io)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(initialization_error());
    }
    Ok(())
}

fn require_absent(path: &Path) -> CoreResult<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) | Err(_) => Err(initialization_error()),
    }
}

fn open_marker_without_following(path: &Path) -> CoreResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x0000_0100); // O_NOFOLLOW
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x0002_0000); // O_NOFOLLOW
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options.open(path).map_err(initialization_io)
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> CoreResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(initialization_io)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> CoreResult<()> {
    Ok(())
}

fn remove_exact_tree(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && !metadata_is_reparse_point(&metadata)
    }) {
        let _ = fs::remove_dir_all(path);
    }
}

fn initialization_io(_error: std::io::Error) -> CoreError {
    initialization_error()
}

fn initialization_error() -> CoreError {
    CoreError::Domain {
        code: "V23_ROLE_INITIALIZATION_EVIDENCE_INVALID",
        message: "The v23 role initialization evidence is incomplete or changed identity."
            .to_owned(),
    }
}

#[cfg(test)]
pub(crate) fn marker_path(user_data_dir: &Path, role_id: &str) -> std::path::PathBuf {
    user_data_dir
        .join("roles")
        .join(role_id)
        .join(MARKER_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_evidence_is_strict_and_bound_to_the_exact_role_tree() {
        let directory = tempfile::tempdir().unwrap();
        let evidence = new_evidence(
            "10000000-0000-4000-8000-000000000001".to_owned(),
            rion_platform::Platform::Macos,
        );
        prepare_empty_store(directory.path(), &evidence).unwrap();
        let role = directory.path().join("roles").join(&evidence.role_id);
        verify_tree(&role, &evidence, true).unwrap();

        let marker = role.join(MARKER_FILE_NAME);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        value["unknownField"] = serde_json::json!(true);
        fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_marker(&marker).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn marker_symlinks_fail_closed() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let evidence = new_evidence(
            "10000000-0000-4000-8000-000000000002".to_owned(),
            rion_platform::Platform::Macos,
        );
        prepare_empty_store(directory.path(), &evidence).unwrap();
        let marker = marker_path(directory.path(), &evidence.role_id);
        let replacement = directory.path().join("replacement.json");
        fs::write(&replacement, serde_json::to_vec(&evidence).unwrap()).unwrap();
        fs::remove_file(&marker).unwrap();
        symlink(&replacement, &marker).unwrap();
        assert!(read_marker(&marker).is_err());
    }

    #[test]
    fn noncanonical_role_identity_is_rejected_before_path_construction() {
        let directory = tempfile::tempdir().unwrap();
        let mut evidence = new_evidence(
            "10000000-0000-4000-8000-000000000003".to_owned(),
            rion_platform::Platform::Macos,
        );
        evidence.role_id = "../escape".to_owned();
        assert!(prepare_empty_store(directory.path(), &evidence).is_err());
        assert!(!directory.path().join("escape").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_filesystem_primitives_publish_one_exact_empty_role_tree() {
        let directory = tempfile::tempdir().unwrap();
        let evidence = new_evidence(
            "10000000-0000-4000-8000-000000000004".to_owned(),
            rion_platform::Platform::Windows,
        );
        let roles = directory.path().join("roles");
        ensure_roles_directory(&roles).expect("create and protect roles directory");
        let stage = roles.join(format!(
            ".v23-role-initializing-{}-{}",
            evidence.role_id, evidence.transition_id
        ));
        let destination = roles.join(&evidence.role_id);
        fs::create_dir(&stage).expect("create role staging directory");
        let browser = stage.join("browser");
        fs::create_dir(&browser).expect("create role browser directory");
        for name in ["system", "webview2", "chromium"] {
            fs::create_dir(browser.join(name)).expect("create empty engine store");
        }
        write_marker(&stage.join(MARKER_FILE_NAME), &evidence).expect("write durable role marker");
        rion_platform::restrict_directory_to_current_user(&stage)
            .expect("protect role staging tree");
        verify_tree(&stage, &evidence, true).expect("verify protected staging tree");
        fs::rename(&stage, &destination).expect("publish role tree");
        verify_tree(&destination, &evidence, true).expect("verify published role tree");
    }
}
