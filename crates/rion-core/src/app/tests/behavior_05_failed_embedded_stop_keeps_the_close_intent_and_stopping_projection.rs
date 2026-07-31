#[test]
    fn failed_embedded_stop_keeps_the_close_intent_and_stopping_projection() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (launch, _) = drive_command(
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
        assert!(launch.is_ok());

        let (stop, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            Some("embeddedDestroyTab"),
        );
        assert_eq!(stop.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
        assert!(
            actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
        );
        assert!(
            actions
                .iter()
                .all(|action| !matches!(action, CoreEffectAction::EmbeddedApplyRuntime { .. })),
            "close isolation must not queue behind a projection effect: {actions:?}"
        );
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(
            snapshot
                .roles
                .iter()
                .any(|role| { role.role_id == role_id && role.state == "stopping" })
        );
        assert!(
            snapshot
                .tabs
                .iter()
                .any(|tab| { tab.role_ids.contains(&role_id) && tab.hidden })
        );
        assert!(
            core.invoke(CoreCommand::GameWindowsList)
                .unwrap()
                .as_array()
                .is_some_and(|windows| windows.iter().all(|window| {
                    window["tabs"].as_array().is_none_or(|tabs| {
                        tabs.iter().all(|tab| {
                            tab["roleIds"].as_array().is_none_or(|ids| {
                                ids.iter().all(|id| id.as_str() != Some(role_id.as_str()))
                            })
                        })
                    })
                }))
        );

        let (cleanup, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop { role_id },
            None,
        );
        assert!(cleanup.is_ok());
        core.shutdown();
    }

    #[test]
    fn rolls_back_runtime_and_native_handles_after_load_failure() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (result, actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            Some("embeddedLoadRoles"),
        );
        assert_eq!(result.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");
        assert!(
            actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
        );
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty());
        assert!(snapshot.tabs.is_empty());
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                if snapshot.roles.is_empty() && snapshot.tabs.is_empty()
        )));
        core.shutdown();
    }

    #[test]
    fn failed_native_compensation_requires_restart_and_is_journaled() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let expected_role_id = role_id.clone();
        let (result, actions) = drive_command_with(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            |effect| {
                let (failed, code) = match &effect.action {
                    CoreEffectAction::EmbeddedLoadRoles { .. } => (true, "GAME_PAGE_LOAD_FAILED"),
                    CoreEffectAction::EmbeddedDestroyTab { .. } => (true, "NATIVE_DESTROY_FAILED"),
                    _ => (false, ""),
                };
                CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: !failed,
                    value_json: None,
                    error: failed.then(|| CoreErrorPayload {
                        code: code.to_owned(),
                        message: "Injected native effect failure.".to_owned(),
                    }),
                }
            },
        );

        let error = result.unwrap_err();
        assert_eq!(error.code(), "CORE_OPERATION_COMPENSATION_FAILED");
        assert!(error.to_string().contains("Restart Rion Studio"));
        assert!(
            actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
        );
        let journals = core
            .with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap();
        assert_eq!(journals.len(), 1);
        assert_eq!(journals[0].kind, "native_effect_compensation_v1");
        assert_eq!(journals[0].phase, "restart-required");
        assert_eq!(journals[0].payload["roleIds"], json!([expected_role_id]));
        assert_eq!(
            journals[0].payload["failures"][0]["error"]["code"],
            json!("NATIVE_DESTROY_FAILED")
        );

        let data_dir = directory.path().to_string_lossy().into_owned();
        core.shutdown();
        drop(core);
        let restarted = AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            platform: "darwin".to_owned(),
            user_data_dir: data_dir,
            performance_telemetry_path: None,
        })
        .unwrap();
        assert!(
            restarted
                .with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );
        restarted.shutdown();
    }

    #[test]
    fn stopping_a_launching_role_cancels_the_active_operation_and_rolls_back() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let receiver = core.subscribe().unwrap();
        let launch_core = Arc::clone(&core);
        let launch_role_id = role_id.clone();
        let launch = thread::spawn(move || {
            launch_core.invoke(command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": launch_role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })))
        });
        let mut stop = None;
        let mut saw_compensation = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !launch.is_finished()
            || stop
                .as_ref()
                .is_some_and(|stop: &thread::JoinHandle<_>| !stop.is_finished())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "launch cancellation did not complete before the deadline"
            );
            let events = match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(events) => events,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(error) => panic!("core event channel disconnected: {error}"),
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let mut results = Vec::new();
                for effect in effects {
                    if matches!(effect.action, CoreEffectAction::EmbeddedLoadRoles { .. })
                        && stop.is_none()
                    {
                        let stop_core = Arc::clone(&core);
                        let stop_role_id = role_id.clone();
                        stop = Some(thread::spawn(move || {
                            stop_core.invoke(CoreCommand::EmbeddedRoleStop {
                                role_id: stop_role_id,
                            })
                        }));
                        continue;
                    }
                    if matches!(effect.action, CoreEffectAction::EmbeddedDestroyTab { .. }) {
                        saw_compensation = true;
                    }
                    results.push(effect_result(effect, None));
                }
                if !results.is_empty() {
                    core.dispatch_core_effect_results(results).unwrap();
                }
            }
        }
        assert_eq!(
            launch.join().unwrap().unwrap_err().code(),
            "LAUNCH_CANCELLED"
        );
        assert!(stop.unwrap().join().unwrap().is_ok());
        assert!(saw_compensation);
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty());
        assert!(snapshot.tabs.is_empty());
        core.shutdown();
    }

    #[test]
    fn workspace_launch_rejects_a_role_snapshot_that_changed_before_the_lease() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let first_role_id = create_role(&core, &game_id, 1);
        let second_role_id = create_role(&core, &game_id, 2);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": "Changing workspace",
                    "template": "single",
                    "slots": [{"roleId": first_role_id, "rect": workspace_rect(0, 1)}]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        core.invoke(command(json!({
            "type": "workspaceUpdate",
            "id": workspace_id,
            "input": {
                "slots": [{"roleId": second_role_id, "rect": workspace_rect(0, 1)}]
            }
        })))
        .unwrap();

        let error = core
            .launch_embedded_workspace_for_roles(
                &workspace_id,
                std::slice::from_ref(&first_role_id),
                EmbeddedLaunchTargetRecord {
                    window_id: "stale-workspace-window".to_owned(),
                    display_id: 1,
                    scale_factor: 1.0,
                    work_area: StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 1440,
                        height: 900,
                    },
                    bounds: StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 960,
                        height: 640,
                    },
                    presentation: "normal".to_owned(),
                },
            )
            .unwrap_err();

        assert_eq!(error.code(), "WORKSPACE_DATA_CHANGED");
        let available = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![first_role_id, workspace_operation_key(&workspace_id)],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&available.id).unwrap();
        core.shutdown();
    }

    #[test]
    fn batches_one_four_and_nine_role_workspace_load_effects() {
        for count in [1_usize, 4, 9] {
            let (_directory, core) = core();
            let game_id = first_game_id(&core);
            let role_ids = (0..count)
                .map(|index| create_role(&core, &game_id, index))
                .collect::<Vec<_>>();
            let slots = role_ids
                .iter()
                .enumerate()
                .map(|(index, role_id)| {
                    json!({
                        "roleId": role_id,
                        "rect": workspace_rect(index, count)
                    })
                })
                .collect::<Vec<_>>();
            let workspace_id = core
                .invoke(command(json!({
                    "type": "workspaceCreate",
                    "input": {
                        "name": format!("{count} roles"),
                        "template": match count {
                            1 => "single",
                            4 => "quad",
                            _ => "nine_grid"
                        },
                        "slots": slots
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let (result, actions) = drive_command(
                Arc::clone(&core),
                command(json!({
                    "type": "embeddedWorkspaceLaunch",
                    "workspaceId": workspace_id,
                    "target": {
                        "displayId": 1,
                        "workArea": {"x": 0, "y": 0, "width": 1800, "height": 1200}
                    }
                })),
                None,
            );
            assert!(result.is_ok(), "{result:?}");
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedLoadRoles { roles } if roles.len() == count
            )));
            assert!(actions.iter().all(|action| !matches!(
                action,
                CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                    if snapshot.roles.iter().any(|role| role.state == "running")
            )));
            let running_snapshot = core
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot;
            assert_eq!(running_snapshot.roles.len(), count);
            assert!(
                running_snapshot
                    .roles
                    .iter()
                    .all(|role| role.state == "running")
            );
            assert!(running_snapshot.workspaces.iter().any(|runtime| {
                runtime.workspace_id == workspace_id && runtime.state == "running"
            }));
            let (stop, stop_actions) = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWorkspaceStop { workspace_id },
                None,
            );
            assert!(stop.is_ok());
            assert!(
                stop_actions
                    .iter()
                    .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
            );
            assert!(
                stop_actions
                    .iter()
                    .all(|action| !matches!(action, CoreEffectAction::EmbeddedApplyRuntime { .. }))
            );
            let stopped_snapshot = core
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot;
            assert!(stopped_snapshot.roles.is_empty());
            assert!(stopped_snapshot.tabs.is_empty());
            assert!(stopped_snapshot.workspaces.is_empty());
            core.shutdown();
        }
    }

    #[test]
    fn transient_system_workspace_launch_failure_does_not_block_a_retry() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let game_id = first_game_id(&core);
            let role_id = create_role(&core, &game_id, 1);
            let workspace_id = core
                .invoke(command(json!({
                    "type": "workspaceCreate",
                    "input": {
                        "name": "Retryable workspace",
                        "template": "single",
                        "slots": [{"roleId": role_id, "rect": workspace_rect(0, 1)}]
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let launch_command = || {
                command(json!({
                    "type": "embeddedWorkspaceLaunch",
                    "workspaceId": workspace_id,
                    "target": {
                        "displayId": 1,
                        "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                    }
                }))
            };

            let (failed, _) = drive_command(
                Arc::clone(&core),
                launch_command(),
                Some("embeddedLoadRoles"),
            );
            assert_eq!(failed.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");

            let (retry, retry_actions) = drive_command(Arc::clone(&core), launch_command(), None);
            assert!(retry.is_ok(), "{retry:?}");
            assert!(
                retry_actions
                    .iter()
                    .any(|action| matches!(action, CoreEffectAction::EmbeddedLoadRoles { .. }))
            );

            let (stop, _) = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWorkspaceStop { workspace_id },
                None,
            );
            assert!(stop.is_ok());
            core.shutdown();
        }
    }

    #[test]
    fn registered_system_runtime_with_macro_input_launches_macro_assigned_roles() {
        let (_directory, core) = core();
        install_test_system_runtime(&core, supported_system_capabilities());
        let role_id = create_role(&core, &first_game_id(&core), 1);
        core.invoke(command(json!({
            "type": "macroCreate",
            "input": {
                "name": "Supported macro input",
                "roleIds": [role_id.clone()],
                "steps": [{"type": "key", "code": "Digit1", "action": "tap"}]
            }
        })))
        .unwrap();
        let (result, actions) = drive_command(
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
        assert!(result.is_ok(), "{result:?}");
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedCreateTab { tab }
                if tab.roles.iter().all(|role| {
                    role.resolved_engine == crate::model::ResolvedBrowserEngine::Wkwebview
                })
        )));
        let statuses = core.browser_statuses().unwrap();
        assert_eq!(
            statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Wkwebview)
        );
        assert_eq!(
            statuses[0].host_kind,
            Some(crate::model::BrowserHostKind::SystemNative)
        );
        assert_eq!(
            statuses[0]
                .capability_snapshot
                .as_ref()
                .map(|snapshot| snapshot.navigation),
            Some(crate::model::EngineCapabilityStatus::Supported)
        );
        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop { role_id },
            None,
        );
        assert!(stopped.is_ok());
        core.shutdown();
    }

    #[test]
    fn macro_launch_fails_closed_before_surface_creation_when_macro_input_is_unavailable() {
        let (_directory, core) = core();
        let mut capabilities = supported_system_capabilities();
        capabilities.trusted_input = crate::model::EngineCapabilityStatus::Disabled;
        capabilities.background_input = crate::model::EngineCapabilityStatus::Disabled;
        install_test_system_runtime(&core, capabilities);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        core.invoke(command(json!({
            "type": "macroCreate",
            "input": {
                "name": "Requires trusted input",
                "roleIds": [role_id.clone()],
                "steps": [{"type": "key", "code": "Digit1", "action": "tap"}]
            }
        })))
        .unwrap();

        let (result, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleLaunch {
                role_id,
                target: EmbeddedLaunchTargetRecord {
                    window_id: uuid::Uuid::new_v4().to_string(),
                    display_id: 1,
                    scale_factor: 1.0,
                    work_area: crate::model::StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 1200,
                        height: 800,
                    },
                    bounds: crate::model::StatePixelBoundsRecord {
                        x: 120,
                        y: 80,
                        width: 960,
                        height: 640,
                    },
                    presentation: "normal".to_owned(),
                },
                zoom_factor: None,
            },
            None,
        );

        assert_eq!(
            result.unwrap_err().code(),
            "SYSTEM_WEBVIEW_CAPABILITY_UNAVAILABLE"
        );
        assert!(actions.is_empty());
        let runtime = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(runtime.roles.is_empty());
        assert!(runtime.tabs.is_empty());
        core.shutdown();
    }

    #[test]
    fn crashed_system_surface_stays_on_the_native_engine_and_clears_its_issue_after_recovery() {
        let (_directory, core) = core();
        install_test_system_runtime(&core, supported_system_capabilities());
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (launch, _) = drive_command(
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
        assert!(launch.is_ok(), "{launch:?}");

        let (failed, failed_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedSystemSurfaceFailed {
                role_id: role_id.clone(),
                reason: Some("web-content-process-terminated".to_owned()),
            },
            None,
        );
        assert!(failed_actions.is_empty());
        let failed_statuses =
            serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(failed.unwrap())
                .unwrap();
        assert_eq!(
            failed_statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Wkwebview)
        );
        assert_eq!(
            failed_statuses[0].issue_reason,
            Some(crate::model::SystemWebViewIssueReason::RuntimeCrashed)
        );

        let (recovered, recovered_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedSystemSurfaceRecovered {
                role_id: role_id.clone(),
            },
            None,
        );
        assert!(recovered_actions.is_empty());
        let recovered_statuses =
            serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(
                recovered.unwrap(),
            )
            .unwrap();
        assert_eq!(
            recovered_statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Wkwebview)
        );
        assert_eq!(recovered_statuses[0].issue_reason, None);

        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop { role_id },
            None,
        );
        assert!(stopped.is_ok());
        core.shutdown();
    }
