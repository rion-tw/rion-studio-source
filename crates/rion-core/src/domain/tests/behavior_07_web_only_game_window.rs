use crate::GameWindowTabRecord;

fn runtime_game_window_input(
    name: &str,
    tabs: Vec<GameWindowTabRecord>,
) -> GameWindowSaveRuntimeInputRecord {
    let create = game_window_input(name);
    GameWindowSaveRuntimeInputRecord {
        window_id: Uuid::new_v4().to_string(),
        name: create.name,
        target_display: create.target_display,
        placement: create.placement,
        tabs,
        active_tab_id: None,
    }
}

fn game_window_tab(value: Value) -> GameWindowTabRecord {
    serde_json::from_value(value).unwrap()
}

#[test]
fn game_window_save_and_restore_preserve_web_only_and_legacy_role_subsets() {
    let web_tab = game_window_tab(json!({
        "id": Uuid::new_v4().to_string(),
        "tabType": "workspace",
        "sourceId": "web-workspace",
        "name": "Web Workspace",
        "roleSlots": [],
        "workspaceSlots": [{
            "id": "web-slot",
            "web": {
                "name": "Rion Docs",
                "startUrl": "https://example.test/docs"
            },
            "rect": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
        }],
        "hidden": false,
        "audioMuted": false
    }));
    let mut web_windows = Vec::new();
    let saved = save_runtime_game_window(
        &mut web_windows,
        runtime_game_window_input("Web Runtime", vec![web_tab]),
    )
    .unwrap();
    assert!(saved.tabs[0].role_slots.is_empty());
    assert_eq!(
        saved.tabs[0].workspace_slots[0]
            .web
            .as_ref()
            .unwrap()
            .start_url,
        "https://example.test/docs"
    );

    let restored: StateGameWindowRecord =
        serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
    validate_game_window_collection(&[restored]).unwrap();

    let legacy_workspace_tab = game_window_tab(json!({
        "id": Uuid::new_v4().to_string(),
        "tabType": "workspace",
        "sourceId": "legacy-workspace",
        "name": "Legacy Workspace",
        "roleIds": ["legacy-role"],
        "roleViews": [],
        "hidden": false,
        "audioMuted": false
    }));
    let mut legacy_windows = Vec::new();
    let legacy = save_runtime_game_window(
        &mut legacy_windows,
        runtime_game_window_input("Legacy Runtime", vec![legacy_workspace_tab]),
    )
    .unwrap();
    assert_eq!(legacy.tabs[0].role_slots.len(), 1);
    assert_eq!(legacy.tabs[0].role_slots[0].role_id, "legacy-role");
    assert!(legacy.tabs[0].workspace_slots.is_empty());
}

#[test]
fn game_window_validation_rejects_blank_workspaces_and_empty_role_tabs() {
    let blank_workspace_tab = game_window_tab(json!({
        "id": Uuid::new_v4().to_string(),
        "tabType": "workspace",
        "sourceId": "blank-workspace",
        "name": "Blank Workspace",
        "roleSlots": [],
        "workspaceSlots": [],
        "hidden": false,
        "audioMuted": false
    }));
    assert_eq!(
        save_runtime_game_window(
            &mut Vec::new(),
            runtime_game_window_input("Blank Runtime", vec![blank_workspace_tab]),
        )
        .unwrap_err()
        .code(),
        "GAME_WINDOW_TAB_INVALID"
    );

    let empty_role_tab = game_window_tab(json!({
        "id": Uuid::new_v4().to_string(),
        "tabType": "role",
        "sourceId": "role-source",
        "name": "Role Source",
        "roleSlots": [],
        "workspaceSlots": [],
        "hidden": false,
        "audioMuted": false
    }));
    assert_eq!(
        save_runtime_game_window(
            &mut Vec::new(),
            runtime_game_window_input("Invalid Role Runtime", vec![empty_role_tab]),
        )
        .unwrap_err()
        .code(),
        "GAME_WINDOW_TAB_INVALID"
    );
}
