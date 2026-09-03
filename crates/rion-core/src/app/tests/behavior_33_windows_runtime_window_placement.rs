fn windows_runtime_placement_event(
    window: &crate::RuntimeLiveWindowRecord,
    event_id: &str,
    adapter_sequence: u64,
    x: i32,
) -> crate::model::WindowsRuntimeWindowPlacementEventRecord {
    crate::model::WindowsRuntimeWindowPlacementEventRecord {
        event_id: event_id.to_owned(),
        adapter_sequence,
        native_host_id: 91,
        native_generation: 4,
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        topology_revision: window.revision,
        target_display: crate::model::DisplayTargetRecord {
            id: 1,
            fingerprint: Some(crate::model::DisplayFingerprintRecord {
                label: "Test Display".to_owned(),
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1440,
                    height: 900,
                },
                resolution: crate::model::StateResolutionRecord {
                    width: 2560,
                    height: 1600,
                },
                scale_factor: 2.0,
                is_primary: true,
                is_internal: false,
            }),
        },
        placement: crate::model::GameWindowPlacementRecord {
            normal_bounds: StatePixelBoundsRecord {
                x,
                y: 80,
                width: 820,
                height: 620,
            },
            saved_work_area: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 1440,
                height: 900,
            },
            presentation: "normal".to_owned(),
        },
    }
}

fn seed_saved_windows_runtime_placement(
    core: &Arc<AppCore>,
) -> crate::RuntimeLiveWindowRecord {
    let window_id = create_saved_window(core, "Windows placement receipt");
    let tab_id = "00000000-0000-4000-8000-000000000334";
    let role_id = "windows-placement-role";
    let mut tab = runtime_ui_test_tab(tab_id, role_id);
    tab.role_ids = vec![role_id.to_owned()];
    tab.role_slots = vec![crate::model::GameWindowRoleSlotRecord {
        slot_id: "windows-placement-slot".to_owned(),
        role_id: role_id.to_owned(),
        rect: crate::model::StateNormalizedRectRecord {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
        browser_zoom_percent: Some(100.0),
    }];
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: "windows-placement-seed".to_owned(),
            source: "command".to_owned(),
            primary_window_id: window_id.clone(),
            windows: vec![crate::RuntimeWindowTopologyCommit {
                active_tab_id: Some(tab_id.to_owned()),
                hidden_tab_ids: std::collections::HashSet::new(),
                tabs: vec![tab],
                ui_sequence: 1,
                window_generation: 3,
                window_id: window_id.clone(),
            }],
        },
    ))
    .unwrap();
    core.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
        crate::RuntimeWindowContextInitializeInput {
            operation_id: "windows-placement-context".to_owned(),
            persisted_name: Some("Windows placement receipt".to_owned()),
            placement: crate::model::GameWindowPlacementRecord {
                normal_bounds: StatePixelBoundsRecord {
                    x: 40,
                    y: 60,
                    width: 960,
                    height: 680,
                },
                saved_work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1440,
                    height: 900,
                },
                presentation: "normal".to_owned(),
            },
            target_display: crate::model::DisplayTargetRecord {
                id: 1,
                fingerprint: None,
            },
            window_generation: 3,
            window_id: window_id.clone(),
        },
    ))
    .unwrap();
    core.browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .get(&window_id)
        .unwrap()
        .clone()
}

#[test]
fn windows_native_placement_commits_core_projects_and_persists_exact_revision() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_saved_windows_runtime_placement(&core);
    let event = windows_runtime_placement_event(
        &window,
        "00000000-0000-4000-8000-000000000331",
        1,
        180,
    );
    let (result, actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::BrowserWindowsRuntimeWindowPlacement {
            event: event.clone(),
        },
        None,
    );
    let receipt: crate::model::WindowsRuntimeWindowPlacementReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.event_id, event.event_id);
    assert_eq!(receipt.native_host_id, event.native_host_id);
    assert_eq!(receipt.native_generation, event.native_generation);
    assert_eq!(receipt.source_topology_revision, event.topology_revision);
    assert!(receipt.topology_revision > event.topology_revision);
    assert_eq!(receipt.status, "applied", "{receipt:?}");
    assert_eq!(receipt.persistence_status, "applied", "{receipt:?}");
    assert!(receipt.core_projection_applied);
    assert!(receipt.failure_code.is_none());
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. }
            if windows.iter().any(|projection| {
                projection.window_id == event.window_id
                    && projection.topology_revision == receipt.topology_revision
            })
    )));
    let saved = core
        .invoke(CoreCommand::GameWindowGet {
            id: event.window_id.clone(),
        })
        .unwrap();
    assert_eq!(saved["placement"]["normalBounds"]["x"], 180);
    assert_eq!(saved["targetDisplay"]["fingerprint"]["label"], "Test Display");
    assert_eq!(
        saved["tabs"][0]["id"],
        "00000000-0000-4000-8000-000000000334"
    );
    core.shutdown();
}

#[test]
fn windows_native_placement_rejects_stale_core_fence_without_persistence_or_projection() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_saved_windows_runtime_placement(&core);
    let mut event = windows_runtime_placement_event(
        &window,
        "00000000-0000-4000-8000-000000000332",
        1,
        220,
    );
    event.topology_revision = event.topology_revision.saturating_sub(1);
    let receipt: crate::model::WindowsRuntimeWindowPlacementReceiptRecord =
        serde_json::from_value(
            core.invoke(CoreCommand::BrowserWindowsRuntimeWindowPlacement { event })
                .unwrap(),
        )
        .unwrap();
    assert_eq!(receipt.status, "superseded");
    assert_eq!(receipt.persistence_status, "superseded");
    assert!(!receipt.core_projection_applied);
    let saved = core
        .invoke(CoreCommand::GameWindowGet {
            id: window.window_id.clone(),
        })
        .unwrap();
    assert_eq!(saved["placement"]["normalBounds"]["x"], 0);
    core.shutdown();
}

#[test]
fn windows_native_placement_never_reports_applied_when_projection_fails() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let window = seed_saved_windows_runtime_placement(&core);
    let event = windows_runtime_placement_event(
        &window,
        "00000000-0000-4000-8000-000000000333",
        1,
        260,
    );
    let (result, _) = drive_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserWindowsRuntimeWindowPlacement { event },
        |effect| {
            let mut result = effect_result(effect, None);
            result.ok = false;
            result.error = Some(CoreErrorPayload {
                code: "WINDOWS_PLACEMENT_PROJECTION_FAILED".to_owned(),
                message: "Injected projection failure.".to_owned(),
            });
            result
        },
    );
    let receipt: crate::model::WindowsRuntimeWindowPlacementReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, "indeterminate");
    assert_eq!(receipt.persistence_status, "applied", "{receipt:?}");
    assert!(!receipt.core_projection_applied);
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("WINDOWS_PLACEMENT_PROJECTION_FAILED")
    );
    core.shutdown();
}
