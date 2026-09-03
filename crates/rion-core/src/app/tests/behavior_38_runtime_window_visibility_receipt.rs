fn runtime_window_visibility_native_receipt(
    effect: &CoreEffectRequest,
    status: &str,
) -> crate::model::RuntimeWindowVisibilityNativeReceiptRecord {
    let CoreEffectAction::EmbeddedSetRuntimeWindowVisibility {
        lifecycle_epoch,
        window_id,
        window_generation,
        topology_revision,
        appkit_identity,
        visible,
    } = &effect.action
    else {
        panic!("expected a runtime-window visibility effect")
    };
    let windows = if status == "applied" {
        vec![
            crate::model::RuntimeWindowVisibilityNativeObservationRecord {
                platform: if appkit_identity.is_some() {
                    "macos"
                } else {
                    "windows"
                }
                .to_owned(),
                source: if *visible { "show" } else { "hide" }.to_owned(),
                sequence: 2,
                lifecycle_epoch: *lifecycle_epoch,
                logical_window_id: window_id.clone(),
                native_host_id: 71,
                native_generation: appkit_identity
                    .as_ref()
                    .map_or(5, |identity| u64::from(identity.native_generation)),
                window_generation: *window_generation,
                topology_revision: *topology_revision,
                visible: *visible,
                minimized: false,
                focused: false,
                foreground: false,
                appkit_identity: appkit_identity.clone(),
                failure_code: None,
            },
        ]
    } else {
        Vec::new()
    };
    crate::model::RuntimeWindowVisibilityNativeReceiptRecord {
        effect_id: effect.effect_id.clone(),
        operation_id: effect.operation_id.clone(),
        lifecycle_epoch: *lifecycle_epoch,
        status: status.to_owned(),
        windows,
    }
}

fn runtime_window_visibility_effect_result(
    effect: CoreEffectRequest,
    status: &str,
) -> CoreEffectResult {
    let receipt = runtime_window_visibility_native_receipt(&effect, status);
    CoreEffectResult {
        effect_id: effect.effect_id,
        operation_id: effect.operation_id,
        ok: true,
        value_json: Some(serde_json::to_string(&receipt).unwrap()),
        error: None,
    }
}

fn runtime_window_visibility_command(
    operation_id: &str,
    window: &crate::RuntimeLiveWindowRecord,
    visible: bool,
) -> CoreCommand {
    CoreCommand::EmbeddedWindowVisibility {
        operation_id: operation_id.to_owned(),
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        topology_revision: window.revision,
        visible,
    }
}

fn next_runtime_window_visibility_effect(
    receiver: &crossbeam_channel::Receiver<Vec<CoreEvent>>,
) -> CoreEffectRequest {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let events = receiver
            .recv_timeout(remaining)
            .expect("runtime-window visibility effect must be emitted without waiting for an older acknowledgement");
        for event in events {
            let CoreEvent::CoreEffects { effects } = event else {
                continue;
            };
            if let Some(effect) = effects.into_iter().find(|effect| {
                matches!(
                    effect.action,
                    CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { .. }
                )
            }) {
                return effect;
            }
        }
    }
}

fn spawn_appkit_visibility_invocation(
    core: Arc<AppCore>,
    event: crate::model::AppKitRuntimeEventRecord,
) -> thread::JoinHandle<CoreResult<Value>> {
    thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(core.invoke_async(CoreCommand::BrowserAppKitRuntimeEvent { event }))
    })
}

#[test]
fn runtime_window_visibility_applied_receipt_is_exact_replayable_and_epoch_fenced() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "visibility-exact-seed",
        vec![(
            "visibility-exact-window",
            "visibility-tab",
            "visibility-role",
        )],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows["visibility-exact-window"].clone();
    let command = runtime_window_visibility_command("visibility-exact", &window, false);
    let (result, actions) = drive_command_with(Arc::clone(&core), command.clone(), |effect| {
        runtime_window_visibility_effect_result(effect, "applied")
    });
    let receipt: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert_eq!(receipt.stage, "runtimeWindowVisibilityApplied");
    assert_eq!(receipt.lifecycle_epoch, Some(1));
    assert_eq!(
        receipt.completion_scope,
        crate::model::SystemRuntimeOperationCompletionScope::NativeAcknowledgement
    );
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility {
            lifecycle_epoch: 1,
            window_id,
            window_generation,
            topology_revision,
            appkit_identity: None,
            visible: false,
        } if window_id == &window.window_id
            && *window_generation == window.window_generation
            && *topology_revision == window.revision
    )));

    let (replay, replay_actions) = drive_command_with(Arc::clone(&core), command, |_| {
        panic!("a retained visibility receipt must not re-run native work")
    });
    let replay: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(replay.unwrap()).unwrap();
    assert_eq!(replay.operation_id, receipt.operation_id);
    assert_eq!(replay.lifecycle_epoch, Some(1));
    assert!(replay_actions.is_empty());

    let (stale, stale_actions) = drive_command_with(
        Arc::clone(&core),
        CoreCommand::EmbeddedWindowVisibility {
            operation_id: "visibility-stale".to_owned(),
            window_id: window.window_id,
            window_generation: window.window_generation + 1,
            topology_revision: window.revision,
            visible: true,
        },
        |_| panic!("a stale visibility fence must not reach the native executor"),
    );
    let stale: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(stale.unwrap()).unwrap();
    assert_eq!(
        stale.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert_eq!(stale.lifecycle_epoch, Some(1));
    assert!(stale_actions.is_empty());
    core.shutdown();
}

#[test]
fn runtime_window_visibility_shares_operation_identity_fencing_with_other_ui_actions() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "visibility-cross-action-seed",
        vec![(
            "visibility-cross-action-window",
            "visibility-cross-action-tab",
            "visibility-cross-action-role",
        )],
    );

    let before_hide = core.browser_runtime.snapshot().unwrap();
    let window = &before_hide.windows["visibility-cross-action-window"];
    let shared_from_tab = "visibility-cross-action-from-tab";
    let (hidden, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedTabHide {
            operation_id: shared_from_tab.to_owned(),
            tab_id: "visibility-cross-action-tab".to_owned(),
            window_id: window.window_id.clone(),
            window_generation: window.window_generation,
            topology_revision: window.revision,
            hidden: true,
        },
        None,
    );
    hidden.unwrap();
    let after_hide = core.browser_runtime.snapshot().unwrap();
    let window = &after_hide.windows["visibility-cross-action-window"];
    let (reused_visibility, reused_visibility_actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_visibility_command(shared_from_tab, window, false),
        |_| panic!("cross-action identity reuse must fail before native visibility work"),
    );
    assert_eq!(
        reused_visibility.unwrap_err().code(),
        "RUNTIME_UI_OPERATION_ID_REUSED"
    );
    assert!(reused_visibility_actions.is_empty());

    let shared_from_visibility = "visibility-cross-action-from-visibility";
    let (visibility, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_visibility_command(shared_from_visibility, window, false),
        |effect| runtime_window_visibility_effect_result(effect, "applied"),
    );
    visibility.unwrap();
    let (reused_tab, reused_tab_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedTabHide {
            operation_id: shared_from_visibility.to_owned(),
            tab_id: "visibility-cross-action-tab".to_owned(),
            window_id: window.window_id.clone(),
            window_generation: window.window_generation,
            topology_revision: window.revision,
            hidden: false,
        },
        None,
    );
    assert_eq!(
        reused_tab.unwrap_err().code(),
        "RUNTIME_UI_OPERATION_ID_REUSED"
    );
    assert!(reused_tab_actions.is_empty());
}

#[test]
fn runtime_window_visibility_never_infers_applied_and_maps_exact_superseded_receipt() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "visibility-terminal-seed",
        vec![(
            "visibility-terminal-window",
            "visibility-tab",
            "visibility-role",
        )],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows["visibility-terminal-window"].clone();

    let (missing, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_visibility_command("visibility-missing", &window, false),
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: true,
            value_json: None,
            error: None,
        },
    );
    let missing: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(missing.unwrap()).unwrap();
    assert_eq!(
        missing.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert_eq!(
        missing.failure_code.as_deref(),
        Some("RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_MISSING")
    );
    assert_eq!(missing.lifecycle_epoch, Some(1));

    let (stale, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_visibility_command("visibility-mismatch", &window, false),
        |effect| {
            let mut receipt = runtime_window_visibility_native_receipt(&effect, "applied");
            receipt.windows[0].topology_revision += 1;
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: true,
                value_json: Some(serde_json::to_string(&receipt).unwrap()),
                error: None,
            }
        },
    );
    let stale: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(stale.unwrap()).unwrap();
    assert_eq!(
        stale.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert_eq!(
        stale.failure_code.as_deref(),
        Some("RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_STALE")
    );

    let (superseded, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_visibility_command("visibility-superseded", &window, true),
        |effect| runtime_window_visibility_effect_result(effect, "superseded"),
    );
    let superseded: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(superseded.unwrap()).unwrap();
    assert_eq!(
        superseded.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert_eq!(superseded.stage, "runtimeWindowVisibilitySuperseded");
    assert_eq!(superseded.lifecycle_epoch, Some(1));
    assert!(superseded.failure_code.is_none());
    core.shutdown();
}

#[test]
fn runtime_window_visibility_reconciles_only_an_exact_completed_host_quarantine() {
    for (native_code, expected_status, expects_teardown) in [
        (
            "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED",
            crate::model::SystemRuntimeOperationStatus::Failed,
            true,
        ),
        (
            "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_QUARANTINE_FAILED",
            crate::model::SystemRuntimeOperationStatus::Indeterminate,
            false,
        ),
    ] {
        let (_directory, core) = core_for_runtime_contract("win32", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("win32", true),
        })
        .unwrap();
        let window_id = if expects_teardown {
            "visibility-quarantined-window"
        } else {
            "visibility-quarantine-failed-window"
        };
        seed_runtime_ui_topology(
            &core,
            &format!("{window_id}-seed"),
            vec![(window_id, "visibility-quarantine-tab", "visibility-role")],
        );
        let snapshot = core.browser_runtime.snapshot().unwrap();
        let window = snapshot.windows[window_id].clone();
        let (result, actions) = drive_command_with(
            Arc::clone(&core),
            runtime_window_visibility_command(&format!("{window_id}-operation"), &window, false),
            |effect| match &effect.action {
                CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { .. } => CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(crate::CoreErrorPayload {
                        code: native_code.to_owned(),
                        message: "injected visibility quarantine outcome".to_owned(),
                    }),
                },
                CoreEffectAction::EmbeddedDestroyTab { .. } => effect_result(effect, None),
                action => panic!("unexpected quarantine reconciliation effect: {action:?}"),
            },
        );
        let receipt: crate::model::SystemRuntimeOperationSummaryRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(receipt.status, expected_status, "{native_code}");
        assert_eq!(receipt.failure_code.as_deref(), Some(native_code));
        assert_eq!(
            actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. })),
            expects_teardown,
            "{native_code}"
        );
        assert_eq!(
            core.browser_runtime
                .snapshot()
                .unwrap()
                .windows
                .contains_key(window_id),
            !expects_teardown,
            "{native_code}"
        );
        core.shutdown();
    }
}

#[test]
fn appkit_visibility_maps_only_an_exact_native_terminal_receipt() {
    for (terminal, expected_status, expected_native_applied) in [
        (
            "superseded",
            crate::model::SystemRuntimeOperationStatus::Superseded,
            false,
        ),
        (
            "missing",
            crate::model::SystemRuntimeOperationStatus::Indeterminate,
            false,
        ),
    ] {
        let (_directory, core) = core_for_runtime_contract("darwin", 23);
        let window_id = format!("appkit-visibility-{terminal}");
        launch_single_appkit_projection_tab(Arc::clone(&core), &window_id);
        let snapshot = core.browser_runtime.snapshot().unwrap();
        let window = &snapshot.windows[&window_id];
        let mut observation = appkit_test_observation(&window_id, 9);
        observation.window_generation = window.window_generation;
        observation.topology_revision = window.revision;
        observation.visible = true;
        let event = crate::model::AppKitRuntimeEventRecord {
            event_id: uuid::Uuid::new_v4().to_string(),
            adapter_sequence: 1,
            hosts: vec![observation],
            action: crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility {
                visible: false,
            },
        };
        let (result, _, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::BrowserAppKitRuntimeEvent { event },
            |effect| {
                if terminal == "missing" {
                    CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: true,
                        value_json: None,
                        error: None,
                    }
                } else {
                    runtime_window_visibility_effect_result(effect, terminal)
                }
            },
        );
        let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(receipt.status, expected_status, "{terminal}");
        assert_eq!(
            receipt.native_applied, expected_native_applied,
            "{terminal}"
        );
        if terminal == "missing" {
            assert_eq!(
                receipt.failure_code.as_deref(),
                Some("RUNTIME_WINDOW_VISIBILITY_NATIVE_RECEIPT_MISSING")
            );
        } else {
            assert!(receipt.failure_code.is_none());
        }
        core.shutdown();
    }
}

#[test]
fn appkit_matching_visibility_still_commits_the_exact_surface_projection() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let window_id = "appkit-matching-visibility";
    launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = &snapshot.windows[window_id];
    let mut observation = appkit_test_observation(window_id, 12);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    observation.visible = true;
    let event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility {
            visible: true,
        },
    };

    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        |effect| effect_result(effect, None),
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();

    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(receipt.native_applied);
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows.len() == 1
                && projection.windows[0].identity.logical_window_id == window_id
                && projection.windows[0].window_visible
    )));
    assert!(!actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { .. }
    )));
    core.shutdown();
}

#[test]
fn appkit_visible_but_unfocused_show_requires_an_exact_native_reveal() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let window_id = "appkit-visible-unfocused-show";
    launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = &snapshot.windows[window_id];
    let mut observation = appkit_test_observation(window_id, 13);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    observation.visible = true;
    observation.focused = false;
    let event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility {
            visible: true,
        },
    };

    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        |effect| runtime_window_visibility_effect_result(effect, "applied"),
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();

    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(receipt.native_applied);
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility {
            visible: true,
            ..
        }
    )));
    core.shutdown();
}

#[test]
fn runtime_window_visibility_releases_the_lane_after_dispatch_and_joins_duplicates() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "visibility-concurrent-seed",
        vec![(
            "visibility-concurrent-window",
            "visibility-concurrent-tab",
            "visibility-concurrent-role",
        )],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows["visibility-concurrent-window"].clone();
    let hide = runtime_window_visibility_command("visibility-concurrent-hide", &window, false);
    let show = runtime_window_visibility_command("visibility-concurrent-show", &window, true);
    let receiver = core.subscribe().unwrap();

    let hide_core = Arc::clone(&core);
    let hide_command = hide.clone();
    let hide_invocation = thread::spawn(move || hide_core.invoke(hide_command));
    let first = next_runtime_window_visibility_effect(&receiver);
    assert!(matches!(
        &first.action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { visible: false, .. }
    ));

    let duplicate_core = Arc::clone(&core);
    let duplicate_command = hide.clone();
    let duplicate_invocation = thread::spawn(move || duplicate_core.invoke(duplicate_command));
    let show_core = Arc::clone(&core);
    let show_invocation = thread::spawn(move || show_core.invoke(show));
    let second = next_runtime_window_visibility_effect(&receiver);
    assert!(matches!(
        &second.action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { visible: true, .. }
    ));

    core.dispatch_core_effect_results(vec![
        runtime_window_visibility_effect_result(first, "superseded"),
        runtime_window_visibility_effect_result(second, "applied"),
    ])
    .unwrap();
    let hide_receipt = hide_invocation.join().unwrap().unwrap();
    let duplicate_receipt = duplicate_invocation.join().unwrap().unwrap();
    let show_receipt: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(show_invocation.join().unwrap().unwrap()).unwrap();
    assert_eq!(hide_receipt, duplicate_receipt);
    assert_eq!(
        serde_json::from_value::<crate::model::SystemRuntimeOperationSummaryRecord>(
            hide_receipt.clone(),
        )
        .unwrap()
        .status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert_eq!(
        show_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );

    let emitted_before_replay = core.operation_actor.metrics().emitted_effect_count;
    assert_eq!(core.invoke(hide.clone()).unwrap(), hide_receipt);
    assert_eq!(
        core.operation_actor.metrics().emitted_effect_count,
        emitted_before_replay
    );
    let reused = match hide {
        CoreCommand::EmbeddedWindowVisibility {
            operation_id,
            window_id,
            window_generation,
            topology_revision,
            ..
        } => CoreCommand::EmbeddedWindowVisibility {
            operation_id,
            window_id,
            window_generation,
            topology_revision,
            visible: true,
        },
        _ => unreachable!(),
    };
    assert_eq!(
        core.invoke(reused).unwrap_err().code(),
        "RUNTIME_UI_OPERATION_ID_REUSED"
    );
    core.shutdown();
}

#[test]
fn appkit_visibility_releases_the_event_lane_and_replays_one_exact_terminal_receipt() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let window_id = "appkit-visibility-concurrent";
    launch_single_appkit_projection_tab(Arc::clone(&core), window_id);
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = &snapshot.windows[window_id];
    let mut visible_observation = appkit_test_observation(window_id, 11);
    visible_observation.window_generation = window.window_generation;
    visible_observation.topology_revision = window.revision;
    visible_observation.visible = true;
    let hide_event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![visible_observation.clone()],
        action: crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility {
            visible: false,
        },
    };
    let mut hidden_observation = visible_observation;
    hidden_observation.visible = false;
    hidden_observation.focused = false;
    let show_event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 2,
        hosts: vec![hidden_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility { visible: true },
    };
    let receiver = core.subscribe().unwrap();

    let hide_invocation = spawn_appkit_visibility_invocation(Arc::clone(&core), hide_event.clone());
    let first = next_runtime_window_visibility_effect(&receiver);
    assert!(matches!(
        &first.action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { visible: false, .. }
    ));
    let duplicate_invocation =
        spawn_appkit_visibility_invocation(Arc::clone(&core), hide_event.clone());
    let show_invocation = spawn_appkit_visibility_invocation(Arc::clone(&core), show_event);
    let second = next_runtime_window_visibility_effect(&receiver);
    assert!(matches!(
        &second.action,
        CoreEffectAction::EmbeddedSetRuntimeWindowVisibility { visible: true, .. }
    ));

    core.dispatch_core_effect_results(vec![
        runtime_window_visibility_effect_result(first, "superseded"),
        runtime_window_visibility_effect_result(second, "applied"),
    ])
    .unwrap();
    let hide_receipt = hide_invocation.join().unwrap().unwrap();
    let duplicate_receipt = duplicate_invocation.join().unwrap().unwrap();
    let show_receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(show_invocation.join().unwrap().unwrap()).unwrap();
    assert_eq!(hide_receipt, duplicate_receipt);
    assert_eq!(
        serde_json::from_value::<crate::model::AppKitRuntimeEventReceiptRecord>(
            hide_receipt.clone(),
        )
        .unwrap()
        .status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert_eq!(
        show_receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );

    let emitted_before_replay = core.operation_actor.metrics().emitted_effect_count;
    let replay = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(core.invoke_async(CoreCommand::BrowserAppKitRuntimeEvent {
            event: hide_event.clone(),
        }))
        .unwrap();
    assert_eq!(replay, hide_receipt);
    assert_eq!(
        core.operation_actor.metrics().emitted_effect_count,
        emitted_before_replay
    );

    let mut reused_event = hide_event;
    reused_event.action =
        crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility { visible: true };
    let reused = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(core.invoke_async(CoreCommand::BrowserAppKitRuntimeEvent {
            event: reused_event,
        }))
        .unwrap_err();
    assert_eq!(
        reused.code(),
        "RUNTIME_WINDOW_VISIBILITY_OPERATION_ID_REUSED"
    );
    core.shutdown();
}

fn next_runtime_window_visibility_cancellation(
    receiver: &crossbeam_channel::Receiver<Vec<CoreEvent>>,
    effect: &CoreEffectRequest,
) -> crate::model::CoreEffectCancellationRecord {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let events = receiver
            .recv_timeout(remaining)
            .expect("runtime-window visibility cancellation must follow the dispatched effect");
        for event in events {
            let CoreEvent::CoreEffectCancellations { cancellations } = event else {
                continue;
            };
            if let Some(cancellation) = cancellations.into_iter().find(|cancellation| {
                cancellation.effect_id == effect.effect_id
                    && cancellation.operation_id == effect.operation_id
            }) {
                return cancellation;
            }
        }
    }
}

#[test]
fn runtime_window_visibility_post_dispatch_cancel_preserves_continuation_indeterminate() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "visibility-cancel-seed",
        vec![(
            "visibility-cancel-window",
            "visibility-cancel-tab",
            "visibility-cancel-role",
        )],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows["visibility-cancel-window"].clone();
    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation = thread::spawn(move || {
        invocation_core.invoke(runtime_window_visibility_command(
            "visibility-cancel",
            &window,
            false,
        ))
    });
    let effect = next_runtime_window_visibility_effect(&receiver);

    let cancelled = core
        .invoke(CoreCommand::OperationCancel {
            operation_id: effect.operation_id.clone(),
        })
        .unwrap();
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!(
        next_runtime_window_visibility_cancellation(&receiver, &effect).reason,
        crate::model::CoreEffectCancellationReason::OperationCancelled
    );
    let report = core
        .dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(crate::CoreErrorPayload {
                code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE".to_owned(),
                message: "native visibility submission may have completed".to_owned(),
            }),
        }])
        .unwrap();
    assert_eq!(report.accepted.len(), 1);
    let receipt: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(invocation.join().unwrap().unwrap()).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE")
    );
    core.shutdown();
}

#[test]
fn runtime_window_visibility_actor_stop_preserves_continuation_indeterminate() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "visibility-actor-stop-seed",
        vec![(
            "visibility-actor-stop-window",
            "visibility-actor-stop-tab",
            "visibility-actor-stop-role",
        )],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows["visibility-actor-stop-window"].clone();
    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation = thread::spawn(move || {
        invocation_core.invoke(runtime_window_visibility_command(
            "visibility-actor-stop",
            &window,
            false,
        ))
    });
    let effect = next_runtime_window_visibility_effect(&receiver);

    core.shutdown();
    assert_eq!(
        next_runtime_window_visibility_cancellation(&receiver, &effect).reason,
        crate::model::CoreEffectCancellationReason::ActorStopped
    );
    let report = core
        .dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(crate::CoreErrorPayload {
                code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE".to_owned(),
                message: "native visibility submission may have completed".to_owned(),
            }),
        }])
        .unwrap();
    assert_eq!(report.accepted.len(), 1);
    let receipt: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(invocation.join().unwrap().unwrap()).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE")
    );
}
