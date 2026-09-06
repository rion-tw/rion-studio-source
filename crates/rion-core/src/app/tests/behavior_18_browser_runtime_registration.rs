fn core_for_runtime_contract(
    platform: &str,
    runtime_contract_version: u32,
) -> (TempDir, Arc<AppCore>) {
    let directory = tempfile::tempdir().unwrap();
    let core = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: platform.to_owned(),
            runtime_contract_version: Some(runtime_contract_version),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap(),
    );
    (directory, core)
}

fn chromium_registration(
    platform: &str,
    available: bool,
) -> BrowserRuntimeRegistrationRecord {
    BrowserRuntimeRegistrationRecord {
        contract_version: 23,
        platform: match platform {
            "darwin" => "macos",
            "win32" => "windows",
            other => panic!("unsupported test platform: {other}"),
        }
        .to_owned(),
        engine: crate::model::ResolvedBrowserEngine::Chromium,
        adapter_version: "bundled-chromium-150".to_owned(),
        available,
        capabilities: supported_system_capabilities(),
        failure_reason: (!available)
            .then_some(crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed),
    }
}

#[test]
fn contract_v23_expects_unavailable_chromium_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        let registration = core.browser_runtime_registration().unwrap();
        assert_eq!(registration.contract_version, 23, "{platform}");
        assert_eq!(
            registration.platform,
            if platform == "darwin" { "macos" } else { "windows" },
            "{platform}"
        );
        assert_eq!(
            registration.engine,
            crate::model::ResolvedBrowserEngine::Chromium,
            "{platform}"
        );
        assert!(!registration.available, "{platform}");

        let legacy = core
            .invoke(CoreCommand::SystemWebViewRuntimeRegister {
                registration: SystemWebViewRuntimeRegistrationRecord {
                    platform: registration.platform.clone(),
                    engine: if platform == "darwin" {
                        crate::model::ResolvedBrowserEngine::Wkwebview
                    } else {
                        crate::model::ResolvedBrowserEngine::Webview2
                    },
                    adapter_version: "legacy-test".to_owned(),
                    available: true,
                    capability_snapshot: supported_system_capabilities(),
                    failure_reason: None,
                },
            })
            .unwrap_err();
        assert_eq!(legacy.code(), "CORE_INPUT_INVALID", "{platform}");
        assert_eq!(
            core.browser_runtime_registration().unwrap(),
            registration,
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn browser_runtime_registration_validates_every_identity_and_availability_field() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let initial = core.browser_runtime_registration().unwrap();
    let mut invalid = Vec::new();

    let mut wrong_contract = chromium_registration("darwin", true);
    wrong_contract.contract_version = 22;
    invalid.push(wrong_contract);

    let mut wrong_platform = chromium_registration("darwin", true);
    wrong_platform.platform = "windows".to_owned();
    invalid.push(wrong_platform);

    let mut wrong_engine = chromium_registration("darwin", true);
    wrong_engine.engine = crate::model::ResolvedBrowserEngine::Wkwebview;
    invalid.push(wrong_engine);

    let mut invalid_adapter = chromium_registration("darwin", true);
    invalid_adapter.adapter_version = " bundled-chromium-150".to_owned();
    invalid.push(invalid_adapter);

    let mut missing_baseline = chromium_registration("darwin", true);
    missing_baseline.capabilities.persistent_session =
        crate::model::EngineCapabilityStatus::Disabled;
    invalid.push(missing_baseline);

    let mut success_with_failure = chromium_registration("darwin", true);
    success_with_failure.failure_reason =
        Some(crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed);
    invalid.push(success_with_failure);

    let mut unavailable_without_failure = chromium_registration("darwin", false);
    unavailable_without_failure.failure_reason = None;
    invalid.push(unavailable_without_failure);

    for registration in invalid {
        let error = core
            .invoke(CoreCommand::BrowserRuntimeRegister { registration })
            .unwrap_err();
        assert_eq!(error.code(), "CORE_INPUT_INVALID");
        assert_eq!(core.browser_runtime_registration().unwrap(), initial);
    }
    core.shutdown();
}

#[test]
fn v22_registration_preserves_legacy_reason_and_maps_status_to_generic_reason() {
    let (_directory, core) = core_for_runtime_contract("darwin", 22);
    let legacy = core
        .invoke(CoreCommand::SystemWebViewRuntimeRegister {
            registration: SystemWebViewRuntimeRegistrationRecord {
                platform: "macos".to_owned(),
                engine: crate::model::ResolvedBrowserEngine::Wkwebview,
                adapter_version: "appkit-wkwebview-22".to_owned(),
                available: false,
                capability_snapshot: supported_system_capabilities(),
                failure_reason: Some(
                    crate::model::SystemWebViewIssueReason::WebkitSpiUnavailable,
                ),
            },
        })
        .unwrap();
    assert_eq!(legacy["failureReason"], "webkit-spi-unavailable");

    let role_id = create_role(&core, &first_game_id(&core), 1);
    seed_running_role(&core, &role_id);
    let statuses = core.browser_statuses().unwrap();
    assert_eq!(
        statuses[0].issue_reason,
        Some(crate::model::BrowserRuntimeFailureReason::TrustedInputUnavailable)
    );
    core.shutdown();
}

#[test]
fn registered_v23_launch_statuses_and_effects_retain_platform_chromium_hosts() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (unavailable, unavailable_actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(unavailable_actions.is_empty(), "{platform}");
        assert_eq!(
            unavailable.unwrap_err().code(),
            "BROWSER_RUNTIME_CAPABILITY_UNAVAILABLE",
            "{platform}"
        );

        let registered = core
            .invoke(CoreCommand::BrowserRuntimeRegister {
                registration: chromium_registration(platform, true),
            })
            .unwrap();
        assert_eq!(registered["engine"], "chromium", "{platform}");
        assert_eq!(registered["available"], true, "{platform}");

        let (launched, actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launched.is_ok(), "{platform}: {launched:?}");
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedCreateTab { tab }
                if tab.roles.iter().all(|role| {
                    role.resolved_engine == crate::model::ResolvedBrowserEngine::Chromium
                })
        )), "{platform}");
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedLoadRoles { roles }
                if roles.iter().all(|role| {
                    role.resolved_engine == crate::model::ResolvedBrowserEngine::Chromium
                })
        )), "{platform}");
        let statuses = core.browser_statuses().unwrap();
        assert_eq!(
            statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Chromium),
            "{platform}"
        );
        assert_eq!(
            statuses[0].host_kind,
            Some(if platform == "darwin" {
                crate::model::BrowserHostKind::AppkitChromium
            } else {
                crate::model::BrowserHostKind::BundledChromium
            }),
            "{platform}"
        );
        core.shutdown();
    }
}
