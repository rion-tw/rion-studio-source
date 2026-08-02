const SOURCE_FLYFF_IDENTITY: &str = "source_identity_000000000000000000000000";
const TARGET_FLYFF_IDENTITY: &str = "target_identity_000000000000000000000000";

#[test]
fn flyff_identity_integrity_runs_even_when_every_sync_selector_is_disabled() {
    let observer = local_storage_sync_observer_script(&LocalStorageRuntimeConfig {
        codec: Some("flyff-client-settings-v7".to_owned()),
        dependent_role_ids: Vec::new(),
        generation: 1,
        keys: Vec::new(),
        selectors: Vec::new(),
        origin: "https://universe.flyff.com".to_owned(),
        source_role_id: None,
        token: "capability".to_owned(),
    })
    .unwrap();

    assert!(observer.contains("const flyffCodecEnabled = true"));
    assert!(observer.contains("repairLocalStorageCodecIdentity(state.selectors)"));
    assert!(observer.contains("FLYFF_IDENTITY_REPAIRED"));
    assert!(observer.contains("diagnosticCode: request.diagnosticCode"));
    assert!(observer.contains("parseFlyffLengthPrefixed(lines[8], 65536)"));
    assert!(!observer.contains("flyffInteger"));
    assert!(!observer.contains("validFlyffBindings"));
}

#[test]
fn flyff_v7_selector_capture_and_merge_preserve_identity_and_unknown_fields() {
    let selectors = rion_core::FLYFF_LOCAL_STORAGE_SYNC_SELECTORS
        .iter()
        .map(|selector| (*selector).to_owned())
        .collect::<Vec<_>>();
    let source_value = flyff_codec_reference::fixture(SOURCE_FLYFF_IDENTITY, "0.5");
    let target_value = flyff_codec_reference::fixture(TARGET_FLYFF_IDENTITY, "1");
    let source = flyff_codec_reference::parse(&source_value).unwrap();
    let target = flyff_codec_reference::parse(&target_value).unwrap();

    let entries = source.capture(&selectors).unwrap();
    let cached = serde_json::to_string(&entries).unwrap();
    assert!(!cached.contains(SOURCE_FLYFF_IDENTITY));
    assert!(!cached.contains("game_client_sessions"));

    let merged_value = target.merge(&entries).unwrap();
    let merged = flyff_codec_reference::parse(&merged_value).unwrap();
    assert_eq!(merged.line(4), format!("40 {TARGET_FLYFF_IDENTITY}"));
    assert_eq!(merged.line(47), target.line(47));
    assert_eq!(merged.line(55), "0.5");
    assert_eq!(merged.line(43), "future-bindings-format");
    assert_eq!(merged.line(50), "future-hotbars-format");
    for selector in &selectors {
        for index in flyff_selector_line_indices(selector).unwrap() {
            assert_eq!(merged.line(index), source.line(index), "{selector} line {index}");
        }
    }
}

#[test]
fn flyff_v7_codec_fails_closed_for_unknown_or_malformed_payloads() {
    let valid = flyff_codec_reference::fixture(SOURCE_FLYFF_IDENTITY, "9");
    let mut unknown_version = valid.clone();
    unknown_version.replace_range(2..3, "8");
    assert!(flyff_codec_reference::parse(&unknown_version).is_err());

    let missing_line = valid.replacen("\n0\n", "\n", 1);
    assert!(flyff_codec_reference::parse(&missing_line).is_err());

    let malformed_layout = valid.replacen("8 1 2  3 9", "7 1 2  3 9", 1);
    assert!(flyff_codec_reference::parse(&malformed_layout).is_err());

    let malformed_identity = valid.replacen(
        &format!("40 {SOURCE_FLYFF_IDENTITY}"),
        "3 bad",
        1,
    );
    assert!(flyff_codec_reference::parse(&malformed_identity).is_err());

    let oversized = "0".repeat(1_048_577);
    assert!(flyff_codec_reference::parse(&oversized).is_err());
}

#[test]
fn flyff_v7_selector_fields_require_exact_bounded_line_mappings() {
    let selectors = vec!["game_client_settings.audio".to_owned()];
    let entry = |values: Vec<(usize, String)>| {
        vec![(
            selectors[0].clone(),
            Some(serde_json::to_string(&values).unwrap()),
        )]
    };
    let valid = entry(
        ["0.5", "1", "0", "1", "future-audio-value"]
            .into_iter()
            .enumerate()
            .map(|(offset, value)| (55 + offset, value.to_owned()))
            .collect(),
    );
    assert!(validate_flyff_selector_entries(&selectors, &valid).is_ok());

    for invalid in [
        entry(vec![
            (54, "0.5".to_owned()),
            (56, "1".to_owned()),
            (57, "0".to_owned()),
            (58, "1".to_owned()),
            (59, "1".to_owned()),
        ]),
        entry(vec![
            (55, "0.5".to_owned()),
            (55, "1".to_owned()),
            (57, "0".to_owned()),
            (58, "1".to_owned()),
            (59, "1".to_owned()),
        ]),
        entry(vec![
            (55, "0.5\ninjected".to_owned()),
            (56, "1".to_owned()),
            (57, "0".to_owned()),
            (58, "1".to_owned()),
            (59, "1".to_owned()),
        ]),
        entry(vec![
            (55, "x".repeat(16_385)),
            (56, "1".to_owned()),
            (57, "0".to_owned()),
            (58, "1".to_owned()),
            (59, "1".to_owned()),
        ]),
    ] {
        assert!(validate_flyff_selector_entries(&selectors, &invalid).is_err());
    }
}

#[test]
fn flyff_v7_identity_repair_uses_only_one_strict_session_identity() {
    let target = flyff_codec_reference::fixture(TARGET_FLYFF_IDENTITY, "3");
    let source_session = flyff_codec_reference::sessions(&[(SOURCE_FLYFF_IDENTITY, "角色")]);
    let repaired = flyff_codec_reference::repair_identity(&target, &source_session)
        .unwrap()
        .unwrap();
    let before = flyff_codec_reference::parse(&target).unwrap();
    let after = flyff_codec_reference::parse(&repaired).unwrap();
    assert_eq!(after.line(4), format!("40 {SOURCE_FLYFF_IDENTITY}"));
    for index in (0..FLYFF_SETTINGS_LINE_COUNT).filter(|index| *index != 4) {
        assert_eq!(after.line(index), before.line(index), "line {index}");
    }

    let matching = flyff_codec_reference::fixture(SOURCE_FLYFF_IDENTITY, "3");
    assert!(flyff_codec_reference::repair_identity(&matching, &source_session)
        .unwrap()
        .is_none());

    let empty = flyff_codec_reference::sessions(&[]);
    assert_eq!(
        flyff_codec_reference::repair_identity(&target, &empty)
            .unwrap_err()
            .code,
        "LOCAL_STORAGE_SYNC_FLYFF_SESSION_MISSING"
    );
    let ambiguous = flyff_codec_reference::sessions(&[
        (SOURCE_FLYFF_IDENTITY, "角色一"),
        (TARGET_FLYFF_IDENTITY, "角色二"),
    ]);
    assert_eq!(
        flyff_codec_reference::repair_identity(&target, &ambiguous)
            .unwrap_err()
            .code,
        "LOCAL_STORAGE_SYNC_FLYFF_SESSION_AMBIGUOUS"
    );
}
