fn follow_slot_rect(x: f64, width: f64) -> Value {
    json!({"x": x, "y": 0.0, "width": width, "height": 1.0})
}

/// Saves a Workspace tab whose layout snapshot holds only `saved_role_id`, in a
/// 60/40 split that differs from the Workspace's own 50/50 geometry.
fn save_single_role_workspace_tab(
    core: &Arc<AppCore>,
    workspace_id: &str,
    saved_role_id: &str,
) -> (String, String) {
    let window_id = create_saved_window(core, "Saved workspace follow");
    let tab_id = uuid::Uuid::new_v4().to_string();
    core.invoke(command(json!({
        "type": "gameWindowUpdate",
        "id": window_id,
        "input": {
            "tabs": [{
                "id": tab_id,
                "tabType": "workspace",
                "sourceId": workspace_id,
                "name": "Follow",
                "roleSlots": [{
                    "slotId": "follow-left", "roleId": saved_role_id,
                    "rect": follow_slot_rect(0.0, 0.6), "browserZoomPercent": 150
                }],
                "workspaceSlots": [
                    {
                        "id": "follow-left", "roleId": saved_role_id,
                        "browserZoomPercent": 150, "rect": follow_slot_rect(0.0, 0.6)
                    },
                    {"id": "follow-right", "rect": follow_slot_rect(0.6, 0.4)}
                ],
                "hidden": false,
                "audioMuted": false
            }],
            "activeTabId": tab_id
        }
    })))
    .unwrap();
    (window_id, tab_id)
}

fn follow_workspace_slots(left_role_id: Option<&str>, right_role_id: Option<&str>) -> Value {
    let slot = |id: &str, x: f64, role_id: Option<&str>| {
        let mut slot = json!({"id": id, "rect": follow_slot_rect(x, 0.5)});
        if let Some(role_id) = role_id {
            slot["roleId"] = json!(role_id);
            slot["browserZoomPercent"] = json!(125);
        }
        slot
    };
    json!([
        slot("follow-left", 0.0, left_role_id),
        slot("follow-right", 0.5, right_role_id)
    ])
}

fn restore_saved_workspace_tab(
    core: &Arc<AppCore>,
    workspace_id: &str,
    saved: &crate::model::StateGameWindowRecord,
) -> Vec<crate::model::StateWorkspaceSlotRecord> {
    let tab = &saved.tabs[0];
    drive_accepted_launch_to_completion(
        Arc::clone(core),
        CoreCommand::BrowserWorkspaceLaunch {
            launch_tab_id: Some(tab.id.clone()),
            workspace_id: workspace_id.to_owned(),
            target: EmbeddedLaunchTargetRecord {
                window_id: saved.id.clone(),
                persisted_name: Some(saved.name.clone()),
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
            restore_role_slots: Some(tab.role_slots.clone()),
        },
    );
    core.browser_runtime.snapshot().unwrap().windows[&saved.id]
        .tabs
        .iter()
        .find(|live| live.id == tab.id)
        .unwrap()
        .workspace_slots
        .clone()
}

#[test]
fn saved_workspace_tab_survives_deleting_its_snapshot_role_and_restores_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        // After the save, the Workspace either replaced the snapshot Role in
        // its slot or gained another Role in the slot that was empty.
        for replaced in [true, false] {
            let case = format!("{platform}, replaced: {replaced}");
            let (_directory, core) = chromium_web_core(platform);
            let game_id = first_game_id(&core);
            let deleted_role_id = create_role(&core, &game_id, 1);
            let kept_role_id = create_role(&core, &game_id, 2);
            let workspace_id = core
                .invoke(command(json!({
                    "type": "workspaceCreate",
                    "input": {
                        "name": "Follow",
                        "template": "two_columns",
                        "slots": follow_workspace_slots(Some(&deleted_role_id), None)
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let (window_id, tab_id) =
                save_single_role_workspace_tab(&core, &workspace_id, &deleted_role_id);
            let (left, right) = if replaced {
                (Some(kept_role_id.as_str()), None)
            } else {
                (Some(deleted_role_id.as_str()), Some(kept_role_id.as_str()))
            };
            core.invoke(command(json!({
                "type": "workspaceUpdate",
                "id": workspace_id,
                "input": {"slots": follow_workspace_slots(left, right)}
            })))
            .unwrap();

            let (deleted, _, _) = drive_async_command(
                Arc::clone(&core),
                CoreCommand::RoleDelete {
                    id: deleted_role_id.clone(),
                },
                None,
            );
            deleted.unwrap();

            let saved: crate::model::StateGameWindowRecord = serde_json::from_value(
                core.invoke(CoreCommand::GameWindowGet {
                    id: window_id.clone(),
                })
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                saved
                    .tabs
                    .iter()
                    .map(|tab| tab.id.as_str())
                    .collect::<Vec<_>>(),
                vec![tab_id.as_str()],
                "{case}: the Workspace tab stays in the saved Game Window"
            );
            assert_eq!(
                saved.tabs[0]
                    .role_slots
                    .iter()
                    .map(|slot| slot.role_id.as_str())
                    .collect::<Vec<_>>(),
                vec![kept_role_id.as_str()],
                "{case}"
            );

            let slots = restore_saved_workspace_tab(&core, &workspace_id, &saved);
            let kept_index = usize::from(!replaced);
            assert_eq!(
                slots[kept_index].role_id.as_deref(),
                Some(kept_role_id.as_str()),
                "{case}: the current Workspace content is restored"
            );
            assert_eq!(
                slots[kept_index].browser_zoom_percent,
                Some(125.0),
                "{case}"
            );
            assert_eq!(slots[1 - kept_index].role_id, None, "{case}");
            assert!(
                (slots[0].rect.width - 0.6).abs() < 1e-9,
                "{case}: the saved geometry is restored: {:?}",
                slots[0].rect
            );
            core.shutdown();
        }
    }
}
