use std::{env, error::Error, io, path::Path, process::ExitCode};

use rion_core::{
    AppCore, AppCoreOptions, CoreCommand, ROLE_SESSION_TRANSFER_VERSION, RoleCreateInputRecord,
    RoleSessionMigrationEngine, RoleSessionMigrationPhase, RoleSessionMigrationPlatform,
    RoleSessionMigrationRecord, RoleSessionMigrationTransitionInput,
    RoleSessionTransferCookiePartitionCapability, RoleSessionTransferEnvelopeRecord,
    RoleSessionTransferFormat, RoleSessionTransferInventoryRecord,
    RoleSessionTransferMetadataRecord, RoleSessionTransferSourceEvidenceKind,
    RoleSessionTransferSourceEvidenceRecord,
};

const EXPORT_TRANSITION_ID: &str = "30000000-0000-4000-8000-000000000101";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("native integration fixture failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args().skip(1);
    let user_data_dir = arguments.next().ok_or_else(|| {
        fixture_error("usage: rion-node-native-integration-fixture <user-data-dir> <platform>")
    })?;
    let platform = arguments.next().ok_or_else(|| {
        fixture_error("usage: rion-node-native-integration-fixture <user-data-dir> <platform>")
    })?;
    if arguments.next().is_some() || !Path::new(&user_data_dir).is_absolute() {
        return Err(fixture_error(
            "the fixture requires exactly one absolute user-data directory and one platform",
        ));
    }

    let (migration_platform, source_engine, source_evidence) = fixture_platform(&platform)?;
    let core = AppCore::create(AppCoreOptions {
        user_data_dir,
        platform,
        app_version: "22.0.0-native-integration".to_owned(),
        build_commit: None,
        packaged: false,
        runtime_contract_version: Some(22),
        performance_telemetry_path: None,
    })?;
    let seeded = seed_exported_migration(&core, migration_platform, source_engine, source_evidence);
    core.shutdown();
    let exported = seeded?;
    println!("{}", serde_json::to_string(&exported)?);
    Ok(())
}

fn fixture_platform(
    platform: &str,
) -> Result<
    (
        RoleSessionMigrationPlatform,
        RoleSessionMigrationEngine,
        Option<RoleSessionTransferSourceEvidenceRecord>,
    ),
    Box<dyn Error>,
> {
    let host_platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "unsupported"
    };
    if platform != host_platform {
        return Err(fixture_error(
            "the source fixture must seed the current native host platform",
        ));
    }
    match platform {
        "darwin" => Ok((
            RoleSessionMigrationPlatform::Macos,
            RoleSessionMigrationEngine::Wkwebview,
            None,
        )),
        "win32" => Ok((
            RoleSessionMigrationPlatform::Windows,
            RoleSessionMigrationEngine::Webview2,
            Some(RoleSessionTransferSourceEvidenceRecord {
                kind: RoleSessionTransferSourceEvidenceKind::Webview2StorageGetCookies,
                runtime_version: "143.0.3650.75".to_owned(),
                protocol_version: "1.3".to_owned(),
                partition_capability:
                    RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque,
            }),
        )),
        _ => Err(fixture_error(
            "native integration is supported only on macOS and Windows",
        )),
    }
}

fn seed_exported_migration(
    core: &AppCore,
    platform: RoleSessionMigrationPlatform,
    source_engine: RoleSessionMigrationEngine,
    source_evidence: Option<RoleSessionTransferSourceEvidenceRecord>,
) -> Result<RoleSessionMigrationRecord, Box<dyn Error>> {
    let games = core.invoke(CoreCommand::GamesList)?;
    let game_id = games
        .as_array()
        .and_then(|records| records.first())
        .and_then(|record| record.get("id"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fixture_error("Core did not expose a seed game"))?;
    let role = core.invoke(CoreCommand::RoleCreate {
        input: RoleCreateInputRecord {
            game_id: game_id.to_owned(),
            name: "Native integration role".to_owned(),
            launch_url: Some("https://example.test/play".to_owned()),
            notes: None,
            cover_image_data_url: None,
            cover_image_dominant_color: None,
        },
    })?;
    let role_id = role
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fixture_error("Core did not return the created role identity"))?;
    let prepared = core
        .prepare_v22_role_session_migrations_internal()?
        .into_iter()
        .find(|record| record.role_id == role_id)
        .ok_or_else(|| fixture_error("Core did not prepare the created role migration"))?;

    let envelope = RoleSessionTransferEnvelopeRecord {
        metadata: RoleSessionTransferMetadataRecord {
            format: RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: ROLE_SESSION_TRANSFER_VERSION,
            transfer_id: prepared.transfer_id.clone(),
            role_id: prepared.role_id.clone(),
            platform,
            source_engine,
            target_engine: RoleSessionMigrationEngine::Chromium,
            source_revision: prepared.source_revision,
            source_evidence,
        },
        inventory: RoleSessionTransferInventoryRecord {
            cookies: Vec::new(),
            local_storage: Vec::new(),
        },
    };
    let evidence =
        core.write_role_session_transfer_vault_internal(&envelope.canonical_envelope_json()?)?;
    let mut transition = RoleSessionMigrationTransitionInput {
        role_id: prepared.role_id,
        transfer_id: prepared.transfer_id,
        transition_id: EXPORT_TRANSITION_ID.to_owned(),
        expected_phase: RoleSessionMigrationPhase::V22Ready,
        expected_journal_revision: prepared.journal_revision,
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
        occurred_at: prepared.updated_at,
    };
    evidence.apply_to_transition(&mut transition)?;
    Ok(core.transition_role_session_migration(transition)?)
}

fn fixture_error(message: &'static str) -> Box<dyn Error> {
    io::Error::new(io::ErrorKind::InvalidInput, message).into()
}
