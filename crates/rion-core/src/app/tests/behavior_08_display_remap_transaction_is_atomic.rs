use crate::model::{
    DisplayTargetRecord, GameWindowDisplayRemapRecord, GameWindowPlacementRecord,
};

fn create_display_remap_window(core: &AppCore, name: &str, display_id: i64) -> String {
    core.invoke(command(json!({
        "type": "gameWindowCreate",
        "input": {
            "name": name,
            "targetDisplay": { "id": display_id },
            "placement": {
                "normalBounds": { "x": 10, "y": 20, "width": 800, "height": 600 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1200, "height": 800 },
                "presentation": "normal"
            }
        }
    })))
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn display_remap_update(window_id: &str, display_id: i64) -> GameWindowDisplayRemapRecord {
    GameWindowDisplayRemapRecord {
        window_id: window_id.to_owned(),
        input: GameWindowUpdateInputRecord {
            target_display: Some(DisplayTargetRecord {
                id: display_id,
                fingerprint: None,
            }),
            placement: Some(GameWindowPlacementRecord {
                normal_bounds: StatePixelBoundsRecord {
                    x: display_id as i32,
                    y: 40,
                    width: 900,
                    height: 700,
                },
                saved_work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1600,
                    height: 900,
                },
                presentation: "normal".to_owned(),
            }),
            ..GameWindowUpdateInputRecord::default()
        },
    }
}

#[test]
fn display_remaps_commit_all_windows_or_none_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let first = create_display_remap_window(&core, "First", 1);
        let second = create_display_remap_window(&core, "Second", 2);

        let error = core
            .invoke(CoreCommand::GameWindowsDisplayRemap {
                updates: vec![
                    display_remap_update(&first, 10),
                    display_remap_update("missing-window", 11),
                ],
            })
            .unwrap_err();
        assert_eq!(error.code(), "GAME_WINDOW_NOT_FOUND", "{platform}");
        assert_eq!(
            core.invoke(CoreCommand::GameWindowGet { id: first.clone() })
                .unwrap()["targetDisplay"]["id"],
            1,
            "{platform}"
        );

        let remapped = core
            .invoke(CoreCommand::GameWindowsDisplayRemap {
                updates: vec![
                    display_remap_update(&first, 10),
                    display_remap_update(&second, 11),
                ],
            })
            .unwrap();
        assert_eq!(remapped.as_array().unwrap().len(), 2, "{platform}");
        assert_eq!(
            core.invoke(CoreCommand::GameWindowGet { id: first })
                .unwrap()["targetDisplay"]["id"],
            10,
            "{platform}"
        );
        assert_eq!(
            core.invoke(CoreCommand::GameWindowGet { id: second })
                .unwrap()["targetDisplay"]["id"],
            11,
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn display_remap_rejects_duplicate_window_updates_before_commit() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let window_id = create_display_remap_window(&core, "Only", 1);
        let error = core
            .invoke(CoreCommand::GameWindowsDisplayRemap {
                updates: vec![
                    display_remap_update(&window_id, 10),
                    display_remap_update(&window_id, 11),
                ],
            })
            .unwrap_err();
        assert_eq!(
            error.code(),
            "GAME_WINDOW_DISPLAY_REMAP_DUPLICATE",
            "{platform}"
        );
        assert_eq!(
            core.invoke(CoreCommand::GameWindowGet { id: window_id })
                .unwrap()["targetDisplay"]["id"],
            1,
            "{platform}"
        );
        core.shutdown();
    }
}
