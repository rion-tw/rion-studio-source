fn empty_window_registration_target(window_id: &str) -> crate::model::EmbeddedLaunchTargetRecord {
    crate::model::EmbeddedLaunchTargetRecord {
        window_id: window_id.to_owned(),
        persisted_name: Some("Empty Window".to_owned()),
        display_id: 17,
        scale_factor: 2.0,
        work_area: crate::model::StatePixelBoundsRecord {
            x: 40,
            y: 20,
            width: 1400,
            height: 900,
        },
        bounds: crate::model::StatePixelBoundsRecord {
            x: 160,
            y: 120,
            width: 1120,
            height: 720,
        },
        presentation: "normal".to_owned(),
    }
}

fn empty_window_registration_display() -> crate::model::DisplayTargetRecord {
    crate::model::DisplayTargetRecord {
        id: 17,
        fingerprint: Some(crate::model::DisplayFingerprintRecord {
            label: "Current native display".to_owned(),
            bounds: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 1480,
                height: 960,
            },
            resolution: crate::model::StateResolutionRecord {
                width: 1480,
                height: 960,
            },
            scale_factor: 2.0,
            is_primary: true,
            is_internal: true,
        }),
    }
}

#[test]
fn embedded_window_register_projects_one_exact_empty_logical_window_before_native_follow() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let window_id = format!("empty-window-{platform}");
        let target = empty_window_registration_target(&window_id);
        let (result, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWindowRegister {
                target_display: empty_window_registration_display(),
                target: target.clone(),
            },
            None,
        );
        assert!(result.is_ok(), "{platform}: {result:?}");
        assert_eq!(actions.len(), 1, "{platform}");
        let CoreEffectAction::EmbeddedFollowRoleOwnership {
            lifecycle_epoch,
            roles,
            windows,
            target: effect_target,
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
            content_focus_tab_id,
        } = &actions[0]
        else {
            panic!("{platform}: expected one ownership-follow effect");
        };
        assert_eq!(*lifecycle_epoch, 1, "{platform}");
        assert!(roles.is_empty(), "{platform}");
        assert!(content_focus_tab_id.is_none(), "{platform}");
        assert_eq!(windows.len(), 1, "{platform}");
        let projected = &windows[0];
        assert_eq!(projected.window_id, window_id, "{platform}");
        assert!(projected.window_generation >= 1, "{platform}");
        assert!(projected.topology_revision >= 1, "{platform}");
        assert!(projected.tab_ids.is_empty(), "{platform}");
        assert!(projected.tab_phases.is_empty(), "{platform}");
        assert!(projected.hidden_tab_ids.is_empty(), "{platform}");
        assert!(projected.active_tab_id.is_none(), "{platform}");
        let effect_target = effect_target.as_ref().expect("missing exact target");
        assert_eq!(effect_target.window_id, target.window_id, "{platform}");
        assert_eq!(
            effect_target.persisted_name, target.persisted_name,
            "{platform}"
        );
        assert_eq!(effect_target.display_id, target.display_id, "{platform}");
        assert_eq!(
            effect_target.scale_factor, target.scale_factor,
            "{platform}"
        );
        assert_eq!(effect_target.work_area.x, target.work_area.x, "{platform}");
        assert_eq!(effect_target.work_area.y, target.work_area.y, "{platform}");
        assert_eq!(
            effect_target.work_area.width, target.work_area.width,
            "{platform}"
        );
        assert_eq!(
            effect_target.work_area.height, target.work_area.height,
            "{platform}"
        );
        assert_eq!(effect_target.bounds.x, target.bounds.x, "{platform}");
        assert_eq!(effect_target.bounds.y, target.bounds.y, "{platform}");
        assert_eq!(
            effect_target.bounds.width, target.bounds.width,
            "{platform}"
        );
        assert_eq!(
            effect_target.bounds.height, target.bounds.height,
            "{platform}"
        );
        assert_eq!(
            effect_target.presentation, target.presentation,
            "{platform}"
        );
        assert_eq!(
            reveal_window_ids,
            std::slice::from_ref(&window_id),
            "{platform}"
        );
        assert_eq!(
            focus_window_ids,
            std::slice::from_ref(&window_id),
            "{platform}"
        );
        assert!(focus_tab_id.is_none(), "{platform}");

        let snapshot = core.app_snapshot().unwrap();
        assert_eq!(snapshot.logical_windows.len(), 1, "{platform}");
        let logical = &snapshot.logical_windows[0];
        assert_eq!(logical.window_id, window_id, "{platform}");
        assert_eq!(
            logical.window_generation, projected.window_generation,
            "{platform}"
        );
        assert_eq!(logical.revision, projected.topology_revision, "{platform}");
        assert_eq!(
            logical.presentation.as_deref(),
            Some("normal"),
            "{platform}"
        );
        assert!(logical.tabs.is_empty(), "{platform}");
        assert!(logical.active_tab_id.is_none(), "{platform}");
        assert_eq!(snapshot.browser_runtime.windows.len(), 1, "{platform}");
        assert_eq!(
            snapshot.browser_runtime.windows[0].window_id, window_id,
            "{platform}"
        );
        assert!(
            snapshot.browser_runtime.windows[0].tab_ids.is_empty(),
            "{platform}"
        );
        assert!(
            snapshot.browser_runtime.windows[0].active_tab_id.is_none(),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn embedded_window_show_all_reveals_every_window_without_competing_focus_requests() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let window_ids = [
            format!("show-all-a-{platform}"),
            format!("show-all-b-{platform}"),
        ];
        for window_id in &window_ids {
            let (result, _) = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWindowRegister {
                    target_display: empty_window_registration_display(),
                    target: empty_window_registration_target(window_id),
                },
                None,
            );
            assert!(result.is_ok(), "{platform}: {result:?}");
        }

        let (result, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWindowsShow { window_id: None },
            None,
        );
        assert!(result.is_ok(), "{platform}: {result:?}");
        assert_eq!(actions.len(), 1, "{platform}");
        let CoreEffectAction::EmbeddedFollowRoleOwnership {
            reveal_window_ids,
            focus_window_ids,
            ..
        } = &actions[0]
        else {
            panic!("{platform}: expected an ownership-follow effect");
        };
        let mut revealed = reveal_window_ids.clone();
        revealed.sort();
        let mut expected = window_ids.to_vec();
        expected.sort();
        assert_eq!(revealed, expected, "{platform}");
        assert!(focus_window_ids.is_empty(), "{platform}");

        let focused_window_id = window_ids[1].clone();
        let (result, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWindowsShow {
                window_id: Some(focused_window_id.clone()),
            },
            None,
        );
        assert!(result.is_ok(), "{platform}: {result:?}");
        let CoreEffectAction::EmbeddedFollowRoleOwnership {
            reveal_window_ids,
            focus_window_ids,
            ..
        } = &actions[0]
        else {
            panic!("{platform}: expected an ownership-follow effect");
        };
        assert_eq!(
            reveal_window_ids,
            std::slice::from_ref(&focused_window_id),
            "{platform}"
        );
        assert_eq!(focus_window_ids, &[focused_window_id], "{platform}");
        core.shutdown();
    }
}

#[test]
fn ownership_follow_effect_carries_the_exact_core_lifecycle_epoch() {
    let (_directory, core) = core_for_platform_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeSuspend {
        suspended: false,
        lifecycle_epoch: Some(41),
    })
    .unwrap();
    let (result, actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedWindowRegister {
            target_display: empty_window_registration_display(),
            target: empty_window_registration_target("lifecycle-fenced-window"),
        },
        None,
    );
    assert!(result.is_ok(), "{result:?}");
    let CoreEffectAction::EmbeddedFollowRoleOwnership {
        lifecycle_epoch, ..
    } = &actions[0]
    else {
        panic!("expected an ownership-follow effect");
    };
    assert_eq!(*lifecycle_epoch, 41);
    core.shutdown();
}

#[test]
fn embedded_window_register_removes_only_its_new_logical_window_on_native_failure() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let window_id = format!("failed-empty-window-{platform}");
        let (result, actions) = drive_command_with(
            Arc::clone(&core),
            CoreCommand::EmbeddedWindowRegister {
                target_display: empty_window_registration_display(),
                target: empty_window_registration_target(&window_id),
            },
            |effect| {
                let failed = matches!(
                    effect.action,
                    CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
                );
                CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: !failed,
                    value_json: None,
                    error: failed.then(|| CoreErrorPayload {
                        code: "EMPTY_WINDOW_NATIVE_FAILED".to_owned(),
                        message: "The fixture rejected empty-window creation.".to_owned(),
                    }),
                }
            },
        );
        assert_eq!(
            result.unwrap_err().code(),
            "EMPTY_WINDOW_NATIVE_FAILED",
            "{platform}"
        );
        assert_eq!(actions.len(), 1, "{platform}");
        assert!(
            matches!(
                actions[0],
                CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
            ),
            "{platform}"
        );
        let snapshot = core.app_snapshot().unwrap();
        assert!(
            snapshot
                .logical_windows
                .iter()
                .all(|window| window.window_id != window_id),
            "{platform}"
        );
        assert!(
            snapshot
                .browser_runtime
                .windows
                .iter()
                .all(|window| window.window_id != window_id),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn embedded_window_register_preserves_a_preexisting_logical_window_on_native_failure() {
    let (_directory, core) = core_for_platform_contract("darwin", 23);
    let window_id = "preexisting-empty-window".to_owned();
    let target = empty_window_registration_target(&window_id);
    core.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
        crate::RuntimeWindowContextInitializeInput {
            operation_id: "preexisting-empty-window-context".to_owned(),
            persisted_name: target.persisted_name.clone(),
            placement: crate::model::GameWindowPlacementRecord {
                normal_bounds: target.bounds.clone(),
                saved_work_area: target.work_area.clone(),
                presentation: target.presentation.clone(),
            },
            target_display: crate::model::DisplayTargetRecord {
                id: target.display_id,
                fingerprint: None,
            },
            window_generation: 8,
            window_id: window_id.clone(),
        },
    ))
    .unwrap();

    let (result, _) = drive_command_with(
        Arc::clone(&core),
        CoreCommand::EmbeddedWindowRegister {
            target,
            target_display: empty_window_registration_display(),
        },
        |effect| {
            let failed = matches!(
                effect.action,
                CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
            );
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: !failed,
                value_json: None,
                error: failed.then(|| CoreErrorPayload {
                    code: "EMPTY_WINDOW_NATIVE_FAILED".to_owned(),
                    message: "The fixture rejected empty-window creation.".to_owned(),
                }),
            }
        },
    );
    assert_eq!(result.unwrap_err().code(), "EMPTY_WINDOW_NATIVE_FAILED");
    let snapshot = core.app_snapshot().unwrap();
    assert_eq!(snapshot.logical_windows.len(), 1);
    assert_eq!(snapshot.logical_windows[0].window_id, window_id);
    assert_eq!(snapshot.logical_windows[0].window_generation, 8);
    assert!(snapshot.logical_windows[0].tabs.is_empty());
    core.shutdown();
}

#[test]
fn embedded_window_register_completes_a_topology_only_window_context() {
    let (_directory, core) = core_for_platform_contract("darwin", 23);
    let window_id = "topology-only-window".to_owned();
    let target = empty_window_registration_target(&window_id);
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: "topology-only-window-commit".to_owned(),
            source: "command".to_owned(),
            primary_window_id: window_id.clone(),
            windows: vec![crate::RuntimeWindowTopologyCommit {
                active_tab_id: None,
                hidden_tab_ids: std::collections::HashSet::new(),
                tabs: Vec::new(),
                ui_sequence: 1,
                window_generation: 7,
                window_id: window_id.clone(),
            }],
        },
    ))
    .unwrap();
    let before = core.browser_runtime.snapshot().unwrap();
    assert_eq!(before.windows[&window_id].persisted_name, None);
    assert_eq!(before.windows[&window_id].placement, None);

    let (result, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedWindowRegister {
            target_display: empty_window_registration_display(),
            target: target.clone(),
        },
        None,
    );
    assert!(result.is_ok(), "{result:?}");

    let after = core.browser_runtime.snapshot().unwrap();
    let window = &after.windows[&window_id];
    assert_eq!(window.persisted_name, target.persisted_name);
    assert_eq!(window.window_generation, 7);
    assert_eq!(
        window
            .placement
            .as_ref()
            .map(|placement| &placement.normal_bounds),
        Some(&target.bounds)
    );
    assert_eq!(
        window
            .placement
            .as_ref()
            .map(|placement| &placement.saved_work_area),
        Some(&target.work_area)
    );
    assert_eq!(
        window.target_display.as_ref().map(|display| display.id),
        Some(target.display_id)
    );
    core.shutdown();
}

#[test]
fn empty_window_registration_preserves_current_display_without_native_placement() {
    for platform in ["darwin", "win32"] {
        for saved_metadata in ["current", "absent", "legacy", "changed"] {
            let (directory, core) = core_for_platform_contract(platform, 23);
            core.invoke(CoreCommand::BrowserRuntimeRegister {
                registration: chromium_registration(platform, true),
            })
            .unwrap();
            let current_display = empty_window_registration_display();
            let mut saved_display = current_display.clone();
            match saved_metadata {
                "absent" => saved_display.fingerprint = None,
                "legacy" => {
                    saved_display.id = 3_220_048_483_667_338;
                    saved_display.fingerprint = None;
                }
                "changed" => {
                    let fingerprint = saved_display.fingerprint.as_mut().unwrap();
                    fingerprint.label = "Retired display metadata".to_owned();
                    fingerprint.resolution.width = 1920;
                    fingerprint.scale_factor = 1.0;
                }
                _ => {}
            }
            let mut target = empty_window_registration_target("not-yet-created");
            target.presentation = "fullscreen".to_owned();
            let saved = core
                .invoke(command(json!({
                    "type": "gameWindowCreate",
                    "input": {
                        "name": "Empty Window",
                        "targetDisplay": saved_display,
                        "placement": {
                            "normalBounds": target.bounds,
                            "savedWorkArea": target.work_area,
                            "presentation": "fullscreen"
                        },
                        "tabs": []
                    }
                })))
                .unwrap();
            target.window_id = saved["id"].as_str().unwrap().to_owned();
            let expected_display = serde_json::to_value(&current_display).unwrap();
            let register = || CoreCommand::EmbeddedWindowRegister {
                target: target.clone(),
                target_display: current_display.clone(),
            };
            let (result, _) = drive_command(Arc::clone(&core), register(), None);
            assert!(result.is_ok(), "{platform}/{saved_metadata}: {result:?}");
            let initial =
                core.browser_runtime.snapshot().unwrap().windows[&target.window_id].clone();
            assert_eq!(
                serde_json::to_value(&initial.target_display).unwrap(),
                expected_display,
                "{platform}/{saved_metadata}: registration must use current metadata"
            );
            assert_eq!(initial.placement_sequence, 0);
            assert_eq!(
                initial.placement.as_ref().unwrap().presentation,
                "fullscreen"
            );
            drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWindowRetireProvision {
                    operation_id: format!("empty-display-fullscreen-close-{saved_metadata}"),
                    window_id: target.window_id.clone(),
                    window_generation: initial.window_generation,
                    topology_revision: initial.revision,
                },
                None,
            )
            .0
            .unwrap();
            assert_eq!(
                core.invoke(CoreCommand::GameWindowGet {
                    id: target.window_id.clone(),
                })
                .unwrap(),
                saved
            );
            drive_command(Arc::clone(&core), register(), None)
                .0
                .unwrap();
            let fullscreen_reopened =
                core.browser_runtime.snapshot().unwrap().windows[&target.window_id].clone();
            assert!(fullscreen_reopened.window_generation > initial.window_generation);
            assert_eq!(fullscreen_reopened.placement_sequence, 0);
            assert_eq!(
                fullscreen_reopened.placement.as_ref().unwrap().presentation,
                "fullscreen"
            );

            let modes: &[&str] = if platform == "win32" {
                &["normal", "maximized"]
            } else {
                &["normal"]
            };
            for presentation in modes {
                let before =
                    core.browser_runtime.snapshot().unwrap().windows[&target.window_id].clone();
                let (result, _) = drive_command(
                    Arc::clone(&core),
                    runtime_window_presentation_command(
                        &format!("empty-display-{saved_metadata}-{presentation}"),
                        &before,
                        presentation,
                    ),
                    None,
                );
                let summary: crate::model::SystemRuntimeOperationSummaryRecord =
                    serde_json::from_value(result.unwrap()).unwrap();
                assert_eq!(
                    summary.status,
                    crate::model::SystemRuntimeOperationStatus::Applied,
                    "{platform}/{saved_metadata}/{presentation}: {summary:?}"
                );
                let current =
                    core.browser_runtime.snapshot().unwrap().windows[&target.window_id].clone();
                assert_eq!(
                    current.placement_sequence, 0,
                    "no native placement was submitted"
                );
                assert_eq!(
                    serde_json::to_value(current.target_display).unwrap(),
                    expected_display
                );
                let durable = core
                    .invoke(CoreCommand::GameWindowGet {
                        id: target.window_id.clone(),
                    })
                    .unwrap();
                assert_eq!(durable["targetDisplay"], expected_display);
                assert_eq!(durable["placement"]["presentation"], *presentation);
                assert_eq!(
                    durable["placement"]["normalBounds"],
                    saved["placement"]["normalBounds"]
                );
                assert!(durable["tabs"].as_array().unwrap().is_empty());
            }

            let before_close =
                core.browser_runtime.snapshot().unwrap().windows[&target.window_id].clone();
            let durable = core
                .invoke(CoreCommand::GameWindowGet {
                    id: target.window_id.clone(),
                })
                .unwrap();
            drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWindowRetireProvision {
                    operation_id: format!("empty-display-close-{saved_metadata}"),
                    window_id: target.window_id.clone(),
                    window_generation: before_close.window_generation,
                    topology_revision: before_close.revision,
                },
                None,
            )
            .0
            .unwrap();
            assert!(
                !core
                    .browser_runtime
                    .snapshot()
                    .unwrap()
                    .windows
                    .contains_key(&target.window_id)
            );
            assert_eq!(
                core.invoke(CoreCommand::GameWindowGet {
                    id: target.window_id.clone(),
                })
                .unwrap(),
                durable
            );

            target.presentation = modes.last().unwrap().to_string();
            drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWindowRegister {
                    target: target.clone(),
                    target_display: current_display,
                },
                None,
            )
            .0
            .unwrap();
            let reopened =
                core.browser_runtime.snapshot().unwrap().windows[&target.window_id].clone();
            assert!(reopened.window_generation > before_close.window_generation);
            assert_eq!(reopened.placement_sequence, 0);
            assert_eq!(
                serde_json::to_value(reopened.target_display).unwrap(),
                expected_display
            );
            assert_eq!(
                reopened.placement.unwrap().presentation,
                target.presentation
            );
            core.shutdown();
            drop(core);

            let restarted = AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                build_commit: None,
                packaged: false,
                platform: platform.to_owned(),
                runtime_contract_version: Some(23),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
            })
            .unwrap();
            assert_eq!(
                restarted
                    .invoke(CoreCommand::GameWindowGet {
                        id: target.window_id,
                    })
                    .unwrap(),
                durable
            );
            restarted.shutdown();
        }
    }
}

#[test]
fn empty_window_registration_rejects_invalid_display_before_context_or_effect() {
    for platform in ["darwin", "win32"] {
        for invalid in [
            "missing-fingerprint",
            "display-id",
            "scale-mismatch",
            "blank-label",
            "bounds",
            "resolution",
            "invalid-scale",
        ] {
            let (_directory, core) = core_for_platform_contract(platform, 23);
            let target = empty_window_registration_target("invalid-empty-display");
            let mut display = empty_window_registration_display();
            let expected_code = match invalid {
                "missing-fingerprint" => {
                    display.fingerprint = None;
                    "RUNTIME_WINDOW_REGISTER_DISPLAY_INVALID"
                }
                "display-id" => {
                    display.id += 1;
                    "RUNTIME_WINDOW_REGISTER_DISPLAY_INVALID"
                }
                "scale-mismatch" => {
                    display.fingerprint.as_mut().unwrap().scale_factor = 1.0;
                    "RUNTIME_WINDOW_REGISTER_DISPLAY_INVALID"
                }
                "blank-label" => {
                    display.fingerprint.as_mut().unwrap().label = "  ".to_owned();
                    "RUNTIME_WINDOW_REGISTER_DISPLAY_INVALID"
                }
                "bounds" => {
                    display.fingerprint.as_mut().unwrap().bounds.width = 0;
                    "DISPLAY_TARGET_INVALID"
                }
                "resolution" => {
                    display.fingerprint.as_mut().unwrap().resolution.height = 0;
                    "DISPLAY_TARGET_INVALID"
                }
                _ => {
                    display.fingerprint.as_mut().unwrap().scale_factor = f64::NAN;
                    "DISPLAY_TARGET_INVALID"
                }
            };
            let before = core.browser_runtime.snapshot().unwrap();
            let receiver = core.subscribe().unwrap();
            let error = core
                .invoke(CoreCommand::EmbeddedWindowRegister {
                    target,
                    target_display: display,
                })
                .unwrap_err();
            assert_eq!(error.code(), expected_code, "{platform}/{invalid}");
            let after = core.browser_runtime.snapshot().unwrap();
            assert_eq!(after.revision, before.revision, "{platform}/{invalid}");
            assert!(after.windows.is_empty(), "{platform}/{invalid}");
            assert!(
                !receiver
                    .try_iter()
                    .flatten()
                    .any(|event| matches!(event, CoreEvent::CoreEffects { .. })),
                "{platform}/{invalid}"
            );
            core.shutdown();
        }
    }
}

#[test]
fn empty_window_registration_requires_an_explicit_current_display_command_field() {
    let decoded = serde_json::from_value::<CoreCommand>(json!({
        "type": "embeddedWindowRegister",
        "target": empty_window_registration_target("missing-display-field")
    }));
    assert!(decoded.unwrap_err().to_string().contains("targetDisplay"));
}
