fn create_web_only_workspace(core: &AppCore, name: &str) -> String {
    core.invoke(command(json!({
        "type": "workspaceCreate",
        "input": {
            "name": name,
            "template": "single",
            "slots": [{
                "web": {
                    "name": "Rion Docs",
                    "startUrl": "https://example.test/docs"
                },
                "rect": workspace_rect(0, 1)
            }]
        }
    })))
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn web_workspace_launch(workspace_id: &str, window_id: &str) -> CoreCommand {
    command(json!({
        "type": "embeddedWorkspaceLaunch",
        "workspaceId": workspace_id,
        "target": {
            "windowId": window_id,
            "displayId": 1,
            "workArea": {"x": 0, "y": 0, "width": 1440, "height": 900}
        }
    }))
}

fn web_workspace_browser_launch(workspace_id: &str, window_id: &str) -> CoreCommand {
    CoreCommand::BrowserWorkspaceLaunch {
        launch_tab_id: None,
        workspace_id: workspace_id.to_owned(),
        target: EmbeddedLaunchTargetRecord {
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
        },
        launch_preview_id: None,
        restore_role_slots: None,
    }
}

#[test]
fn web_only_workspace_launches_without_creating_managed_role_statuses() {
    for platform in ["darwin", "win32"] {
        let (directory, core) = core_for_platform(platform);
        let workspace_id = create_web_only_workspace(&core, &format!("Web only {platform}"));
        let (launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("web-window-{platform}")),
            None,
        );

        assert_eq!(launch.unwrap(), json!([]), "{platform}");
        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedCreateTab { tab }
                    if tab.workspace_slots.len() == 1
                        && tab.workspace_slots[0].web.is_some()
                        && tab.slots.len() == 1
                        && tab.slots[0].web.is_some()
                        && tab.roles.len() == 1
                        && tab.roles[0].web.is_some()
            )),
            "{platform}"
        );
        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedLoadRoles { roles } if roles.is_empty()
            )),
            "{platform}"
        );
        assert!(
            actions
                .iter()
                .all(|action| !matches!(action, CoreEffectAction::EmbeddedLoadWebSurfaces { .. })),
            "{platform}"
        );
        assert!(
            !directory.path().join("web-profiles").exists(),
            "{platform}"
        );

        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty(), "{platform}");
        assert_eq!(snapshot.tabs.len(), 1, "{platform}");
        assert!(snapshot.tabs[0].slots.is_empty(), "{platform}");
        assert_eq!(snapshot.workspaces.len(), 1, "{platform}");
        assert!(snapshot.workspaces[0].role_ids.is_empty(), "{platform}");
        assert_eq!(snapshot.workspaces[0].state, "running", "{platform}");
        assert!(core.browser_statuses().unwrap().is_empty(), "{platform}");

        let (stop, stop_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWorkspaceStop {
                workspace_id: workspace_id.clone(),
            },
            None,
        );
        assert!(stop.is_ok(), "{platform}: {stop:?}");
        assert!(
            stop_actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. })),
            "{platform}"
        );
        assert!(
            core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot
                .tabs
                .is_empty(),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn repeated_web_only_launch_joins_the_existing_tab_and_stop_allows_a_fresh_attempt() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let workspace_id = create_web_only_workspace(&core, &format!("Lifecycle {platform}"));
        let (first_launch, first_actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("first-web-window-{platform}")),
            None,
        );
        assert_eq!(first_launch.unwrap(), json!([]), "{platform}");
        let (first_tab_id, first_attempt_generation) = first_actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some((
                    tab.tab_id.clone(),
                    tab.attempt_generation
                        .clone()
                        .expect("launch attempt generation"),
                )),
                _ => None,
            })
            .expect("first Web-only launch must create a native tab");

        let (joined, joined_actions, _) = drive_async_command(
            Arc::clone(&core),
            web_workspace_browser_launch(
                &workspace_id,
                &format!("ignored-second-window-{platform}"),
            ),
            None,
        );
        let joined = joined.unwrap();
        assert_eq!(joined["completion"], "completed", "{platform}");
        assert_eq!(joined["disposition"], "joined", "{platform}");
        assert_eq!(joined["tabId"], first_tab_id, "{platform}");
        assert_eq!(joined["statuses"], json!([]), "{platform}");
        assert!(joined_actions.is_empty(), "{platform}: {joined_actions:?}");
        let joined_snapshot = core.browser_runtime_snapshot().unwrap();
        assert_eq!(joined_snapshot.tabs.len(), 1, "{platform}");
        assert_eq!(joined_snapshot.tabs[0].id, first_tab_id, "{platform}");

        let (stop, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWorkspaceStop {
                workspace_id: workspace_id.clone(),
            },
            None,
        );
        assert!(stop.is_ok(), "{platform}: {stop:?}");

        let (relaunched, relaunch_actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("relaunch-web-window-{platform}")),
            None,
        );
        assert_eq!(relaunched.unwrap(), json!([]), "{platform}");
        let (relaunch_tab_id, relaunch_attempt_generation) = relaunch_actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some((
                    tab.tab_id.clone(),
                    tab.attempt_generation
                        .clone()
                        .expect("relaunch attempt generation"),
                )),
                _ => None,
            })
            .expect("Web-only relaunch must create a fresh native tab");
        assert_ne!(relaunch_tab_id, first_tab_id, "{platform}");
        assert_ne!(
            relaunch_attempt_generation, first_attempt_generation,
            "{platform}"
        );
        let relaunched_snapshot = core.browser_runtime_snapshot().unwrap();
        assert_eq!(relaunched_snapshot.tabs.len(), 1, "{platform}");
        assert_eq!(
            relaunched_snapshot.tabs[0].id, relaunch_tab_id,
            "{platform}"
        );
        assert!(relaunched_snapshot.roles.is_empty(), "{platform}");
        core.shutdown();
    }
}

#[test]
fn chromium_browser_workspace_stop_retires_kernel_and_ownership_topology() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let workspace_id = create_web_only_workspace(
            &core,
            &format!("Chromium stop topology {platform}"),
        );
        let window_id = format!("chromium-stop-window-{platform}");
        let (launched, launch_actions) = drive_launch_through_terminal(
            Arc::clone(&core),
            web_workspace_browser_launch(&workspace_id, &window_id),
        );
        assert!(launched["operationId"].is_string(), "{platform}: {launched:?}");
        assert!(launch_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedCreateTab { .. }
        )), "{platform}");
        let before = core.app_snapshot().unwrap();
        assert_eq!(before.logical_windows.len(), 1, "{platform}");
        assert_eq!(before.browser_runtime.windows.len(), 1, "{platform}");
        assert_eq!(before.browser_runtime.tabs.len(), 1, "{platform}");

        let (stopped, stop_actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserWorkspaceStop {
                workspace_id: workspace_id.clone(),
            },
            None,
        );
        assert!(stopped.is_ok(), "{platform}: {stopped:?}");
        assert!(stop_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedDestroyTab { .. }
        )), "{platform}");
        let after = core.app_snapshot().unwrap();
        assert!(after.logical_windows.is_empty(), "{platform}");
        assert!(after.browser_runtime.windows.is_empty(), "{platform}");
        assert!(after.browser_runtime.tabs.is_empty(), "{platform}");
        assert!(after.browser_runtime.roles.is_empty(), "{platform}");
        core.shutdown();
    }
}

#[test]
fn blank_workspace_is_rejected_after_releasing_its_operation_lease() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": format!("Blank {platform}"),
                    "template": "single",
                    "slots": [{}]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("blank-window-{platform}")),
            None,
        );

        assert_eq!(
            launch.unwrap_err().code(),
            "WORKSPACE_CONTENT_REQUIRED",
            "{platform}"
        );
        assert!(actions.is_empty(), "{platform}");
        assert_eq!(
            core.browser_operations.active_ticket_count(),
            0,
            "{platform}"
        );
        assert!(
            core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot
                .tabs
                .is_empty(),
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn web_only_workspace_requires_an_available_system_webview_registration() {
    for platform in ["darwin", "win32"] {
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(
            AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                build_commit: None,
                packaged: false,
                platform: platform.to_owned(),
                runtime_contract_version: Some(22),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
            })
            .unwrap(),
        );
        let workspace_id = create_web_only_workspace(&core, &format!("Unavailable {platform}"));
        let (launch, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace_id, &format!("unavailable-window-{platform}")),
            None,
        );

        assert_eq!(
            launch.unwrap_err().code(),
            "SYSTEM_WEBVIEW_CAPABILITY_UNAVAILABLE",
            "{platform}"
        );
        assert!(actions.is_empty(), "{platform}");
        assert_eq!(
            core.browser_operations.active_ticket_count(),
            0,
            "{platform}"
        );
        assert!(
            core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot
                .tabs
                .is_empty(),
            "{platform}"
        );
        core.shutdown();
    }
}
