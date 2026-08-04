#[test]
    fn latest_live_snapshot_is_the_only_persisted_tab_order() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let window_id = core
                .invoke(command(json!({
                    "type": "gameWindowCreate",
                    "input": {
                        "name": "Game Window 1",
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
            let tab_ids = [
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
            ];
            let mut snapshot = None;
            for (tab_id, name) in tab_ids.iter().zip(["Rimi", "里央", "test"]) {
                snapshot = Some(
                    core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                        tab_id: Some((*tab_id).to_owned()),
                        source_id: format!("role-{tab_id}"),
                        name: (*name).to_owned(),
                        window_id: window_id.clone(),
                        tab_type: "role".to_owned(),
                        workspace_id: None,
                        role_slots: test_role_slots(&[&format!("role-{tab_id}")]),
                    })
                    .unwrap()
                    .snapshot,
                );
            }
            core.sync_game_windows_from_runtime(
                &snapshot.expect("three tabs produce a runtime snapshot"),
                &HashSet::new(),
            )
            .unwrap();

            let before = tab_ids.iter().map(|tab_id| (*tab_id).to_owned()).collect::<Vec<_>>();
            let after = vec![
                tab_ids[0].to_owned(),
                tab_ids[2].to_owned(),
                tab_ids[1].to_owned(),
            ];
            let parent_operation_id = format!("native-tabDragTopology-{platform}");
            let (committed, native_effects) = drive_command_with(
                Arc::clone(&core),
                CoreCommand::EmbeddedTabDragTopologyCommit {
                    request: crate::model::RuntimeTabMutationRequestRecord {
                        operation_id: parent_operation_id.clone(),
                        mutation_kind: "reorder".to_owned(),
                        tab_id: tab_ids[2].to_owned(),
                        source_window_id: window_id.clone(),
                        source_window_generation: 1,
                        target_window_id: None,
                        target_window_generation: None,
                        lifecycle_epoch: 1,
                        topology_revision: 1,
                        presentation_revision: 1,
                        reorder_target_index: None,
                        expected_tab_order: after.clone(),
                        expected_active_tab_id: Some(tab_ids[0].to_owned()),
                    },
                    target: None,
                    source_before_tab_ids: before.clone(),
                    source_after_tab_ids: after.clone(),
                    target_before_tab_ids: before.clone(),
                    target_after_tab_ids: after.clone(),
                },
                |effect| effect_result_with_parent(effect, &parent_operation_id, platform),
            );
            let committed = committed.unwrap();
            assert!(
                native_effects.is_empty(),
                "the live native presentation must not be replayed on {platform}"
            );
            assert_eq!(committed["windows"][0]["tabIds"], json!(after), "{platform}");
            let persisted_before_commit = core
                .invoke(CoreCommand::GameWindowGet {
                    id: window_id.clone(),
                })
                .unwrap();
            assert_eq!(
                persisted_before_commit["tabs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tab| tab["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                before,
                "Core runtime topology is no longer a persistence authority on {platform}"
            );
            let persisted_tabs = after
                .iter()
                .map(|tab_id| {
                    persisted_before_commit["tabs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|tab| tab["id"].as_str() == Some(tab_id))
                        .unwrap()
                        .clone()
                })
                .collect::<Vec<_>>();
            assert_eq!(
                commit_live_window_tabs(
                    &core,
                    &window_id,
                    1,
                    1,
                    "Game Window 1",
                    persisted_tabs,
                    Some(tab_ids[0]),
                )["status"],
                "applied",
                "{platform}"
            );
            let persisted = core
                .invoke(CoreCommand::GameWindowGet {
                    id: window_id.clone(),
                })
                .unwrap();
            assert_eq!(
                persisted["tabs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tab| tab["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                after,
                "{platform}"
            );

            let persisted_before_projection = core.invoke(CoreCommand::GameWindowGet { id: window_id.clone() }).unwrap();
            let projected = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedTabDragTopologyCommit {
                    request: crate::model::RuntimeTabMutationRequestRecord {
                        operation_id: format!("{parent_operation_id}-stale"),
                        mutation_kind: "reorder".to_owned(),
                        tab_id: tab_ids[2].to_owned(),
                        source_window_id: window_id.clone(),
                        source_window_generation: 1,
                        target_window_id: None,
                        target_window_generation: None,
                        lifecycle_epoch: 1,
                        topology_revision: 1,
                        presentation_revision: 2,
                        reorder_target_index: None,
                        expected_tab_order: before.clone(),
                        expected_active_tab_id: Some(tab_ids[0].to_owned()),
                    },
                    target: None,
                    source_before_tab_ids: before.clone(),
                    source_after_tab_ids: before.clone(),
                    target_before_tab_ids: before.clone(),
                    target_after_tab_ids: before.clone(),
                },
                None,
            )
            .0;
            assert_eq!(projected.unwrap()["windows"][0]["tabIds"], json!(before), "{platform}");
            assert_eq!(
                core.invoke(CoreCommand::GameWindowGet { id: window_id }).unwrap(),
                persisted_before_projection,
                "Core topology projection must never write or roll back the saved UI snapshot on {platform}"
            );
            core.shutdown();
        }
    }
