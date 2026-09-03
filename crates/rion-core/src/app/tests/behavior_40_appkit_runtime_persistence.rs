fn launch_saved_appkit_role(
    core: Arc<AppCore>,
    role_id: &str,
    window_id: &str,
    persisted_name: &str,
) -> String {
    let (result, actions) = drive_command(
        core,
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "windowId": window_id,
                "persistedName": persisted_name,
                "displayId": 1,
                "scaleFactor": 1.0,
                "workArea": {"x": 0, "y": 0, "width": 1440, "height": 900},
                "bounds": {"x": 0, "y": 0, "width": 960, "height": 640},
                "presentation": "normal"
            }
        })),
        None,
    );
    result.unwrap();
    actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        })
        .expect("saved AppKit launch must create one Chromium tab")
}

fn persisted_game_window_tab_ids(directory: &TempDir, window_id: &str) -> Vec<String> {
    let connection =
        rusqlite::Connection::open(directory.path().join("rion-studio.sqlite3")).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT payload_json FROM game_windows WHERE id = ?1",
            [window_id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str::<Value>(&payload).unwrap()["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tab| tab["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn appkit_drag_drop_persists_the_exact_saved_window_order_before_receipt() {
    let (directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let game_id = first_game_id(&core);
    let role_ids = [
        create_role(&core, &game_id, 1),
        create_role(&core, &game_id, 2),
    ];
    let window_name = "Durable AppKit drag";
    let window_id = create_saved_window(&core, window_name);
    let tab_ids = role_ids
        .iter()
        .map(|role_id| {
            launch_saved_appkit_role(
                Arc::clone(&core),
                role_id,
                &window_id,
                window_name,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(persisted_game_window_tab_ids(&directory, &window_id), tab_ids);

    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get(&window_id).unwrap();
    let mut observation = appkit_test_observation(&window_id, 1);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    let expected = vec![tab_ids[1].clone(), tab_ids[0].clone()];
    let event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::Move {
            session_id: uuid::Uuid::new_v4().to_string(),
            tab_id: tab_ids[1].clone(),
            source_window_id: window_id.clone(),
            target_window_id: window_id.clone(),
            before_tab_id: Some(tab_ids[0].clone()),
            ordered_tab_ids: expected.clone(),
            phase: "drop".to_owned(),
        },
    };
    let (result, _, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        |effect| effect_result(effect, None),
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();

    assert_eq!(receipt.status, crate::model::SystemRuntimeOperationStatus::Applied);
    assert!(receipt.topology_committed);
    assert!(receipt.native_applied);
    assert_eq!(persisted_game_window_tab_ids(&directory, &window_id), expected);
    core.shutdown();
}
