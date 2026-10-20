#[test]
fn native_zoom_factors_convert_to_exact_stored_percents() {
    for (factor, percent) in [
        (1.1, 110.0),
        (1.15, 115.0),
        (0.9, 90.0),
        (0.33, 33.0),
        (2.5, 250.0),
    ] {
        assert_eq!(zoom_factor_percent(factor), percent);
    }
    assert_ne!(1.1_f64 * 100.0, 110.0);
}

fn noisy_zoom_target(window_id: &str, name: &str) -> EmbeddedLaunchTargetRecord {
    EmbeddedLaunchTargetRecord {
        window_id: window_id.to_owned(),
        persisted_name: Some(name.to_owned()),
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
    }
}

fn noisy_zoom_restore_result(core: &Arc<AppCore>, command: CoreCommand) -> Result<Value, String> {
    let core = Arc::clone(core);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        drive_accepted_launch_to_completion(core, command)
    }))
    .map_err(|panic| {
        panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default()
    })
}

/// Earlier runtime role zoom writes stored `factor * 100.0`; 0.55 * 100 keeps
/// its binary noise through JSON and must still restore on both platforms.
#[test]
fn saved_workspace_tab_with_a_noisy_zoom_percent_restores_on_both_platforms() {
    let noisy = 0.55_f64 * 100.0;
    assert_ne!(noisy, 55.0);
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let game_id = first_game_id(&core);
        let left = create_role(&core, &game_id, 1);
        let right = create_role(&core, &game_id, 2);
        let workspace_id = create_zoomed_two_role_workspace(&core, &left, &right);
        let window_id = create_saved_window(&core, "Noisy zoom window");
        let tab_id = uuid::Uuid::new_v4().to_string();
        let l = json!({"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0});
        let r = json!({"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0});
        core.invoke(command(json!({
            "type": "gameWindowUpdate",
            "id": window_id,
            "input": {
                "tabs": [{
                    "id": tab_id, "tabType": "workspace", "sourceId": workspace_id, "name": "Zoomed roles",
                    "roleSlots": [
                        {"slotId": "zoom-left", "roleId": left, "rect": l, "browserZoomPercent": noisy},
                        {"slotId": "zoom-right", "roleId": right, "rect": r, "browserZoomPercent": 125}
                    ],
                    "workspaceSlots": [
                        {"id": "zoom-left", "roleId": left, "browserZoomPercent": noisy, "rect": l},
                        {"id": "zoom-right", "roleId": right, "browserZoomPercent": 125, "rect": r}
                    ],
                    "hidden": false, "audioMuted": false
                }],
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
        let result = noisy_zoom_restore_result(
            &core,
            CoreCommand::BrowserWorkspaceLaunch {
                launch_tab_id: Some(tab_id.clone()),
                workspace_id: workspace_id.clone(),
                target: noisy_zoom_target(&window_id, &saved.name),
                launch_preview_id: None,
                restore_role_slots: Some(saved.tabs[0].role_slots.clone()),
            },
        );
        assert!(result.is_ok(), "{platform} restore failed: {result:?}");
        core.shutdown();
    }
}
