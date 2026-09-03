#[test]
fn canonical_serialization_is_order_independent_and_byte_lossless() {
    let envelope = test_envelope();
    let mut permuted = envelope.clone();
    permuted.inventory.cookies.reverse();
    permuted.inventory.local_storage.reverse();
    for origin in &mut permuted.inventory.local_storage {
        origin.entries.reverse();
    }

    assert_eq!(
        envelope.canonical_inventory_json().unwrap(),
        permuted.canonical_inventory_json().unwrap()
    );
    assert_eq!(
        envelope.canonical_envelope_json().unwrap(),
        permuted.canonical_envelope_json().unwrap()
    );
    assert_eq!(
        envelope.inventory_sha256().unwrap(),
        permuted.inventory_sha256().unwrap()
    );
    assert_eq!(
        envelope.envelope_sha256().unwrap(),
        permuted.envelope_sha256().unwrap()
    );

    let canonical = envelope.canonicalized().unwrap();
    assert_eq!(canonical.inventory.cookies[0].domain, "example.com");
    assert_eq!(canonical.inventory.cookies[1].domain, "www.example.com");
    assert_eq!(
        canonical.inventory.cookies[1].name.decoded_bytes().unwrap(),
        [0xff, b'a']
    );
    assert_eq!(
        canonical.inventory.cookies[1]
            .value
            .decoded_bytes()
            .unwrap(),
        [0x00, 0xfe, b'v']
    );
    assert_eq!(
        canonical.inventory.local_storage[0].origin,
        "https://a.example.com"
    );
    assert_eq!(
        canonical.inventory.local_storage[1].entries[0]
            .key
            .decoded_bytes()
            .unwrap(),
        0xd800_u16.to_le_bytes()
    );

    let inventory_json = envelope.canonical_inventory_json().unwrap();
    let reparsed: RoleSessionTransferInventoryRecord =
        serde_json::from_slice(&inventory_json).unwrap();
    assert_eq!(reparsed, canonical.inventory);
    assert!(!inventory_json.contains(&b'\n'));
    assert_eq!(
        RoleSessionTransferEnvelopeRecord::from_json(&envelope.canonical_envelope_json().unwrap())
            .unwrap(),
        canonical
    );

    for digest in [
        envelope.inventory_sha256().unwrap(),
        envelope.envelope_sha256().unwrap(),
    ] {
        assert_eq!(digest.len(), 64);
        assert!(
            digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
    }
}

#[test]
fn canonical_json_carries_explicit_format_and_cookie_evidence() {
    let envelope = test_envelope();
    let json: serde_json::Value =
        serde_json::from_slice(&envelope.canonical_envelope_json().unwrap()).unwrap();

    assert_eq!(
        json["metadata"]["format"],
        serde_json::json!("rion-role-session-transfer")
    );
    assert_eq!(json["metadata"]["version"], serde_json::json!(1));
    assert_eq!(
        json["metadata"]["sourceEngine"],
        serde_json::json!("wkwebview")
    );
    assert_eq!(
        json["metadata"]["targetEngine"],
        serde_json::json!("chromium")
    );
    assert_eq!(json["inventory"]["cookies"][0]["hostOnly"], true);
    assert_eq!(json["inventory"]["cookies"][0]["secure"], true);
    assert_eq!(json["inventory"]["cookies"][0]["httpOnly"], true);
    assert_eq!(json["inventory"]["cookies"][0]["expiry"]["kind"], "session");
    assert_eq!(json["inventory"]["cookies"][0]["sameSite"], "unspecified");
    assert_eq!(
        json["inventory"]["cookies"][0]["partition"]["kind"],
        "unpartitioned"
    );
    assert_eq!(
        json["inventory"]["localStorage"][0]["entries"][0]["key"]["encoding"],
        "base64Utf16Le"
    );
}
