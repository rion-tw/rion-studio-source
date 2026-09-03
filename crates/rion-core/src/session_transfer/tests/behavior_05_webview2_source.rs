fn windows_source_evidence() -> RoleSessionTransferSourceEvidenceRecord {
    RoleSessionTransferSourceEvidenceRecord {
        kind: RoleSessionTransferSourceEvidenceKind::Webview2StorageGetCookies,
        runtime_version: "151.0.3900.0".to_owned(),
        protocol_version: "1.3".to_owned(),
        partition_capability:
            RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque,
    }
}

fn windows_test_envelope() -> RoleSessionTransferEnvelopeRecord {
    let mut envelope = test_envelope();
    envelope.metadata.platform = RoleSessionMigrationPlatform::Windows;
    envelope.metadata.source_engine = RoleSessionMigrationEngine::Webview2;
    envelope.metadata.source_evidence = Some(windows_source_evidence());
    envelope
}

fn webview2_leveldb_fixture(
    profile: &Path,
    records: impl IntoIterator<Item = (Vec<u8>, Vec<u8>)>,
) -> PathBuf {
    let path = profile.join("Local Storage/leveldb");
    std::fs::create_dir_all(&path).unwrap();
    let options = Options {
        create_if_missing: true,
        ..Options::default()
    };
    let mut database = DB::open(&path, options).unwrap();
    for (key, value) in records {
        database.put(&key, &value).unwrap();
    }
    database.flush().unwrap();
    drop(database);
    path
}

fn chromium_latin1(value: &[u8]) -> Vec<u8> {
    [b"\x01".as_slice(), value].concat()
}

fn chromium_utf16(value: &[u16]) -> Vec<u8> {
    let mut bytes = vec![0];
    for code_unit in value {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    bytes
}

fn decoded_utf16(record: &RoleSessionTransferBytesRecord) -> Vec<u16> {
    record
        .decoded_bytes()
        .unwrap()
        .chunks_exact(2)
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
        .collect()
}

#[test]
fn source_evidence_is_windows_only_and_version_fields_are_canonical() {
    windows_test_envelope().validate().unwrap();

    let mut missing = windows_test_envelope();
    missing.metadata.source_evidence = None;
    expect_error(
        missing.validate(),
        "ROLE_SESSION_TRANSFER_SOURCE_EVIDENCE_INVALID",
    );

    let mut misplaced = test_envelope();
    misplaced.metadata.source_evidence = Some(windows_source_evidence());
    expect_error(
        misplaced.validate(),
        "ROLE_SESSION_TRANSFER_SOURCE_EVIDENCE_INVALID",
    );

    for invalid_protocol in ["", "1", "01.3", "1.03", "1.3.1", "1.a"] {
        let mut invalid = windows_test_envelope();
        invalid
            .metadata
            .source_evidence
            .as_mut()
            .unwrap()
            .protocol_version = invalid_protocol.to_owned();
        expect_error(
            invalid.validate(),
            "ROLE_SESSION_TRANSFER_SOURCE_EVIDENCE_INVALID",
        );
    }

    let mut control = windows_test_envelope();
    control
        .metadata
        .source_evidence
        .as_mut()
        .unwrap()
        .runtime_version = "151.0\nsecret".to_owned();
    let message = expect_error(
        control.validate(),
        "ROLE_SESSION_TRANSFER_SOURCE_EVIDENCE_INVALID",
    );
    assert!(!message.contains("secret"));
}

#[test]
fn source_evidence_rejects_future_fields_and_missing_partition_capability() {
    let mut future = serde_json::to_value(windows_test_envelope()).unwrap();
    future["metadata"]["sourceEvidence"]
        .as_object_mut()
        .unwrap()
        .insert("futurePartitionSemantics".to_owned(), true.into());
    expect_error(
        RoleSessionTransferEnvelopeRecord::from_json(&serde_json::to_vec(&future).unwrap()),
        "ROLE_SESSION_TRANSFER_ENVELOPE_INVALID",
    );

    let mut missing = serde_json::to_value(windows_test_envelope()).unwrap();
    missing["metadata"]["sourceEvidence"]
        .as_object_mut()
        .unwrap()
        .remove("partitionCapability");
    expect_error(
        RoleSessionTransferEnvelopeRecord::from_json(&serde_json::to_vec(&missing).unwrap()),
        "ROLE_SESSION_TRANSFER_ENVELOPE_INVALID",
    );
}

#[test]
fn real_leveldb_fixture_preserves_latin1_utf16_and_lone_surrogates() {
    let directory = tempfile::tempdir().unwrap();
    let origin = b"https://game.example.test";
    let data_prefix = [b"_".as_slice(), origin, b"\0"].concat();
    let leveldb = webview2_leveldb_fixture(
        directory.path(),
        [
            (b"VERSION".to_vec(), b"1".to_vec()),
            (
                [b"META:".as_slice(), origin].concat(),
                // Chromium LocalStorage metadata is opaque to the exporter;
                // these are persisted protobuf wire bytes from the v22 schema.
                vec![0x08, 0x80, 0x80, 0x80, 0x80, 0x10],
            ),
            (
                [b"METAACCESS:".as_slice(), origin].concat(),
                vec![0x08, 0x81, 0x01],
            ),
            (
                [
                    data_prefix.as_slice(),
                    chromium_latin1(b"caf\xe9").as_slice(),
                ]
                .concat(),
                chromium_utf16(&[0xd800, 0x0041]),
            ),
            (
                [data_prefix.as_slice(), chromium_utf16(&[0x4f60]).as_slice()].concat(),
                chromium_latin1(b"ol\xe9"),
            ),
        ],
    );
    assert!(leveldb.join("LOCK").is_file());

    let inventory = read_webview2_local_storage_source_internal(directory.path()).unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].origin, "https://game.example.test");
    assert_eq!(inventory[0].entries.len(), 2);
    assert!(
        inventory[0]
            .entries
            .iter()
            .any(|entry| decoded_utf16(&entry.key)
                == vec![b'c' as u16, b'a' as u16, b'f' as u16, 0xe9]
                && decoded_utf16(&entry.value) == vec![0xd800, 0x0041])
    );
    assert!(
        inventory[0]
            .entries
            .iter()
            .any(|entry| decoded_utf16(&entry.key) == vec![0x4f60]
                && decoded_utf16(&entry.value) == vec![b'o' as u16, b'l' as u16, 0xe9])
    );
    RoleSessionTransferEnvelopeRecord {
        metadata: windows_test_envelope().metadata,
        inventory: RoleSessionTransferInventoryRecord {
            cookies: Vec::new(),
            local_storage: inventory,
        },
    }
    .validate()
    .unwrap();
}

#[test]
fn unknown_records_partitioned_origins_and_incomplete_metadata_fail_closed() {
    let cases = [
        (
            b"UNKNOWN".to_vec(),
            b"opaque".to_vec(),
            "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_LAYOUT_UNSUPPORTED",
        ),
        (
            b"META:https://game.example.test/^0https://top.example.test".to_vec(),
            vec![1],
            "ROLE_SESSION_TRANSFER_WEBVIEW2_LOCAL_STORAGE_ORIGIN_UNSUPPORTED",
        ),
        (
            b"META:file://local-source".to_vec(),
            vec![1],
            "ROLE_SESSION_TRANSFER_WEBVIEW2_LOCAL_STORAGE_ORIGIN_UNSUPPORTED",
        ),
        (
            [
                b"_https://game.example.test\0".as_slice(),
                chromium_latin1(b"key").as_slice(),
            ]
            .concat(),
            chromium_latin1(b"value"),
            "ROLE_SESSION_TRANSFER_WEBVIEW2_LOCAL_STORAGE_INCOMPLETE",
        ),
        (
            b"METAACCESS:https://game.example.test".to_vec(),
            vec![1],
            "ROLE_SESSION_TRANSFER_WEBVIEW2_LOCAL_STORAGE_INCOMPLETE",
        ),
    ];
    for (key, value, expected_code) in cases {
        let directory = tempfile::tempdir().unwrap();
        webview2_leveldb_fixture(
            directory.path(),
            [(b"VERSION".to_vec(), b"1".to_vec()), (key, value)],
        );
        expect_error(
            read_webview2_local_storage_source_internal(directory.path()),
            expected_code,
        );
    }
}

#[cfg(unix)]
#[test]
fn source_symlinks_profile_escape_and_open_file_identity_changes_are_rejected() {
    use std::os::unix::fs::symlink;

    let profile = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(outside.path().join("leveldb")).unwrap();
    symlink(outside.path(), profile.path().join("Local Storage")).unwrap();
    expect_error(
        read_webview2_local_storage_source_internal(profile.path()),
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_LAYOUT_UNSUPPORTED",
    );

    let profile = tempfile::tempdir().unwrap();
    let leveldb = webview2_leveldb_fixture(
        profile.path(),
        [
            (b"VERSION".to_vec(), b"1".to_vec()),
            (b"META:https://game.example.test".to_vec(), vec![1]),
        ],
    );
    symlink(leveldb.join("CURRENT"), leveldb.join("unexpected-link")).unwrap();
    expect_error(
        read_webview2_local_storage_source_internal(profile.path()),
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_LAYOUT_UNSUPPORTED",
    );

    let identity = tempfile::tempdir().unwrap();
    let source = identity.path().join("source");
    let replacement = identity.path().join("replacement");
    std::fs::write(&source, b"one").unwrap();
    std::fs::write(&replacement, b"two").unwrap();
    let opened = open_source_file(&source).unwrap();
    std::fs::rename(&replacement, &source).unwrap();
    expect_error(
        validate_source_file_identity(&source, &opened),
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_IDENTITY_CHANGED",
    );
}

#[test]
fn pending_vault_resume_returns_only_authenticated_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;
    let expected = write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();

    let pending = pending_session_transfer_vault_evidence_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &protector,
    )
    .unwrap()
    .unwrap();
    assert_eq!(pending, expected);
    let metadata = serde_json::to_string(&pending).unwrap();
    assert!(!metadata.contains("secret"));

    let absent = tempfile::tempdir().unwrap();
    assert!(
        pending_session_transfer_vault_evidence_with(
            absent.path(),
            rion_platform::Platform::Macos,
            &journal,
            &protector,
        )
        .unwrap()
        .is_none()
    );
}
