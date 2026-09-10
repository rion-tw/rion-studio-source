use super::*;
#[cfg(target_os = "macos")]
use crate::{session_migration::*, session_transfer::*};
#[cfg(target_os = "macos")]
use rusqlite::Connection;

#[cfg(target_os = "macos")]
fn envelope(role: &str) -> RoleSessionTransferEnvelopeRecord {
    RoleSessionTransferEnvelopeRecord {
        metadata: RoleSessionTransferMetadataRecord {
            format: RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: 1,
            transfer_id: uuid::Uuid::new_v4().to_string(),
            role_id: role.to_owned(),
            platform: RoleSessionMigrationPlatform::Macos,
            source_engine: RoleSessionMigrationEngine::Wkwebview,
            target_engine: RoleSessionMigrationEngine::Chromium,
            source_revision: 7,
            source_evidence: None,
        },
        inventory: RoleSessionTransferInventoryRecord {
            cookies: Vec::new(),
            local_storage: vec![RoleSessionTransferLocalStorageOriginRecord {
                origin: "https://recovery.invalid".to_owned(),
                entries: vec![RoleSessionTransferLocalStorageEntryRecord {
                    key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[
                        0x91cc, 0x512a,
                    ]),
                    value: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[
                        0xd800, 0, 0xdfff,
                    ]),
                }],
            }],
        },
    }
}
#[cfg(target_os = "macos")]
fn database(role: &str) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE roles(id TEXT PRIMARY KEY);")
        .unwrap();
    connection
        .execute_batch(ROLE_SESSION_MIGRATION_SCHEMA_SQL)
        .unwrap();
    connection
        .execute("INSERT INTO roles VALUES(?1)", [role])
        .unwrap();
    connection
}
#[test]
fn session_recovery_closed_command_rejects_paths_values_and_success_flags() {
    assert!(
        crate::CoreCommand::RoleSessionRecovery {
            command: types::RoleSessionRecoveryCommand::Inspect {
                role_id: uuid::Uuid::new_v4().to_string()
            }
        }
        .requires_async_dispatch()
    );
    for field in ["path", "cookieValue", "success", "platform"] {
        let mut command =
            serde_json::json!({"type":"inspect","roleId":uuid::Uuid::new_v4().to_string()});
        command[field] = serde_json::json!("untrusted");
        assert!(serde_json::from_value::<types::RoleSessionRecoveryCommand>(command).is_err());
    }
    assert!(uuid("../role-b").is_err());
    assert!(!source::native_support(rion_platform::Platform::Windows));
}
#[test]
fn session_recovery_target_conflict_never_clears_either_role() {
    let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let a = uuid::Uuid::new_v4().to_string();
    let b = uuid::Uuid::new_v4().to_string();
    for role in [&a, &b] {
        let path = stage::ensure_target_empty(data.path(), role)
            .unwrap()
            .chromium_user_data_dir;
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(std::path::Path::new(&path).join("sentinel"), role).unwrap();
        assert_eq!(
            stage::ensure_target_empty(data.path(), role)
                .err()
                .unwrap()
                .code(),
            "RECOVERY_TARGET_DATA_CONFLICT"
        );
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("sentinel")).unwrap(),
            *role
        );
    }
}
#[cfg(target_os = "macos")]
#[test]
fn session_recovery_isolated_validation_precedes_single_role_admission() {
    let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let role = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let original = envelope(&role);
    let stage = stage::prepare(
        data.path(),
        &attempt,
        rion_platform::Platform::Macos,
        original.clone(),
    )
    .unwrap();
    let mut database = database(&role);
    assert!(read(&database, &role).unwrap().is_none());
    assert!(stage::mark_verified(&stage, "same-process-readback").is_err());
    assert!(read(&database, &role).unwrap().is_none());
    let receipt = format!("chromium-session-fresh:{}", "1".repeat(64));
    let verified = stage::mark_verified(&stage, &receipt).unwrap();
    let exported =
        stage::publish_vault(data.path(), rion_platform::Platform::Macos, &stage).unwrap();
    let mut wrong = verified.clone();
    wrong.role_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        commit::admit(
            &mut database,
            commit::Admission {
                previous: None,
                exported: exported.clone(),
                isolated: wrong
            }
        )
        .unwrap_err()
        .code(),
        "RECOVERY_ISOLATED_EVIDENCE_INVALID"
    );
    assert!(read(&database, &role).unwrap().is_none());
    let admitted = commit::admit(
        &mut database,
        commit::Admission {
            previous: None,
            exported: exported.clone(),
            isolated: verified.clone(),
        },
    )
    .unwrap();
    assert_eq!(admitted.phase, RoleSessionMigrationPhase::Exported);
    assert_ne!(admitted.transfer_id, original.metadata.transfer_id);
    assert!(admitted.first_verified_launch_at.is_none());
    assert_eq!(
        read_session_transfer_vault(data.path(), rion_platform::Platform::Macos, &admitted)
            .unwrap()
            .inventory,
        original.inventory
    );
    assert_eq!(
        commit::admit(
            &mut database,
            commit::Admission {
                previous: None,
                exported,
                isolated: verified
            }
        )
        .unwrap_err()
        .code(),
        "RECOVERY_JOURNAL_STALE"
    );
    assert_eq!(read(&database, &role).unwrap(), Some(admitted));
    assert!(
        stage::prepare(
            data.path(),
            &attempt,
            rion_platform::Platform::Macos,
            original
        )
        .is_err()
    );
    assert!(stage::load(data.path(), &attempt, &uuid::Uuid::new_v4().to_string()).is_err());
}
#[cfg(unix)]
#[test]
fn session_recovery_rejects_symlinks_and_changed_source_digest() {
    let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let path = data.path().join("original");
    std::fs::write(&path, "before").unwrap();
    let before = source::digest(&path).unwrap();
    std::fs::write(&path, "after").unwrap();
    assert_ne!(before, source::digest(&path).unwrap());
    let link = data.path().join("replacement");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(source::digest(&link).is_err());
    assert!(stage::private_directory(&link).is_err());
}
