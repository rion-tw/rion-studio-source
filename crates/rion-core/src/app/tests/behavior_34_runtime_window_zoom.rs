fn seed_runtime_window_zoom(core: &AppCore, platform: &str) -> crate::RuntimeLiveWindowRecord {
    seed_runtime_ui_topology(
        core,
        &format!("runtime-window-zoom-seed-{platform}"),
        vec![("runtime-window-zoom", "runtime-window-zoom-tab", "zoom-role")],
    );
    core.browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .get("runtime-window-zoom")
        .unwrap()
        .clone()
}

fn runtime_window_zoom_command(
    operation_id: &str,
    window: &crate::RuntimeLiveWindowRecord,
    action: &str,
) -> CoreCommand {
    CoreCommand::BrowserRuntimeWindowZoom {
        operation_id: operation_id.to_owned(),
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        topology_revision: window.revision,
        action: action.to_owned(),
    }
}

fn runtime_window_zoom_effect_result(effect: CoreEffectRequest) -> CoreEffectResult {
    let value_json = match &effect.action {
        CoreEffectAction::EmbeddedSetRuntimeWindowZoom {
            window_id,
            window_generation,
            topology_revision,
            zoom_factor,
            previous_zoom_factor,
        } => Some(
            serde_json::to_string(&crate::model::RuntimeWindowZoomNativeReceiptRecord {
                window_id: window_id.clone(),
                window_generation: *window_generation,
                topology_revision: *topology_revision,
                previous_zoom_factor: *previous_zoom_factor,
                next_zoom_factor: *zoom_factor,
                role_surface_count: 2,
                global_web_surface_count: 1,
                popup_surface_count: 3,
                status: "applied".to_owned(),
            })
            .unwrap(),
        ),
        _ => None,
    };
    CoreEffectResult {
        effect_id: effect.effect_id,
        operation_id: effect.operation_id,
        ok: true,
        value_json,
        error: None,
    }
}

#[test]
fn runtime_window_zoom_matches_v22_game_window_step_on_both_chromium_hosts() {
    // Stable v22 Game Windows use ±0.05 (not the launcher's separate 0.1 lane).
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let window = seed_runtime_window_zoom(&core, platform);
        let (result, actions) = drive_command_with(
            Arc::clone(&core),
            runtime_window_zoom_command(
                &format!("runtime-window-zoom-applied-{platform}"),
                &window,
                "in",
            ),
            runtime_window_zoom_effect_result,
        );
        let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(receipt.status, "applied", "{platform}: {receipt:?}");
        assert_eq!(receipt.previous_zoom_factor, 1.0, "{platform}");
        assert_eq!(receipt.next_zoom_factor, 1.05, "{platform}");
        assert_eq!(receipt.source_topology_revision, window.revision, "{platform}");
        assert!(receipt.topology_revision > window.revision, "{platform}");
        assert_eq!(receipt.role_surface_count, 2, "{platform}");
        assert_eq!(receipt.global_web_surface_count, 1, "{platform}");
        assert_eq!(receipt.popup_surface_count, 3, "{platform}");
        assert!(receipt.failure_code.is_none(), "{platform}");
        assert!(actions.iter().any(|candidate| matches!(
            candidate,
            CoreEffectAction::EmbeddedSetRuntimeWindowZoom {
                previous_zoom_factor,
                zoom_factor,
                ..
            } if *previous_zoom_factor == 1.0 && *zoom_factor == 1.05
        )), "{platform}");
        let committed = core
            .browser_runtime
            .snapshot()
            .unwrap()
            .windows
            .get(&window.window_id)
            .unwrap()
            .window_zoom_factor;
        assert_eq!(committed, Some(1.05), "{platform}");
        assert_eq!(
            core.app_snapshot()
                .unwrap()
                .logical_windows
                .iter()
                .find(|candidate| candidate.window_id == window.window_id)
                .unwrap()
                .window_zoom_factor,
            1.05,
            "{platform}"
        );
        core.replace_browser_runtime_registration(chromium_registration(platform, false))
            .unwrap();
        let replay: crate::model::RuntimeWindowZoomReceiptRecord = serde_json::from_value(
            core.invoke(runtime_window_zoom_command(
                &format!("runtime-window-zoom-applied-{platform}"),
                &window,
                "in",
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replay.operation_id, receipt.operation_id, "{platform}");
        assert_eq!(replay.topology_revision, receipt.topology_revision, "{platform}");
        let reused = core
            .invoke(runtime_window_zoom_command(
                &format!("runtime-window-zoom-applied-{platform}"),
                &window,
                "out",
            ))
            .unwrap_err();
        assert_eq!(
            reused.code(),
            "RUNTIME_WINDOW_ZOOM_OPERATION_ID_REUSED",
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn stable_v22_runtime_rejects_chromium_window_zoom_without_native_effects() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 22);
        let window = seed_runtime_window_zoom(&core, platform);
        let receiver = core.subscribe().unwrap();
        let result = core.invoke(runtime_window_zoom_command(
                &format!("runtime-window-zoom-v22-unavailable-{platform}"),
                &window,
                "in",
            ));
        assert_eq!(
            result.unwrap_err().code(),
            "RUNTIME_WINDOW_ZOOM_UNAVAILABLE",
            "{platform}"
        );
        let emitted_zoom = receiver.try_iter().flatten().any(|event| {
            matches!(
                event,
                CoreEvent::CoreEffects { effects }
                    if effects.iter().any(|effect| matches!(
                        &effect.action,
                        CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }
                    ))
            )
        });
        assert!(!emitted_zoom, "{platform}");
        core.shutdown();
    }
}

#[test]
fn evicted_zoom_receipt_never_treats_a_kernel_duplicate_as_applied() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "win32");
    let operation_id = "runtime-window-zoom-evicted";
    let fingerprint = format!(
        "{}:{}:{}:in",
        window.window_id, window.window_generation, window.revision
    );
    let dummy = crate::model::RuntimeWindowZoomReceiptRecord {
        operation_id: operation_id.to_owned(),
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        source_topology_revision: window.revision,
        topology_revision: window.revision,
        action: "in".to_owned(),
        previous_zoom_factor: 1.0,
        next_zoom_factor: 1.05,
        status: "applied".to_owned(),
        role_surface_count: 0,
        global_web_surface_count: 0,
        popup_surface_count: 0,
        failure_code: None,
    };
    core.retain_runtime_window_zoom_receipt(
        operation_id.to_owned(),
        fingerprint,
        dummy,
    )
    .unwrap();
    for index in 0..RETAINED_RUNTIME_WINDOW_ZOOM_RECEIPTS {
        let id = format!("runtime-window-zoom-retained-{index}");
        let receipt = crate::model::RuntimeWindowZoomReceiptRecord {
            operation_id: id.clone(),
            window_id: window.window_id.clone(),
            window_generation: window.window_generation,
            source_topology_revision: window.revision,
            topology_revision: window.revision,
            action: "reset".to_owned(),
            previous_zoom_factor: 1.0,
            next_zoom_factor: 1.0,
            status: "applied".to_owned(),
            role_surface_count: 0,
            global_web_surface_count: 0,
            popup_surface_count: 0,
            failure_code: None,
        };
        core.retain_runtime_window_zoom_receipt(id.clone(), id, receipt)
            .unwrap();
    }
    core.apply_runtime_intent(crate::RuntimeIntent::SetWindowZoomFactor {
        expected_revision: Some(window.revision),
        operation_id: format!("{operation_id}:commit"),
        window_id: window.window_id.clone(),
        zoom_factor: 1.0,
    })
    .unwrap();

    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command(operation_id, &window, "in"),
        runtime_window_zoom_effect_result,
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "superseded", "{receipt:?}");
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("RUNTIME_WINDOW_ZOOM_COMMIT_DUPLICATE")
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }
            ))
            .count(),
        2
    );
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
            .window_zoom_factor
            .unwrap_or(1.0),
        1.0
    );
    core.shutdown();
}

#[test]
fn rejected_native_zoom_after_exact_shell_rollback_is_failed_not_indeterminate() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "darwin");
    let mut zoom_effects = 0;
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-native-rejected", &window, "in"),
        move |effect| {
            if matches!(effect.action, CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }) {
                zoom_effects += 1;
                if zoom_effects == 1 {
                    return CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(CoreErrorPayload {
                            code: "CHROMIUM_RUNTIME_WINDOW_ZOOM_APPLY_FAILED".to_owned(),
                            message: "The native shell rolled back the partial fanout exactly."
                                .to_owned(),
                        }),
                    };
                }
            }
            runtime_window_zoom_effect_result(effect)
        },
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "failed", "{receipt:?}");
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("CHROMIUM_RUNTIME_WINDOW_ZOOM_APPLY_FAILED")
    );
    // The negative result is authoritative only after the shell has rolled its
    // partial fanout back. Core must not issue a second reverse for that known
    // rejection; transport uncertainty remains OperationActor-owned.
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }
            ))
            .count(),
        1
    );
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
            .window_zoom_factor,
        None
    );
    core.shutdown();
}

#[test]
fn pre_mutation_native_stale_rejection_is_failed_without_reverse() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "win32");
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-preflight-stale", &window, "out"),
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "CHROMIUM_RUNTIME_WINDOW_ZOOM_NATIVE_STALE".to_owned(),
                message: "The native host fence changed before mutation.".to_owned(),
            }),
        },
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "failed", "{receipt:?}");
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("CHROMIUM_RUNTIME_WINDOW_ZOOM_NATIVE_STALE")
    );
    assert_eq!(actions.len(), 1);
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
            .window_zoom_factor,
        None
    );
    core.shutdown();
}

#[test]
fn unknown_internal_shell_rollback_is_indeterminate_without_core_double_reverse() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "darwin");
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-rollback-unknown", &window, "in"),
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "CHROMIUM_RUNTIME_WINDOW_ZOOM_COMPENSATION_UNKNOWN".to_owned(),
                message: "The native shell could not prove native rollback.".to_owned(),
            }),
        },
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "indeterminate", "{receipt:?}");
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("CHROMIUM_RUNTIME_WINDOW_ZOOM_COMPENSATION_UNKNOWN")
    );
    assert_eq!(actions.len(), 1);
    core.shutdown();
}

#[test]
fn no_op_zoom_receipt_uses_the_exact_target_window_revision() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    seed_runtime_ui_topology(
        &core,
        "runtime-window-zoom-no-op-seed",
        vec![
            ("runtime-window-zoom", "runtime-window-zoom-tab", "zoom-role"),
            ("other-window", "other-tab", "other-role"),
        ],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let target = snapshot.windows["runtime-window-zoom"].clone();
    let other = snapshot.windows["other-window"].clone();
    let other_commit = core
        .apply_runtime_intent(crate::RuntimeIntent::SetWindowZoomFactor {
            expected_revision: Some(other.revision),
            operation_id: "runtime-window-zoom-other-window".to_owned(),
            window_id: other.window_id,
            zoom_factor: 1.2,
        })
        .unwrap();
    assert!(other_commit.revision > target.revision);

    let (result, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-no-op", &target, "reset"),
        runtime_window_zoom_effect_result,
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "applied", "{receipt:?}");
    assert_eq!(receipt.previous_zoom_factor, 1.0);
    assert_eq!(receipt.next_zoom_factor, 1.0);
    assert_eq!(receipt.source_topology_revision, target.revision);
    assert_eq!(receipt.topology_revision, target.revision);
    core.shutdown();
}

#[test]
fn superseded_zoom_commit_compensates_to_the_current_kernel_factor() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "darwin");
    let mutate_core = Arc::clone(&core);
    let concurrent_window = window.clone();
    let mut zoom_effects = 0;
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-superseded", &window, "in"),
        move |effect| {
            if matches!(effect.action, CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }) {
                zoom_effects += 1;
                if zoom_effects == 1 {
                    mutate_core
                        .apply_runtime_intent(crate::RuntimeIntent::SetWindowZoomFactor {
                            expected_revision: Some(concurrent_window.revision),
                            operation_id: "runtime-window-zoom-concurrent".to_owned(),
                            window_id: concurrent_window.window_id.clone(),
                            zoom_factor: 1.2,
                        })
                        .unwrap();
                }
            }
            runtime_window_zoom_effect_result(effect)
        },
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "superseded", "{receipt:?}");
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("RUNTIME_WINDOW_ZOOM_COMMIT_STALE")
    );
    let zooms = actions
        .iter()
        .filter_map(|action| match action {
            CoreEffectAction::EmbeddedSetRuntimeWindowZoom {
                previous_zoom_factor,
                zoom_factor,
                topology_revision,
                ..
            } => Some((*previous_zoom_factor, *zoom_factor, *topology_revision)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(zooms.len(), 2);
    assert_eq!(zooms[0], (1.0, 1.05, window.revision));
    assert_eq!(zooms[1].0, 1.05);
    assert_eq!(zooms[1].1, 1.2);
    assert!(zooms[1].2 > window.revision);
    assert_eq!(
        core.browser_runtime
            .snapshot()
            .unwrap()
            .windows[&window.window_id]
            .window_zoom_factor,
        Some(1.2)
    );
    core.shutdown();
}

#[test]
fn unknown_superseded_zoom_compensation_is_indeterminate() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "win32");
    let mutate_core = Arc::clone(&core);
    let concurrent_window = window.clone();
    let mut zoom_effects = 0;
    let (result, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-indeterminate", &window, "out"),
        move |effect| {
            if matches!(effect.action, CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }) {
                zoom_effects += 1;
                if zoom_effects == 1 {
                    mutate_core
                        .apply_runtime_intent(crate::RuntimeIntent::SetWindowZoomFactor {
                            expected_revision: Some(concurrent_window.revision),
                            operation_id: "runtime-window-zoom-concurrent-failure".to_owned(),
                            window_id: concurrent_window.window_id.clone(),
                            zoom_factor: 1.2,
                        })
                        .unwrap();
                } else {
                    return CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(CoreErrorPayload {
                            code: "CHROMIUM_RUNTIME_WINDOW_ZOOM_COMPENSATION_UNKNOWN".to_owned(),
                            message: "Injected native zoom compensation failure.".to_owned(),
                        }),
                    };
                }
            }
            runtime_window_zoom_effect_result(effect)
        },
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "indeterminate", "{receipt:?}");
    assert!(receipt.failure_code.unwrap().contains("COMPENSATION"));
    core.shutdown();
}

#[test]
fn malformed_superseded_zoom_compensation_receipt_is_indeterminate() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_runtime_window_zoom(&core, "darwin");
    let mutate_core = Arc::clone(&core);
    let concurrent_window = window.clone();
    let mut zoom_effects = 0;
    let (result, _) = drive_command_with(
        Arc::clone(&core),
        runtime_window_zoom_command("runtime-window-zoom-malformed-reverse", &window, "in"),
        move |effect| {
            if matches!(effect.action, CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. }) {
                zoom_effects += 1;
                if zoom_effects == 1 {
                    mutate_core
                        .apply_runtime_intent(crate::RuntimeIntent::SetWindowZoomFactor {
                            expected_revision: Some(concurrent_window.revision),
                            operation_id: "runtime-window-zoom-malformed-concurrent".to_owned(),
                            window_id: concurrent_window.window_id.clone(),
                            zoom_factor: 1.2,
                        })
                        .unwrap();
                } else {
                    return CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: true,
                        value_json: Some("{}".to_owned()),
                        error: None,
                    };
                }
            }
            runtime_window_zoom_effect_result(effect)
        },
    );
    let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "indeterminate", "{receipt:?}");
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_INVALID")
    );
    core.shutdown();
}
