#[test]
fn already_running_role_returns_completed_launch_admission() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let target = EmbeddedLaunchTargetRecord {
            window_id: "window-2".to_owned(),
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
        };
        drive_accepted_launch_to_completion(
            Arc::clone(&core),
            CoreCommand::BrowserRoleLaunch {
                launch_tab_id: None,
                role_id: role_id.clone(),
                target: target.clone(),
                launch_preview_id: None,
                zoom_factor: None,
                restore_role_slots: None,
            },
        );
        let admission = drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserRoleLaunch {
                launch_tab_id: None,
                role_id: role_id.clone(),
                target,
                launch_preview_id: Some("unused-preview".to_owned()),
                zoom_factor: None,
                restore_role_slots: None,
            },
            None,
        )
        .0
        .unwrap();

        assert_eq!(admission["completion"], "completed", "{platform}");
        assert_eq!(admission["statuses"][0]["roleId"], role_id, "{platform}");
        assert_eq!(admission["statuses"][0]["state"], "running", "{platform}");
        core.shutdown();
    }
}

#[test]
fn failed_restored_role_launch_releases_its_operation_lease_for_retry() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let tab_id = "11000000-0000-4000-8000-000000000001";
        let target = EmbeddedLaunchTargetRecord {
            window_id: "restore-retry-window".to_owned(),
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
        };
        let command = || CoreCommand::BrowserRoleLaunch {
            launch_tab_id: Some(tab_id.to_owned()),
            role_id: role_id.clone(),
            target: target.clone(),
            launch_preview_id: None,
            zoom_factor: None,
            restore_role_slots: Some(vec![GameWindowRoleSlotRecord {
                slot_id: "saved-role-slot".to_owned(),
                role_id: role_id.clone(),
                rect: StateNormalizedRectRecord {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                browser_zoom_percent: Some(100.0),
            }]),
        };

        let (failed, _, _) = drive_async_command(
            Arc::clone(&core),
            command(),
            Some("embeddedLoadRoles"),
        );
        assert!(failed.is_err(), "{platform}");
        assert_eq!(core.browser_operations.active_ticket_count(), 0, "{platform}");

        let (retried, actions, _) = drive_async_command(Arc::clone(&core), command(), None);
        assert!(retried.is_ok(), "{platform}: {retried:?}");
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedCreateTab { tab } if tab.tab_id == tab_id
        )));
        assert_eq!(core.browser_operations.active_ticket_count(), 0, "{platform}");
        core.shutdown();
    }
}

#[test]
fn overlapping_role_launches_share_one_logical_tab_and_one_native_create() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let target = EmbeddedLaunchTargetRecord {
            window_id: "window-overlap".to_owned(),
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
        };
        let effects = core.subscribe().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers = [
            "10000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000002",
        ]
        .into_iter()
        .map(|launch_tab_id| {
            let core = Arc::clone(&core);
            let barrier = Arc::clone(&barrier);
            let role_id = role_id.clone();
            let target = target.clone();
            thread::spawn(move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(core.invoke_async(CoreCommand::BrowserRoleLaunch {
                        launch_tab_id: Some(launch_tab_id.to_owned()),
                        role_id,
                        target,
                        launch_preview_id: Some(format!("preview-{launch_tab_id}")),
                        zoom_factor: None,
                        restore_role_slots: None,
                    }))
            })
        })
        .collect::<Vec<_>>();
        barrier.wait();

        let mut actions = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while workers.iter().any(|worker| !worker.is_finished()) {
            assert!(
                std::time::Instant::now() < deadline,
                "overlapping launch admission did not terminalize on {platform}"
            );
            let Ok(events) = effects.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            let results = events
                .into_iter()
                .filter_map(|event| match event {
                    CoreEvent::CoreEffects { effects } => Some(effects),
                    _ => None,
                })
                .flatten()
                .map(|effect| {
                    actions.push(effect.action.clone());
                    effect_result(effect, None)
                })
                .collect::<Vec<_>>();
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        let admissions = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            admissions
                .iter()
                .map(|admission| admission["tabId"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1,
            "{platform}"
        );
        assert_eq!(
            admissions
                .iter()
                .filter(|admission| admission["disposition"] == "admitted")
                .count(),
            1,
            "{platform}"
        );
        assert!(
            admissions.iter().any(|admission| {
                matches!(admission["disposition"].as_str(), Some("existing" | "joined"))
            }),
            "{platform}"
        );
        assert_eq!(
            actions
                .iter()
                .filter(|action| matches!(action, CoreEffectAction::EmbeddedCreateTab { .. }))
                .count(),
            1,
            "{platform}"
        );
        assert_eq!(core.browser_runtime_snapshot().unwrap().tabs.len(), 1, "{platform}");
        core.shutdown();
    }
}

#[test]
fn overlapping_workspace_launches_share_one_logical_tab_and_one_native_create() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": "Overlapping workspace",
                    "template": "single",
                    "slots": [{
                        "roleId": role_id,
                        "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 }
                    }]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let target = EmbeddedLaunchTargetRecord {
            window_id: "window-workspace-overlap".to_owned(),
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
        };
        let effects = core.subscribe().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers = [
            "20000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000002",
        ]
        .into_iter()
        .map(|launch_tab_id| {
            let core = Arc::clone(&core);
            let barrier = Arc::clone(&barrier);
            let workspace_id = workspace_id.clone();
            let target = target.clone();
            thread::spawn(move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(core.invoke_async(CoreCommand::BrowserWorkspaceLaunch {
                        launch_tab_id: Some(launch_tab_id.to_owned()),
                        workspace_id,
                        target,
                        launch_preview_id: Some(format!("preview-{launch_tab_id}")),
                        restore_role_slots: None,
                    }))
            })
        })
        .collect::<Vec<_>>();
        barrier.wait();

        let mut actions = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while workers.iter().any(|worker| !worker.is_finished()) {
            assert!(
                std::time::Instant::now() < deadline,
                "overlapping workspace admission did not terminalize on {platform}"
            );
            let Ok(events) = effects.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            let results = events
                .into_iter()
                .filter_map(|event| match event {
                    CoreEvent::CoreEffects { effects } => Some(effects),
                    _ => None,
                })
                .flatten()
                .map(|effect| {
                    actions.push(effect.action.clone());
                    effect_result(effect, None)
                })
                .collect::<Vec<_>>();
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        let admissions = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            admissions
                .iter()
                .map(|admission| admission["tabId"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1,
            "{platform}"
        );
        assert_eq!(
            admissions
                .iter()
                .filter(|admission| admission["disposition"] == "admitted")
                .count(),
            1,
            "{platform}"
        );
        assert!(
            admissions.iter().any(|admission| {
                matches!(admission["disposition"].as_str(), Some("existing" | "joined"))
            }),
            "{platform}"
        );
        assert_eq!(
            actions
                .iter()
                .filter(|action| matches!(action, CoreEffectAction::EmbeddedCreateTab { .. }))
                .count(),
            1,
            "{platform}"
        );
        assert_eq!(core.browser_runtime_snapshot().unwrap().tabs.len(), 1, "{platform}");
        core.shutdown();
    }
}

#[test]
fn app_snapshot_projects_state_statuses_and_logical_topology_in_one_envelope() {
    let (_directory, core) = core_for_platform("darwin");
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: "app-snapshot-topology".to_owned(),
                source: "command".to_owned(),
                primary_window_id: "window-a".to_owned(),
                windows: vec![crate::RuntimeWindowTopologyCommit {
                    active_tab_id: Some("tab-a".to_owned()),
                    hidden_tab_ids: std::collections::HashSet::new(),
                    tabs: vec![crate::RuntimeLiveTabRecord {
                        audio_muted: false,
                        closable: true,
                        icon_data_url: None,
                        id: "tab-a".to_owned(),
                        persistable: true,
                        role_ids: vec!["role-a".to_owned()],
                        role_slots: Vec::new(),
                        source_id: "role-a".to_owned(),
                        tab_type: "role".to_owned(),
                        title: "Role A".to_owned(),
                        workspace_template: None,
                    }],
                    ui_sequence: 1,
                    window_generation: 7,
                    window_id: "window-a".to_owned(),
                }],
            },
        ))
        .unwrap();

    let first = serde_json::from_value::<crate::model::CoreAppSnapshotRecord>(
        core.invoke(CoreCommand::AppSnapshot).unwrap(),
    )
    .unwrap();
    let second = serde_json::from_value::<crate::model::CoreAppSnapshotRecord>(
        core.invoke(CoreCommand::AppSnapshot).unwrap(),
    )
    .unwrap();

    assert!(second.revision > first.revision);
    assert_eq!(first.runtime_revision, core.runtime_kernel().current_revision().unwrap());
    assert_eq!(first.logical_windows.len(), 1);
    assert_eq!(first.logical_windows[0].window_generation, 7);
    assert_eq!(first.browser_runtime.windows[0].tab_ids, ["tab-a"]);
    assert_eq!(first.browser_runtime.tabs[0].window_id, "window-a");
    assert_eq!(first.state.revision, first.state_revision);
    core.shutdown();
}

#[test]
fn app_snapshot_is_linearized_by_the_runtime_authority_barrier() {
    let (_directory, core) = core_for_platform("darwin");
    let barrier = core.runtime_authority_barrier();
    let write_guard = barrier.write().unwrap();
    let snapshot_core = Arc::clone(&core);
    let (finished, completion) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let result = snapshot_core.app_snapshot();
        finished.send(result.is_ok()).unwrap();
    });

    assert!(
        completion
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err(),
        "AppSnapshot must not cross an in-flight state/runtime commit"
    );
    drop(write_guard);
    assert!(
        completion
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
    );
    worker.join().unwrap();
    core.shutdown();
}
