fn chromium_web_core(platform: &str) -> (TempDir, Arc<AppCore>) {
    let (directory, core) = core_for_runtime_contract(platform, 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration(platform, true),
    })
    .unwrap();
    (directory, core)
}

fn chromium_web_launch_sequence(actions: &[CoreEffectAction]) -> Vec<&'static str> {
    actions
        .iter()
        .filter_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { .. } => Some("create"),
            CoreEffectAction::EmbeddedLoadRoles { .. } => Some("roles"),
            CoreEffectAction::EmbeddedLoadWebSurfaces { .. } => Some("web"),
            _ => None,
        })
        .collect()
}

fn malformed_web_effect_tab(
    tab_id: &str,
    resolved_engine: crate::model::ResolvedBrowserEngine,
    include_view: bool,
) -> EmbeddedTabEffectRecord {
    let web = crate::model::WorkspaceWebContentRecord {
        name: "Malformed Web".to_owned(),
        start_url: "https://malformed.example.test/".to_owned(),
    };
    let rect = full_window_rect();
    let role = workspace_web_surface_role(tab_id, 0, &web);
    EmbeddedTabEffectRecord {
        tab_id: tab_id.to_owned(),
        audio_muted: false,
        appkit_window_generation: None,
        appkit_topology_revision: None,
        attempt_generation: Some(format!("attempt-{tab_id}")),
        launch_preview_id: None,
        source_id: format!("workspace-{tab_id}"),
        name: "Malformed Web Workspace".to_owned(),
        workspace_id: Some(format!("workspace-{tab_id}")),
        workspace_template: Some("single".to_owned()),
        workspace_slots: vec![crate::model::StateWorkspaceSlotRecord {
            id: "web-slot".to_owned(),
            role_id: None,
            web: Some(web.clone()),
            browser_zoom_percent: Some(100.0),
            rect: rect.clone(),
        }],
        workspace_appearance: crate::model::WorkspaceAppearanceSettingsRecord {
            background: "black".to_owned(),
            gap: 1,
        },
        target: EmbeddedLaunchTargetRecord {
            window_id: format!("window-{tab_id}"),
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
        slots: vec![EmbeddedRoleSlotEffectRecord {
            slot_id: "web-slot".to_owned(),
            role: role.clone(),
            web: Some(web.clone()),
            rect: rect.clone(),
            zoom_factor: 1.0,
            zoom_mode: "fixed".to_owned(),
            state: "running".to_owned(),
            owner: None,
        }],
        roles: include_view
            .then(|| EmbeddedRoleViewEffectRecord {
                role,
                web: Some(web),
                resolved_engine,
                rect,
                zoom_factor: 1.0,
                zoom_mode: "fixed".to_owned(),
            })
            .into_iter()
            .collect(),
    }
}

#[test]
fn malformed_v23_web_surface_contract_fails_before_appkit_topology_or_effect_planning() {
    let (directory, core) = chromium_web_core("darwin");
    let emitted_effects_before = core.operation_actor.metrics().emitted_effect_count;
    let profile = crate::global_web_profile::ensure(directory.path()).unwrap();
    for (tab_id, engine, include_view) in [
        (
            "missing-web-view",
            crate::model::ResolvedBrowserEngine::Chromium,
            false,
        ),
        (
            "wrong-web-engine",
            crate::model::ResolvedBrowserEngine::Wkwebview,
            true,
        ),
    ] {
        let error = match core.start_system_launch(SystemLaunchRequest {
            tab_id,
            tab: malformed_web_effect_tab(tab_id, engine, include_view),
            roles: &[],
            runtime_snapshot: BrowserRuntimeSnapshot {
                windows: Vec::new(),
                roles: Vec::new(),
                tabs: Vec::new(),
                workspaces: Vec::new(),
            },
            global_web_profile: Some(profile.clone()),
            presentation_intent: EmbeddedLaunchPresentationIntent::Foreground,
            resolved_engine: engine,
        }) {
            Ok(_) => panic!("malformed Web contract unexpectedly created an effect plan"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "GLOBAL_WEB_SURFACE_EFFECT_INVALID");
        assert!(core.browser_runtime.snapshot().unwrap().windows.is_empty());
    }
    assert_eq!(
        core.operation_actor.metrics().emitted_effect_count,
        emitted_effects_before
    );
    core.shutdown();
}

#[test]
fn v23_web_only_workspace_emits_an_explicit_global_chromium_surface_effect() {
    for platform in ["darwin", "win32"] {
        let (directory, core) = chromium_web_core(platform);
        let workspace_id = create_web_only_workspace(&core, &format!("Chromium Web {platform}"));
        let (launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("chromium-web-window-{platform}")),
            None,
        );

        assert_eq!(launch.unwrap(), json!([]), "{platform}");
        assert_eq!(
            chromium_web_launch_sequence(&actions),
            ["create", "web"],
            "{platform}"
        );
        let tab = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .expect("v23 Web-only launch creates a tab");
        let projected_launch_phase = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. } => windows
                    .iter()
                    .find(|window| window.window_id == tab.target.window_id)
                    .and_then(|window| {
                        window
                            .tab_phases
                            .iter()
                            .find(|phase| phase.tab_id == tab.tab_id)
                    })
                    .map(|phase| phase.phase),
                _ => None,
            })
            .expect("foreground launch projects its exact pending tab phase");
        assert_eq!(
            projected_launch_phase,
            crate::model::RuntimeTabActivationPhaseRecord::Activating,
            "{platform}"
        );
        let (effect_tab_id, attempt_generation, profile, surfaces) = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedLoadWebSurfaces {
                    tab_id,
                    attempt_generation,
                    profile,
                    surfaces,
                } => Some((tab_id, attempt_generation, profile, surfaces)),
                _ => None,
            })
            .expect("v23 Web-only launch loads explicit Web surfaces");

        assert_eq!(effect_tab_id, &tab.tab_id, "{platform}");
        assert_eq!(
            Some(attempt_generation),
            tab.attempt_generation.as_ref(),
            "{platform}"
        );
        assert_eq!(profile.profile_key, "global-web", "{platform}");
        let expected_profile = fs::canonicalize(directory.path())
            .unwrap()
            .join("web-profiles")
            .join("global-web")
            .join("chromium");
        assert_eq!(
            profile.chromium_user_data_dir,
            crate::global_web_profile::chromium_engine_path(&expected_profile).unwrap(),
            "{platform}"
        );
        assert!(expected_profile.is_dir(), "{platform}");
        assert_eq!(surfaces.len(), 1, "{platform}");
        assert_eq!(surfaces[0].surface_id, tab.slots[0].role.id, "{platform}");
        assert_eq!(surfaces[0].surface_id, tab.roles[0].role.id, "{platform}");
        assert_eq!(surfaces[0].slot_id, "slot-1", "{platform}");
        assert_eq!(surfaces[0].url, "https://example.test/docs", "{platform}");
        assert_eq!(surfaces[0].zoom_factor, 1.0, "{platform}");
        assert_eq!(
            surfaces[0].resolved_engine,
            crate::model::ResolvedBrowserEngine::Chromium,
            "{platform}"
        );
        if platform == "darwin" {
            let projected = super::runtime_live_tab_from_effect(tab);
            assert!(projected.role_ids.is_empty());
            assert!(projected.role_slots.is_empty());
        }

        let snapshot = core.browser_runtime_snapshot().unwrap();
        assert!(snapshot.roles.is_empty(), "{platform}");
        assert!(snapshot.workspaces[0].role_ids.is_empty(), "{platform}");
        assert!(core.browser_statuses().unwrap().is_empty(), "{platform}");
        assert_eq!(
            core.browser_runtime.snapshot().unwrap().tab_activations[&tab.tab_id].phase,
            crate::model::RuntimeTabActivationPhaseRecord::Ready,
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn v23_mixed_workspace_loads_managed_roles_before_explicit_web_surfaces() {
    for platform in ["darwin", "win32"] {
        let (directory, core) = chromium_web_core(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": format!("Mixed Chromium {platform}"),
                    "template": "two_columns",
                    "slots": [
                        {
                            "id": "managed-slot",
                            "roleId": role_id,
                            "rect": workspace_rect(0, 2)
                        },
                        {
                            "id": "web-slot",
                            "web": {
                                "name": "Status",
                                "startUrl": "https://status.example.test/app"
                            },
                            "browserZoomPercent": 150,
                            "rect": workspace_rect(1, 2)
                        }
                    ]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("mixed-window-{platform}")),
            None,
        );

        let launched = launch.unwrap();
        assert_eq!(launched.as_array().unwrap().len(), 1, "{platform}");
        assert_eq!(launched[0]["roleId"], role_id, "{platform}");
        assert_eq!(
            chromium_web_launch_sequence(&actions),
            ["create", "roles", "web"],
            "{platform}"
        );
        let managed_roles = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedLoadRoles { roles } => Some(roles),
                _ => None,
            })
            .expect("mixed workspace loads its managed role");
        assert_eq!(managed_roles.len(), 1, "{platform}");
        assert_eq!(managed_roles[0].role_id, role_id, "{platform}");
        let tab = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .expect("mixed workspace creates an AppKit projection tab");
        let (profile, surfaces) = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedLoadWebSurfaces {
                    profile, surfaces, ..
                } => Some((profile, surfaces)),
                _ => None,
            })
            .expect("mixed workspace loads its Web surface");
        assert_eq!(surfaces.len(), 1, "{platform}");
        assert_eq!(surfaces[0].slot_id, "web-slot", "{platform}");
        assert_eq!(
            surfaces[0].url, "https://status.example.test/app",
            "{platform}"
        );
        assert_eq!(surfaces[0].zoom_factor, 1.5, "{platform}");
        let expected_profile = fs::canonicalize(directory.path())
            .unwrap()
            .join("web-profiles")
            .join("global-web")
            .join("chromium");
        assert_eq!(
            profile.chromium_user_data_dir,
            crate::global_web_profile::chromium_engine_path(&expected_profile).unwrap(),
            "{platform}"
        );
        if platform == "darwin" {
            let projected = super::runtime_live_tab_from_effect(tab);
            assert_eq!(
                projected.role_ids.as_slice(),
                std::slice::from_ref(&role_id)
            );
            assert_eq!(projected.role_slots.len(), 1);
            assert_eq!(projected.role_slots[0].slot_id, "managed-slot");
            assert_eq!(projected.role_slots[0].role_id, role_id);
            assert_eq!(projected.role_slots[0].browser_zoom_percent, None);
        }

        let snapshot = core.browser_runtime_snapshot().unwrap();
        assert_eq!(snapshot.roles.len(), 1, "{platform}");
        assert_eq!(snapshot.roles[0].role_id, role_id, "{platform}");
        assert_eq!(
            snapshot.workspaces[0].role_ids.as_slice(),
            std::slice::from_ref(&role_id),
            "{platform}"
        );
        let statuses = core.browser_statuses().unwrap();
        assert_eq!(statuses.len(), 1, "{platform}");
        assert_eq!(statuses[0].role_id, role_id, "{platform}");
        assert!(
            !surfaces.iter().any(|surface| surface.surface_id == role_id),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn v23_multiple_web_slots_share_one_profile_and_retain_exact_surface_slot_identity() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": format!("Multi Web {platform}"),
                    "template": "two_columns",
                    "slots": [
                        {
                            "id": "web-left",
                            "web": {"name": "Left", "startUrl": "https://left.example.test"},
                            "rect": workspace_rect(0, 2)
                        },
                        {
                            "id": "web-right",
                            "web": {"name": "Right", "startUrl": "https://right.example.test"},
                            "browserZoomPercent": 175,
                            "rect": workspace_rect(1, 2)
                        }
                    ]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("multi-web-window-{platform}")),
            None,
        );

        assert_eq!(launch.unwrap(), json!([]), "{platform}");
        assert_eq!(
            chromium_web_launch_sequence(&actions),
            ["create", "web"],
            "{platform}"
        );
        let tab = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .unwrap();
        let (profile, surfaces) = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedLoadWebSurfaces {
                    profile, surfaces, ..
                } => Some((profile, surfaces)),
                _ => None,
            })
            .unwrap();

        assert_eq!(profile.profile_key, "global-web", "{platform}");
        assert_eq!(surfaces.len(), 2, "{platform}");
        assert_eq!(
            surfaces
                .iter()
                .map(|surface| surface.slot_id.as_str())
                .collect::<Vec<_>>(),
            ["web-left", "web-right"],
            "{platform}"
        );
        assert_eq!(
            surfaces
                .iter()
                .map(|surface| surface.url.as_str())
                .collect::<Vec<_>>(),
            ["https://left.example.test/", "https://right.example.test/"],
            "{platform}"
        );
        assert_eq!(
            surfaces
                .iter()
                .map(|surface| surface.zoom_factor)
                .collect::<Vec<_>>(),
            [1.0, 1.75],
            "{platform}"
        );
        assert_eq!(
            surfaces
                .iter()
                .map(|surface| surface.surface_id.as_str())
                .collect::<Vec<_>>(),
            tab.slots
                .iter()
                .map(|slot| slot.role.id.as_str())
                .collect::<Vec<_>>(),
            "{platform}"
        );
        assert_eq!(
            surfaces[0].surface_id,
            format!("web-{}-1", tab.tab_id),
            "{platform}"
        );
        assert_eq!(
            surfaces[1].surface_id,
            format!("web-{}-2", tab.tab_id),
            "{platform}"
        );
        if platform == "darwin" {
            let projected = super::runtime_live_tab_from_effect(tab);
            assert!(projected.role_ids.is_empty());
            assert!(projected.role_slots.is_empty());
        }
        assert!(
            core.browser_runtime_snapshot().unwrap().roles.is_empty(),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn active_workspace_web_failure_is_generation_fenced_and_projected_as_degraded() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let workspace_id = create_web_only_workspace(&core, &format!("Failure Web {platform}"));
        let (_launch, launch_actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("failure-web-window-{platform}")),
            None,
        );
        let tab = launch_actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .expect("Web-only launch creates an exact runtime tab");
        let surface_id = tab.roles[0].role.id.clone();
        let tab_id = tab.tab_id.clone();
        let window_id = tab.target.window_id.clone();
        let attempt_generation = tab
            .attempt_generation
            .clone()
            .expect("v23 Web-only launch owns an attempt generation");
        let window_generation =
            core.browser_runtime.snapshot().unwrap().windows[&window_id].window_generation;

        let (receipt, failure_actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserWorkspaceWebSurfaceFailed {
                operation_id: format!("workspace-web-failure-{platform}"),
                surface_id: surface_id.clone(),
                surface_generation: 1,
                tab_id: tab_id.clone(),
                window_id: window_id.clone(),
                expected_attempt_generation: attempt_generation.clone(),
                expected_window_generation: window_generation,
            },
            None,
        );

        let receipt: crate::model::BrowserRuntimeSnapshot =
            serde_json::from_value(receipt.unwrap()).unwrap();
        assert!(receipt.tabs.iter().any(|candidate| {
            candidate.id == tab_id
                && candidate.attempt_generation.as_deref() == Some(attempt_generation.as_str())
                && candidate
                    .web_surfaces
                    .iter()
                    .any(|surface| surface.surface_id == surface_id)
        }));
        assert!(
            failure_actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. }
                    if windows.iter().any(|window| {
                        window.window_id == window_id
                            && window.tab_phases.iter().any(|phase| {
                                phase.tab_id == tab_id
                                    && phase.phase
                                        == crate::model::RuntimeTabActivationPhaseRecord::Degraded
                            })
                    })
            )),
            "{platform}"
        );
        assert_eq!(
            core.browser_runtime.snapshot().unwrap().tab_activations[&tab_id].phase,
            crate::model::RuntimeTabActivationPhaseRecord::Degraded,
            "{platform}"
        );

        let (stale, stale_actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserWorkspaceWebSurfaceFailed {
                operation_id: format!("workspace-web-failure-stale-{platform}"),
                surface_id,
                surface_generation: 1,
                tab_id,
                window_id,
                expected_attempt_generation: format!("stale-{attempt_generation}"),
                expected_window_generation: window_generation,
            },
            None,
        );
        assert_eq!(
            stale.unwrap_err().code(),
            "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
            "{platform}"
        );
        assert!(stale_actions.is_empty(), "{platform}");
        core.shutdown();
    }
}

#[test]
fn active_managed_role_failure_degrades_its_exact_chromium_tab_projection() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let game_id = first_game_id(&core);
        let failing_role_id = create_role(&core, &game_id, 1);
        let healthy_role_id = create_role(&core, &game_id, 2);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": format!("Managed failure {platform}"),
                    "template": "two_columns",
                    "slots": [
                        {"roleId": failing_role_id, "rect": workspace_rect(0, 2)},
                        {"roleId": healthy_role_id, "rect": workspace_rect(1, 2)}
                    ]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (_launch, launch_actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedWorkspaceLaunch",
                "workspaceId": workspace_id,
                "target": {
                    "windowId": format!("managed-failure-window-{platform}"),
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        let tab = launch_actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .expect("managed workspace launch creates an exact runtime tab");
        let tab_id = tab.tab_id.clone();
        let window_id = tab.target.window_id.clone();
        let owner = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot
            .roles
            .into_iter()
            .find(|role| role.role_id == failing_role_id)
            .unwrap()
            .owner;

        let (receipt, failure_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedSystemSurfaceFailed {
                role_id: failing_role_id.clone(),
                reason: Some("surface.navigation-failed".to_owned()),
                expected_tab_id: Some(owner.tab_id),
                expected_owner_generation: Some(owner.generation),
            },
            None,
        );

        let statuses =
            serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(receipt.unwrap())
                .unwrap();
        assert_eq!(statuses.len(), 1, "{platform}");
        assert_eq!(statuses[0].role_id, failing_role_id, "{platform}");
        assert_eq!(
            statuses[0].issue_reason,
            Some(crate::model::BrowserRuntimeFailureReason::RuntimeCrashed),
            "{platform}"
        );
        assert!(
            failure_actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. }
                    if windows.iter().any(|window| {
                        window.window_id == window_id
                            && window.tab_phases.iter().any(|phase| {
                                phase.tab_id == tab_id
                                    && phase.phase
                                        == crate::model::RuntimeTabActivationPhaseRecord::Degraded
                            })
                    })
            )),
            "{platform}"
        );
        assert_eq!(
            core.browser_runtime.snapshot().unwrap().tab_activations[&tab_id].phase,
            crate::model::RuntimeTabActivationPhaseRecord::Degraded,
            "{platform}"
        );
        let healthy = core
            .browser_statuses()
            .unwrap()
            .into_iter()
            .find(|status| status.role_id == healthy_role_id)
            .unwrap();
        assert!(healthy.issue_reason.is_none(), "{platform}");
        assert_eq!(
            healthy.automation_state.as_deref(),
            Some("ready"),
            "{platform}"
        );

        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWorkspaceStop {
                workspace_id: workspace_id.clone(),
            },
            None,
        );
        assert!(stopped.is_ok(), "{platform}: {stopped:?}");
        let (relaunched, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedWorkspaceLaunch",
                "workspaceId": workspace_id,
                "target": {
                    "windowId": format!("managed-recovery-window-{platform}"),
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(relaunched.is_ok(), "{platform}: {relaunched:?}");
        for role_id in [&failing_role_id, &healthy_role_id] {
            let recovered = core
                .browser_statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.role_id == *role_id)
                .unwrap();
            assert!(recovered.issue_reason.is_none(), "{platform}");
            assert_eq!(
                recovered.automation_state.as_deref(),
                Some("ready"),
                "{platform}"
            );
        }
        core.shutdown();
    }
}
