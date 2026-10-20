#[test]
fn empty_window_stop_requires_native_retirement_before_logical_removal() {
    for platform in ["win32", "darwin"] {
        for fail_close in [false, true] {
            let (_directory, core) = core_for_runtime_contract(platform, 23);
            core.invoke(CoreCommand::BrowserRuntimeRegister {
                registration: chromium_registration(platform, true),
            }).unwrap();
            core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
                crate::RuntimeTopologyCommitInput {
                    commit_id: "empty-close-seed".to_owned(),
                    source: "command".to_owned(),
                    primary_window_id: "empty-window".to_owned(),
                    windows: vec![crate::RuntimeWindowTopologyCommit {
                        active_tab_id: None,
                        hidden_tab_ids: HashSet::new(),
                        tabs: vec![],
                        ui_sequence: 1,
                        window_generation: 1,
                        window_id: "empty-window".to_owned(),
                    }],
                },
            )).unwrap();
            let before = core.browser_runtime.snapshot().unwrap();
            let window = &before.windows["empty-window"];
            let request = RuntimeWindowStopRequestRecord {
                window_generation: window.window_generation,
                topology_revision: window.revision,
                ..test_window_stop_request("empty-window", vec![])
            };
            let (result, actions, _) = drive_async_command(
                Arc::clone(&core), CoreCommand::BrowserWindowStop { request },
                fail_close.then_some("other"),
            );
            assert!(actions.iter().any(|action| matches!(action,
                CoreEffectAction::EmbeddedRetireProvisionedWindow {
                    window_id, window_generation, topology_revision
                } if window_id == "empty-window" && *window_generation == window.window_generation
                    && *topology_revision == window.revision)), "{platform}: {actions:?}");
            assert_eq!(result.is_err(), fail_close, "{platform}");
            assert_eq!(core.browser_runtime.snapshot().unwrap().windows.contains_key("empty-window"),
                fail_close, "{platform}");
            core.shutdown();
        }
    }
}

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

fn launch_role_into_saved_window(core: &Arc<AppCore>, role_id: &str, window_id: &str) {
    let (launch, _) = drive_command_with(
        Arc::clone(core),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "windowId": window_id,
                "displayId": 1,
                "scaleFactor": 1.0,
                "workArea": {"x": 0, "y": 0, "width": 1440, "height": 900},
                "bounds": {"x": 0, "y": 0, "width": 960, "height": 640},
                "presentation": "normal"
            }
        })),
        |effect| effect_result(effect, None),
    );
    launch.unwrap();
}

#[test]
fn closing_a_live_saved_window_retires_it_from_the_unclean_recovery_cohort() {
    for platform in ["win32", "darwin"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let game_id = first_game_id(&core);
        let surviving_role = create_role(&core, &game_id, 1);
        let closing_role = create_role(&core, &game_id, 2);
        let surviving_window = create_saved_window(&core, "Still open");
        let closing_window = create_saved_window(&core, "Closed by the user");
        launch_role_into_saved_window(&core, &surviving_role, &surviving_window);
        launch_role_into_saved_window(&core, &closing_role, &closing_window);
        // A restore that the user interrupts by closing the window must not
        // be resumed by a later crash recovery either.
        core.update_runtime_restore_session(|session| {
            session
                .restore_in_progress_window_ids
                .push(closing_window.clone());
        })
        .unwrap();
        let before = core.runtime_restore_session().unwrap();
        let mut expected_live = vec![surviving_window.clone(), closing_window.clone()];
        expected_live.sort();
        assert!(!before.clean_exit, "{platform}");
        assert_eq!(before.live_window_ids, Some(expected_live), "{platform}");
        assert_eq!(
            before.last_focused_window_id.as_deref(),
            Some(closing_window.as_str()),
            "{platform}"
        );

        let runtime = core.browser_runtime.snapshot().unwrap();
        let window = &runtime.windows[&closing_window];
        let request = RuntimeWindowStopRequestRecord {
            window_generation: window.window_generation,
            topology_revision: window.revision,
            ..test_window_stop_request(closing_window.clone(), window.tab_ids())
        };
        drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserWindowStop { request },
            None,
        )
        .0
        .unwrap();

        let after = core.runtime_restore_session().unwrap();
        assert!(
            !after.clean_exit,
            "{platform}: a normal window close must not declare the process clean"
        );
        assert_eq!(
            after.live_window_ids,
            Some(vec![surviving_window.clone()]),
            "{platform}: a user-closed window must leave the crash-recovery cohort"
        );
        assert!(
            after.restore_in_progress_window_ids.is_empty(),
            "{platform}: {:?}",
            after.restore_in_progress_window_ids
        );
        assert_eq!(after.last_focused_window_id, None, "{platform}");
        let projected = core.app_snapshot().unwrap().state.runtime_restore_session;
        assert_eq!(
            projected.and_then(|session| session.live_window_ids),
            Some(vec![surviving_window.clone()]),
            "{platform}"
        );
        let saved = core
            .invoke(CoreCommand::GameWindowGet {
                id: closing_window.clone(),
            })
            .unwrap();
        assert_eq!(
            saved["tabs"].as_array().unwrap().len(),
            1,
            "{platform}: the dormant saved window remains manually restorable"
        );
        core.shutdown();
    }
}
