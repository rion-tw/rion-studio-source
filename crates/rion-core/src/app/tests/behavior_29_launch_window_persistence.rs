#[test]
fn v23_launch_terminalizes_only_after_the_saved_game_window_contains_the_tab() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let window_id = create_saved_window(&core, "Chromium launch destination");
        let observed_core = Arc::clone(&core);
        let observed_window_id = window_id.clone();

        let (launch, actions) = drive_command_with(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "windowId": window_id,
                    "persistedName": "Chromium launch destination",
                    "displayId": 1,
                    "scaleFactor": 1.0,
                    "workArea": {"x": 0, "y": 0, "width": 1440, "height": 900},
                    "bounds": {"x": 0, "y": 0, "width": 960, "height": 640},
                    "presentation": "normal"
                }
            })),
            |effect| {
                if let CoreEffectAction::EmbeddedCreateTab { tab } = &effect.action {
                    let snapshot = observed_core.browser_runtime.snapshot().unwrap();
                    let window = &snapshot.windows[&observed_window_id];
                    assert_eq!(
                        window.persisted_name.as_deref(),
                        Some("Chromium launch destination"),
                        "{platform}",
                    );
                    assert!(window.placement.is_some(), "{platform}");
                    assert!(window.target_display.is_some(), "{platform}");
                    assert_eq!(
                        window.placement.as_ref().unwrap().normal_bounds,
                        tab.target.bounds,
                        "{platform}",
                    );
                    assert_eq!(
                        window.placement.as_ref().unwrap().saved_work_area,
                        tab.target.work_area,
                        "{platform}",
                    );
                    assert_eq!(
                        window.target_display.as_ref().unwrap().id,
                        tab.target.display_id,
                        "{platform}",
                    );
                    if platform == "darwin" {
                        assert_eq!(
                            tab.appkit_window_generation,
                            Some(window.window_generation),
                        );
                        assert_eq!(tab.appkit_topology_revision, Some(window.revision));
                    }
                }
                effect_result(effect, None)
            },
        );

        assert!(launch.is_ok(), "{platform}: {launch:?}");
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedCreateTab { tab }
                if tab.target.window_id == window_id
                    && tab.roles.iter().all(|role| {
                        role.resolved_engine == crate::model::ResolvedBrowserEngine::Chromium
                    })
        )), "{platform}");
        let runtime = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
        let runtime_tab = runtime["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["sourceId"] == role_id)
            .unwrap();
        let saved = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();

        assert_eq!(saved["tabs"].as_array().unwrap().len(), 1, "{platform}");
        assert_eq!(saved["tabs"][0]["id"], runtime_tab["id"], "{platform}");
        assert_eq!(saved["tabs"][0]["sourceId"], role_id, "{platform}");
        assert_eq!(saved["activeTabId"], runtime_tab["id"], "{platform}");
        let recovery = core.runtime_restore_session().unwrap();
        assert!(!recovery.clean_exit, "{platform}");
        assert_eq!(
            recovery.live_window_ids,
            Some(vec![window_id.clone()]),
            "{platform}"
        );
        assert_eq!(
            recovery.last_focused_window_id.as_deref(),
            Some(window_id.as_str()),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn v23_launch_preserves_an_existing_same_generation_native_window_context() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let window_id = create_saved_window(&core, "Existing AppKit placement");
        let authoritative_placement = crate::model::GameWindowPlacementRecord {
            normal_bounds: crate::model::StatePixelBoundsRecord {
                x: 120,
                y: 90,
                width: 1080,
                height: 720,
            },
            saved_work_area: crate::model::StatePixelBoundsRecord {
                x: 0,
                y: 30,
                width: 1728,
                height: 1085,
            },
            presentation: "fullscreen".to_owned(),
        };
        let authoritative_display = crate::model::DisplayTargetRecord {
            id: 7,
            fingerprint: Some(crate::model::DisplayFingerprintRecord {
                label: "Existing native display".to_owned(),
                bounds: authoritative_placement.saved_work_area.clone(),
                resolution: crate::model::StateResolutionRecord {
                    width: 3456,
                    height: 2234,
                },
                scale_factor: 2.0,
                is_primary: true,
                is_internal: true,
            }),
        };
        core.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
            crate::RuntimeWindowContextInitializeInput {
                operation_id: format!("existing-native-context-{platform}"),
                persisted_name: Some("Existing AppKit placement".to_owned()),
                placement: authoritative_placement.clone(),
                target_display: authoritative_display.clone(),
                window_generation: 9,
                window_id: window_id.clone(),
            },
        ))
        .unwrap();

        let observed_core = Arc::clone(&core);
        let observed_window_id = window_id.clone();
        let observed_placement = authoritative_placement.clone();
        let observed_display = authoritative_display.clone();
        let (launch, _) = drive_command_with(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "windowId": window_id,
                    "persistedName": "Existing AppKit placement",
                    "displayId": 1,
                    "scaleFactor": 1.0,
                    "workArea": {"x": 0, "y": 0, "width": 1440, "height": 900},
                    "bounds": {"x": 0, "y": 0, "width": 960, "height": 640},
                    "presentation": "normal"
                }
            })),
            |effect| {
                if let CoreEffectAction::EmbeddedCreateTab { tab } = &effect.action {
                    let snapshot = observed_core.browser_runtime.snapshot().unwrap();
                    let window = &snapshot.windows[&observed_window_id];
                    assert_eq!(window.window_generation, 9, "{platform}");
                    assert_eq!(window.placement.as_ref(), Some(&observed_placement));
                    assert_eq!(window.target_display.as_ref(), Some(&observed_display));
                    if platform == "darwin" {
                        assert_eq!(tab.appkit_window_generation, Some(9));
                        assert_eq!(tab.appkit_topology_revision, Some(window.revision));
                    }
                }
                effect_result(effect, None)
            },
        );
        assert!(launch.is_ok(), "{platform}: {launch:?}");
        let snapshot = core.browser_runtime.snapshot().unwrap();
        let window = &snapshot.windows[&window_id];
        assert_eq!(window.window_generation, 9, "{platform}");
        assert_eq!(window.placement.as_ref(), Some(&authoritative_placement));
        assert_eq!(window.target_display.as_ref(), Some(&authoritative_display));
        core.shutdown();
    }
}
