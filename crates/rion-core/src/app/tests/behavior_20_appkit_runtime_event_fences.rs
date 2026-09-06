fn appkit_test_identity(
    logical_window_id: &str,
    native_generation: u32,
) -> AppKitRuntimeHostIdentityRecord {
    AppKitRuntimeHostIdentityRecord {
        logical_window_id: logical_window_id.to_owned(),
        launch_generation: format!("launch-{logical_window_id}"),
        native_generation,
    }
}

fn appkit_test_observation(
    logical_window_id: &str,
    native_generation: u32,
) -> crate::model::AppKitRuntimeHostObservationRecord {
    crate::model::AppKitRuntimeHostObservationRecord {
        identity: appkit_test_identity(logical_window_id, native_generation),
        window_generation: 3,
        topology_revision: 7,
        content_bounds: crate::model::LayoutBounds {
            x: 0,
            y: 0,
            width: 900,
            height: 600,
        },
        normal_bounds: StatePixelBoundsRecord {
            x: 20,
            y: 30,
            width: 900,
            height: 640,
        },
        saved_work_area: StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        },
        target_display: crate::model::DisplayTargetRecord {
            id: 1,
            fingerprint: None,
        },
        presentation: "normal".to_owned(),
        focused: true,
        minimized: false,
        visible: true,
    }
}

fn appkit_test_event(
    action: crate::model::AppKitRuntimeEventActionRecord,
) -> crate::model::AppKitRuntimeEventRecord {
    crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![appkit_test_observation("window-1", 1)],
        action,
    }
}

#[test]
fn appkit_runtime_event_shape_fails_closed_for_missing_sequence_and_aliased_hosts() {
    let mut event = appkit_test_event(
        crate::model::AppKitRuntimeEventActionRecord::Layout { layout_sequence: 1 },
    );
    assert!(validate_appkit_runtime_event_shape(&event).is_ok());

    event.adapter_sequence = 0;
    assert_eq!(
        validate_appkit_runtime_event_shape(&event)
            .unwrap_err()
            .code(),
        "APPKIT_EVENT_IDENTITY_INVALID"
    );

    event.adapter_sequence = 1;
    event.hosts.push(event.hosts[0].clone());
    assert_eq!(
        validate_appkit_runtime_event_shape(&event)
            .unwrap_err()
            .code(),
        "APPKIT_EVENT_HOST_INVALID"
    );
}

#[test]
fn appkit_runtime_event_shape_requires_exact_drag_and_layout_fences() {
    let mut drag = appkit_test_event(crate::model::AppKitRuntimeEventActionRecord::Move {
        session_id: "drag-1".to_owned(),
        tab_id: "tab-1".to_owned(),
        source_window_id: "window-1".to_owned(),
        target_window_id: "window-2".to_owned(),
        before_tab_id: None,
        ordered_tab_ids: vec!["tab-2".to_owned(), "tab-1".to_owned()],
        phase: "drop".to_owned(),
    });
    assert_eq!(
        validate_appkit_runtime_event_shape(&drag)
            .unwrap_err()
            .code(),
        "APPKIT_DRAG_HOST_FENCE_INVALID"
    );
    drag.hosts.insert(0, appkit_test_observation("window-2", 2));
    assert!(validate_appkit_runtime_event_shape(&drag).is_ok());

    let layout = appkit_test_event(
        crate::model::AppKitRuntimeEventActionRecord::Layout { layout_sequence: 0 },
    );
    assert_eq!(
        validate_appkit_runtime_event_shape(&layout)
            .unwrap_err()
            .code(),
        "APPKIT_LAYOUT_SEQUENCE_INVALID"
    );
}

#[test]
fn appkit_adapter_sequence_and_drag_order_are_strictly_monotonic_and_exact() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let identity = appkit_test_identity("window-1", 1);
    assert!(core.accept_appkit_event_sequence(&identity, 4).unwrap());
    assert!(!core.accept_appkit_event_sequence(&identity, 4).unwrap());
    assert!(!core.accept_appkit_event_sequence(&identity, 3).unwrap());
    assert!(core
        .accept_appkit_event_sequence(&appkit_test_identity("window-1", 2), 1)
        .unwrap());

    let exact = vec!["tab-2".to_owned(), "tab-1".to_owned()];
    assert!(validate_exact_order(&exact, &exact, "tab-1", None).is_ok());
    assert_eq!(
        validate_exact_order(
            &["tab-1".to_owned(), "tab-2".to_owned()],
            &exact,
            "tab-1",
            None,
        )
        .unwrap_err()
        .code(),
        "APPKIT_DRAG_ORDER_INVALID"
    );
    core.shutdown();
}

#[test]
fn appkit_activation_commits_core_topology_and_finishes_from_exact_native_projection() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let game_id = first_game_id(&core);
    let role_ids = [
        create_role(&core, &game_id, 1),
        create_role(&core, &game_id, 2),
    ];
    let mut tab_ids = Vec::new();
    for role_id in role_ids {
        let (result, actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "windowId": "appkit-window-1",
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        result.unwrap();
        tab_ids.push(
            actions
                .iter()
                .find_map(|action| match action {
                    CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
                    _ => None,
                })
                .expect("AppKit Chromium launch must create one exact tab"),
        );
    }
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get("appkit-window-1").unwrap();
    assert_eq!(window.selected_tab_id.as_deref(), Some(tab_ids[1].as_str()));
    let mut observation = appkit_test_observation("appkit-window-1", 1);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    let event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::Activate {
            tab_id: tab_ids[0].clone(),
        },
    };

    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent {
            event: event.clone(),
        },
        |effect| effect_result(effect, None),
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, crate::model::SystemRuntimeOperationStatus::Applied);
    assert!(receipt.topology_committed);
    assert!(receipt.native_applied);
    let projection = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedApplyAppKitProjection { projection } => {
                Some(projection.as_ref())
            }
            _ => None,
        })
        .expect("activation must finish from an exact AppKit projection effect");
    assert_eq!(projection.event_id, event.event_id);
    assert_eq!(projection.windows[0].active_tab_id.as_deref(), Some(tab_ids[0].as_str()));
    assert!(projection.windows[0].tabs.iter().all(|tab| {
        tab.phase == crate::model::RuntimeTabActivationPhaseRecord::Ready
    }));
    assert_eq!(
        projection.windows[0]
            .tabs
            .iter()
            .map(|tab| tab.tab_id.as_str())
            .collect::<Vec<_>>(),
        tab_ids.iter().map(String::as_str).collect::<Vec<_>>()
    );

    let mut replay = event.clone();
    replay.event_id = uuid::Uuid::new_v4().to_string();
    let (replay_result, replay_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: replay },
        |effect| effect_result(effect, None),
    );
    let replay_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(replay_result.unwrap()).unwrap();
    assert_eq!(
        replay_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert!(replay_actions.is_empty());

    let mut stale_callback = event;
    stale_callback.event_id = uuid::Uuid::new_v4().to_string();
    stale_callback.adapter_sequence = 2;
    stale_callback.action = crate::model::AppKitRuntimeEventActionRecord::Activate {
        tab_id: tab_ids[1].clone(),
    };
    let (stale_result, stale_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent {
            event: stale_callback,
        },
        |effect| effect_result(effect, None),
    );
    let stale_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(stale_result.unwrap()).unwrap();
    assert_eq!(
        stale_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert!(!stale_receipt.topology_committed);
    assert!(stale_receipt.native_applied);
    assert!(stale_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows[0].active_tab_id.as_deref() == Some(tab_ids[0].as_str())
                && projection.windows[0].adapter_sequence == 2
    )));

    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get("appkit-window-1").unwrap();
    let mut stop_observation = appkit_test_observation("appkit-window-1", 1);
    stop_observation.window_generation = window.window_generation;
    stop_observation.topology_revision = window.revision;
    let stop = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 3,
        hosts: vec![stop_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::Stop {
            tab_id: tab_ids[0].clone(),
            ordered_tab_ids: vec![tab_ids[1].clone()],
        },
    };
    let (stop_result, stop_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: stop },
        |effect| effect_result(effect, None),
    );
    let stop_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(stop_result.unwrap()).unwrap();
    assert_eq!(
        stop_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(stop_receipt.topology_committed);
    assert!(stop_receipt.native_applied);
    assert!(stop_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedDestroyTab { tab_id, .. } if tab_id == &tab_ids[0]
    )));
    assert!(stop_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows[0].active_tab_id.as_deref() == Some(tab_ids[1].as_str())
    )));

    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get("appkit-window-1").unwrap();
    let mut close_observation = appkit_test_observation("appkit-window-1", 1);
    close_observation.window_generation = window.window_generation;
    close_observation.topology_revision = window.revision;
    let late_observation = close_observation.clone();
    let close = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 4,
        hosts: vec![close_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::CloseWindow,
    };
    let (close_result, close_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: close },
        |effect| effect_result(effect, None),
    );
    let close_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(close_result.unwrap()).unwrap();
    assert_eq!(
        close_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(close_receipt.topology_committed);
    assert!(close_receipt.native_applied);
    assert!(close_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedDestroyTab { tab_id, .. } if tab_id == &tab_ids[1]
    )));
    assert!(!core
        .browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .contains_key("appkit-window-1"));

    let late_event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 5,
        hosts: vec![late_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::WindowState {
            placement_sequence: 1,
        },
    };
    let (late_result, late_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: late_event },
        |effect| effect_result(effect, None),
    );
    let late_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(late_result.unwrap()).unwrap();
    assert_eq!(
        late_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert!(!late_receipt.topology_committed);
    assert!(!late_receipt.native_applied);
    assert!(late_actions.is_empty());
    core.shutdown();
}

fn launch_single_appkit_projection_tab(core: Arc<AppCore>, window_id: &str) -> String {
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let (result, actions) = drive_command(
        core,
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "windowId": window_id,
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    result.unwrap();
    actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        })
        .expect("AppKit projection fixture must create one Chromium tab")
}

fn current_appkit_layout_event(
    core: &AppCore,
    window_id: &str,
) -> crate::model::AppKitRuntimeEventRecord {
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get(window_id).unwrap();
    let mut observation = appkit_test_observation(window_id, 1);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::Layout {
            layout_sequence: 1,
        },
    }
}

#[test]
fn appkit_tab_hiding_and_window_visibility_keep_exact_core_and_native_fences() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let window_id = "appkit-window-visibility";
    let first_tab_id = launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
    let role_id = create_role(&core, &first_game_id(&core), 2);
    let (launch_result, launch_actions) = drive_command(
        Arc::clone(&core),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "windowId": window_id,
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    launch_result.unwrap();
    let second_tab_id = launch_actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        })
        .unwrap();

    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get(window_id).unwrap();
    let mut observation = appkit_test_observation(window_id, 1);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    let hide = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::SetTabHidden {
            tab_id: second_tab_id.clone(),
            hidden: true,
        },
    };
    let (hide_result, hide_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: hide },
        |effect| effect_result(effect, None),
    );
    let hide_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(hide_result.unwrap()).unwrap();
    assert_eq!(hide_receipt.status, crate::model::SystemRuntimeOperationStatus::Applied);
    let hidden_snapshot = core.browser_runtime.snapshot().unwrap();
    let hidden_window = hidden_snapshot.windows.get(window_id).unwrap();
    assert!(hidden_window.hidden_tab_ids.contains(&second_tab_id));
    assert_eq!(hidden_window.selected_tab_id.as_deref(), Some(first_tab_id.as_str()));
    assert!(hide_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows[0].tabs.len() == 1
                && projection.windows[0].tabs[0].tab_id == first_tab_id
                && projection.windows[0].logical_tab_ids
                    == [first_tab_id.clone(), second_tab_id.clone()]
                && projection.windows[0].hidden_tab_ids == [second_tab_id.clone()]
    )));

    let mut last_observation = appkit_test_observation(window_id, 1);
    last_observation.window_generation = hidden_window.window_generation;
    last_observation.topology_revision = hidden_window.revision;
    let hide_last = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 2,
        hosts: vec![last_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::SetTabHidden {
            tab_id: first_tab_id.clone(),
            hidden: true,
        },
    };
    let (last_result, last_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: hide_last },
        |effect| effect_result(effect, None),
    );
    let last_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(last_result.unwrap()).unwrap();
    assert_eq!(last_receipt.status, crate::model::SystemRuntimeOperationStatus::Applied);
    let last_snapshot = core.browser_runtime.snapshot().unwrap();
    let last_window = last_snapshot.windows.get(window_id).unwrap();
    assert!(last_window.selected_tab_id.is_none());
    assert_eq!(last_window.hidden_tab_ids.len(), 2);
    assert!(last_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows[0].tabs.is_empty()
                && projection.windows[0].active_tab_id.is_none()
                && projection.windows[0].logical_tab_ids
                    == [first_tab_id.clone(), second_tab_id.clone()]
                && projection.windows[0].hidden_tab_ids
                    == [first_tab_id.clone(), second_tab_id.clone()]
    )));

    let mut visibility_observation = appkit_test_observation(window_id, 1);
    visibility_observation.window_generation = last_window.window_generation;
    visibility_observation.topology_revision = last_window.revision;
    let visibility_identity = visibility_observation.identity.clone();
    let visibility = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 3,
        hosts: vec![visibility_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility {
            visible: false,
        },
    };
    let (visibility_result, visibility_actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: visibility },
        |effect| {
            if matches!(
                &effect.action,
                CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { .. }
            ) {
                runtime_window_visibility_effect_result(effect, "applied")
            } else {
                effect_result(effect, None)
            }
        },
    );
    let visibility_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(visibility_result.unwrap()).unwrap();
    assert_eq!(
        visibility_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(visibility_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility {
            lifecycle_epoch,
            window_id: effect_window_id,
            window_generation,
            topology_revision,
            appkit_identity: Some(identity),
            visible: false,
        } if *lifecycle_epoch == 1
            && effect_window_id == window_id
            && *window_generation == last_window.window_generation
            && *topology_revision == last_window.revision
            && identity == &visibility_identity
    )));
    core.shutdown();
}

#[test]
fn appkit_projection_quarantine_failures_retire_exact_core_window_and_tab_topology() {
    for failure_code in [
        "MACOS_APPKIT_CHROMIUM_PROJECTION_HOST_QUARANTINED",
        "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED",
    ] {
        let (_directory, core) = core_for_runtime_contract("darwin", 23);
        let window_id = format!("appkit-quarantine-{failure_code}");
        let tab_id = launch_single_appkit_projection_tab(Arc::clone(&core), &window_id);
        let event = current_appkit_layout_event(&core, &window_id);
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::BrowserAppKitRuntimeEvent { event },
            |effect| {
                if matches!(
                    &effect.action,
                    CoreEffectAction::EmbeddedApplyAppKitProjection { .. }
                ) {
                    CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(CoreErrorPayload {
                            code: failure_code.to_owned(),
                            message: "Injected exact AppKit projection quarantine.".to_owned(),
                        }),
                    }
                } else {
                    effect_result(effect, None)
                }
            },
        );
        let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.status,
            crate::model::SystemRuntimeOperationStatus::Failed
        );
        assert!(!receipt.topology_committed);
        assert!(!receipt.native_applied);
        assert_eq!(receipt.failure_code.as_deref(), Some(failure_code));
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedDestroyTab {
                tab_id: destroyed_tab_id,
                ..
            } if destroyed_tab_id == &tab_id
        )));
        assert!(!core
            .browser_runtime
            .snapshot()
            .unwrap()
            .windows
            .contains_key(&window_id));
        assert!(!core
            .browser_runtime_snapshot()
            .unwrap()
            .tabs
            .iter()
            .any(|tab| tab.id == tab_id));
        core.shutdown();
    }
}

#[test]
fn ordinary_appkit_projection_failure_preserves_retryable_core_topology() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let window_id = "appkit-projection-retry";
    let tab_id = launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
    let event = current_appkit_layout_event(&core, window_id);
    let failure_code = "MACOS_APPKIT_CHROMIUM_PROJECTION_STALE";
    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        |effect| {
            if matches!(
                &effect.action,
                CoreEffectAction::EmbeddedApplyAppKitProjection { .. }
            ) {
                CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(CoreErrorPayload {
                        code: failure_code.to_owned(),
                        message: "Injected retryable AppKit projection failure.".to_owned(),
                    }),
                }
            } else {
                effect_result(effect, None)
            }
        },
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Failed
    );
    assert_eq!(receipt.failure_code.as_deref(), Some(failure_code));
    assert!(!actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedDestroyTab { .. }
    )));
    assert!(core
        .browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .contains_key(window_id));
    assert!(core
        .browser_runtime_snapshot()
        .unwrap()
        .tabs
        .iter()
        .any(|tab| tab.id == tab_id));
    core.shutdown();
}

#[test]
fn appkit_projection_quarantine_teardown_failure_is_indeterminate_and_keeps_window() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let window_id = "appkit-quarantine-retry";
    launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
    let event = current_appkit_layout_event(&core, window_id);
    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        |effect| {
            if matches!(
                &effect.action,
                CoreEffectAction::EmbeddedApplyAppKitProjection { .. }
            ) {
                CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(CoreErrorPayload {
                        code: "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED".to_owned(),
                        message: "Injected indeterminate AppKit projection.".to_owned(),
                    }),
                }
            } else {
                effect_result(effect, Some("embeddedDestroyTab"))
            }
        },
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert!(!receipt.topology_committed);
    assert!(!receipt.native_applied);
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("DESKTOP_EFFECT_FAILED")
    );
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedDestroyTab { .. }
    )));
    assert!(core
        .browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .contains_key(window_id));
    core.shutdown();
}

#[test]
fn appkit_layout_supersession_requires_a_newer_same_generation_core_projection() {
    for (advance, replace_generation) in [(false, false), (true, false), (true, true)] {
        let (_directory, core) = core_for_runtime_contract("darwin", 23);
        let window_id = "appkit-layout-superseded";
        launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
        let event = current_appkit_layout_event(&core, window_id);
        let (result, _, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::BrowserAppKitRuntimeEvent { event },
            |effect| {
                if matches!(&effect.action, CoreEffectAction::EmbeddedApplyAppKitProjection { .. }) {
                    if advance {
                        let snapshot = core.browser_runtime.snapshot().unwrap();
                        let window = snapshot.windows.get(window_id).unwrap();
                        core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
                            crate::RuntimeTopologyCommitInput {
                                commit_id: "newer-layout-owner".to_owned(),
                                source: "command".to_owned(),
                                primary_window_id: window_id.to_owned(),
                                windows: vec![crate::RuntimeWindowTopologyCommit {
                                    active_tab_id: window.selected_tab_id.clone(),
                                    hidden_tab_ids: window.hidden_tab_ids.clone(),
                                    tabs: window.tabs.clone(),
                                    ui_sequence: window.ui_sequence + 1,
                                    window_generation: window.window_generation + u64::from(replace_generation),
                                    window_id: window_id.to_owned(),
                                }],
                            },
                        )).unwrap();
                    }
                    CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(CoreErrorPayload {
                            code: "ELECTRON_MACOS_APPKIT_PROJECTION_SUPERSEDED".to_owned(),
                            message: "Exact projection was superseded before application.".to_owned(),
                        }),
                    }
                } else {
                    effect_result(effect, None)
                }
            },
        );
        let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(receipt.status, if advance && !replace_generation {
            crate::model::SystemRuntimeOperationStatus::Superseded
        } else {
            crate::model::SystemRuntimeOperationStatus::Failed
        });
        assert!(!receipt.native_applied);
        assert!(!receipt.topology_committed);
        core.shutdown();
    }
}
