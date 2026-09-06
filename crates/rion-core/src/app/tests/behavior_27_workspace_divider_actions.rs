fn create_mixed_divider_workspace(core: &AppCore, role_id: &str) -> String {
    core.invoke(command(json!({
        "type": "workspaceCreate",
        "input": {
            "name": "Divider mixed workspace",
            "template": "two_columns",
            "slots": [
                {
                    "id": "web-left",
                    "web": {
                        "name": "Fixture Web",
                        "startUrl": "https://fixture.example.test/workspace"
                    },
                    "rect": {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
                },
                {
                    "id": "role-right",
                    "roleId": role_id,
                    "browserZoomPercent": 100,
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

fn launch_divider_workspace(
    core: Arc<AppCore>,
    workspace_id: &str,
    window_id: &str,
) -> (String, String, u64) {
    let (result, actions) = drive_command(
        Arc::clone(&core),
        web_workspace_launch(workspace_id, window_id),
        None,
    );
    result.unwrap();
    let tab = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.as_ref().clone()),
            _ => None,
        })
        .unwrap();
    let runtime = core.browser_runtime.snapshot().unwrap();
    let window = runtime.windows.get(window_id).unwrap();
    assert!(window.contains_tab(&tab.tab_id));
    (
        tab.tab_id,
        tab.attempt_generation.unwrap(),
        window.window_generation,
    )
}

struct DividerGesture<'a> {
    window_id: &'a str,
    tab_id: &'a str,
    attempt_generation: &'a str,
    gesture_id: &'a str,
    host_generation: u64,
    window_generation: u64,
}

impl DividerGesture<'_> {
    fn event(
        &self,
        pointer_sequence: u64,
        phase: crate::model::BrowserWorkspaceDividerPointerPhase,
        topology_revision: u64,
        requested_position: Option<f64>,
    ) -> crate::model::BrowserWorkspaceDividerPointerRecord {
        crate::model::BrowserWorkspaceDividerPointerRecord {
            event_id: uuid::Uuid::new_v4().to_string(),
            gesture_id: self.gesture_id.to_owned(),
            pointer_sequence,
            phase,
            platform: crate::model::BrowserWorkspaceDividerPlatform::Windows,
            host_identity: crate::model::BrowserWorkspaceDividerHostIdentityRecord::Windows {
                native_host_id: 41,
                host_generation: self.host_generation,
            },
            appkit_host: None,
            appkit_adapter_sequence: None,
            window_id: self.window_id.to_owned(),
            tab_id: self.tab_id.to_owned(),
            attempt_generation: self.attempt_generation.to_owned(),
            window_generation: self.window_generation,
            topology_revision,
            divider_index: 0,
            requested_position,
        }
    }
}

fn drive_divider(
    core: Arc<AppCore>,
    event: crate::model::BrowserWorkspaceDividerPointerRecord,
) -> crate::model::BrowserWorkspaceDividerPointerReceiptRecord {
    let (result, _, _) = drive_async_command(
        core,
        CoreCommand::BrowserWorkspaceDividerPointer { event },
        None,
    );
    serde_json::from_value(result.unwrap()).unwrap()
}

#[test]
fn workspace_divider_moves_are_fenced_event_bound_and_only_end_commits_durability() {
    let (directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = create_mixed_divider_workspace(&core, &role_id);
    let window_id = create_saved_window(&core, "Divider persistence window");
    let (tab_id, attempt_generation, window_generation) = launch_divider_workspace(
        Arc::clone(&core),
        &workspace_id,
        &window_id,
    );
    let initial = core.browser_runtime.snapshot().unwrap();
    let initial_window = initial.windows.get(&window_id).unwrap();
    let initial_revision = initial_window.revision;
    let initial_slots = initial_window.tabs[0].workspace_slots.clone();
    let gesture_id = uuid::Uuid::new_v4().to_string();
    let gesture = DividerGesture {
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &gesture_id,
        host_generation: 1,
        window_generation,
    };

    let start_event = gesture.event(
        1,
        crate::model::BrowserWorkspaceDividerPointerPhase::Start,
        initial_revision,
        None,
    );
    let start_command = CoreCommand::BrowserWorkspaceDividerPointer {
        event: start_event.clone(),
    };
    let start = drive_divider(Arc::clone(&core), start_event);
    assert_eq!(start.status, crate::model::SystemRuntimeOperationStatus::Applied);
    assert!(!start.changed);
    assert!(!start.durable);
    let (duplicate, duplicate_effects, _) =
        drive_async_command(Arc::clone(&core), start_command, None);
    let duplicate: crate::model::BrowserWorkspaceDividerPointerReceiptRecord =
        serde_json::from_value(duplicate.unwrap()).unwrap();
    assert_eq!(duplicate.event_id, start.event_id);
    assert!(duplicate_effects.is_empty());

    let moved = drive_divider(
        Arc::clone(&core),
        gesture.event(
            2,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            start.topology_revision,
            Some(0.7),
        ),
    );
    assert_eq!(moved.status, crate::model::SystemRuntimeOperationStatus::Applied);
    assert!(moved.changed);
    assert!(!moved.durable);
    assert!(moved.topology_revision > start.topology_revision);
    assert_ne!(moved.workspace_slots, initial_slots);

    let unchanged = drive_divider(
        Arc::clone(&core),
        gesture.event(
            3,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            moved.topology_revision,
            moved.position,
        ),
    );
    assert_eq!(unchanged.status, crate::model::SystemRuntimeOperationStatus::Applied);
    assert!(!unchanged.changed);
    assert_eq!(unchanged.topology_revision, moved.topology_revision);

    let moved_again = drive_divider(
        Arc::clone(&core),
        gesture.event(
            4,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            unchanged.topology_revision,
            Some(0.62),
        ),
    );
    assert!(moved_again.changed);
    core.runtime_window_persistence_revisions
        .lock()
        .unwrap()
        .insert(
            window_id.clone(),
            (window_generation.saturating_add(1), u64::MAX),
        );
    let ended = drive_divider(
        Arc::clone(&core),
        gesture.event(
            5,
            crate::model::BrowserWorkspaceDividerPointerPhase::End,
            moved_again.topology_revision,
            None,
        ),
    );
    assert_eq!(ended.status, crate::model::SystemRuntimeOperationStatus::Applied);
    assert!(ended.durable);

    let saved = core
        .invoke(CoreCommand::GameWindowGet { id: window_id.clone() })
        .unwrap();
    let saved: crate::model::StateGameWindowRecord = serde_json::from_value(saved).unwrap();
    let saved_tab = saved.tabs.iter().find(|tab| tab.id == tab_id).unwrap();
    assert_eq!(saved_tab.workspace_slots, ended.workspace_slots);
    core.shutdown();

    let restarted = Arc::new(AppCore::create(AppCoreOptions {
        app_version: "2.1.0-test".to_owned(),
        build_commit: None,
        packaged: false,
        platform: "win32".to_owned(),
        runtime_contract_version: Some(23),
        user_data_dir: directory.path().to_string_lossy().into_owned(),
    })
    .unwrap());
    let restored = restarted
        .invoke(CoreCommand::GameWindowGet {
            id: window_id.clone(),
        })
        .unwrap();
    let restored: crate::model::StateGameWindowRecord = serde_json::from_value(restored).unwrap();
    assert_eq!(restored.tabs[0].workspace_slots, ended.workspace_slots);
    restarted
        .invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("win32", true),
        })
        .unwrap();
    let restored_tab = restored.tabs[0].clone();
    drive_accepted_launch_to_completion(
        Arc::clone(&restarted),
        CoreCommand::BrowserWorkspaceLaunch {
            launch_tab_id: Some(restored_tab.id.clone()),
            workspace_id: workspace_id.clone(),
            target: EmbeddedLaunchTargetRecord {
                window_id: window_id.clone(),
                persisted_name: Some(restored.name.clone()),
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
            restore_role_slots: Some(restored_tab.role_slots.clone()),
        },
    );
    let live = restarted.browser_runtime.snapshot().unwrap();
    let live_tab = live.windows[&window_id]
        .tabs
        .iter()
        .find(|tab| tab.id == restored_tab.id)
        .unwrap();
    assert_eq!(live_tab.workspace_slots, ended.workspace_slots);
    restarted.shutdown();
}

#[test]
fn workspace_divider_cancel_and_host_replacement_terminalize_without_implicit_persistence() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = create_mixed_divider_workspace(&core, &role_id);
    let window_id = create_saved_window(&core, "Divider cancellation window");
    let (tab_id, attempt_generation, window_generation) = launch_divider_workspace(
        Arc::clone(&core),
        &workspace_id,
        &window_id,
    );
    let revision = core
        .browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .get(&window_id)
        .unwrap()
        .revision;
    let first_gesture = uuid::Uuid::new_v4().to_string();
    let gesture = DividerGesture {
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &first_gesture,
        host_generation: 1,
        window_generation,
    };
    let started = drive_divider(
        Arc::clone(&core),
        gesture.event(
            1,
            crate::model::BrowserWorkspaceDividerPointerPhase::Start,
            revision,
            None,
        ),
    );
    let moved = drive_divider(
        Arc::clone(&core),
        gesture.event(
            2,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            started.topology_revision,
            Some(0.66),
        ),
    );
    let cancelled = drive_divider(
        Arc::clone(&core),
        gesture.event(
            3,
            crate::model::BrowserWorkspaceDividerPointerPhase::Cancel,
            moved.topology_revision,
            None,
        ),
    );
    assert_eq!(
        cancelled.status,
        crate::model::SystemRuntimeOperationStatus::Cancelled
    );
    assert!(!cancelled.durable);

    let replacement_gesture = uuid::Uuid::new_v4().to_string();
    let replacement_gesture = DividerGesture {
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &replacement_gesture,
        host_generation: 2,
        window_generation,
    };
    let replacement = drive_divider(
        Arc::clone(&core),
        replacement_gesture.event(
            1,
            crate::model::BrowserWorkspaceDividerPointerPhase::Start,
            cancelled.topology_revision,
            None,
        ),
    );
    assert_eq!(replacement.status, crate::model::SystemRuntimeOperationStatus::Applied);
    let replacement_cancel = drive_divider(
        Arc::clone(&core),
        replacement_gesture.event(
            2,
            crate::model::BrowserWorkspaceDividerPointerPhase::Cancel,
            replacement.topology_revision,
            None,
        ),
    );
    assert_eq!(
        replacement_cancel.status,
        crate::model::SystemRuntimeOperationStatus::Cancelled
    );

    // Cancellation performs no durability write. A later independent saved
    // window snapshot is nevertheless allowed to persist current Core truth.
    core.persist_runtime_ui_windows(std::slice::from_ref(&window_id))
        .unwrap();
    let saved = core
        .invoke(CoreCommand::GameWindowGet { id: window_id })
        .unwrap();
    let saved: crate::model::StateGameWindowRecord = serde_json::from_value(saved).unwrap();
    assert_eq!(saved.tabs[0].workspace_slots, replacement_cancel.workspace_slots);
    core.shutdown();
}
