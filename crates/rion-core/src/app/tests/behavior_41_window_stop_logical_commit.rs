#[test]
fn successful_window_stop_removes_exact_logical_window_and_preserves_saved_configuration() {
    for platform in ["win32", "darwin"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let saved = core
            .invoke(command(json!({
                "type": "gameWindowCreate",
                "input": {
                    "name": "Retained after stop", "targetDisplay": { "id": 1 },
                    "placement": {
                        "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                        "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                        "presentation": "normal"
                    }
                }
            })))
            .unwrap();
        let window_id = saved["id"].as_str().unwrap();
        seed_runtime_ui_topology(
            &core,
            "window-stop-seed",
            vec![
                (window_id, "closing-tab", "closing-role"),
                ("surviving-window", "surviving-tab", "surviving-role"),
            ],
        );
        let before = core.browser_runtime.snapshot().unwrap();
        let window = &before.windows[window_id];
        let request = RuntimeWindowStopRequestRecord {
            window_generation: window.window_generation,
            topology_revision: window.revision,
            ..test_window_stop_request(window_id, window.tab_ids())
        };
        drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserWindowStop { request },
            None,
        )
        .0
        .unwrap();
        let after = core.browser_runtime.snapshot().unwrap();
        assert!(!after.windows.contains_key(window_id), "{platform}");
        let survivor = &after.windows["surviving-window"];
        assert_eq!(
            survivor.tab_ids(),
            before.windows["surviving-window"].tab_ids(),
            "{platform}"
        );
        assert_eq!(
            survivor.revision, before.windows["surviving-window"].revision,
            "{platform}"
        );
        assert_eq!(
            survivor.window_generation, before.windows["surviving-window"].window_generation,
            "{platform}"
        );
        assert_eq!(
            core.invoke(CoreCommand::GameWindowGet {
                id: window_id.to_owned()
            })
            .unwrap(),
            saved,
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn window_stop_never_removes_a_changed_or_unacknowledged_logical_window() {
    for platform in ["win32", "darwin"] {
        for changed_during_destroy in [false, true] {
            let (_directory, core) = core_for_runtime_contract(platform, 23);
            core.invoke(CoreCommand::BrowserRuntimeRegister {
                registration: chromium_registration(platform, true),
            })
            .unwrap();
            seed_runtime_ui_topology(
                &core,
                "failed-stop-seed",
                vec![("closing-window", "closing-tab", "role")],
            );
            let before = core.browser_runtime.snapshot().unwrap();
            let window = &before.windows["closing-window"];
            let request = RuntimeWindowStopRequestRecord {
                window_generation: window.window_generation,
                topology_revision: window.revision,
                ..test_window_stop_request("closing-window", window.tab_ids())
            };
            let (result, _, _) = drive_async_command_with(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop { request },
                |effect| {
                    if changed_during_destroy {
                        core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
                            crate::RuntimeTopologyCommitInput {
                                commit_id: "replacement-during-destroy".to_owned(),
                                source: "command".to_owned(),
                                primary_window_id: "closing-window".to_owned(),
                                windows: vec![crate::RuntimeWindowTopologyCommit {
                                    active_tab_id: Some("replacement-tab".to_owned()),
                                    hidden_tab_ids: HashSet::new(),
                                    tabs: vec![runtime_ui_test_tab(
                                        "replacement-tab",
                                        "other-role",
                                    )],
                                    ui_sequence: 2,
                                    window_generation: 4,
                                    window_id: "closing-window".to_owned(),
                                }],
                            },
                        ))
                        .unwrap();
                        effect_result(effect, None)
                    } else {
                        effect_result(effect, Some("embeddedDestroyTab"))
                    }
                },
            );
            let error = result.unwrap_err();
            if changed_during_destroy {
                assert_eq!(
                    error.code(),
                    "SYSTEM_WINDOW_CLOSE_SCOPE_CHANGED",
                    "{platform}"
                );
            }
            let after = core.browser_runtime.snapshot().unwrap();
            assert_eq!(
                after.windows["closing-window"].tab_ids(),
                vec![if changed_during_destroy {
                    "replacement-tab"
                } else {
                    "closing-tab"
                }],
                "{platform}"
            );
            core.shutdown();
        }
    }
}
