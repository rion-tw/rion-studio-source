#[test]
fn typed_tab_stop_accepts_live_window_membership_ahead_of_core_projection() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        drive_command(
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
        )
        .0
        .unwrap();
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        let tab = snapshot.tabs.first().unwrap();
        let operation_id = format!("live-window-ahead-stop-{platform}");

        let (stopped, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            embedded_tab_stop_mutation_command(
                &operation_id,
                &tab.id,
                "live-window-not-yet-projected-to-core",
                &role_id,
            ),
            |effect| effect_result_with_parent(effect, &operation_id, platform),
        );

        let stopped: BrowserRuntimeSnapshot =
            serde_json::from_value(stopped.unwrap()).unwrap();
        assert!(stopped.tabs.is_empty(), "{platform}");
        assert!(stopped.roles.is_empty(), "{platform}");
        assert!(
            actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. })),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn typed_tab_stop_is_idempotent_after_core_projection_is_already_absent() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let stopped = runtime
            .block_on(core.invoke_async(embedded_tab_stop_mutation_command(
                &format!("already-absent-stop-{platform}"),
                "already-absent-tab",
                "already-closed-window",
                "already-absent-role",
            )))
            .unwrap();
        let stopped: BrowserRuntimeSnapshot = serde_json::from_value(stopped).unwrap();

        assert!(stopped.tabs.is_empty(), "{platform}");
        assert!(stopped.roles.is_empty(), "{platform}");
        core.shutdown();
    }
}
