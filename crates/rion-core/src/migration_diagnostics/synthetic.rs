use super::{Result, native_platform, paths};
use crate::{
    AppCore, AppCoreOptions, CoreCommand, RoleCreateInputRecord, RoleSessionMigrationPhase,
    RoleSessionMigrationTransitionInput, RoleSessionTransferEnvelopeRecord,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::Path;

/// Source-authority fixture only: never admitted against an existing directory.
pub(super) fn prepare(output: &Path, fixture: Value) -> Result<Value> {
    let root = paths::create_output(output, &[])?;
    let platform = native_platform()?;
    let mut options = AppCoreOptions {
        user_data_dir: root.to_str().ok_or("OUTPUT_ENCODING")?.to_owned(),
        platform: if platform == rion_platform::Platform::Macos {
            "darwin"
        } else {
            "win32"
        }
        .to_owned(),
        app_version: "0.0.0-migration-diagnostic".to_owned(),
        build_commit: None,
        packaged: false,
        runtime_contract_version: Some(22),
    };
    let core = AppCore::create(options.clone()).map_err(|_| "FIXTURE_CORE_CREATE_FAILED")?;
    let result: Result<_> = (|| {
        let games = core
            .invoke(CoreCommand::GamesList)
            .map_err(|_| "FIXTURE_GAME_FAILED")?;
        let game_id = games[0]["id"].as_str().ok_or("FIXTURE_GAME_FAILED")?;
        let role = core
            .invoke(CoreCommand::RoleCreate {
                input: RoleCreateInputRecord {
                    game_id: game_id.to_owned(),
                    name: "Migration diagnostic synthetic role".to_owned(),
                    launch_url: Some("https://migration-one.invalid".to_owned()),
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            })
            .map_err(|_| "FIXTURE_ROLE_FAILED")?;
        let role_id = role["id"].as_str().ok_or("FIXTURE_ROLE_FAILED")?;
        let journal = core
            .prepare_v22_role_session_migrations_internal()
            .map_err(|_| "FIXTURE_JOURNAL_FAILED")?
            .into_iter()
            .find(|j| j.role_id == role_id)
            .ok_or("FIXTURE_JOURNAL_FAILED")?;
        let mut envelope: RoleSessionTransferEnvelopeRecord =
            serde_json::from_value(fixture["envelope"].clone())
                .map_err(|_| "FIXTURE_ENVELOPE_FAILED")?;
        envelope.metadata.role_id = journal.role_id.clone();
        envelope.metadata.transfer_id = journal.transfer_id.clone();
        envelope.metadata.source_revision = journal.source_revision;
        let evidence = core
            .write_role_session_transfer_vault_internal(
                &envelope
                    .canonical_envelope_json()
                    .map_err(|_| "FIXTURE_CANONICAL_FAILED")?,
            )
            .map_err(|_| "FIXTURE_VAULT_FAILED")?;
        let mut transition = RoleSessionMigrationTransitionInput {
            role_id: journal.role_id.clone(),
            transfer_id: journal.transfer_id.clone(),
            transition_id: uuid::Uuid::new_v4().to_string(),
            expected_phase: RoleSessionMigrationPhase::V22Ready,
            expected_journal_revision: journal.journal_revision,
            next_phase: RoleSessionMigrationPhase::Exported,
            target_revision: None,
            envelope_sha256: None,
            inventory_sha256: None,
            cookie_count: None,
            local_storage_origin_count: None,
            local_storage_entry_count: None,
            stable_error_code: None,
            outcome: None,
            clean_flush_receipt_id: None,
            reset_receipt_id: None,
            mark_first_verified_launch: false,
            occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        evidence
            .apply_to_transition(&mut transition)
            .map_err(|_| "FIXTURE_EVIDENCE_FAILED")?;
        let exported = core
            .transition_role_session_migration(transition)
            .map_err(|_| "FIXTURE_EXPORT_FAILED")?;
        let role_paths = core
            .invoke(CoreCommand::RolePathsResolve {
                id: role_id.to_owned(),
            })
            .map_err(|_| "FIXTURE_PATHS_FAILED")?;
        Ok((envelope, evidence, exported, role_paths))
    })();
    core.shutdown_checked()
        .map_err(|_| "FIXTURE_SOURCE_SHUTDOWN_FAILED")?;
    let (envelope, evidence, exported, role_paths) = result?;
    options.runtime_contract_version = Some(crate::CHROMIUM_RUNTIME_CONTRACT_VERSION);
    let target = AppCore::create(options).map_err(|_| "FIXTURE_TARGET_CREATE_FAILED")?;
    let admission = target.begin_role_session_migration_import_internal(
        crate::RoleSessionMigrationImportBeginInput {
            role_id: exported.role_id,
            transfer_id: exported.transfer_id,
            expected_journal_revision: exported.journal_revision,
        },
    );
    target
        .shutdown_checked()
        .map_err(|_| "FIXTURE_TARGET_SHUTDOWN_FAILED")?;
    let admission = admission.map_err(|_| "FIXTURE_IMPORT_ADMISSION_FAILED")?;
    Ok(json!({"synthetic": true, "envelope": envelope,
        "canonicalEnvelopeBase64": STANDARD.encode(envelope.canonical_envelope_json().map_err(|_| "FIXTURE_CANONICAL_FAILED")?),
        "evidence": evidence, "journal": admission, "rolePaths": role_paths}))
}
