#[test]
fn conditional_tab_activation_noops_after_the_tab_moves_to_another_window() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let create_window = |name: &str| {
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
        };
        let window_a = create_window("A");
        let window_b = create_window("B");
        let create_tab = |source_id: &str, window_id: &str| {
            core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: None,
                source_id: source_id.to_owned(),
                name: source_id.to_owned(),
                window_id: window_id.to_owned(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_slots: test_role_slots(&[source_id]),
            })
            .unwrap()
            .created_tab_id
            .unwrap()
        };
        let tab_a = create_tab("role-a", &window_a);
        let tab_b = create_tab("role-b", &window_a);
        let tab_c = create_tab("role-c", &window_b);
        core.invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
            tab_id: tab_b.clone(),
        })
        .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::MoveTab {
            tab_id: tab_a.clone(),
            window_id: window_b.clone(),
        })
        .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
            tab_id: tab_c.clone(),
        })
        .unwrap();

        let stale = core
            .invoke(CoreCommand::EmbeddedTabActivateConditional {
                tab_id: tab_a.clone(),
                window_id: window_a.clone(),
                selection_revision: 10,
            })
            .unwrap();
        let stale_window_a = stale["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["windowId"] == window_a)
            .unwrap();
        assert_eq!(stale_window_a["activeTabId"], tab_b, "{platform}");
        let stale_window_b = stale["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["windowId"] == window_b)
            .unwrap();
        assert_eq!(stale_window_b["activeTabId"], tab_c, "{platform}");

        let current = core
            .invoke(CoreCommand::EmbeddedTabActivateConditional {
                tab_id: tab_a.clone(),
                window_id: window_b.clone(),
                selection_revision: 11,
            })
            .unwrap();
        let current_window_b = current["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["windowId"] == window_b)
            .unwrap();
        assert_eq!(current_window_b["activeTabId"], tab_a, "{platform}");
        core.shutdown();
    }
}

#[test]
fn runtime_projection_rejects_transient_invalid_role_membership() {
    let tab_id = uuid::Uuid::new_v4().to_string();
    let tab = GameWindowTabRecord {
        id: tab_id,
        tab_type: "role".to_owned(),
        source_id: "role-source".to_owned(),
        name: "Role".to_owned(),
        role_slots: ["role-source", "role-stale"]
            .into_iter()
            .enumerate()
            .map(|(index, role_id)| crate::model::GameWindowRoleSlotRecord {
                slot_id: format!("slot-{index}"),
                role_id: role_id.to_owned(),
                rect: full_window_rect(),
                browser_zoom_percent: None,
            })
            .collect(),
        hidden: false,
        audio_muted: false,
    };
    assert!(!runtime_game_window_tab_is_valid(&tab));
    assert!(runtime_game_window_tab_is_valid(&GameWindowTabRecord {
        role_slots: vec![crate::model::GameWindowRoleSlotRecord {
            slot_id: "slot-0".to_owned(),
            role_id: "role-source".to_owned(),
            rect: full_window_rect(),
            browser_zoom_percent: None,
        }],
        ..tab
    }));
}
