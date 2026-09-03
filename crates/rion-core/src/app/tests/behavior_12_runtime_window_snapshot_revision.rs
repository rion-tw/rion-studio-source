fn commit_live_window_tabs(
    core: &Arc<AppCore>,
    window_id: &str,
    window_generation: u64,
    revision: u64,
    name: &str,
    tabs: Vec<Value>,
    active_tab_id: Option<&str>,
) -> Value {
    core.invoke(command(json!({
        "type": "gameWindowRuntimeSnapshotCommit",
        "input": {
            "snapshot": {
                "windowId": window_id,
                "windowGeneration": window_generation,
                "revision": revision,
                "tabs": tabs,
                "activeTabId": active_tab_id
            },
            "name": name,
            "targetDisplay": { "id": 1 },
            "placement": {
                "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            }
        }
    })))
    .unwrap()
}

fn create_saved_window(core: &Arc<AppCore>, name: &str) -> String {
    core.invoke(command(json!({
        "type": "gameWindowCreate",
        "input": {
            "name": name,
            "targetDisplay": { "id": 1 },
            "placement": {
                "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            }
        }
    })))
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn runtime_window_snapshot_input(
    window_id: &str,
    window_generation: u64,
    revision: u64,
    name: &str,
    x: i32,
) -> Value {
    json!({
        "snapshot": {
            "windowId": window_id,
            "windowGeneration": window_generation,
            "revision": revision,
            "tabs": [],
            "activeTabId": null
        },
        "name": name,
        "targetDisplay": { "id": 1 },
        "placement": {
            "normalBounds": { "x": x, "y": 0, "width": 960, "height": 640 },
            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
            "presentation": "normal"
        }
    })
}

fn restore_cohort_tab(id: &str, source_id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "tabType": "role",
        "sourceId": source_id,
        "name": name,
        "roleSlots": [{
            "slotId": format!("restore:{source_id}"),
            "roleId": source_id,
            "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
            "browserZoomPercent": 100.0
        }],
        "hidden": false,
        "audioMuted": false
    })
}

fn saved_restore_cohort(core: &Arc<AppCore>, name: &str) -> (String, Vec<Value>) {
    let window_id = create_saved_window(core, name);
    let tabs = vec![
        restore_cohort_tab(
            "00000000-0000-4000-8000-0000000000a1",
            "restore-role-alpha",
            "Alpha",
        ),
        restore_cohort_tab(
            "00000000-0000-4000-8000-0000000000b2",
            "restore-role-beta",
            "Beta",
        ),
        restore_cohort_tab(
            "00000000-0000-4000-8000-0000000000c3",
            "restore-role-gamma",
            "Gamma",
        ),
    ];
    assert_eq!(
        commit_live_window_tabs(
            core,
            &window_id,
            1,
            1,
            name,
            tabs.clone(),
            Some("00000000-0000-4000-8000-0000000000c3"),
        )["status"],
        "applied"
    );
    (window_id, tabs)
}

fn mark_window_restore_in_progress(core: &Arc<AppCore>, window_id: &str) {
    core.update_runtime_restore_session(|session| {
        session.clean_exit = false;
        session.restore_in_progress_window_ids = vec![window_id.to_owned()];
    })
    .unwrap();
}

fn saved_tab_ids(core: &Arc<AppCore>, window_id: &str) -> Vec<String> {
    core.invoke(CoreCommand::GameWindowGet {
        id: window_id.to_owned(),
    })
    .unwrap()["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tab| tab["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn runtime_window_snapshot_commit_is_latest_revision_wins() {
    let (_directory, core) = core();
    let window_id = core
        .invoke(command(json!({
            "type": "gameWindowCreate",
            "input": {
                "name": "Original",
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                }
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let commit = |revision: u64, name: &str| {
        core.invoke(command(json!({
            "type": "gameWindowRuntimeSnapshotCommit",
            "input": {
                "snapshot": {
                    "windowId": window_id.clone(),
                    "windowGeneration": 7,
                    "revision": revision,
                    "tabs": [],
                    "activeTabId": null
                },
                "name": name,
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": revision as i32, "y": 0, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                }
            }
        })))
        .unwrap()
    };

    assert_eq!(commit(2, "Latest")["status"], "applied");
    assert_eq!(commit(1, "Stale")["status"], "superseded");
    assert_eq!(commit(2, "Duplicate")["status"], "superseded");

    let saved = core
        .invoke(CoreCommand::GameWindowGet {
            id: window_id.clone(),
        })
        .unwrap();
    assert_eq!(saved["name"], "Latest");
    assert_eq!(saved["placement"]["normalBounds"]["x"], 2);
}

#[test]
fn runtime_window_snapshot_restores_saved_bounds_and_presentation_after_restart() {
    let (directory, core) = core();
    let window_id = create_saved_window(&core, "Placement restore");
    let commit = |revision: u64, presentation: &str, x: i32| {
        core.invoke(command(json!({
            "type": "gameWindowRuntimeSnapshotCommit",
            "input": {
                "snapshot": {
                    "windowId": window_id.clone(),
                    "windowGeneration": 9,
                    "revision": revision,
                    "tabs": [],
                    "activeTabId": null
                },
                "name": "Placement restore",
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": x, "y": 44, "width": 1110, "height": 720 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": presentation
                }
            }
        })))
        .unwrap()
    };

    assert_eq!(commit(2, "maximized", 33)["status"], "applied");
    let maximized = core
        .invoke(CoreCommand::GameWindowGet {
            id: window_id.clone(),
        })
        .unwrap();
    assert_eq!(maximized["placement"]["presentation"], "maximized");
    assert_eq!(maximized["placement"]["normalBounds"]["x"], 33);

    assert_eq!(commit(3, "fullscreen", 55)["status"], "applied");
    core.shutdown();
    drop(core);

    let restored = AppCore::create(AppCoreOptions {
        app_version: "2.1.0-test".to_owned(),
        build_commit: None,
        packaged: false,
        platform: "darwin".to_owned(),
        runtime_contract_version: Some(22),
        user_data_dir: directory.path().to_string_lossy().into_owned(),
        performance_telemetry_path: None,
    })
    .unwrap();
    let saved = restored
        .invoke(CoreCommand::GameWindowGet { id: window_id })
        .unwrap();
    assert_eq!(saved["placement"]["presentation"], "fullscreen");
    assert_eq!(
        saved["placement"]["normalBounds"],
        json!({ "x": 55, "y": 44, "width": 1110, "height": 720 })
    );
    restored.shutdown();
}

#[test]
fn runtime_window_snapshot_batch_is_atomic_and_latest_revision_wins_per_window() {
    let (_directory, core) = core();
    let window_a = create_saved_window(&core, "A0");
    let window_b = create_saved_window(&core, "B0");
    let batch = |inputs: Vec<Value>| {
        core.invoke(command(json!({
            "type": "gameWindowRuntimeSnapshotBatchCommit",
            "input": { "inputs": inputs }
        })))
    };

    let first = batch(vec![
        runtime_window_snapshot_input(&window_a, 8, 4, "A4", 40),
        runtime_window_snapshot_input(&window_b, 3, 2, "B2", 20),
    ])
    .unwrap();
    assert_eq!(first["receipts"][0]["status"], "applied");
    assert_eq!(first["receipts"][1]["status"], "applied");

    let mixed = batch(vec![
        runtime_window_snapshot_input(&window_a, 8, 3, "A stale", 30),
        runtime_window_snapshot_input(&window_b, 3, 3, "B3", 30),
    ])
    .unwrap();
    assert_eq!(mixed["receipts"][0]["status"], "superseded");
    assert_eq!(mixed["receipts"][1]["status"], "applied");
    assert_eq!(
        core.invoke(CoreCommand::GameWindowGet {
            id: window_a.clone(),
        })
        .unwrap()["name"],
        "A4"
    );
    assert_eq!(
        core.invoke(CoreCommand::GameWindowGet {
            id: window_b.clone(),
        })
        .unwrap()["name"],
        "B3"
    );

    let failed = batch(vec![
        runtime_window_snapshot_input(&window_a, 8, 5, "A5", 50),
        runtime_window_snapshot_input(
            "00000000-0000-4000-8000-000000000000",
            1,
            1,
            "Missing",
            0,
        ),
    ]);
    assert!(failed.is_err());
    let saved_a = core
        .invoke(CoreCommand::GameWindowGet {
            id: window_a.clone(),
        })
        .unwrap();
    assert_eq!(saved_a["name"], "A4");
    assert_eq!(saved_a["placement"]["normalBounds"]["x"], 40);

    let retry = batch(vec![runtime_window_snapshot_input(
        &window_a, 8, 5, "A5", 50,
    )])
    .unwrap();
    assert_eq!(retry["receipts"][0]["status"], "applied");
}

#[test]
fn partial_runtime_restore_snapshot_retains_the_ordered_saved_cohort() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let (window_id, tabs) = saved_restore_cohort(&core, "Partial restore");
        mark_window_restore_in_progress(&core, &window_id);

        let mut admitted_alpha = tabs[0].clone();
        admitted_alpha["name"] = json!("Alpha admitted");
        assert_eq!(
            commit_live_window_tabs(
                &core,
                &window_id,
                2,
                1,
                "Partial restore",
                vec![admitted_alpha],
                Some("00000000-0000-4000-8000-0000000000a1"),
            )["status"],
            "applied",
            "{platform}"
        );

        assert_eq!(
            saved_tab_ids(&core, &window_id),
            tabs.iter()
                .map(|tab| tab["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            "{platform}"
        );
        let saved = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(saved["tabs"][0]["name"], "Alpha admitted", "{platform}");
        assert_eq!(
            saved["activeTabId"],
            "00000000-0000-4000-8000-0000000000c3",
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn complete_runtime_restore_snapshot_commits_exact_tabs_and_active_tab() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let (window_id, mut tabs) = saved_restore_cohort(&core, "Complete restore");
        mark_window_restore_in_progress(&core, &window_id);
        tabs[1]["name"] = json!("Beta terminal");

        assert_eq!(
            commit_live_window_tabs(
                &core,
                &window_id,
                2,
                1,
                "Complete restore",
                tabs.clone(),
                Some("00000000-0000-4000-8000-0000000000b2"),
            )["status"],
            "applied",
            "{platform}"
        );
        let saved = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(saved["tabs"][1]["name"], "Beta terminal", "{platform}");
        assert_eq!(
            saved["activeTabId"],
            "00000000-0000-4000-8000-0000000000b2",
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn failed_or_cancelled_runtime_restore_preserves_the_saved_cohort() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let (window_id, tabs) = saved_restore_cohort(&core, "Cancelled restore");
        mark_window_restore_in_progress(&core, &window_id);
        commit_live_window_tabs(
            &core,
            &window_id,
            2,
            1,
            "Cancelled restore",
            vec![tabs[0].clone()],
            Some("00000000-0000-4000-8000-0000000000a1"),
        );

        core.update_runtime_restore_session(|session| {
            session.restore_in_progress_window_ids.clear();
        })
        .unwrap();
        assert_eq!(
            saved_tab_ids(&core, &window_id),
            tabs.iter()
                .map(|tab| tab["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            "{platform}"
        );
        assert_eq!(
            core.invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap()["activeTabId"],
            "00000000-0000-4000-8000-0000000000c3",
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn typed_tab_stop_leaves_saved_topology_to_the_live_snapshot_commit() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let window_id = core
            .invoke(command(json!({
                "type": "gameWindowCreate",
                "input": {
                    "name": "Saved runtime",
                    "targetDisplay": { "id": 1 },
                    "placement": {
                        "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                        "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                        "presentation": "normal"
                    }
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "windowId": window_id,
                    "displayId": 1,
                    "scaleFactor": 1.0,
                    "workArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "bounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                    "presentation": "normal"
                }
            })),
            None,
        )
        .0
        .unwrap();
        let runtime = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        let tab = runtime.tabs.first().unwrap();
        let persisted_tab = json!({
            "id": tab.id,
            "tabType": tab.tab_type,
            "sourceId": tab.source_id,
            "name": tab.name,
            "roleSlots": tab.slots.iter().map(|slot| json!({
                "slotId": slot.slot_id,
                "roleId": slot.role_id,
                "rect": slot.rect,
                "browserZoomPercent": slot.browser_zoom_percent,
            })).collect::<Vec<_>>(),
            "hidden": false,
            "audioMuted": false,
        });
        assert_eq!(
            commit_live_window_tabs(
                &core,
                &window_id,
                1,
                1,
                "Saved runtime",
                vec![persisted_tab],
                Some(&tab.id),
            )["status"],
            "applied",
            "{platform}"
        );
        let operation_id = format!("native-saved-tab-stop-{platform}");
        drive_async_command_with(
            Arc::clone(&core),
            embedded_tab_stop_mutation_command(
                &operation_id,
                &tab.id,
                &window_id,
                &role_id,
            ),
            |effect| effect_result_with_parent(effect, &operation_id, platform),
        )
        .0
        .unwrap();

        let before_live_commit = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(
            before_live_commit["tabs"].as_array().unwrap().len(),
            1,
            "tab teardown must not write saved topology on {platform}"
        );
        assert_eq!(
            commit_live_window_tabs(
                &core,
                &window_id,
                2,
                1,
                "Saved runtime",
                Vec::new(),
                None,
            )["status"],
            "applied",
            "{platform}"
        );
        assert!(
            core.invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap()["tabs"]
                .as_array()
                .unwrap()
                .is_empty(),
            "{platform}"
        );
        core.shutdown();
    }
}
