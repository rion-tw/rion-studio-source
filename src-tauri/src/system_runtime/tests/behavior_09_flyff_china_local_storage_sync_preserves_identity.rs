const SOURCE_FLYFF_CHINA_IDENTITY: &str = "source_identity_000000000000000000000000";
const TARGET_FLYFF_CHINA_IDENTITY: &str = "target_identity_000000000000000000000000";

#[test]
fn flyff_china_identity_integrity_runs_even_when_every_sync_selector_is_disabled() {
    let observer = local_storage_sync_observer_script(&LocalStorageRuntimeConfig {
        codec: Some("flyff-china-client-settings".to_owned()),
        dependent_role_ids: Vec::new(),
        generation: 1,
        keys: Vec::new(),
        selectors: Vec::new(),
        origin: "https://ffcli.ruiwoo.cn".to_owned(),
        source_role_id: None,
        token: "capability".to_owned(),
    })
    .unwrap();

    assert!(observer.contains("const flyff_chinaCodecEnabled = true"));
    assert!(observer.contains("repairLocalStorageCodecIdentity(state.selectors)"));
    assert!(observer.contains("FLYFF_CHINA_IDENTITY_REPAIRED"));
    assert!(observer.contains("diagnosticCode: request.diagnosticCode"));
}

#[test]
fn flyff_china_v7_selector_capture_and_merge_preserve_identity_and_unknown_fields() {
    let selectors = rion_core::FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS
        .iter()
        .map(|selector| (*selector).to_owned())
        .collect::<Vec<_>>();
    let source_value = flyff_china_codec_reference::fixture(SOURCE_FLYFF_CHINA_IDENTITY, 9);
    let target_value = flyff_china_codec_reference::fixture(TARGET_FLYFF_CHINA_IDENTITY, 3);
    let source = flyff_china_codec_reference::parse(&source_value).unwrap();
    let target = flyff_china_codec_reference::parse(&target_value).unwrap();

    let entries = source.capture(&selectors).unwrap();
    let cached = serde_json::to_string(&entries).unwrap();
    assert!(!cached.contains(SOURCE_FLYFF_CHINA_IDENTITY));
    assert!(!cached.contains("game_client_sessions"));

    let merged_value = target.merge(&entries).unwrap();
    let merged = flyff_china_codec_reference::parse(&merged_value).unwrap();
    assert_eq!(merged.line(4), format!("40 {TARGET_FLYFF_CHINA_IDENTITY}"));
    assert_eq!(merged.line(47), target.line(47));
    for selector in &selectors {
        for index in flyff_china_selector_line_indices(selector).unwrap() {
            assert_eq!(merged.line(index), source.line(index), "{selector} line {index}");
        }
    }
}

#[test]
fn flyff_china_v7_codec_fails_closed_for_unknown_or_malformed_payloads() {
    let valid = flyff_china_codec_reference::fixture(SOURCE_FLYFF_CHINA_IDENTITY, 9);
    let mut unknown_version = valid.clone();
    unknown_version.replace_range(2..3, "8");
    assert!(flyff_china_codec_reference::parse(&unknown_version).is_err());

    let missing_line = valid.replacen("\n0\n", "\n", 1);
    assert!(flyff_china_codec_reference::parse(&missing_line).is_err());

    let malformed_layout = valid.replacen("8 1 2  3 9", "7 1 2  3 9", 1);
    assert!(flyff_china_codec_reference::parse(&malformed_layout).is_err());

    let oversized = "0".repeat(1_048_577);
    assert!(flyff_china_codec_reference::parse(&oversized).is_err());
}

#[test]
fn flyff_china_v7_identity_repair_uses_only_one_strict_session_identity() {
    let target = flyff_china_codec_reference::fixture(TARGET_FLYFF_CHINA_IDENTITY, 3);
    let source_session = flyff_china_codec_reference::sessions(&[(SOURCE_FLYFF_CHINA_IDENTITY, "角色")]);
    let repaired = flyff_china_codec_reference::repair_identity(&target, &source_session)
        .unwrap()
        .unwrap();
    let before = flyff_china_codec_reference::parse(&target).unwrap();
    let after = flyff_china_codec_reference::parse(&repaired).unwrap();
    assert_eq!(after.line(4), format!("40 {SOURCE_FLYFF_CHINA_IDENTITY}"));
    for index in (0..FLYFF_CHINA_SETTINGS_LINE_COUNT).filter(|index| *index != 4) {
        assert_eq!(after.line(index), before.line(index), "line {index}");
    }

    let matching = flyff_china_codec_reference::fixture(SOURCE_FLYFF_CHINA_IDENTITY, 3);
    assert!(flyff_china_codec_reference::repair_identity(&matching, &source_session)
        .unwrap()
        .is_none());

    let empty = flyff_china_codec_reference::sessions(&[]);
    assert_eq!(
        flyff_china_codec_reference::repair_identity(&target, &empty)
            .unwrap_err()
            .code,
        "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SESSION_MISSING"
    );
    let ambiguous = flyff_china_codec_reference::sessions(&[
        (SOURCE_FLYFF_CHINA_IDENTITY, "角色一"),
        (TARGET_FLYFF_CHINA_IDENTITY, "角色二"),
    ]);
    assert_eq!(
        flyff_china_codec_reference::repair_identity(&target, &ambiguous)
            .unwrap_err()
            .code,
        "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SESSION_AMBIGUOUS"
    );
}
