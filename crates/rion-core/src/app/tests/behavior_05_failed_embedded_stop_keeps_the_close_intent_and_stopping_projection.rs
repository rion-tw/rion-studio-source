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
        Some("embeddedDestroyRole"),
    );
    assert_eq!(stop.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyRole { .. }))
    );
    assert!(
        actions
            .iter()
            .all(|action| !matches!(action, CoreEffectAction::EmbeddedFollowRoleOwnership { .. })),
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
    assert!(snapshot.tabs.iter().any(|tab| {
        tab.slots
            .iter()
            .any(|slot| slot.role_id == role_id && slot.state == "stopping")
    }));
    assert!(
        core.invoke(CoreCommand::GameWindowsList)
            .unwrap()
            .as_array()
            .is_some_and(|windows| windows.iter().all(|window| {
                window["tabs"].as_array().is_none_or(|tabs| {
                    tabs.iter().all(|tab| {
                        tab["roleSlots"].as_array().is_none_or(|slots| {
                            slots
                                .iter()
                                .all(|slot| slot["roleId"].as_str() != Some(role_id.as_str()))
                        })
                    })
                })
            }))
    );

    let (cleanup, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedRoleStop {
            role_id: role_id.clone(),
        },
        None,
    );
    assert!(cleanup.is_ok());
    let released_input = core
        .macro_input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == role_id)
        .unwrap();
    assert!(!released_input.stopping);
    assert!(!released_input.quiesced);
    core.shutdown();
}

#[test]
fn load_failure_keeps_live_tab_cleanup_out_of_core_compensation() {
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
            .all(|action| !matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
    );
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.roles.is_empty());
    assert!(snapshot.tabs.is_empty());
    core.shutdown();
}

#[test]
fn failed_role_load_returns_the_original_error_without_a_restart_journal() {
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
            .all(|action| !matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
    );
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    core.shutdown();
}
#[test]
fn stopping_a_launching_role_cancels_and_still_retires_its_native_surface() {
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
    let mut saw_native_cleanup = false;
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
            let effects = match event {
                CoreEvent::CoreEffectCancellations { cancellations } => {
                    let results = cancellations
                        .into_iter()
                        .map(|cancellation| CoreEffectResult {
                            effect_id: cancellation.effect_id,
                            operation_id: cancellation.operation_id,
                            ok: false,
                            value_json: None,
                            error: Some(crate::CoreErrorPayload {
                                code: "CHROMIUM_RUNTIME_EFFECT_CANCELLED".to_owned(),
                                message: "the exact Chromium continuation was cancelled".to_owned(),
                            }),
                        })
                        .collect();
                    core.dispatch_core_effect_results(results).unwrap();
                    continue;
                }
                CoreEvent::CoreEffects { effects } => effects,
                _ => continue,
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
                if matches!(effect.action, CoreEffectAction::EmbeddedDestroyRole { .. }) {
                    saw_native_cleanup = true;
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
    assert!(saw_native_cleanup);
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
                persisted_name: None,
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
            CoreEffectAction::EmbeddedFollowRoleOwnership { roles, .. }
                if roles.iter().any(|role| role.state == "running")
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
        assert!(
            running_snapshot.workspaces.iter().any(|runtime| {
                runtime.workspace_id == workspace_id && runtime.state == "running"
            })
        );
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
            stop_actions.iter().all(|action| !matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
            ))
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
    assert_eq!(statuses[0].automation_state, None);
    assert!(core.macro_active_role_ids().unwrap().is_empty());
    let (recovered, recovered_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceRecovered {
            role_id: role_id.clone(),
        },
        None,
    );
    assert!(recovered_actions.is_empty());
    let recovered_statuses =
        serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(recovered.unwrap())
            .unwrap();
    assert_eq!(
        recovered_statuses[0].automation_state.as_deref(),
        Some("ready")
    );
    assert_eq!(core.macro_active_role_ids().unwrap(), vec![role_id.clone()]);
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
                persisted_name: None,
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
fn foreground_macro_launch_does_not_require_background_input_capability() {
    let (_directory, core) = core();
    let mut capabilities = supported_system_capabilities();
    capabilities.background_input = crate::model::EngineCapabilityStatus::Disabled;
    install_test_system_runtime(&core, capabilities);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    core.invoke(command(json!({
        "type": "macroCreate",
        "input": {
            "name": "Foreground trusted input",
            "roleIds": [role_id.clone()],
            "steps": [{"type": "key", "code": "KeyA", "action": "tap"}]
        }
    })))
    .unwrap();

    let (launched, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedRoleLaunch {
            role_id: role_id.clone(),
            target: EmbeddedLaunchTargetRecord {
                window_id: uuid::Uuid::new_v4().to_string(),
                persisted_name: None,
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
    assert!(launched.is_ok(), "{launched:?}");
    let (ready, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceRecovered {
            role_id: role_id.clone(),
        },
        None,
    );
    let statuses =
        serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(ready.unwrap())
            .unwrap();
    assert_eq!(statuses[0].automation_state.as_deref(), Some("ready"));
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

    let (ready, ready_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceRecovered {
            role_id: role_id.clone(),
        },
        None,
    );
    assert!(ready_actions.is_empty());
    let ready_statuses =
        serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(ready.unwrap())
            .unwrap();
    assert_eq!(ready_statuses[0].automation_state.as_deref(), Some("ready"));

    let owner = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .roles
        .into_iter()
        .find(|role| role.role_id == role_id)
        .unwrap()
        .owner;
    let (stale, stale_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: role_id.clone(),
            reason: Some("surface.navigation-failed".to_owned()),
            expected_tab_id: Some(owner.tab_id.clone()),
            expected_owner_generation: Some(owner.generation + 1),
        },
        None,
    );
    assert_eq!(stale.unwrap_err().code(), "RUNTIME_ROLE_OWNER_STALE");
    assert!(stale_actions.is_empty());
    let after_stale = core
        .browser_statuses()
        .unwrap()
        .into_iter()
        .find(|status| status.role_id == role_id)
        .unwrap();
    assert_eq!(after_stale.automation_state.as_deref(), Some("ready"));
    assert!(after_stale.issue_reason.is_none());

    let (failed, failed_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: role_id.clone(),
            reason: Some("web-content-process-terminated".to_owned()),
            expected_tab_id: Some(owner.tab_id),
            expected_owner_generation: Some(owner.generation),
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
        Some(crate::model::BrowserRuntimeFailureReason::RuntimeCrashed)
    );
    assert_eq!(
        failed_statuses[0].automation_state.as_deref(),
        Some("unavailable")
    );
    assert!(core.macro_active_role_ids().unwrap().is_empty());

    let (recovered, recovered_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceRecovered {
            role_id: role_id.clone(),
        },
        None,
    );
    assert!(recovered_actions.is_empty());
    let recovered_statuses =
        serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(recovered.unwrap())
            .unwrap();
    assert_eq!(
        recovered_statuses[0].resolved_engine,
        Some(crate::model::ResolvedBrowserEngine::Wkwebview)
    );
    assert_eq!(recovered_statuses[0].issue_reason, None);
    assert_eq!(
        recovered_statuses[0].automation_state.as_deref(),
        Some("ready")
    );
    assert_eq!(core.macro_active_role_ids().unwrap(), vec![role_id.clone()]);

    let (stopped, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedRoleStop { role_id },
        None,
    );
    assert!(stopped.is_ok());
    core.shutdown();
}

#[test]
fn crashed_workspace_surface_only_degrades_the_exact_failing_role() {
    let (_directory, core) = core();
    install_test_system_runtime(&core, supported_system_capabilities());
    let game_id = first_game_id(&core);
    let failing_role_id = create_role(&core, &game_id, 1);
    let healthy_role_id = create_role(&core, &game_id, 2);
    let slots = [failing_role_id.clone(), healthy_role_id.clone()]
        .iter()
        .enumerate()
        .map(|(index, role_id)| {
            json!({
                "roleId": role_id,
                "rect": workspace_rect(index, 2)
            })
        })
        .collect::<Vec<_>>();
    let workspace_id = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "Exact navigation failure isolation",
                "template": "two_columns",
                "slots": slots
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (launch, _) = drive_command(
        Arc::clone(&core),
        command(json!({
            "type": "embeddedWorkspaceLaunch",
            "workspaceId": workspace_id,
            "target": {
                "windowId": "exact-navigation-failure-window",
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    assert!(launch.is_ok(), "{launch:?}");
    for role_id in [&failing_role_id, &healthy_role_id] {
        assert!(
            core.invoke(CoreCommand::EmbeddedSystemSurfaceRecovered {
                role_id: role_id.clone(),
            })
            .is_ok()
        );
    }

    let healthy_before = core
        .browser_statuses()
        .unwrap()
        .into_iter()
        .find(|status| status.role_id == healthy_role_id)
        .unwrap();
    assert!(healthy_before.issue_reason.is_none());
    assert_eq!(healthy_before.automation_state.as_deref(), Some("ready"));
    let failing_owner = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .roles
        .into_iter()
        .find(|role| role.role_id == failing_role_id)
        .unwrap()
        .owner;

    let failed = core
        .invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: failing_role_id.clone(),
            reason: Some("surface.navigation-failed".to_owned()),
            expected_tab_id: Some(failing_owner.tab_id),
            expected_owner_generation: Some(failing_owner.generation),
        })
        .unwrap();
    let failed_statuses = serde_json::from_value::<
        Vec<crate::model::BrowserRoleStatusRecord>,
    >(failed)
    .unwrap();
    assert_eq!(failed_statuses.len(), 1);
    assert_eq!(failed_statuses[0].role_id, failing_role_id);
    assert_eq!(
        failed_statuses[0].issue_reason,
        Some(crate::model::BrowserRuntimeFailureReason::RuntimeCrashed)
    );
    assert_eq!(
        failed_statuses[0].automation_state.as_deref(),
        Some("unavailable")
    );

    let healthy_after = core
        .browser_statuses()
        .unwrap()
        .into_iter()
        .find(|status| status.role_id == healthy_role_id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(healthy_after).unwrap(),
        serde_json::to_value(healthy_before).unwrap()
    );
    assert!(
        core.macro_active_role_ids()
            .unwrap()
            .contains(&healthy_role_id)
    );
    assert!(
        !core
            .macro_active_role_ids()
            .unwrap()
            .contains(&failing_role_id)
    );
    core.shutdown();
}

#[test]
fn crashed_surface_report_linearizes_with_role_ownership_transfer() {
    use std::sync::{Barrier, mpsc};

    let (_directory, core) = core();
    install_test_system_runtime(&core, supported_system_capabilities());
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let create_workspace = |name: &str| {
        core.invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": name,
                "template": "single",
                "slots": [{"roleId": role_id, "rect": workspace_rect(0, 1)}]
            }
        })))
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let source_workspace_id = create_workspace("Failure source");
    let target_workspace_id = create_workspace("Failure target");
    let launch_workspace = |workspace_id: &str, window_id: &str| {
        drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedWorkspaceLaunch",
                "workspaceId": workspace_id,
                "target": {
                    "windowId": window_id,
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        )
        .0
    };
    assert!(
        launch_workspace(&source_workspace_id, "failure-source-window").is_ok()
    );
    assert!(
        launch_workspace(&target_workspace_id, "failure-target-window").is_ok()
    );
    assert!(
        core.invoke(CoreCommand::EmbeddedSystemSurfaceRecovered {
            role_id: role_id.clone(),
        })
        .is_ok()
    );

    let before = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let source_owner = before
        .roles
        .iter()
        .find(|role| role.role_id == role_id)
        .unwrap()
        .owner
        .clone();
    let target_tab = before
        .tabs
        .iter()
        .find(|tab| tab.source_id == target_workspace_id)
        .unwrap();
    let target_tab_id = target_tab.id.clone();
    let target_slot_id = target_tab.slots[0].slot_id.clone();
    assert_eq!(target_tab.slots[0].state, "blocked");

    let failure_fenced = Arc::new(Barrier::new(2));
    let allow_failure_commit = Arc::new(Barrier::new(2));
    *core
        .system_surface_failure_after_owner_fence_hook
        .lock()
        .unwrap() = Some({
        let failure_fenced = Arc::clone(&failure_fenced);
        let allow_failure_commit = Arc::clone(&allow_failure_commit);
        Arc::new(move || {
            failure_fenced.wait();
            allow_failure_commit.wait();
        })
    });

    let reporting_core = Arc::clone(&core);
    let reporting_role_id = role_id.clone();
    let reporting_owner = source_owner.clone();
    let reporting = thread::spawn(move || {
        reporting_core.invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: reporting_role_id,
            reason: Some("surface.navigation-failed".to_owned()),
            expected_tab_id: Some(reporting_owner.tab_id),
            expected_owner_generation: Some(reporting_owner.generation),
        })
    });
    failure_fenced.wait();

    let (transfer_started_sender, transfer_started_receiver) = mpsc::sync_channel(1);
    let (transfer_finished_sender, transfer_finished_receiver) = mpsc::sync_channel(1);
    let transferring_core = Arc::clone(&core);
    let transferring_role_id = role_id.clone();
    let transfer_tab_id = target_tab_id.clone();
    let transfer_slot_id = target_slot_id.clone();
    let expected_generation = source_owner.generation;
    let transferring = thread::spawn(move || {
        transfer_started_sender.send(()).unwrap();
        let result = transferring_core.invoke_browser_runtime(
            BrowserRuntimeCommand::ClaimRoleSlot {
                role_id: transferring_role_id,
                tab_id: transfer_tab_id,
                slot_id: transfer_slot_id,
                expected_owner_generation: Some(expected_generation),
            },
        );
        transfer_finished_sender
            .send(
                result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|error| error.code().to_owned()),
            )
            .unwrap();
        result
    });
    transfer_started_receiver.recv().unwrap();
    assert!(
        transfer_finished_receiver
            .recv_timeout(Duration::from_millis(50))
            .is_err(),
        "role ownership transfer must wait for the fenced failure commit"
    );
    let while_failure_is_fenced = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert_eq!(
        &while_failure_is_fenced
            .roles
            .iter()
            .find(|role| role.role_id == role_id)
            .unwrap()
            .owner,
        &source_owner
    );

    allow_failure_commit.wait();
    assert!(reporting.join().unwrap().is_ok());
    assert_eq!(
        transfer_finished_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        Ok(())
    );
    let transferred = transferring.join().unwrap().unwrap().snapshot;
    let transferred_role = transferred
        .roles
        .iter()
        .find(|role| role.role_id == role_id)
        .unwrap();
    assert_eq!(transferred_role.owner.tab_id, target_tab_id);
    assert_eq!(transferred_role.owner.slot_id, target_slot_id);
    assert!(transferred_role.owner.generation > source_owner.generation);
    let transferred_generation = transferred_role.owner.generation;
    let launched_at = transferred_role.launched_at.clone();
    *core
        .system_surface_failure_after_owner_fence_hook
        .lock()
        .unwrap() = None;

    core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
        role_id: role_id.clone(),
        runtime: "embedded".to_owned(),
        tab_id: target_tab_id.clone(),
        slot_id: Some(target_slot_id),
        state: "running".to_owned(),
        launched_at,
    })
    .unwrap();
    core.invoke(CoreCommand::EmbeddedSystemSurfaceRecovered {
        role_id: role_id.clone(),
    })
    .unwrap();
    let before_stale_statuses = serde_json::to_value(core.browser_statuses().unwrap()).unwrap();
    let before_stale_runtime = serde_json::to_value(
        core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot,
    )
    .unwrap();
    let before_stale_input = core.macro_input_diagnostics().unwrap();

    let (stale, stale_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: role_id.clone(),
            reason: Some("surface.navigation-failed".to_owned()),
            expected_tab_id: Some(source_owner.tab_id),
            expected_owner_generation: Some(source_owner.generation),
        },
        None,
    );
    assert_eq!(stale.unwrap_err().code(), "RUNTIME_ROLE_OWNER_STALE");
    assert!(stale_actions.is_empty());
    assert_eq!(
        serde_json::to_value(core.browser_statuses().unwrap()).unwrap(),
        before_stale_statuses
    );
    assert_eq!(
        serde_json::to_value(
            core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot,
        )
        .unwrap(),
        before_stale_runtime
    );
    assert_eq!(core.macro_input_diagnostics().unwrap(), before_stale_input);
    assert_eq!(
        core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot
            .roles
            .into_iter()
            .find(|role| role.role_id == role_id)
            .unwrap()
            .owner
            .generation,
        transferred_generation
    );
    core.shutdown();
}
