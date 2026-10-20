#[test]
fn a_web_only_workspace_tab_survives_portable_import() {
    let mut source = fixture_value(23);
    source["launchWorkspaces"][0]["template"] = json!("single");
    source["launchWorkspaces"][0]["slots"] = json!([
        {
            "id":"slot-web",
            "web":{"lastUrl":"https://example.test/web"},
            "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
        }
    ]);
    source["gameWindows"] = json!([{
        "id":uuid::Uuid::new_v4().to_string(),
        "name":"Web window",
        "targetDisplay":{"id":0},
        "placement":{
            "normalBounds":{"x":0,"y":0,"width":1280,"height":720},
            "savedWorkArea":{"x":0,"y":0,"width":1920,"height":1080},
            "presentation":"normal"
        },
        "tabs":[{
            "id":uuid::Uuid::new_v4().to_string(),
            "tabType":"workspace",
            "sourceId":"w1",
            "name":"Web workspace",
            "roleSlots":[],
            "workspaceSlots":[{
                "id":"slot-web",
                "web":{"lastUrl":"https://example.test/web"},
                "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
            }],
            "hidden":false,
            "audioMuted":false
        }]
    }]);
    let mut runtime = PortableRuntime::default();
    let preview = runtime
        .preview(&source.to_string(), "web-only.json".to_owned(), empty_snapshot())
        .unwrap();
    let prepared = runtime
        .prepare_apply(&preview.import_id, all_selection(), Vec::new(), empty_snapshot())
        .unwrap();
    assert_eq!(prepared.snapshot.game_windows.len(), 1);
    assert_eq!(prepared.snapshot.game_windows[0].tabs.len(), 1);
    assert!(prepared.snapshot.game_windows[0].tabs[0].workspace_slots[0].web.is_some());
    let warnings = serde_json::to_value(&prepared.result).unwrap()["warnings"].clone();
    assert!(!warnings.to_string().contains("GAME_WINDOW_TAB_ROLE_CONFLICT"), "{warnings}");
}
