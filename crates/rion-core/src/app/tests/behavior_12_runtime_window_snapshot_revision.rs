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

#[test]
fn selecting_live_tabs_requires_the_live_snapshot_to_persist_selection() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let window_id = core
            .invoke(command(json!({
                "type": "gameWindowCreate",
                "input": {
                    "name": "Mixed live and dormant",
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
        let dormant_a = uuid::Uuid::new_v4().to_string();
        let dormant_b = uuid::Uuid::new_v4().to_string();
        core.invoke(command(json!({
            "type": "gameWindowUpdate",
            "id": window_id,
            "input": {
                "tabs": [{
                    "id": dormant_a,
                    "tabType": "role",
                    "sourceId": "dormant-a",
                    "name": "Dormant A",
                    "roleIds": ["dormant-a"],
                    "hidden": false,
                    "audioMuted": true,
                    "roleViews": []
                }, {
                    "id": dormant_b,
                    "tabType": "role",
                    "sourceId": "dormant-b",
                    "name": "Dormant B",
                    "roleIds": ["dormant-b"],
                    "hidden": false,
                    "audioMuted": false,
                    "roleViews": []
                }],
                "activeTabId": dormant_a
            }
        })))
        .unwrap();
        let create_live_tab = |source_id: &str| {
            core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: None,
                source_id: source_id.to_owned(),
                name: source_id.to_owned(),
                window_id: window_id.clone(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_slots: test_role_slots(&[source_id]),
            })
            .unwrap()
        };
        let live_c = create_live_tab("live-c").created_tab_id.unwrap();
        let created_d = create_live_tab("live-d");
        let live_d = created_d.created_tab_id.unwrap();
        core.sync_game_windows_from_runtime(&created_d.snapshot, &HashSet::new())
            .unwrap();

        let before_selection = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        let active_before_selection = before_selection["activeTabId"].clone();
        for selected in [&live_c, &live_d, &live_c] {
            core.invoke(CoreCommand::EmbeddedTabActivate {
                tab_id: selected.clone(),
            })
            .unwrap();
        }

        let before_live_commit = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(
            before_live_commit["activeTabId"], active_before_selection,
            "Core activation must not write the UI snapshot on {platform}"
        );
        let mut live_tabs = before_live_commit["tabs"].as_array().unwrap().clone();
        for tab in &mut live_tabs {
            if matches!(
                tab["id"].as_str(),
                Some(id) if id == live_c || id == live_d
            ) {
                tab["hidden"] = json!(false);
            }
        }
        assert_eq!(
            commit_live_window_tabs(
                &core,
                &window_id,
                1,
                1,
                "Mixed live and dormant",
                live_tabs,
                Some(&live_c),
            )["status"],
            "applied",
            "{platform}"
        );
        let window = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(
            window["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tab| tab["sourceId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["dormant-a", "dormant-b", "live-c", "live-d"],
            "{platform}"
        );
        assert_eq!(window["activeTabId"], live_c, "{platform}");
        core.shutdown();
    }
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
                1,
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
