#[test]
fn v23_global_web_profile_paths_resolve_is_exact_idempotent_and_napi_serializable() {
    for platform in ["darwin", "win32"] {
        let (directory, core) = core_for_runtime_contract(platform, 23);
        let first: crate::model::GlobalWebProfilePathsRecord = serde_json::from_value(
            core.invoke(CoreCommand::GlobalWebProfilePathsResolve)
                .unwrap(),
        )
        .unwrap();
        let second: crate::model::GlobalWebProfilePathsRecord = serde_json::from_value(
            core.invoke(CoreCommand::GlobalWebProfilePathsResolve)
                .unwrap(),
        )
        .unwrap();
        let expected = fs::canonicalize(directory.path())
            .unwrap()
            .join("web-profiles")
            .join("global-web")
            .join("chromium");

        assert_eq!(first, second, "{platform}");
        assert_eq!(first.profile_key, "global-web", "{platform}");
        assert_eq!(std::path::Path::new(&first.chromium_user_data_dir), expected);
        assert!(expected.is_dir(), "{platform}");
        assert!(!directory.path().join("roles").exists(), "{platform}");
        assert!(core.browser_runtime.snapshot().unwrap().windows.is_empty());
        core.shutdown();
    }
}

#[test]
fn v23_global_web_profile_clear_uses_the_core_effect_operation_identity_and_exact_path() {
    let (directory, core) = core_for_runtime_contract("win32", 23);
    let expected = fs::canonicalize(directory.path())
        .unwrap()
        .join("web-profiles")
        .join("global-web")
        .join("chromium");
    let mut effect_operation_id = None;
    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::GlobalWebProfileClear,
        |effect| {
            assert_eq!(effect.target.handle_id, "global-web");
            assert_eq!(
                effect.completion_policy,
                crate::model::OperationCompletionPolicy::DeadlineBound
            );
            effect_operation_id = Some(effect.operation_id.clone());
            effect_result(effect, None)
        },
    );
    let receipt: crate::model::GlobalWebProfileClearReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();

    assert_eq!(receipt.operation_id, effect_operation_id.unwrap());
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert_eq!(
        std::path::Path::new(&receipt.profile.chromium_user_data_dir),
        expected
    );
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::GlobalWebProfileClear { profile }
            if profile == &receipt.profile
    )));
    assert!(expected.is_dir());
    core.shutdown();
}

#[test]
fn v22_rejects_global_web_profile_commands_before_filesystem_or_effect_work() {
    let (directory, core) = core_for_runtime_contract("darwin", 22);
    let emitted_before = core.operation_actor.metrics().emitted_effect_count;
    let resolve = core
        .invoke(CoreCommand::GlobalWebProfilePathsResolve)
        .unwrap_err();
    let clear = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(core.invoke_async(CoreCommand::GlobalWebProfileClear))
        .unwrap_err();

    assert_eq!(resolve.code(), "GLOBAL_WEB_PROFILE_RUNTIME_UNAVAILABLE");
    assert_eq!(clear.code(), "GLOBAL_WEB_PROFILE_RUNTIME_UNAVAILABLE");
    assert!(!directory.path().join("web-profiles").exists());
    assert_eq!(
        core.operation_actor.metrics().emitted_effect_count,
        emitted_before
    );
    core.shutdown();
}
