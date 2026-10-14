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

fn appkit_native_placement_event(
    window: &crate::RuntimeLiveWindowRecord,
    sequence: u64,
    presentation: &str,
) -> crate::model::AppKitRuntimeEventRecord {
    let mut observation = appkit_test_observation(&window.window_id, 1);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    observation.normal_bounds.x = 140;
    observation.normal_bounds.width = 1100;
    observation.presentation = presentation.to_owned();
    crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: sequence,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::WindowState {
            placement_sequence: sequence,
        },
    }
}

#[test]
fn appkit_native_placement_after_core_presentations_persists_before_close_and_restart() {
    for presentation in ["maximized", "fullscreen", "normal"] {
        let (directory, core) = core_for_runtime_contract("darwin", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("darwin", true),
        })
        .unwrap();
        let window_id = create_saved_window(&core, "Native AppKit placement");
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let tab_id = launch_saved_appkit_role(
            Arc::clone(&core),
            &role_id,
            &window_id,
            "Native AppKit placement",
        );
        for (index, mode) in ["fullscreen", "normal"].iter().enumerate() {
            let window = core.browser_runtime.snapshot().unwrap().windows[&window_id].clone();
            drive_command(
                Arc::clone(&core),
                runtime_window_presentation_command(
                    &format!("appkit-presentation-{index}"),
                    &window,
                    mode,
                ),
                None,
            )
            .0
            .unwrap();
        }
        let window = core.browser_runtime.snapshot().unwrap().windows[&window_id].clone();
        assert_eq!(window.placement_sequence, 0);
        let event = appkit_native_placement_event(&window, 1, presentation);
        let expected_placement = json!({
            "normalBounds": event.hosts[0].normal_bounds,
            "savedWorkArea": event.hosts[0].saved_work_area,
            "presentation": presentation,
        });
        let (result, _, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::BrowserAppKitRuntimeEvent {
                event: event.clone(),
            },
            |effect| effect_result(effect, None),
        );
        let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.status,
            crate::model::SystemRuntimeOperationStatus::Applied,
            "{presentation}: {receipt:?}"
        );
        assert!(receipt.native_applied);
        assert!(!receipt.topology_committed);
        let committed = core.browser_runtime.snapshot().unwrap().windows[&window_id].clone();
        assert_eq!(committed.placement_sequence, 1);
        let saved = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(saved["placement"], expected_placement);
        assert_eq!(saved["tabs"][0]["id"], tab_id);
        let request = RuntimeWindowStopRequestRecord {
            window_generation: committed.window_generation,
            topology_revision: committed.revision,
            ..test_window_stop_request(&window_id, committed.tab_ids())
        };
        drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserWindowStop { request },
            None,
        )
        .0
        .unwrap();
        core.shutdown();
        drop(core);
        let reopened = AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap();
        assert_eq!(
            reopened
                .invoke(CoreCommand::GameWindowGet { id: window_id })
                .unwrap(),
            saved
        );
        reopened.shutdown();
    }
}

#[test]
fn appkit_native_placement_failure_keeps_live_mode_and_unsaved_windows_remain_unsaved() {
    for saved in [true, false] {
        let (_directory, core) = core_for_runtime_contract("darwin", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("darwin", true),
        })
        .unwrap();
        let window = seed_windows_runtime_placement(&core, saved);
        let before = core
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")
            .unwrap();
        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_appkit_placement BEFORE INSERT ON game_windows
             BEGIN SELECT RAISE(ABORT, 'fixture rejects native AppKit placement'); END;",
            )
            .unwrap();
        let event = appkit_native_placement_event(&window, 1, "maximized");
        let (result, _, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::BrowserAppKitRuntimeEvent { event },
            |effect| effect_result(effect, None),
        );
        let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.status,
            if saved {
                crate::model::SystemRuntimeOperationStatus::Degraded
            } else {
                crate::model::SystemRuntimeOperationStatus::Applied
            },
            "saved={saved}: {receipt:?}"
        );
        assert!(receipt.native_applied);
        assert_eq!(receipt.failure_code.is_some(), saved);
        let committed = core.browser_runtime.snapshot().unwrap().windows[&window.window_id].clone();
        assert_eq!(
            committed.placement.as_ref().unwrap().presentation,
            "maximized"
        );
        assert_eq!(
            core.read_typed_state_collection::<StateGameWindowRecord>("gameWindows")
                .unwrap(),
            before
        );
        core.shutdown();
    }
}

#[test]
fn appkit_native_placement_persists_accepted_state_despite_projection_failure() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let window = seed_windows_runtime_placement(&core, true);
    let event = appkit_native_placement_event(&window, 1, "maximized");
    let (result, _, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        |effect| {
            if matches!(
                effect.action,
                CoreEffectAction::EmbeddedApplyAppKitProjection { .. }
            ) {
                CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(CoreErrorPayload {
                        code: "APPKIT_PLACEMENT_FOLLOWER_FAILED".to_owned(),
                        message: "Injected downstream AppKit projection failure.".to_owned(),
                    }),
                }
            } else {
                effect_result(effect, None)
            }
        },
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Failed
    );
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("APPKIT_PLACEMENT_FOLLOWER_FAILED")
    );
    assert!(!receipt.native_applied);
    let committed = core.browser_runtime.snapshot().unwrap().windows[&window.window_id].clone();
    let saved = core
        .invoke(CoreCommand::GameWindowGet {
            id: window.window_id,
        })
        .unwrap();
    assert_eq!(
        saved["placement"],
        serde_json::to_value(committed.placement.as_ref().unwrap()).unwrap()
    );
    assert_eq!(saved["placement"]["presentation"], "maximized");
    core.shutdown();
}
