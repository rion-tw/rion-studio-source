fn create_zoomed_two_role_workspace(core: &AppCore, left_role_id: &str, right_role_id: &str) -> String {
    core.invoke(command(json!({
        "type": "workspaceCreate",
        "input": {
            "name": "Zoomed roles",
            "template": "two_columns",
            "slots": [
                {
                    "id": "zoom-left",
                    "roleId": left_role_id,
                    "browserZoomPercent": 150,
                    "rect": {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
                },
                {
                    "id": "zoom-right",
                    "roleId": right_role_id,
                    "browserZoomPercent": 125,
                    "rect": {"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0}
                }
            ]
        }
    })))
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn launch_zoomed_workspace(
    core: &Arc<AppCore>,
    workspace_id: &str,
    window_id: &str,
    platform: &str,
) -> Vec<crate::model::StateWorkspaceSlotRecord> {
    let (result, _) = drive_command(
        Arc::clone(core),
        web_workspace_launch(workspace_id, window_id),
        None,
    );
    if let Err(error) = result {
        panic!("{platform}: workspace launch was rejected: {error}");
    }
    core.browser_runtime.snapshot().unwrap().windows[window_id]
        .tabs
        .iter()
        .find(|tab| tab.tab_type == "workspace" && tab.source_id == workspace_id)
        .unwrap()
        .workspace_slots
        .clone()
}

fn assert_left_slot_empty_without_zoom(
    slots: &[crate::model::StateWorkspaceSlotRecord],
    right_role_id: &str,
    platform: &str,
) {
    assert_eq!(slots[0].id, "zoom-left", "{platform}");
    assert_eq!(slots[0].role_id, None, "{platform}");
    assert_eq!(slots[0].browser_zoom_percent, None, "{platform}");
    assert_eq!(slots[1].role_id.as_deref(), Some(right_role_id), "{platform}");
    assert_eq!(slots[1].browser_zoom_percent, Some(125.0), "{platform}");
}

#[test]
fn workspace_launches_after_its_zoomed_role_is_deleted_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let game_id = first_game_id(&core);
        let deleted_role_id = create_role(&core, &game_id, 1);
        let kept_role_id = create_role(&core, &game_id, 2);
        let workspace_id =
            create_zoomed_two_role_workspace(&core, &deleted_role_id, &kept_role_id);

        let (deleted, _, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::RoleDelete {
                id: deleted_role_id,
            },
            None,
        );
        deleted.unwrap();

        let slots = launch_zoomed_workspace(
            &core,
            &workspace_id,
            "deleted-role-zoom-window",
            platform,
        );
        assert_left_slot_empty_without_zoom(&slots, &kept_role_id, platform);
        core.shutdown();
    }
}

#[test]
fn workspace_launch_drops_zoom_left_on_a_slot_emptied_by_an_older_role_deletion() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let game_id = first_game_id(&core);
        let cleared_role_id = create_role(&core, &game_id, 1);
        let kept_role_id = create_role(&core, &game_id, 2);
        let workspace_id =
            create_zoomed_two_role_workspace(&core, &cleared_role_id, &kept_role_id);

        // Older builds cleared only the role identity, so persisted workspaces
        // can still carry the removed role's zoom on an empty slot.
        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        let payload = connection
            .query_row(
                "SELECT payload_json FROM workspaces WHERE id=?1",
                rusqlite::params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let mut payload = serde_json::from_str::<Value>(&payload).unwrap();
        payload["slots"][0].as_object_mut().unwrap().remove("roleId");
        assert_eq!(payload["slots"][0]["browserZoomPercent"], json!(150.0));
        connection
            .execute(
                "UPDATE workspaces SET payload_json=?1 WHERE id=?2",
                rusqlite::params![payload.to_string(), workspace_id],
            )
            .unwrap();
        drop(connection);

        let slots = launch_zoomed_workspace(
            &core,
            &workspace_id,
            "legacy-cleared-zoom-window",
            platform,
        );
        assert_left_slot_empty_without_zoom(&slots, &kept_role_id, platform);
        core.shutdown();
    }
}

fn saved_zoomed_workspace_tab(
    tab_id: &str,
    workspace_id: &str,
    left_role_id: &str,
    right_role_id: &str,
    with_layout_snapshot: bool,
) -> Value {
    let left = json!({"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0});
    let right = json!({"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0});
    let workspace_slots = if with_layout_snapshot {
        json!([
            {"id": "zoom-left", "roleId": left_role_id, "browserZoomPercent": 175, "rect": left},
            {"id": "zoom-right", "roleId": right_role_id, "browserZoomPercent": 150, "rect": right}
        ])
    } else {
        json!([])
    };
    json!({
        "id": tab_id,
        "tabType": "workspace",
        "sourceId": workspace_id,
        "name": "Zoomed roles",
        "roleSlots": [
            {"slotId": "zoom-left", "roleId": left_role_id, "rect": left, "browserZoomPercent": 175},
            {"slotId": "zoom-right", "roleId": right_role_id, "rect": right, "browserZoomPercent": 150}
        ],
        "workspaceSlots": workspace_slots,
        "hidden": false,
        "audioMuted": false
    })
}

#[test]
fn saved_workspace_restore_skips_zoom_for_slots_that_lost_their_role_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        // The saved tab either owns a full workspace layout snapshot or, for
        // older saves, only its role slots; both restore paths copy zoom.
        for with_layout_snapshot in [true, false] {
            let case = format!("{platform}, layout snapshot: {with_layout_snapshot}");
            let (_directory, core) = chromium_web_core(platform);
            let game_id = first_game_id(&core);
            let cleared_role_id = create_role(&core, &game_id, 1);
            let kept_role_id = create_role(&core, &game_id, 2);
            let workspace_id =
                create_zoomed_two_role_workspace(&core, &cleared_role_id, &kept_role_id);
            let window_id = create_saved_window(&core, "Zoomed restore window");
            let tab_id = uuid::Uuid::new_v4().to_string();
            core.invoke(command(json!({
                "type": "gameWindowUpdate",
                "id": window_id,
                "input": {
                    "tabs": [saved_zoomed_workspace_tab(
                        &tab_id,
                        &workspace_id,
                        &cleared_role_id,
                        &kept_role_id,
                        with_layout_snapshot,
                    )],
                    "activeTabId": tab_id
                }
            })))
            .unwrap();
            let saved: crate::model::StateGameWindowRecord = serde_json::from_value(
                core.invoke(CoreCommand::GameWindowGet {
                    id: window_id.clone(),
                })
                .unwrap(),
            )
            .unwrap();

            // The Workspace stays authoritative for slot content: the role is
            // removed from it after the Game Window saved its zoomed layout.
            core.invoke(CoreCommand::WorkspaceClearRole {
                role_id: cleared_role_id.clone(),
            })
            .unwrap();

            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserWorkspaceLaunch {
                    launch_tab_id: Some(tab_id.clone()),
                    workspace_id: workspace_id.clone(),
                    target: EmbeddedLaunchTargetRecord {
                        window_id: window_id.clone(),
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
                    restore_role_slots: Some(saved.tabs[0].role_slots.clone()),
                },
            );

            let live = core.browser_runtime.snapshot().unwrap();
            let slots = &live.windows[&window_id]
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .unwrap()
                .workspace_slots;
            assert_eq!(slots[0].id, "zoom-left", "{case}");
            assert_eq!(slots[0].role_id, None, "{case}");
            assert_eq!(slots[0].browser_zoom_percent, None, "{case}");
            assert_eq!(
                slots[1].role_id.as_deref(),
                Some(kept_role_id.as_str()),
                "{case}"
            );
            assert_eq!(
                slots[1].browser_zoom_percent,
                Some(150.0),
                "{case}: the saved zoom still restores onto its own role"
            );
            core.shutdown();
        }
    }
}
