fn windows_held_continuity_core() -> (tempfile::TempDir, Arc<AppCore>, u64) {
    let (directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    for (role_id, tab_id) in [
        ("held-role", "00000000-0000-4000-8000-000000000041"),
        ("foreground-role", "00000000-0000-4000-8000-000000000042"),
    ] {
        core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            tab_id: Some(tab_id.to_owned()),
            source_id: role_id.to_owned(),
            name: role_id.to_owned(),
            tab_type: "role".to_owned(),
            workspace_id: None,
            audio_muted: false,
            attempt_generation: Some(format!("{role_id}-attempt")),
            window_id: "held-window".to_owned(),
            role_slots: test_role_slots(&[role_id]),
            web_surfaces: Vec::new(),
        })
        .unwrap();
        for state in ["launching", "running"] {
            core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.to_owned(),
                runtime: "embedded".to_owned(),
                tab_id: tab_id.to_owned(),
                slot_id: None,
                state: state.to_owned(),
                launched_at: (state == "running").then(|| chrono::Utc::now().to_rfc3339()),
            })
            .unwrap();
        }
    }
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: "00000000-0000-4000-8000-000000000043".to_owned(),
            source: "command".to_owned(),
            primary_window_id: "held-window".to_owned(),
            windows: vec![crate::RuntimeWindowTopologyCommit {
                active_tab_id: Some("00000000-0000-4000-8000-000000000042".to_owned()),
                hidden_tab_ids: std::collections::HashSet::from([
                    "00000000-0000-4000-8000-000000000041".to_owned(),
                ]),
                tabs: vec![
                    runtime_ui_test_tab(
                        "00000000-0000-4000-8000-000000000041",
                        "held-role",
                    ),
                    runtime_ui_test_tab(
                        "00000000-0000-4000-8000-000000000042",
                        "foreground-role",
                    ),
                ],
                ui_sequence: 1,
                window_generation: 1,
                window_id: "held-window".to_owned(),
            }],
        },
    ))
    .unwrap();
    let owner_generation = core
        .browser_runtime
        .snapshot()
        .unwrap()
        .browser_runtime
        .roles
        .iter()
        .find(|role| role.role_id == "held-role")
        .unwrap()
        .owner
        .generation;
    (directory, core, owner_generation)
}

fn windows_held_continuity_input(
    owner_generation: u64,
) -> WindowsChromiumHeldKeyContinuityInput {
    WindowsChromiumHeldKeyContinuityInput {
        operation_id: "continuity-core-1".to_owned(),
        role_id: "held-role".to_owned(),
        tab_id: "00000000-0000-4000-8000-000000000041".to_owned(),
        expected_owner_generation: owner_generation,
        surface_generation: 3,
        document_instance_id: "document-held-role".to_owned(),
        loss_reason: "hidden".to_owned(),
        loss_revision: 1,
    }
}

#[test]
fn windows_hidden_role_continuity_requires_exact_core_topology_and_capability() {
    let (_directory, core, owner_generation) = windows_held_continuity_core();
    let receipt = core
        .restore_windows_chromium_held_keys_internal(windows_held_continuity_input(
            owner_generation,
        ))
        .unwrap();
    assert_eq!(receipt.status, "noHeldKeys");
    assert_eq!(receipt.role_id, "held-role");
    assert_eq!(receipt.expected_owner_generation, owner_generation);
    assert_eq!(receipt.surface_generation, 3);
    assert!(receipt.request_ids.is_empty());

    let mut stale = windows_held_continuity_input(owner_generation + 1);
    stale.operation_id = "continuity-core-stale".to_owned();
    stale.loss_revision = 2;
    let stale = core
        .restore_windows_chromium_held_keys_internal(stale)
        .unwrap();
    assert_eq!(stale.status, "superseded");
    core.shutdown();
}

#[test]
fn appkit_chromium_never_enters_the_windows_continuity_boundary() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let error = core
        .restore_windows_chromium_held_keys_internal(windows_held_continuity_input(1))
        .unwrap_err();
    assert_eq!(error.code(), "WINDOWS_CHROMIUM_BACKGROUND_INPUT_UNAVAILABLE");
    core.shutdown();
}
