#[test]
fn duplicate_cookie_and_local_storage_identities_are_rejected() {
    let mut duplicate_cookie = test_envelope();
    let mut cookie = duplicate_cookie.inventory.cookies[0].clone();
    cookie.value = RoleSessionTransferBytesRecord::from_bytes(b"different-secret");
    duplicate_cookie.inventory.cookies.push(cookie);
    expect_error(
        duplicate_cookie.validate(),
        "ROLE_SESSION_TRANSFER_COOKIE_DUPLICATE",
    );

    let mut duplicate_key = test_envelope();
    let entry = duplicate_key.inventory.local_storage[0].entries[0].clone();
    duplicate_key.inventory.local_storage[0].entries.push(entry);
    expect_error(
        duplicate_key.validate(),
        "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_DUPLICATE",
    );

    let mut duplicate_origin = test_envelope();
    let origin = duplicate_origin.inventory.local_storage[0].clone();
    duplicate_origin.inventory.local_storage.push(origin);
    expect_error(
        duplicate_origin.validate(),
        "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_ORIGIN_DUPLICATE",
    );
}

#[test]
fn partition_and_unsupported_cookie_evidence_fail_closed_without_secrets() {
    const PARTITION_SECRET: &str = "partition-secret-must-not-escape";
    const COOKIE_SECRET: &str = "cookie-secret-must-not-escape";

    let mut partitioned = test_envelope();
    partitioned.inventory.cookies[0].partition =
        RoleSessionTransferCookiePartitionEvidence::Partitioned {
            partition_key: Some(RoleSessionTransferBytesRecord::from_bytes(
                PARTITION_SECRET.as_bytes(),
            )),
            has_cross_site_ancestor: Some(true),
        };
    let message = expect_error(
        partitioned.validate(),
        "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED",
    );
    assert!(!message.contains(PARTITION_SECRET));

    let mut unknown_partition = test_envelope();
    unknown_partition.inventory.cookies[0].partition =
        RoleSessionTransferCookiePartitionEvidence::Unknown;
    expect_error(
        unknown_partition.validate(),
        "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED",
    );

    let mut unsupported = test_envelope();
    unsupported.inventory.cookies[0].value =
        RoleSessionTransferBytesRecord::from_bytes(COOKIE_SECRET.as_bytes());
    unsupported.inventory.cookies[0].unsupported_attribute_codes = vec!["SAME_PARTY".to_owned()];
    let message = expect_error(
        unsupported.validate(),
        "ROLE_SESSION_TRANSFER_COOKIE_ATTRIBUTE_UNSUPPORTED",
    );
    assert!(!message.contains(COOKIE_SECRET));
}

#[test]
fn malformed_secret_bytes_and_noncanonical_metadata_are_rejected_without_echo() {
    const INVALID_SECRET: &str = "not-base64-secret-must-not-escape$$";
    let mut malformed = test_envelope();
    malformed.inventory.cookies[0].value.data = INVALID_SECRET.to_owned();
    let message = expect_error(malformed.validate(), "ROLE_SESSION_TRANSFER_BYTES_INVALID");
    assert!(!message.contains(INVALID_SECRET));

    let mut wrong_cookie_encoding = test_envelope();
    wrong_cookie_encoding.inventory.cookies[0].name =
        RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[0x0061]);
    expect_error(
        wrong_cookie_encoding.validate(),
        "ROLE_SESSION_TRANSFER_BYTES_INVALID",
    );

    let mut wrong_storage_encoding = test_envelope();
    wrong_storage_encoding.inventory.local_storage[0].entries[0].key =
        RoleSessionTransferBytesRecord::from_bytes(b"key");
    expect_error(
        wrong_storage_encoding.validate(),
        "ROLE_SESSION_TRANSFER_BYTES_INVALID",
    );

    let mut odd_utf16 = test_envelope();
    odd_utf16.inventory.local_storage[0].entries[0].value = RoleSessionTransferBytesRecord {
        encoding: RoleSessionTransferByteEncoding::Base64Utf16Le,
        data: "AA==".to_owned(),
    };
    expect_error(
        odd_utf16.validate(),
        "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_ORIGIN_INVALID",
    );
}

#[test]
fn envelope_decoding_rejects_unknown_or_malformed_fields_without_echoing_them() {
    const UNKNOWN_SECRET: &str = "unknown-secret-field-must-not-escape";
    let mut json = serde_json::to_value(test_envelope()).unwrap();
    json["inventory"]["cookies"][0]
        .as_object_mut()
        .unwrap()
        .insert(
            UNKNOWN_SECRET.to_owned(),
            serde_json::Value::String(UNKNOWN_SECRET.to_owned()),
        );
    let message = expect_error(
        RoleSessionTransferEnvelopeRecord::from_json(&serde_json::to_vec(&json).unwrap()),
        "ROLE_SESSION_TRANSFER_ENVELOPE_INVALID",
    );
    assert!(!message.contains(UNKNOWN_SECRET));

    let malformed = format!(r#"{{"metadata":"{UNKNOWN_SECRET}""#);
    let message = expect_error(
        RoleSessionTransferEnvelopeRecord::from_json(malformed.as_bytes()),
        "ROLE_SESSION_TRANSFER_ENVELOPE_INVALID",
    );
    assert!(!message.contains(UNKNOWN_SECRET));
}

#[test]
fn identity_engine_origin_and_cookie_metadata_are_strict() {
    let mut wrong_version = test_envelope();
    wrong_version.metadata.version += 1;
    expect_error(
        wrong_version.validate(),
        "ROLE_SESSION_TRANSFER_VERSION_UNSUPPORTED",
    );

    let mut excessive_revision = test_envelope();
    excessive_revision.metadata.source_revision = u64::MAX;
    expect_error(
        excessive_revision.validate(),
        "ROLE_SESSION_TRANSFER_VERSION_UNSUPPORTED",
    );

    let mut noncanonical_identity = test_envelope();
    noncanonical_identity.metadata.role_id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".to_owned();
    expect_error(
        noncanonical_identity.validate(),
        "ROLE_SESSION_TRANSFER_IDENTITY_INVALID",
    );

    let mut wrong_engine = test_envelope();
    wrong_engine.metadata.platform = RoleSessionMigrationPlatform::Windows;
    expect_error(
        wrong_engine.validate(),
        "ROLE_SESSION_TRANSFER_ENGINE_INVALID",
    );

    let mut wrong_domain = test_envelope();
    wrong_domain.inventory.cookies[0].domain = "Example.com".to_owned();
    expect_error(
        wrong_domain.validate(),
        "ROLE_SESSION_TRANSFER_COOKIE_INVALID",
    );

    let mut non_origin_url = test_envelope();
    non_origin_url.inventory.local_storage[0].origin = "https://z.example.com/".to_owned();
    expect_error(
        non_origin_url.validate(),
        "ROLE_SESSION_TRANSFER_LOCAL_STORAGE_ORIGIN_INVALID",
    );
}

#[test]
fn count_field_and_total_byte_limits_are_enforced() {
    let envelope = test_envelope();
    let limits = RoleSessionTransferValidationLimits {
        max_cookies: 1,
        ..DEFAULT_VALIDATION_LIMITS
    };
    expect_error(
        canonicalize_with_limits(&envelope, limits),
        "ROLE_SESSION_TRANSFER_LIMIT_EXCEEDED",
    );

    let limits = RoleSessionTransferValidationLimits {
        max_local_storage_entries: 2,
        ..DEFAULT_VALIDATION_LIMITS
    };
    expect_error(
        canonicalize_with_limits(&envelope, limits),
        "ROLE_SESSION_TRANSFER_LIMIT_EXCEEDED",
    );

    let limits = RoleSessionTransferValidationLimits {
        max_total_bytes: 1,
        ..DEFAULT_VALIDATION_LIMITS
    };
    expect_error(
        canonicalize_with_limits(&envelope, limits),
        "ROLE_SESSION_TRANSFER_LIMIT_EXCEEDED",
    );

    let mut oversized_name = test_envelope();
    oversized_name.inventory.cookies[0].name =
        RoleSessionTransferBytesRecord::from_bytes(&vec![b'a'; MAX_COOKIE_NAME_BYTES + 1]);
    expect_error(
        oversized_name.validate(),
        "ROLE_SESSION_TRANSFER_BYTES_INVALID",
    );
}

#[test]
fn canonical_envelope_limit_is_exactly_the_rsp2_plaintext_ceiling() {
    assert_eq!(
        ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES,
        rion_platform::SESSION_TRANSFER_V2_MAX_PLAINTEXT_BYTES
    );
    assert_eq!(
        ROLE_SESSION_TRANSFER_MAX_TOTAL_BYTES,
        ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES
    );
    validate_canonical_envelope_length(ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES).unwrap();
    expect_error(
        validate_canonical_envelope_length(ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES + 1),
        "ROLE_SESSION_TRANSFER_LIMIT_EXCEEDED",
    );
}

#[test]
fn actual_canonical_envelope_is_accepted_near_rsp2_limit_and_rejected_above_it() {
    fn large_utf16_value(decoded_bytes: usize) -> RoleSessionTransferBytesRecord {
        assert_eq!(decoded_bytes % 2, 0);
        RoleSessionTransferBytesRecord {
            encoding: RoleSessionTransferByteEncoding::Base64Utf16Le,
            data: BASE64_STANDARD.encode(vec![0_u8; decoded_bytes]),
        }
    }

    let mebibyte = 1024 * 1024;
    let mut envelope = test_envelope();
    envelope.inventory.cookies.clear();
    envelope.inventory.local_storage = vec![RoleSessionTransferLocalStorageOriginRecord {
        origin: "https://limit.example.com".to_owned(),
        entries: vec![
            RoleSessionTransferLocalStorageEntryRecord {
                key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[1]),
                value: large_utf16_value(15 * mebibyte),
            },
            RoleSessionTransferLocalStorageEntryRecord {
                key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[2]),
                value: large_utf16_value(16 * mebibyte),
            },
            RoleSessionTransferLocalStorageEntryRecord {
                key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&[3]),
                value: large_utf16_value(16 * mebibyte),
            },
        ],
    }];

    let near_limit = envelope.canonical_envelope_json().unwrap();
    assert!(near_limit.len() > ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES - 2 * mebibyte);
    assert!(near_limit.len() <= ROLE_SESSION_TRANSFER_MAX_CANONICAL_ENVELOPE_BYTES);
    drop(near_limit);

    envelope.inventory.local_storage[0].entries[0].value = large_utf16_value(16 * mebibyte);
    expect_error(envelope.validate(), "ROLE_SESSION_TRANSFER_LIMIT_EXCEEDED");
}
