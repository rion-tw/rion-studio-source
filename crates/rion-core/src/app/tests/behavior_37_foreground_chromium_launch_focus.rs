fn launch_focus_target(window_id: &str) -> EmbeddedLaunchTargetRecord {
    EmbeddedLaunchTargetRecord {
        window_id: window_id.to_owned(),
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
    }
}

fn drive_launch_through_terminal(
    core: Arc<AppCore>,
    command: CoreCommand,
) -> (Value, Vec<CoreEffectAction>) {
    drive_launch_through_terminal_with(core, command, |_| {})
}

fn drive_launch_through_terminal_with(
    core: Arc<AppCore>,
    command: CoreCommand,
    mut observe_action: impl FnMut(&CoreEffectAction),
) -> (Value, Vec<CoreEffectAction>) {
    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let mut invocation = Some(thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(invocation_core.invoke_async(command))
    }));
    let mut admission = None;
    let mut terminal_operation_ids = HashSet::new();
    let mut actions = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);

    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "launch did not reach its exact terminal event; metrics={:?}",
            core.operation_actor.metrics()
        );
        if admission.is_none()
            && invocation
                .as_ref()
                .is_some_and(std::thread::JoinHandle::is_finished)
        {
            admission = Some(invocation.take().unwrap().join().unwrap().unwrap());
        }
        if let Some(admission) = admission.as_ref()
            && (admission["completion"] == "completed"
                || admission["operationId"]
                    .as_str()
                    .is_some_and(|operation_id| terminal_operation_ids.contains(operation_id)))
        {
            return (admission.clone(), actions);
        }

        let Ok(events) = receiver.recv_timeout(Duration::from_millis(20)) else {
            continue;
        };
        let mut results = Vec::new();
        for event in events {
            match event {
                CoreEvent::CoreEffects { effects } => {
                    results.extend(effects.into_iter().map(|effect| {
                        observe_action(&effect.action);
                        actions.push(effect.action.clone());
                        effect_result(effect, None)
                    }));
                }
                CoreEvent::BrowserLaunchCompleted {
                    operation_id, ok, ..
                } => {
                    assert!(ok, "foreground launch terminalized as failed");
                    terminal_operation_ids.insert(operation_id);
                }
                _ => {}
            }
        }
        if !results.is_empty() {
            core.dispatch_core_effect_results(results).unwrap();
        }
    }
}

fn foreground_focus_action<'a>(
    actions: &'a [CoreEffectAction],
    window_id: &str,
    tab_id: &str,
) -> (usize, &'a [crate::model::BrowserRuntimeRoleRecord]) {
    let (index, roles) = actions
        .iter()
        .enumerate()
        .find_map(|(index, action)| match action {
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                lifecycle_epoch,
                roles,
                windows,
                target,
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
            } if target.is_none()
                && *lifecycle_epoch >= 1
                && reveal_window_ids == &[window_id]
                && focus_window_ids == &[window_id]
                && focus_tab_id.as_deref() == Some(tab_id)
                && windows.iter().any(|window| {
                    window.window_id == window_id
                        && window.window_generation > 0
                        && window.topology_revision > 0
                        && window.active_tab_id.as_deref() == Some(tab_id)
                        && window.tab_ids.iter().any(|candidate| candidate == tab_id)
                }) =>
            {
                Some((index, roles.as_slice()))
            }
            _ => None,
        })
        .expect("foreground launch must emit one exact revision-fenced focus projection");
    assert_eq!(
        actions[index].completion_policy(),
        crate::model::OperationCompletionPolicy::EventBound
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership {
                    focus_tab_id: Some(_),
                    ..
                }
            ))
            .count(),
        2
    );
    (index, roles)
}

fn terminal_ready_focus_action<'a>(
    actions: &'a [CoreEffectAction],
    window_id: &str,
    tab_id: &str,
) -> (
    usize,
    &'a crate::model::EmbeddedRuntimeWindowProjectionRecord,
    &'a [crate::model::BrowserRuntimeRoleRecord],
) {
    actions
        .iter()
        .enumerate()
        .find_map(|(index, action)| match action {
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                roles,
                windows,
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
                ..
            } if reveal_window_ids == &[window_id]
                && focus_window_ids == &[window_id]
                && focus_tab_id.as_deref() == Some(tab_id) => windows
                .iter()
                .find(|window| {
                    window.window_id == window_id
                        && window.tab_phases.iter().any(|phase| {
                            phase.tab_id == tab_id
                                && phase.phase
                                    == crate::model::RuntimeTabActivationPhaseRecord::Ready
                        })
                })
                .map(|window| (index, window, roles.as_slice())),
            _ => None,
        })
        .expect("foreground launch must project and preserve terminal native focus")
}

#[test]
fn appkit_ready_projection_follows_terminal_running_role_owner() {
    let (_directory, core) = core_for_platform_contract("darwin", 23);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let window_id = "appkit-ready-launching-role-window";
    let captured = Arc::new(Mutex::new(None));
    let capture = Arc::clone(&captured);
    let observer_core = Arc::clone(&core);
    let expected_role_id = role_id.clone();
    let (admission, _) = drive_launch_through_terminal_with(
        Arc::clone(&core),
        CoreCommand::BrowserRoleLaunch {
            role_id: role_id.clone(),
            target: launch_focus_target(window_id),
            launch_preview_id: None,
            launch_tab_id: None,
            zoom_factor: None,
            restore_role_slots: None,
        },
        move |action| {
            let CoreEffectAction::EmbeddedFollowRoleOwnership {
                roles, windows, ..
            } = action
            else {
                return;
            };
            let Some(window_projection) = windows.iter().find(|window| {
                window.window_id == window_id
                    && window.tab_phases.iter().any(|phase| {
                        phase.phase == crate::model::RuntimeTabActivationPhaseRecord::Ready
                    })
            }) else {
                return;
            };
            assert!(roles.iter().any(|role| {
                role.role_id == expected_role_id && role.state == "running"
            }));
            let mut observation = appkit_test_observation(window_id, 1);
            observation.window_generation = window_projection.window_generation;
            observation.topology_revision = window_projection.topology_revision;
            let event = crate::model::AppKitRuntimeEventRecord {
                event_id: uuid::Uuid::new_v4().to_string(),
                adapter_sequence: 1,
                hosts: vec![observation],
                action: crate::model::AppKitRuntimeEventActionRecord::Layout {
                    layout_sequence: 1,
                },
            };
            *capture.lock().unwrap() = Some(
                observer_core
                    .build_appkit_projection(&event)
                    .unwrap()
                    .windows
                    .into_iter()
                    .next()
                    .unwrap(),
            );
        },
    );
    let tab_id = admission["tabId"].as_str().unwrap();
    let projection = captured.lock().unwrap().take().unwrap();
    assert_eq!(projection.active_tab_id.as_deref(), Some(tab_id));
    assert!(projection.roles.iter().any(|role| {
        role.role_id == role_id && role.tab_id == tab_id && role.owner_generation > 0
    }));
    assert!(core
        .browser_runtime_snapshot()
        .unwrap()
        .roles
        .iter()
        .any(|role| role.role_id == role_id && role.state == "running"));
    core.shutdown();
}

#[test]
fn fresh_chromium_role_launch_focuses_after_tab_creation_before_navigation() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let window_id = format!("foreground-role-window-{platform}");
        let (admission, actions) = drive_launch_through_terminal(
            Arc::clone(&core),
            CoreCommand::BrowserRoleLaunch {
                role_id: role_id.clone(),
                target: launch_focus_target(&window_id),
                launch_preview_id: None,
                launch_tab_id: None,
                zoom_factor: None,
                restore_role_slots: None,
            },
        );
        let tab_id = admission["tabId"].as_str().unwrap();
        let create_index = actions
            .iter()
            .position(|action| {
                matches!(
                    action,
                    CoreEffectAction::EmbeddedCreateTab { tab } if tab.tab_id == tab_id
                )
            })
            .unwrap();
        let (focus_index, roles) = foreground_focus_action(&actions, &window_id, tab_id);
        let load_index = actions
            .iter()
            .position(|action| {
                matches!(
                    action,
                    CoreEffectAction::EmbeddedLoadRoles { roles }
                        if roles.iter().any(|role| role.role_id == role_id)
                )
            })
            .unwrap();
        let (ready_index, ready_window, terminal_roles) =
            terminal_ready_focus_action(&actions, &window_id, tab_id);

        assert!(
            create_index < focus_index && focus_index < load_index,
            "{platform}"
        );
        assert!(load_index < ready_index, "{platform}");
        assert_eq!(
            ready_window.topology_revision,
            core.browser_runtime.snapshot().unwrap().windows[&window_id].revision,
            "{platform}"
        );
        assert!(
            roles.iter().any(|role| {
                role.role_id == role_id && role.state == "launching" && role.owner.tab_id == tab_id
            }),
            "{platform}"
        );
        assert!(terminal_roles.iter().any(|role| {
            role.role_id == role_id && role.state == "running" && role.owner.tab_id == tab_id
        }), "{platform}");
        core.shutdown();
    }
}

#[test]
fn fresh_chromium_web_only_workspace_focuses_before_web_surface_navigation() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let workspace_id = create_web_only_workspace(&core, &format!("Focus Web {platform}"));
        let window_id = format!("foreground-web-window-{platform}");
        let (admission, actions) = drive_launch_through_terminal(
            Arc::clone(&core),
            CoreCommand::BrowserWorkspaceLaunch {
                workspace_id,
                target: launch_focus_target(&window_id),
                launch_preview_id: None,
                launch_tab_id: None,
                restore_role_slots: None,
            },
        );
        let tab_id = admission["tabId"].as_str().unwrap();
        let create_index = actions
            .iter()
            .position(|action| {
                matches!(
                    action,
                    CoreEffectAction::EmbeddedCreateTab { tab } if tab.tab_id == tab_id
                )
            })
            .unwrap();
        let (focus_index, roles) = foreground_focus_action(&actions, &window_id, tab_id);
        let load_index = actions
            .iter()
            .position(|action| {
                matches!(
                    action,
                    CoreEffectAction::EmbeddedLoadWebSurfaces {
                        tab_id: effect_tab_id,
                        ..
                    } if effect_tab_id == tab_id
                )
            })
            .unwrap();
        let (ready_index, ready_window, terminal_roles) =
            terminal_ready_focus_action(&actions, &window_id, tab_id);

        assert!(
            create_index < focus_index && focus_index < load_index,
            "{platform}"
        );
        assert!(load_index < ready_index, "{platform}");
        assert_eq!(
            ready_window.topology_revision,
            core.browser_runtime.snapshot().unwrap().windows[&window_id].revision,
            "{platform}"
        );
        assert!(roles.is_empty(), "{platform}");
        assert!(terminal_roles.is_empty(), "{platform}");
        core.shutdown();
    }
}

#[test]
fn restored_chromium_workspace_hydration_never_requests_native_focus() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let workspace_id = create_web_only_workspace(&core, &format!("Restore Web {platform}"));
        let tab_id = if platform == "darwin" {
            "51000000-0000-4000-8000-000000000001"
        } else {
            "51000000-0000-4000-8000-000000000002"
        };
        let (_admission, actions) = drive_launch_through_terminal(
            Arc::clone(&core),
            CoreCommand::BrowserWorkspaceLaunch {
                workspace_id,
                target: launch_focus_target(&format!("restore-web-window-{platform}")),
                launch_preview_id: None,
                launch_tab_id: Some(tab_id.to_owned()),
                restore_role_slots: Some(Vec::new()),
            },
        );

        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedCreateTab { tab } if tab.tab_id == tab_id
            )),
            "{platform}"
        );
        let create_index = actions
            .iter()
            .position(|action| matches!(
                action,
                CoreEffectAction::EmbeddedCreateTab { tab } if tab.tab_id == tab_id
            ))
            .unwrap();
        let ownership_index = actions
            .iter()
            .position(|action| matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership {
                    windows,
                    reveal_window_ids,
                    focus_window_ids,
                    focus_tab_id,
                    ..
                } if windows.iter().any(|window| {
                    window.tab_ids.len() == 1
                        && window.tab_ids[0] == tab_id
                        && window.active_tab_id.as_deref() == Some(tab_id)
                        && window.window_generation > 0
                        && window.topology_revision > 0
                })
                    && reveal_window_ids.is_empty()
                    && focus_window_ids.is_empty()
                    && focus_tab_id.is_none()
            ))
            .expect("restore hydration projects ownership without focus");
        let load_index = actions
            .iter()
            .position(|action| matches!(
                action,
                CoreEffectAction::EmbeddedLoadWebSurfaces {
                    tab_id: effect_tab_id,
                    ..
                } if effect_tab_id.as_str() == tab_id
            ))
            .unwrap();
        assert!(create_index < ownership_index && ownership_index < load_index, "{platform}");
        assert!(
            actions.iter().all(|action| !matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership {
                    reveal_window_ids,
                    focus_window_ids,
                    focus_tab_id,
                    ..
                } if !reveal_window_ids.is_empty()
                    || !focus_window_ids.is_empty()
                    || focus_tab_id.is_some()
            )),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn stable_system_webview_launch_does_not_duplicate_preview_focus() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 22);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (_admission, actions) = drive_launch_through_terminal(
            Arc::clone(&core),
            CoreCommand::BrowserRoleLaunch {
                role_id,
                target: launch_focus_target(&format!("stable-focus-window-{platform}")),
                launch_preview_id: None,
                launch_tab_id: None,
                zoom_factor: None,
                restore_role_slots: None,
            },
        );

        assert!(
            actions.iter().all(|action| !matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership {
                    reveal_window_ids,
                    focus_window_ids,
                    focus_tab_id,
                    ..
                } if !reveal_window_ids.is_empty()
                    || !focus_window_ids.is_empty()
                    || focus_tab_id.is_some()
            )),
            "{platform}"
        );
        core.shutdown();
    }
}
