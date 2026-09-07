//! Desktop-E2E-only known-answer source. Never built into production addons.
use rion_core::*;

pub(crate) fn prepare(core: &AppCore, role: String, partial: bool) -> Result<String, CoreError> {
    let platform = if cfg!(target_os = "macos") {
        RoleSessionMigrationPlatform::Macos
    } else {
        RoleSessionMigrationPlatform::Windows
    };
    let engine = if platform == RoleSessionMigrationPlatform::Macos {
        RoleSessionMigrationEngine::Wkwebview
    } else {
        RoleSessionMigrationEngine::Webview2
    };
    let transfer = uuid::Uuid::new_v4().to_string();
    let source = core.start_role_session_migration(RoleSessionMigrationStartInput {
        role_id: role.clone(),
        transfer_id: transfer.clone(),
        platform,
        source_engine: engine,
        target_engine: RoleSessionMigrationEngine::Chromium,
        source_revision: 1,
    })?;
    let launch = core.invoke(CoreCommand::RoleGet { id: role.clone() })?;
    let launch_origin = url::Url::parse(
        launch["launchUrl"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidInput("Missing synthetic launch URL".to_owned()))?,
    )
    .map_err(|_| CoreError::InvalidInput("Invalid synthetic launch URL".to_owned()))?
    .origin()
    .ascii_serialization();
    let mut local_storage = vec![RoleSessionTransferLocalStorageOriginRecord {
        origin: if partial {
            launch_origin
        } else {
            "https://recovery.invalid".to_owned()
        },
        entries: vec![RoleSessionTransferLocalStorageEntryRecord {
            key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&if partial {
                "rion-e2e-session".encode_utf16().collect::<Vec<_>>()
            } else {
                vec![0x91cc, 0x512a]
            }),
            value: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&if partial {
                "retained-upgrade".encode_utf16().collect::<Vec<_>>()
            } else {
                vec![0xd800, 0, 0xdfff]
            }),
        }],
    }];
    if partial {
        local_storage.push(RoleSessionTransferLocalStorageOriginRecord {
            origin: "https://secondary-upgrade.invalid".to_owned(),
            entries: vec![RoleSessionTransferLocalStorageEntryRecord {
                key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[0x7b2c, 0x4e8c]),
                value: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[
                    0xd800, 0, 0xdfff,
                ]),
            }],
        });
    }
    let envelope = RoleSessionTransferEnvelopeRecord {
        metadata: RoleSessionTransferMetadataRecord {
            format: RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: 1,
            role_id: role.clone(),
            transfer_id: transfer.clone(),
            platform,
            source_engine: engine,
            target_engine: RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
            source_evidence: (platform == RoleSessionMigrationPlatform::Windows).then(|| {
                RoleSessionTransferSourceEvidenceRecord {
                    kind: RoleSessionTransferSourceEvidenceKind::Webview2StorageGetCookies,
                    runtime_version: "151.0.0.0".to_owned(),
                    protocol_version: "1.3".to_owned(),
                    partition_capability: RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque,
                }
            }),
        },
        inventory: RoleSessionTransferInventoryRecord {
            cookies: vec![RoleSessionTransferCookieRecord {
                name: RoleSessionTransferBytesRecord::from_bytes(b"synthetic-session"),
                value: RoleSessionTransferBytesRecord::from_bytes(b"known-answer"),
                domain: "recovery.invalid".to_owned(),
                path: "/".to_owned(),
                host_only: true,
                secure: true,
                http_only: true,
                expiry: RoleSessionTransferCookieExpiry::Absolute {
                    unix_ms: ((std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .expect("test clock after epoch")
                        .as_secs()
                        + if partial { 86_400 * 800 } else { 86_400 })
                        * 1000) as i64,
                },
                same_site: RoleSessionTransferCookieSameSite::Lax,
                partition: RoleSessionTransferCookiePartitionEvidence::Unpartitioned,
                unsupported_attribute_codes: Vec::new(),
            }],
            local_storage,
        },
    };
    let evidence =
        core.write_role_session_transfer_vault_internal(&envelope.canonical_envelope_json()?)?;
    let mut input = RoleSessionMigrationTransitionInput {
        role_id: role,
        transfer_id: transfer.clone(),
        transition_id: uuid::Uuid::new_v4().to_string(),
        expected_phase: source.phase,
        expected_journal_revision: source.journal_revision,
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
        occurred_at: source.updated_at,
    };
    evidence.apply_to_transition(&mut input)?;
    core.transition_role_session_migration(input)?;
    Ok(transfer)
}
