#[test]
fn binding_switch_and_unbind_keep_the_running_surface_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        for (builtin_key, expected_codec) in [
            ("flyff-universe", "flyff-client-settings-v7"),
            (
                "feifei-infinite-universe",
                "flyff-china-client-settings",
            ),
        ] {
            let (_directory, core) = core_for_platform(platform);
            let game_id = core
                .invoke(CoreCommand::GamesList)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .find(|game| game["builtinKey"] == builtin_key)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let first_source = create_role(&core, &game_id, 1);
            let second_source = create_role(&core, &game_id, 2);
            let target = create_role(&core, &game_id, 3);
            seed_running_role(&core, &target);

            for source in [Some(first_source.as_str()), Some(second_source.as_str()), None] {
                let (result, actions, _) = drive_async_command(
                    Arc::clone(&core),
                    command(json!({
                        "type":"roleUpdate",
                        "id":target,
                        "input":{
                            "localStorageSourceRoleId":source,
                            "setLocalStorageSourceRoleId":true
                        }
                    })),
                    None,
                );
                assert!(result.is_ok(), "{platform}/{builtin_key}: {result:?}");
                assert!(actions.iter().all(|action| !matches!(
                    action,
                    CoreEffectAction::EmbeddedDestroyRole { .. }
                        | CoreEffectAction::EmbeddedDestroyTab { .. }
                        | CoreEffectAction::EmbeddedApplyRuntime { .. }
                )));
                if source.is_some() {
                    assert!(actions.iter().any(|action| matches!(
                        action,
                        CoreEffectAction::LocalStorageSyncRefresh { selectors, keys, codec, .. }
                            if keys.is_empty()
                                && !selectors.is_empty()
                                && codec.as_deref() == Some(expected_codec)
                    )), "{platform}/{builtin_key}: {actions:?}");
                }
                let snapshot = core
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                    .unwrap()
                    .snapshot;
                assert!(snapshot.roles.iter().any(|role| {
                    role.role_id == target && role.state == "running"
                }), "{platform}/{builtin_key}");
            }

            core.shutdown();
        }
    }
}
