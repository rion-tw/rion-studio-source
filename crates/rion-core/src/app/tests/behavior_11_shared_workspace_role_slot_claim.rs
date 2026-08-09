#[test]
fn shared_workspace_role_is_blocked_then_moves_without_stopping_unique_roles() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let shared_role_id = create_role(&core, &game_id, 1);
    let unique_role_id = create_role(&core, &game_id, 2);
    let create_workspace = |name: &str, role_ids: &[String]| {
        core.invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": name,
                "template": if role_ids.len() == 1 { "single" } else { "two_columns" },
                "slots": role_ids.iter().enumerate().map(|(index, role_id)| json!({
                    "roleId": role_id,
                    "rect": workspace_rect(index, role_ids.len())
                })).collect::<Vec<_>>()
            }
        })))
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let source_workspace_id =
        create_workspace("Source", std::slice::from_ref(&shared_role_id));
    let target_workspace_id =
        create_workspace("Target", &[shared_role_id.clone(), unique_role_id.clone()]);
    let launch = |workspace_id: &str, window_id: &str| {
        command(json!({
            "type": "embeddedWorkspaceLaunch",
            "workspaceId": workspace_id,
            "target": {
                "windowId": window_id,
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1600, "height": 1000}
            }
        }))
    };
    assert!(drive_command(
        Arc::clone(&core),
        launch(&source_workspace_id, "source-window"),
        None,
    )
    .0
    .is_ok());
    let (target_launch, target_actions) = drive_command(
        Arc::clone(&core),
        launch(&target_workspace_id, "target-window"),
        None,
    );
    assert!(target_launch.is_ok());
    assert!(target_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedLoadRoles { roles }
            if roles.len() == 1 && roles[0].role_id == unique_role_id
    )));

    let before = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let source_owner = before
        .roles
        .iter()
        .find(|role| role.role_id == shared_role_id)
        .unwrap()
        .owner
        .clone();
    let unique_owner = before
        .roles
        .iter()
        .find(|role| role.role_id == unique_role_id)
        .unwrap()
        .owner
        .clone();
    let target_tab = before
        .tabs
        .iter()
        .find(|tab| tab.source_id == target_workspace_id)
        .unwrap();
    let target_slot = target_tab
        .slots
        .iter()
        .find(|slot| slot.role_id == shared_role_id)
        .unwrap();
    assert_eq!(target_slot.state, "blocked");
    let target_tab_id = target_tab.id.clone();
    let target_slot_id = target_slot.slot_id.clone();

    let (claim, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleSlotClaim {
            tab_id: target_tab_id.clone(),
            slot_id: target_slot_id.clone(),
            expected_owner_generation: Some(source_owner.generation),
        },
        None,
    );
    assert!(claim.is_ok(), "{claim:?}");
    let destroy_index = actions
        .iter()
        .position(|action| matches!(action, CoreEffectAction::EmbeddedDestroyRole { role_id } if role_id == &shared_role_id))
        .unwrap();
    let claim_index = actions
        .iter()
        .position(|action| matches!(action, CoreEffectAction::EmbeddedClaimRoleSlot { .. }))
        .unwrap();
    assert!(destroy_index < claim_index);

    let after = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let shared = after
        .roles
        .iter()
        .find(|role| role.role_id == shared_role_id)
        .unwrap();
    assert_eq!(shared.owner.tab_id, target_tab_id);
    assert_eq!(shared.owner.slot_id, target_slot_id);
    assert_eq!(shared.state, "running");
    assert_eq!(
        after
            .roles
            .iter()
            .find(|role| role.role_id == unique_role_id)
            .unwrap()
            .owner,
        unique_owner
    );
    assert_eq!(
        after
            .tabs
            .iter()
            .find(|tab| tab.id == source_owner.tab_id)
            .unwrap()
            .slots[0]
            .state,
        "blocked"
    );

    let (stale, stale_actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleSlotClaim {
            tab_id: source_owner.tab_id,
            slot_id: source_owner.slot_id,
            expected_owner_generation: Some(source_owner.generation),
        },
        None,
    );
    assert_eq!(stale.unwrap_err().code(), "RUNTIME_ROLE_OWNER_STALE");
    assert!(stale_actions.is_empty());
    core.shutdown();
}

#[test]
fn failed_shared_role_target_load_releases_owner_and_preserves_both_slots() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let role_id = create_role(&core, &game_id, 1);
    let create_workspace = |name: &str| {
        core.invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": name,
                "template": "single",
                "slots": [{"roleId": role_id, "rect": workspace_rect(0, 1)}]
            }
        })))
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let source_workspace_id = create_workspace("Source");
    let target_workspace_id = create_workspace("Target");
    let launch = |workspace_id: &str, window_id: &str| {
        command(json!({
            "type": "embeddedWorkspaceLaunch",
            "workspaceId": workspace_id,
            "target": {
                "windowId": window_id,
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        }))
    };
    assert!(drive_command(
        Arc::clone(&core),
        launch(&source_workspace_id, "source-window"),
        None,
    )
    .0
    .is_ok());
    assert!(drive_command(
        Arc::clone(&core),
        launch(&target_workspace_id, "target-window"),
        None,
    )
    .0
    .is_ok());

    let before = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let generation = before.roles[0].owner.generation;
    let target_tab = before
        .tabs
        .iter()
        .find(|tab| tab.source_id == target_workspace_id)
        .unwrap();
    let target_tab_id = target_tab.id.clone();
    let target_slot_id = target_tab.slots[0].slot_id.clone();
    let (failed, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleSlotClaim {
            tab_id: target_tab_id,
            slot_id: target_slot_id,
            expected_owner_generation: Some(generation),
        },
        Some("embeddedLoadRoles"),
    );
    assert_eq!(failed.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedClaimRoleSlot { .. }
    )));
    assert!(
        actions
            .iter()
            .filter(|action| matches!(action, CoreEffectAction::EmbeddedDestroyRole { .. }))
            .count()
            >= 2
    );

    let after = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(after.roles.is_empty());
    assert_eq!(after.tabs.len(), 2);
    assert!(after.tabs.iter().all(|tab| {
        tab.slots.len() == 1
            && tab.slots[0].role_id == role_id
            && tab.slots[0].state == "available"
            && tab.slots[0].owner.is_none()
    }));
    core.shutdown();
}

#[test]
fn restored_workspace_uses_saved_role_slots_instead_of_the_current_definition() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let current_role_id = create_role(&core, &game_id, 1);
    let saved_role_id = create_role(&core, &game_id, 2);
    let workspace_id = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "Changed after save",
                "template": "single",
                "slots": [{
                    "roleId": current_role_id,
                    "rect": workspace_rect(0, 1)
                }]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let saved_rect = StateNormalizedRectRecord {
        x: 0.125,
        y: 0.25,
        width: 0.5,
        height: 0.625,
    };

    drive_accepted_launch_to_completion(
        Arc::clone(&core),
        CoreCommand::BrowserWorkspaceLaunch {
            launch_tab_id: None,
            workspace_id: workspace_id.clone(),
            target: EmbeddedLaunchTargetRecord {
                window_id: "restore-window".to_owned(),
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
            restore_role_slots: Some(vec![GameWindowRoleSlotRecord {
                slot_id: "saved-slot".to_owned(),
                role_id: saved_role_id.clone(),
                rect: saved_rect.clone(),
                browser_zoom_percent: Some(137.0),
            }]),
        },
    );

    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.source_id == workspace_id)
        .unwrap();
    assert_eq!(tab.slots.len(), 1);
    assert_eq!(tab.slots[0].slot_id, "saved-slot");
    assert_eq!(tab.slots[0].role_id, saved_role_id);
    assert_eq!(tab.slots[0].rect, saved_rect);
    assert_eq!(tab.slots[0].browser_zoom_percent, Some(137.0));
    assert!(snapshot.roles.iter().all(|role| role.role_id != current_role_id));
    core.shutdown();
}

#[test]
fn restored_role_tab_creates_a_blocked_demand_when_workspace_owns_the_role() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let role_id = create_role(&core, &game_id, 1);
    let workspace_id = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "Owner",
                "template": "single",
                "slots": [{"roleId": role_id, "rect": workspace_rect(0, 1)}]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target = |window_id: &str| EmbeddedLaunchTargetRecord {
        window_id: window_id.to_owned(),
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
    };
    drive_accepted_launch_to_completion(
        Arc::clone(&core),
        CoreCommand::BrowserWorkspaceLaunch {
            launch_tab_id: None,
            workspace_id: workspace_id.clone(),
            target: target("restore-window"),
            launch_preview_id: None,
            restore_role_slots: None,
        },
    );
    let before = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let owner = before
        .roles
        .iter()
        .find(|runtime_role| runtime_role.role_id == role_id)
        .unwrap()
        .owner
        .clone();
    let saved_rect = StateNormalizedRectRecord {
        x: 0.125,
        y: 0.25,
        width: 0.75,
        height: 0.5,
    };
    let (restored, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleLaunch {
            launch_tab_id: None,
            role_id: role_id.clone(),
            target: target("restore-window"),
            launch_preview_id: None,
            zoom_factor: None,
            restore_role_slots: Some(vec![GameWindowRoleSlotRecord {
                slot_id: "saved-role-slot".to_owned(),
                role_id: role_id.clone(),
                rect: saved_rect.clone(),
                browser_zoom_percent: Some(137.0),
            }]),
        },
        None,
    );
    assert!(restored.is_ok(), "{restored:?}");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedCreateTab { tab }
            if tab.roles.is_empty()
                && tab.slots.len() == 1
                && tab.slots[0].slot_id == "saved-role-slot"
                && tab.slots[0].state == "blocked"
                && tab.slots[0].owner.as_ref() == Some(&owner)
    )));
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedLoadRoles { roles } if roles.is_empty()
    )));

    let after = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert_eq!(
        after
            .roles
            .iter()
            .find(|runtime_role| runtime_role.role_id == role_id)
            .unwrap()
            .owner,
        owner
    );
    let restored_tab = after
        .tabs
        .iter()
        .find(|tab| tab.tab_type == "role" && tab.source_id == role_id)
        .unwrap();
    assert_eq!(restored_tab.slots[0].slot_id, "saved-role-slot");
    assert_eq!(restored_tab.slots[0].state, "blocked");
    assert_eq!(restored_tab.slots[0].rect, saved_rect);
    assert_eq!(restored_tab.slots[0].browser_zoom_percent, Some(137.0));
    core.shutdown();
}

#[test]
fn restored_role_tab_rejects_mismatched_slot_without_native_effects() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let role_id = create_role(&core, &game_id, 1);
    let (restored, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleLaunch {
            launch_tab_id: None,
            role_id,
            target: EmbeddedLaunchTargetRecord {
                window_id: "restore-window".to_owned(),
                display_id: 1,
                scale_factor: 1.0,
                work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                },
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                },
                presentation: "normal".to_owned(),
            },
            launch_preview_id: None,
            zoom_factor: None,
            restore_role_slots: Some(Vec::new()),
        },
        None,
    );
    assert_eq!(restored.unwrap_err().code(), "ROLE_RESTORE_SLOT_INVALID");
    assert!(actions.is_empty());
    core.shutdown();
}

#[test]
fn restored_available_role_uses_the_saved_slot_geometry_and_zoom() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let saved_rect = StateNormalizedRectRecord {
        x: 0.2,
        y: 0.1,
        width: 0.6,
        height: 0.8,
    };
    let (restored, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleLaunch {
            launch_tab_id: None,
            role_id: role_id.clone(),
            target: EmbeddedLaunchTargetRecord {
                window_id: "restore-window".to_owned(),
                display_id: 1,
                scale_factor: 1.0,
                work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                },
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                },
                presentation: "normal".to_owned(),
            },
            launch_preview_id: None,
            zoom_factor: None,
            restore_role_slots: Some(vec![GameWindowRoleSlotRecord {
                slot_id: "restored-available-slot".to_owned(),
                role_id: role_id.clone(),
                rect: saved_rect.clone(),
                browser_zoom_percent: Some(142.0),
            }]),
        },
        None,
    );
    assert!(restored.is_ok(), "{restored:?}");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedCreateTab { tab }
            if tab.slots[0].slot_id == "restored-available-slot"
                && tab.slots[0].rect == saved_rect
                && tab.roles[0].zoom_factor == 1.42
    )));
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert_eq!(snapshot.tabs[0].slots[0].slot_id, "restored-available-slot");
    assert_eq!(snapshot.tabs[0].slots[0].rect, saved_rect);
    assert_eq!(snapshot.tabs[0].slots[0].browser_zoom_percent, Some(142.0));
    assert_eq!(snapshot.roles[0].owner.tab_id, snapshot.tabs[0].id);
    core.shutdown();
}

#[test]
fn reopening_a_stopped_role_reuses_its_preserved_available_slot() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let launch = || {
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        }))
    };
    assert!(drive_command(Arc::clone(&core), launch(), None).0.is_ok());
    let original_tab_id = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .tabs[0]
        .id
        .clone();
    assert!(
        drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        )
        .0
        .is_ok()
    );

    let (reopened, actions) = drive_command(Arc::clone(&core), launch(), None);
    assert!(reopened.is_ok(), "{reopened:?}");
    assert!(actions.is_empty());
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.roles.is_empty());
    assert_eq!(snapshot.tabs.len(), 1);
    assert_eq!(snapshot.tabs[0].id, original_tab_id);
    assert_eq!(snapshot.tabs[0].slots[0].state, "available");
    assert!(snapshot.tabs[0].hidden, "Core must not project tab visibility");
    core.shutdown();
}

#[test]
fn closing_an_available_role_tab_removes_its_demand_record() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let launch = command(json!({
        "type": "embeddedRoleLaunch",
        "roleId": role_id,
        "target": {
            "windowId": "available-demand-window",
            "displayId": 1,
            "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
        }
    }));
    assert!(drive_command(Arc::clone(&core), launch, None).0.is_ok());
    let tab_id = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .tabs[0]
        .id
        .clone();
    assert!(
        drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        )
        .0
        .is_ok()
    );

    let (closed, actions, _) = drive_async_command(
        Arc::clone(&core),
        embedded_tab_stop_mutation_command(
            "close-available-demand",
            &tab_id,
            "available-demand-window",
            &role_id,
        ),
        None,
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(actions.is_empty());
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.tabs.is_empty());
    assert!(snapshot.roles.is_empty());
    core.shutdown();
}

#[test]
fn closing_a_window_removes_available_role_demands_without_native_owners() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let window_id = "available-demand-window-close";
    let launch = command(json!({
        "type": "embeddedRoleLaunch",
        "roleId": role_id,
        "target": {
            "windowId": window_id,
            "displayId": 1,
            "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
        }
    }));
    assert!(drive_command(Arc::clone(&core), launch, None).0.is_ok());
    let tab_id = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .tabs[0]
        .id
        .clone();
    assert!(
        drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        )
        .0
        .is_ok()
    );

    let (closed, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserWindowStop {
            request: test_window_stop_request(window_id, vec![tab_id]),
        },
        None,
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(actions.len(), 1);
    assert!(matches!(
        actions[0],
        CoreEffectAction::EmbeddedDestroyTab { .. }
    ));
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.tabs.is_empty());
    assert!(snapshot.roles.is_empty());
    core.shutdown();
}

#[test]
fn restored_available_role_rebuilds_a_stale_demand_instead_of_completing_empty() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let launch = command(json!({
        "type": "embeddedRoleLaunch",
        "roleId": role_id,
        "target": {
            "windowId": "stale-demand-window",
            "displayId": 1,
            "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
        }
    }));
    assert!(drive_command(Arc::clone(&core), launch, None).0.is_ok());
    let stale_tab_id = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot
        .tabs[0]
        .id
        .clone();
    assert!(
        drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        )
        .0
        .is_ok()
    );

    let saved_rect = StateNormalizedRectRecord {
        x: 0.1,
        y: 0.2,
        width: 0.8,
        height: 0.7,
    };
    let (restored, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserRoleLaunch {
            launch_tab_id: None,
            role_id: role_id.clone(),
            target: EmbeddedLaunchTargetRecord {
                window_id: "stale-demand-window".to_owned(),
                display_id: 1,
                scale_factor: 1.0,
                work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                },
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                },
                presentation: "normal".to_owned(),
            },
            launch_preview_id: None,
            zoom_factor: None,
            restore_role_slots: Some(vec![GameWindowRoleSlotRecord {
                slot_id: "restored-stale-slot".to_owned(),
                role_id: role_id.clone(),
                rect: saved_rect.clone(),
                browser_zoom_percent: Some(133.0),
            }]),
        },
        None,
    );
    assert!(restored.is_ok(), "{restored:?}");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedCreateTab { tab }
            if tab.tab_id != stale_tab_id
                && tab.roles.len() == 1
                && tab.slots[0].slot_id == "restored-stale-slot"
                && tab.slots[0].rect == saved_rect
    )));
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert_eq!(snapshot.tabs.len(), 1);
    assert_eq!(snapshot.roles.len(), 1);
    assert_eq!(snapshot.tabs[0].slots[0].slot_id, "restored-stale-slot");
    core.shutdown();
}
