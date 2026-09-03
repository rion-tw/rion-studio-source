use super::*;

#[test]
fn phase_names_are_stable_and_runtime_authority_rejects_graph_skips() {
    assert_eq!(
        serde_json::to_string(&RoleSessionMigrationPhase::V22Ready).unwrap(),
        "\"v22Ready\""
    );
    assert_eq!(
        serde_json::to_string(&RoleSessionMigrationPhase::V23Ready).unwrap(),
        "\"v23Ready\""
    );
    let source = TransitionAuthority::SourceRuntime {
        expected_platform: RoleSessionMigrationPlatform::Macos,
    };
    assert!(
        authorize_transition(
            RoleSessionMigrationPhase::V22Ready,
            RoleSessionMigrationPhase::Exported,
            source,
        )
        .is_ok()
    );
    assert!(
        authorize_transition(
            RoleSessionMigrationPhase::V22Ready,
            RoleSessionMigrationPhase::Importing,
            source,
        )
        .is_err()
    );
    let target = TransitionAuthority::TargetRuntime {
        expected_platform: RoleSessionMigrationPlatform::Macos,
    };
    assert!(
        authorize_transition(
            RoleSessionMigrationPhase::V23Ready,
            RoleSessionMigrationPhase::V22Ready,
            target,
        )
        .is_err()
    );
}

#[test]
fn validators_never_echo_rejected_session_values() {
    let secret = "https://account.example.test/private-cookie-value";
    for error in [
        validate_digest(secret).unwrap_err(),
        validate_optional_stable_code(Some(secret)).unwrap_err(),
        validate_optional_opaque_id(Some(secret)).unwrap_err(),
    ] {
        assert!(!error.to_string().contains(secret));
        assert!(!error.to_string().contains("example.test"));
    }
}

#[test]
fn start_requires_canonical_ids_and_the_platform_source_engine_pair() {
    let valid = RoleSessionMigrationStartInput {
        role_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        transfer_id: "10000000-0000-4000-8000-000000000001".to_owned(),
        platform: RoleSessionMigrationPlatform::Macos,
        source_engine: RoleSessionMigrationEngine::Wkwebview,
        target_engine: RoleSessionMigrationEngine::Chromium,
        source_revision: 22,
    };
    assert!(validate_start_input(&valid).is_ok());

    let mut invalid_role = valid.clone();
    invalid_role.role_id = "../role".to_owned();
    let invalid_role_error = validate_start_input(&invalid_role).unwrap_err();
    assert_eq!(invalid_role_error.code(), "CORE_INPUT_INVALID");
    assert!(!invalid_role_error.to_string().contains("../role"));

    let mut invalid_pair = valid.clone();
    invalid_pair.source_engine = RoleSessionMigrationEngine::Webview2;
    assert_eq!(
        validate_start_input(&invalid_pair).unwrap_err().code(),
        "CORE_INPUT_INVALID"
    );

    let mut invalid_target = valid;
    invalid_target.target_engine = RoleSessionMigrationEngine::Wkwebview;
    assert_eq!(
        validate_start_input(&invalid_target).unwrap_err().code(),
        "CORE_INPUT_INVALID"
    );
}
