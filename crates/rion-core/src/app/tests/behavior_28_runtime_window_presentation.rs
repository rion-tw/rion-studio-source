fn seed_runtime_window_presentation(core: &AppCore) -> crate::RuntimeLiveWindowRecord {
    seed_runtime_ui_topology(
        core,
        "runtime-presentation-seed",
        vec![(
            "runtime-presentation-window",
            "runtime-presentation-tab",
            "presentation-role",
        )],
    );
    core.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
        crate::RuntimeWindowContextInitializeInput {
            operation_id: "runtime-presentation-context".to_owned(),
            persisted_name: Some("Presentation Window".to_owned()),
            placement: crate::model::GameWindowPlacementRecord {
                normal_bounds: StatePixelBoundsRecord {
                    x: 40,
                    y: 60,
                    width: 960,
                    height: 680,
                },
                saved_work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1440,
                    height: 900,
                },
                presentation: "normal".to_owned(),
            },
            target_display: crate::model::DisplayTargetRecord {
                id: 1,
                fingerprint: None,
            },
            window_generation: 3,
            window_id: "runtime-presentation-window".to_owned(),
        },
    ))
    .unwrap();
    core.browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .get("runtime-presentation-window")
        .unwrap()
        .clone()
}

fn runtime_window_presentation_command(
    operation_id: &str,
    window: &crate::RuntimeLiveWindowRecord,
    presentation: &str,
) -> CoreCommand {
    CoreCommand::EmbeddedWindowPresentation {
        operation_id: operation_id.to_owned(),
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        topology_revision: window.revision,
        presentation: presentation.to_owned(),
    }
}

#[test]
fn macos_runtime_window_presentation_round_trips_normal_and_fullscreen() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let normal = seed_runtime_window_presentation(&core);
    let fullscreen_operation_id = "runtime-presentation-macos-fullscreen";
    let expected_window_id = normal.window_id.clone();
    let expected_window_generation = normal.window_generation;
    let expected_topology_revision = normal.revision;
    let (fullscreen_result, fullscreen_actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_presentation_command(fullscreen_operation_id, &normal, "fullscreen"),
        move |effect| {
            if let CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
                window_id,
                window_generation,
                topology_revision,
                presentation,
            } = &effect.action
            {
                assert_eq!(window_id, &expected_window_id);
                assert_eq!(*window_generation, expected_window_generation);
                assert_eq!(*topology_revision, expected_topology_revision);
                assert_eq!(presentation, "fullscreen");
                assert_eq!(
                    effect.completion_policy,
                    crate::model::OperationCompletionPolicy::EventBound
                );
                assert_eq!(effect.deadline_ms, None);
                assert_eq!(
                    effect.parent_operation_id.as_deref(),
                    Some(fullscreen_operation_id)
                );
            }
            effect_result(effect, None)
        },
    );
    let fullscreen_summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(fullscreen_result.unwrap()).unwrap();
    assert_eq!(
        fullscreen_summary.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert_eq!(fullscreen_summary.stage, "runtimeWindowPresentationApplied");
    assert_eq!(fullscreen_summary.platform, "macos");
    assert_eq!(
        fullscreen_summary.completion_policy,
        crate::model::OperationCompletionPolicy::EventBound
    );
    assert_eq!(
        fullscreen_summary.completion_scope,
        crate::model::SystemRuntimeOperationCompletionScope::NativeAcknowledgement
    );
    assert!(fullscreen_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
            presentation,
            topology_revision,
            ..
        } if presentation == "fullscreen" && *topology_revision == normal.revision
    )));

    let fullscreen = core.browser_runtime.snapshot().unwrap().windows[&normal.window_id].clone();
    assert_eq!(
        fullscreen
            .placement
            .as_ref()
            .map(|placement| placement.presentation.as_str()),
        Some("fullscreen")
    );
    assert!(fullscreen.revision > normal.revision);

    let (normal_result, normal_actions) = drive_command(
        Arc::clone(&core),
        runtime_window_presentation_command(
            "runtime-presentation-macos-normal",
            &fullscreen,
            "normal",
        ),
        None,
    );
    let normal_summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(normal_result.unwrap()).unwrap();
    assert_eq!(
        normal_summary.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert_eq!(normal_summary.stage, "runtimeWindowPresentationApplied");
    assert!(normal_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
            presentation,
            topology_revision,
            ..
        } if presentation == "normal" && *topology_revision == fullscreen.revision
    )));
    let restored = core.browser_runtime.snapshot().unwrap().windows[&normal.window_id].clone();
    assert_eq!(
        restored
            .placement
            .as_ref()
            .map(|placement| placement.presentation.as_str()),
        Some("normal")
    );
    assert!(restored.revision > fullscreen.revision);
    core.shutdown();
}

#[test]
fn macos_runtime_window_presentation_rejects_maximized_before_native_effect() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_runtime_window_presentation(&core);
    let receiver = core.subscribe().unwrap();
    let error = core
        .invoke(runtime_window_presentation_command(
            "runtime-presentation-macos-maximized",
            &window,
            "maximized",
        ))
        .unwrap_err();
    assert_eq!(error.code(), "RUNTIME_WINDOW_PRESENTATION_INVALID");
    assert!(error.to_string().contains("not maximized presentation"));
    assert!(!receiver.try_iter().flatten().any(|event| matches!(
        event,
        CoreEvent::CoreEffects { effects }
            if effects.iter().any(|effect| matches!(
                effect.action,
                CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { .. }
            ))
    )));
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
            .placement
            .as_ref()
            .map(|placement| placement.presentation.as_str()),
        Some("normal")
    );
    core.shutdown();
}

#[test]
fn macos_runtime_window_presentation_native_rejection_terminalizes_after_compensation() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_runtime_window_presentation(&core);
    let mut presentation_effects = 0;
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_presentation_command(
            "runtime-presentation-macos-native-rejected",
            &window,
            "fullscreen",
        ),
        move |effect| {
            if matches!(
                effect.action,
                CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { .. }
            ) {
                presentation_effects += 1;
                if presentation_effects == 1 {
                    return CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(CoreErrorPayload {
                            code: "APPKIT_RUNTIME_PRESENTATION_APPLY_FAILED".to_owned(),
                            message: "The AppKit host rejected its fullscreen transition."
                                .to_owned(),
                        }),
                    };
                }
            }
            effect_result(effect, None)
        },
    );
    let summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        summary.status,
        crate::model::SystemRuntimeOperationStatus::Failed
    );
    assert_eq!(summary.stage, "runtimeWindowPresentationFailed");
    assert_eq!(
        summary.failure_code.as_deref(),
        Some("APPKIT_RUNTIME_PRESENTATION_APPLY_FAILED")
    );
    let presentations = actions
        .iter()
        .filter_map(|action| match action {
            CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { presentation, .. } => {
                Some(presentation.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(presentations, ["fullscreen", "normal"]);
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
            .placement
            .as_ref()
            .map(|placement| placement.presentation.as_str()),
        Some("normal")
    );
    let metrics = core.invoke(CoreCommand::CoreEffectMetrics).unwrap();
    assert_eq!(metrics["pendingEffectCount"], 0);
    assert_eq!(metrics["activeOperationCount"], 0);
    core.shutdown();
}

#[test]
fn runtime_window_presentation_preserves_windows_maximized_admission() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_presentation(&core);
    let (result, actions) = drive_command(
        Arc::clone(&core),
        runtime_window_presentation_command(
            "runtime-presentation-windows-maximized",
            &window,
            "maximized",
        ),
        None,
    );
    let summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        summary.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
            presentation,
            topology_revision,
            ..
        } if presentation == "maximized" && *topology_revision == window.revision
    )));
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
            .placement
            .as_ref()
            .map(|placement| placement.presentation.as_str()),
        Some("maximized")
    );
    core.shutdown();
}

#[test]
fn runtime_window_presentation_rejects_stale_generation_and_revision_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        for stale_generation in [true, false] {
            let (_directory, core) = core_for_runtime_contract(platform, 23);
            core.invoke(CoreCommand::BrowserRuntimeRegister {
                registration: chromium_registration(platform, true),
            })
            .unwrap();
            let window = seed_runtime_window_presentation(&core);
            let command = CoreCommand::EmbeddedWindowPresentation {
                operation_id: format!(
                    "runtime-presentation-stale-{platform}-{}",
                    if stale_generation {
                        "generation"
                    } else {
                        "revision"
                    }
                ),
                window_id: window.window_id.clone(),
                window_generation: window.window_generation + u64::from(stale_generation),
                topology_revision: window.revision + u64::from(!stale_generation),
                presentation: "fullscreen".to_owned(),
            };
            let (result, actions) = drive_command(Arc::clone(&core), command, None);
            let summary: crate::model::SystemRuntimeOperationSummaryRecord =
                serde_json::from_value(result.unwrap()).unwrap();
            assert_eq!(
                summary.status,
                crate::model::SystemRuntimeOperationStatus::Superseded,
                "{platform} stale_generation={stale_generation}"
            );
            assert_eq!(summary.stage, "runtimeUiActionSuperseded");
            assert_eq!(
                summary.failure_code.as_deref(),
                Some("RUNTIME_UI_ACTION_STALE")
            );
            assert!(actions.is_empty());
            assert_eq!(
                core.browser_runtime.snapshot().unwrap().windows[&window.window_id]
                    .placement
                    .as_ref()
                    .map(|placement| placement.presentation.as_str()),
                Some("normal")
            );
            core.shutdown();
        }
    }
}

#[test]
fn runtime_window_presentation_already_applied_still_requires_native_readback() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_presentation(&core);
    let (result, actions) = drive_command(
        Arc::clone(&core),
        runtime_window_presentation_command("runtime-presentation-readback", &window, "normal"),
        None,
    );
    let summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        summary.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert_eq!(
        summary.stage,
        "runtimeWindowPresentationNativeReadbackVerified"
    );
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
            presentation,
            topology_revision,
            ..
        } if presentation == "normal" && *topology_revision == window.revision
    )));
    let snapshot: crate::model::CoreAppSnapshotRecord =
        serde_json::from_value(core.invoke(CoreCommand::AppSnapshot).unwrap()).unwrap();
    assert_eq!(
        snapshot.logical_windows[0].presentation.as_deref(),
        Some("normal")
    );
    core.shutdown();
}

#[test]
fn superseded_presentation_commit_compensates_to_current_core_projection() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_presentation(&core);
    let mutate_core = Arc::clone(&core);
    let mut presentation_effects = 0;
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_presentation_command(
            "runtime-presentation-compensate",
            &window,
            "fullscreen",
        ),
        move |effect| {
            if matches!(
                effect.action,
                CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { .. }
            ) {
                presentation_effects += 1;
                if presentation_effects == 1 {
                    mutate_core
                        .apply_runtime_intent(crate::RuntimeIntent::CommitPlacement(
                            crate::RuntimeWindowPlacementCommitInput {
                                operation_id: "runtime-presentation-concurrent".to_owned(),
                                placement: window.placement.clone().unwrap(),
                                placement_sequence: window.placement_sequence + 2,
                                source: "concurrentNativeEvent".to_owned(),
                                target_display: window.target_display.clone().unwrap(),
                                window_generation: window.window_generation,
                                window_id: window.window_id.clone(),
                            },
                        ))
                        .unwrap();
                }
            }
            effect_result(effect, None)
        },
    );
    let summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        summary.status,
        crate::model::SystemRuntimeOperationStatus::Failed
    );
    assert_eq!(
        summary.stage,
        "runtimeWindowPresentationCommitSupersededCompensated"
    );
    let presentations = actions
        .iter()
        .filter_map(|action| match action {
            CoreEffectAction::EmbeddedSetRuntimeWindowPresentation {
                presentation,
                topology_revision,
                ..
            } => Some((presentation.as_str(), *topology_revision)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(presentations.len(), 2);
    assert_eq!(presentations[0], ("fullscreen", window.revision));
    assert_eq!(presentations[1].0, "normal");
    assert!(presentations[1].1 > window.revision);
    core.shutdown();
}

#[test]
fn failed_superseded_presentation_compensation_is_indeterminate() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_runtime_window_presentation(&core);
    let mutate_core = Arc::clone(&core);
    let mut presentation_effects = 0;
    let (result, actions) = drive_command_with(
        Arc::clone(&core),
        runtime_window_presentation_command(
            "runtime-presentation-compensation-fails",
            &window,
            "fullscreen",
        ),
        move |effect| {
            let is_presentation = matches!(
                effect.action,
                CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { .. }
            );
            if is_presentation {
                presentation_effects += 1;
                if presentation_effects == 1 {
                    mutate_core
                        .apply_runtime_intent(crate::RuntimeIntent::CommitPlacement(
                            crate::RuntimeWindowPlacementCommitInput {
                                operation_id: "runtime-presentation-concurrent-failure".to_owned(),
                                placement: window.placement.clone().unwrap(),
                                placement_sequence: window.placement_sequence + 2,
                                source: "concurrentNativeEvent".to_owned(),
                                target_display: window.target_display.clone().unwrap(),
                                window_generation: window.window_generation,
                                window_id: window.window_id.clone(),
                            },
                        ))
                        .unwrap();
                } else {
                    return CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(CoreErrorPayload {
                            code: "NATIVE_PRESENTATION_COMPENSATION_UNKNOWN".to_owned(),
                            message: "Injected compensation failure.".to_owned(),
                        }),
                    };
                }
            }
            effect_result(effect, None)
        },
    );
    let summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        summary.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert_eq!(summary.stage, "runtimeWindowPresentationCompensationFailed");
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { .. }
            ))
            .count(),
        2
    );
    core.shutdown();
}
