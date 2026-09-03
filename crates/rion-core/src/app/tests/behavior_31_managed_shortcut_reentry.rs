const SHORTCUT_TAB_ID: &str = "00000000-0000-4000-8000-000000000031";

fn managed_shortcut_core() -> (tempfile::TempDir, Arc<AppCore>) {
    let (directory, core) = core();
    core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
        tab_id: Some(SHORTCUT_TAB_ID.to_owned()),
        source_id: "role-shortcut".to_owned(),
        name: "Shortcut role".to_owned(),
        tab_type: "role".to_owned(),
        workspace_id: None,
        audio_muted: false,
        attempt_generation: Some("shortcut-attempt".to_owned()),
        window_id: "window-shortcut".to_owned(),
        role_slots: test_role_slots(&["role-shortcut"]),
        web_surfaces: Vec::new(),
    })
    .unwrap();
    for state in ["launching", "running"] {
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: "role-shortcut".to_owned(),
            runtime: "embedded".to_owned(),
            tab_id: SHORTCUT_TAB_ID.to_owned(),
            slot_id: None,
            state: state.to_owned(),
            launched_at: (state == "running").then(|| chrono::Utc::now().to_rfc3339()),
        })
        .unwrap();
    }
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: "00000000-0000-4000-8000-000000000032".to_owned(),
            source: "command".to_owned(),
            primary_window_id: "window-shortcut".to_owned(),
            windows: vec![crate::RuntimeWindowTopologyCommit {
                active_tab_id: Some(SHORTCUT_TAB_ID.to_owned()),
                hidden_tab_ids: std::collections::HashSet::new(),
                tabs: vec![crate::RuntimeLiveTabRecord {
                    audio_muted: false,
                    closable: true,
                    icon_data_url: None,
                    id: SHORTCUT_TAB_ID.to_owned(),
                    persistable: true,
                    role_ids: vec!["role-shortcut".to_owned()],
                    role_slots: Vec::new(),
                    workspace_slots: Vec::new(),
                    source_id: "role-shortcut".to_owned(),
                    tab_type: "role".to_owned(),
                    title: "Shortcut role".to_owned(),
                    workspace_template: None,
                }],
                ui_sequence: 1,
                window_generation: 1,
                window_id: "window-shortcut".to_owned(),
            }],
        },
    ))
    .unwrap();
    let owner_generation = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .roles
        .into_iter()
        .find(|role| role.role_id == "role-shortcut")
        .unwrap()
        .owner
        .generation;
    assert_eq!(owner_generation, 1);
    (directory, core)
}

fn managed_shortcut_command(
    operation_id: &str,
    press_id: &str,
    phase: &str,
) -> CoreCommand {
    managed_shortcut_command_for(
        operation_id,
        press_id,
        phase,
        "macro-shortcut",
        "Digit2",
        "document-shortcut",
    )
}

fn managed_shortcut_command_for(
    operation_id: &str,
    press_id: &str,
    phase: &str,
    macro_id: &str,
    code: &str,
    document_instance_id: &str,
) -> CoreCommand {
    command(json!({
        "type": "managedShortcutPhase",
        "operationId": operation_id,
        "roleId": "role-shortcut",
        "tabId": SHORTCUT_TAB_ID,
        "surfaceGeneration": 7,
        "documentInstanceId": document_instance_id,
        "expectedOwnerGeneration": 1,
        "pressId": press_id,
        "macroId": macro_id,
        "code": code,
        "phase": phase,
        "modifierCodes": ["ShiftLeft"],
    }))
}

#[test]
fn managed_shortcut_reentry_is_blocked_until_the_exact_physical_press_releases() {
    let (_directory, core) = managed_shortcut_core();

    let (down, down_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-down-1", "press-1", "keyDown"),
        None,
    );
    let down = down.unwrap();
    assert_eq!(down["status"], json!("accepted"));
    assert_eq!(down_actions.len(), 1);
    assert!(matches!(
        &down_actions[0],
        CoreEffectAction::BrowserAction { request }
            if request.surface_generation == Some(7) &&
                request.document_instance_id.as_deref() == Some("document-shortcut") &&
                matches!(&request.action, crate::model::BrowserAction::Key {
                phase,
                code: Some(code),
                suppress_overlay_shortcut: true,
                ..
            } if phase == "hold" && code == "Digit2")
    ));

    let (duplicate, duplicate_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-down-duplicate", "press-1", "keyDown"),
        None,
    );
    assert_eq!(duplicate.unwrap()["status"], json!("duplicate"));
    assert!(duplicate_actions.is_empty());

    let (reentry, reentry_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-down-reentry", "press-2", "keyDown"),
        None,
    );
    assert_eq!(reentry.unwrap()["status"], json!("superseded"));
    assert!(reentry_actions.is_empty());

    let (released, release_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-up-1", "press-1", "keyUp"),
        None,
    );
    assert_eq!(released.unwrap()["status"], json!("accepted"));
    assert_eq!(release_actions.len(), 1);
    assert!(matches!(
        &release_actions[0],
        CoreEffectAction::BrowserAction { request }
            if matches!(&request.action, crate::model::BrowserAction::Key {
                phase,
                ..
            } if phase == "release")
    ));

    let (next, next_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-down-2", "press-2", "keyDown"),
        None,
    );
    assert_eq!(next.unwrap()["status"], json!("accepted"));
    assert_eq!(next_actions.len(), 1);
}

#[test]
fn managed_shortcut_exact_key_up_remains_admitted_after_tab_blur() {
    let (_directory, core) = managed_shortcut_core();
    let (down, down_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-blur-down", "press-blur", "keyDown"),
        None,
    );
    assert_eq!(down.unwrap()["status"], json!("accepted"));
    assert_eq!(down_actions.len(), 1);

    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: "00000000-0000-4000-8000-000000000033".to_owned(),
            source: "command".to_owned(),
            primary_window_id: "window-shortcut".to_owned(),
            windows: vec![crate::RuntimeWindowTopologyCommit {
                active_tab_id: Some("tab-other".to_owned()),
                hidden_tab_ids: std::collections::HashSet::new(),
                tabs: vec![
                    crate::RuntimeLiveTabRecord {
                        audio_muted: false,
                        closable: true,
                        icon_data_url: None,
                        id: SHORTCUT_TAB_ID.to_owned(),
                        persistable: true,
                        role_ids: vec!["role-shortcut".to_owned()],
                        role_slots: Vec::new(),
                        workspace_slots: Vec::new(),
                        source_id: "role-shortcut".to_owned(),
                        tab_type: "role".to_owned(),
                        title: "Shortcut role".to_owned(),
                        workspace_template: None,
                    },
                    crate::RuntimeLiveTabRecord {
                        audio_muted: false,
                        closable: true,
                        icon_data_url: None,
                        id: "tab-other".to_owned(),
                        persistable: true,
                        role_ids: Vec::new(),
                        role_slots: Vec::new(),
                        workspace_slots: Vec::new(),
                        source_id: "other".to_owned(),
                        tab_type: "role".to_owned(),
                        title: "Other".to_owned(),
                        workspace_template: None,
                    },
                ],
                ui_sequence: 2,
                window_generation: 1,
                window_id: "window-shortcut".to_owned(),
            }],
        },
    ))
    .unwrap();

    let (new_down, new_down_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command_for(
            "shortcut-inactive-down",
            "press-inactive",
            "keyDown",
            "macro-inactive",
            "Digit3",
            "document-shortcut",
        ),
        None,
    );
    assert_eq!(new_down.unwrap()["status"], json!("superseded"));
    assert!(new_down_actions.is_empty());

    let (released, release_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-blur-up", "press-blur", "keyUp"),
        None,
    );
    assert_eq!(released.unwrap()["status"], json!("accepted"));
    assert_eq!(release_actions.len(), 1);
    assert!(matches!(
        &release_actions[0],
        CoreEffectAction::BrowserAction { request }
            if matches!(&request.action, crate::model::BrowserAction::Key {
                phase,
                ..
            } if phase == "release")
    ));
}

#[test]
fn managed_shortcut_distinct_keys_have_independent_active_presses() {
    let (_directory, core) = managed_shortcut_core();
    let (first, first_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command_for(
            "shortcut-a-down",
            "press-a",
            "keyDown",
            "macro-a",
            "Digit2",
            "document-shortcut",
        ),
        None,
    );
    assert_eq!(first.unwrap()["status"], json!("accepted"));
    assert_eq!(first_actions.len(), 1);

    let (second, second_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command_for(
            "shortcut-b-down",
            "press-b",
            "keyDown",
            "macro-b",
            "Digit3",
            "document-shortcut",
        ),
        None,
    );
    assert_eq!(second.unwrap()["status"], json!("accepted"));
    assert_eq!(second_actions.len(), 1);
}

#[test]
fn managed_shortcut_authoritative_surface_retirement_releases_the_old_press() {
    let (_directory, core) = managed_shortcut_core();
    let (down, _) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-old-down", "press-old", "keyDown"),
        None,
    );
    assert_eq!(down.unwrap()["status"], json!("accepted"));

    let retirement_command = || command(json!({
        "type": "managedShortcutSurfaceRetire",
        "roleId": "role-shortcut",
        "surfaceGeneration": 7,
        "documentInstanceId": "document-shortcut",
    }));
    let (retired, cleanup_actions) = drive_command(
        Arc::clone(&core),
        retirement_command(),
        None,
    );
    let retired = retired.unwrap();
    assert_eq!(retired["terminal"], json!(true));
    assert_eq!(retired["retiredPressIds"], json!(["press-old"]));
    assert_eq!(cleanup_actions.len(), 1);
    assert!(matches!(
        &cleanup_actions[0],
        CoreEffectAction::BrowserAction { request }
            if request.intent == "cleanup" &&
                request.surface_generation == Some(7) &&
                request.document_instance_id.as_deref() == Some("document-shortcut") &&
                matches!(&request.action, crate::model::BrowserAction::Key {
                    phase,
                    ..
                } if phase == "release")
    ));

    let (fresh, fresh_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command_for(
            "shortcut-new-down",
            "press-new",
            "keyDown",
            "macro-shortcut",
            "Digit2",
            "document-replacement",
        ),
        None,
    );
    assert_eq!(fresh.unwrap()["status"], json!("accepted"));
    assert_eq!(fresh_actions.len(), 1);
    assert!(matches!(
        &fresh_actions[0],
        CoreEffectAction::BrowserAction { request }
            if request.document_instance_id.as_deref() == Some("document-replacement")
    ));
}

#[test]
fn managed_shortcut_operation_identity_cannot_be_reused_for_another_phase() {
    let (_directory, core) = managed_shortcut_core();
    let (first, _) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-operation", "press-1", "replay"),
        None,
    );
    assert_eq!(first.unwrap()["status"], json!("accepted"));

    let reused = core
        .invoke(managed_shortcut_command(
            "shortcut-operation",
            "press-1",
            "keyDown",
        ))
        .unwrap_err();
    assert_eq!(reused.code(), "MANAGED_SHORTCUT_OPERATION_REUSED");
}

#[test]
fn managed_shortcut_stale_role_owner_is_superseded_without_a_browser_action() {
    let (_directory, core) = managed_shortcut_core();
    let stale = command(json!({
        "type": "managedShortcutPhase",
        "operationId": "shortcut-stale-owner",
        "roleId": "role-shortcut",
        "tabId": SHORTCUT_TAB_ID,
        "surfaceGeneration": 7,
        "documentInstanceId": "document-shortcut",
        "expectedOwnerGeneration": 2,
        "pressId": "press-stale",
        "macroId": "macro-shortcut",
        "code": "Digit2",
        "phase": "keyDown",
        "modifierCodes": [],
    }));
    let (receipt, actions) = drive_command(Arc::clone(&core), stale, None);
    assert_eq!(receipt.unwrap()["status"], json!("superseded"));
    assert!(actions.is_empty());

    let reused = core
        .invoke(command(json!({
            "type": "managedShortcutPhase",
            "operationId": "shortcut-stale-owner",
            "roleId": "role-shortcut",
            "tabId": SHORTCUT_TAB_ID,
            "surfaceGeneration": 7,
            "documentInstanceId": "document-shortcut",
            "expectedOwnerGeneration": 2,
            "pressId": "press-stale-reused",
            "macroId": "macro-shortcut",
            "code": "Digit2",
            "phase": "keyDown",
            "modifierCodes": [],
        })))
        .unwrap_err();
    assert_eq!(reused.code(), "MANAGED_SHORTCUT_OPERATION_REUSED");
}

#[test]
fn managed_shortcut_document_replacement_cannot_collide_with_an_old_receipt() {
    let (_directory, core) = managed_shortcut_core();
    let (old, old_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-old-document", "press-shared", "replay"),
        None,
    );
    assert_eq!(old.unwrap()["status"], json!("accepted"));
    assert_eq!(old_actions.len(), 1);

    let (replacement, replacement_actions) = drive_command(
        Arc::clone(&core),
        managed_shortcut_command_for(
            "shortcut-replacement-document",
            "press-shared",
            "replay",
            "macro-shortcut",
            "Digit2",
            "document-replacement",
        ),
        None,
    );
    assert_eq!(replacement.unwrap()["status"], json!("accepted"));
    assert_eq!(replacement_actions.len(), 1);
}

#[test]
fn managed_shortcut_indeterminate_key_down_remains_cleanup_reachable() {
    let (_directory, core) = managed_shortcut_core();
    let (failed, down_actions) = drive_command_with(
        Arc::clone(&core),
        managed_shortcut_command("shortcut-indeterminate", "press-indeterminate", "keyDown"),
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE".to_owned(),
                message: "The native receipt was lost.".to_owned(),
            }),
        },
    );
    assert_eq!(failed.unwrap_err().code(), "SYSTEM_TRUSTED_INPUT_INDETERMINATE");
    assert_eq!(down_actions.len(), 1);

    let retirement_command = || command(json!({
        "type": "managedShortcutSurfaceRetire",
        "roleId": "role-shortcut",
        "surfaceGeneration": 7,
        "documentInstanceId": "document-shortcut",
    }));
    let (unknown_cleanup, first_cleanup_actions) = drive_command_with(
        Arc::clone(&core),
        retirement_command(),
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE".to_owned(),
                message: "Cleanup neutrality is unknown.".to_owned(),
            }),
        },
    );
    assert_eq!(
        unknown_cleanup.unwrap_err().code(),
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
    );
    assert_eq!(first_cleanup_actions.len(), 1);

    let (retired, cleanup_actions) = drive_command(
        Arc::clone(&core),
        retirement_command(),
        None,
    );
    assert_eq!(retired.unwrap()["retiredPressIds"], json!(["press-indeterminate"]));
    assert_eq!(cleanup_actions.len(), 1);
    assert!(matches!(
        &cleanup_actions[0],
        CoreEffectAction::BrowserAction { request }
            if request.intent == "cleanup" &&
                matches!(&request.action, crate::model::BrowserAction::Key {
                    phase,
                    ..
                } if phase == "release")
    ));
}

#[test]
fn managed_shortcut_owner_transfer_waits_for_exact_terminality() {
    let (_directory, core) = managed_shortcut_core();
    let effects = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation = thread::spawn(move || {
        invocation_core.invoke(managed_shortcut_command(
            "shortcut-owner-race",
            "press-owner-race",
            "replay",
        ))
    });
    let effect = loop {
        let events = effects.recv_timeout(Duration::from_secs(2)).unwrap();
        if let Some(effect) = events.into_iter().find_map(|event| match event {
            CoreEvent::CoreEffects { effects } => effects.into_iter().next(),
            _ => None,
        }) {
            break effect;
        }
    };

    let transfer_core = Arc::clone(&core);
    let (transferred, transfer_observed) = std::sync::mpsc::sync_channel(1);
    let transfer = thread::spawn(move || {
        transfer_core
            .invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                role_id: "role-shortcut".to_owned(),
                expected_tab_id: Some(SHORTCUT_TAB_ID.to_owned()),
            })
            .unwrap();
        transferred.send(()).unwrap();
    });
    assert!(transfer_observed
        .recv_timeout(Duration::from_millis(50))
        .is_err());

    core.dispatch_core_effect_results(vec![effect_result(effect, None)])
        .unwrap();
    assert_eq!(invocation.join().unwrap().unwrap()["status"], json!("accepted"));
    transfer_observed
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    transfer.join().unwrap();
}
