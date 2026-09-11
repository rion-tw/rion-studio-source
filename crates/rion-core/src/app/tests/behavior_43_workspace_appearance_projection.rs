fn workspace_appearance_patch(gap: u32) -> CoreCommand {
    command(json!({
        "type": "gameBrowserSettingsPatch",
        "patch": { "workspace": { "background": "black", "gap": gap } }
    }))
}

fn workspace_appearance_core(platform: &str) -> (TempDir, Arc<AppCore>) {
    let (directory, core) =
        core_for_runtime_contract(platform, crate::CHROMIUM_RUNTIME_CONTRACT_VERSION);
    let mut registration = chromium_registration(platform, true);
    registration.contract_version = crate::CHROMIUM_RUNTIME_CONTRACT_VERSION;
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration,
    })
    .unwrap();
    (directory, core)
}

fn workspace_appearance_observation_result(
    effect: CoreEffectRequest,
    event: &crate::model::AppKitRuntimeEventRecord,
) -> CoreEffectResult {
    let mut result = effect_result(effect, None);
    result.value_json = Some(
        serde_json::to_string(
            &crate::model::AppKitWorkspaceAppearanceObservationReceiptRecord {
                observation_id: event.event_id.clone(),
                adapter_sequence: event.adapter_sequence,
                hosts: event.hosts.clone(),
            },
        )
        .unwrap(),
    );
    result
}

fn create_three_slot_divider_workspace(
    core: &AppCore,
    primary_role_id: &str,
    secondary_role_id: &str,
) -> String {
    core.invoke(command(json!({
        "type": "workspaceCreate",
        "input": {
            "name": "Three-slot divider workspace",
            "template": "main_left_stack_right",
            "slots": [
                {
                    "id": "main-role",
                    "roleId": primary_role_id,
                    "browserZoomPercent": 100,
                    "rect": {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
                },
                {
                    "id": "top-role",
                    "roleId": secondary_role_id,
                    "browserZoomPercent": 100,
                    "rect": {"x": 0.5, "y": 0.0, "width": 0.5, "height": 0.5}
                },
                {
                    "id": "bottom-web",
                    "web": {"lastUrl": "https://fixture.example.test/bottom"},
                    "rect": {"x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5}
                }
            ]
        }
    })))
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn workspace_appearance_refreshes_live_windows_once_and_ignores_unrelated_or_equal_patches() {
    let (_directory, core) = workspace_appearance_core("win32");
    let workspace_id = create_web_only_workspace(&core, "Live appearance");
    let window_id = "live-appearance-window";
    let (launch, _) = drive_command(
        Arc::clone(&core),
        web_workspace_launch(&workspace_id, window_id),
        None,
    );
    launch.unwrap();
    let revision_before = core
        .browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .get(window_id)
        .unwrap()
        .revision;

    let (changed, changed_actions, _) =
        drive_async_command(Arc::clone(&core), workspace_appearance_patch(16), None);
    assert_eq!(changed.unwrap()["workspace"]["gap"], 16);
    let projections = changed_actions
        .iter()
        .filter_map(|action| match action {
            CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. } => Some(windows),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(projections.len(), 1);
    let projected_tab = projections[0]
        .iter()
        .find(|window| window.window_id == window_id)
        .and_then(|window| window.workspace_tabs.first())
        .expect("live workspace projection");
    assert_eq!(projected_tab.workspace_appearance.gap, 16);
    assert_eq!(
        core.browser_runtime
            .snapshot()
            .unwrap()
            .windows
            .get(window_id)
            .unwrap()
            .revision,
        revision_before,
        "appearance projection must not mutate topology"
    );

    let (equal, equal_actions, _) =
        drive_async_command(Arc::clone(&core), workspace_appearance_patch(16), None);
    assert_eq!(equal.unwrap()["workspace"]["gap"], 16);
    assert!(equal_actions.is_empty());

    let (unrelated, unrelated_actions, _) = drive_async_command(
        Arc::clone(&core),
        command(json!({
            "type": "gameBrowserSettingsPatch",
            "patch": { "macroOverlay": { "showRunningBadges": false } }
        })),
        None,
    );
    assert_eq!(unrelated.unwrap()["macroOverlay"]["showRunningBadges"], false);
    assert!(unrelated_actions.is_empty());
    core.shutdown();
}

#[test]
fn workspace_appearance_projection_failure_restores_the_confirmed_setting() {
    let (_directory, core) = workspace_appearance_core("win32");
    let workspace_id = create_web_only_workspace(&core, "Appearance rollback");
    let (launch, _) = drive_command(
        Arc::clone(&core),
        web_workspace_launch(&workspace_id, "appearance-rollback-window"),
        None,
    );
    launch.unwrap();
    let confirmed = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
    let confirmed_gap = confirmed["workspace"]["gap"].clone();

    let (result, actions, _) = drive_async_command(
        Arc::clone(&core),
        workspace_appearance_patch(16),
        Some("embeddedFollowRoleOwnership"),
    );
    assert_eq!(result.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
    )));
    let restored = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
    assert_eq!(restored["workspace"]["gap"], confirmed_gap);
    core.shutdown();
}

#[test]
fn workspace_appearance_without_a_live_workspace_only_persists() {
    let (_directory, core) = workspace_appearance_core("win32");
    let (result, actions, _) =
        drive_async_command(Arc::clone(&core), workspace_appearance_patch(12), None);
    assert_eq!(result.unwrap()["workspace"]["gap"], 12);
    assert!(actions.is_empty());
    core.shutdown();
}

#[test]
fn workspace_appearance_supersedes_an_unfinished_divider_gesture() {
    let (_directory, core) = workspace_appearance_core("win32");
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = create_mixed_divider_workspace(&core, &role_id);
    let window_id = create_saved_window(&core, "Appearance supersede window");
    let (tab_id, attempt_generation, window_generation) =
        launch_divider_workspace(Arc::clone(&core), &workspace_id, &window_id);
    let revision = core.browser_runtime.snapshot().unwrap().windows[&window_id].revision;
    let gesture_id = uuid::Uuid::new_v4().to_string();
    let gesture = DividerGesture {
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &gesture_id,
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

    let (changed, _, _) =
        drive_async_command(Arc::clone(&core), workspace_appearance_patch(16), None);
    assert_eq!(changed.unwrap()["workspace"]["gap"], 16);
    let superseded = drive_divider(
        Arc::clone(&core),
        gesture.event(
            2,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            started.topology_revision,
            Some(0.7),
        ),
    );
    assert_eq!(
        superseded.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert_eq!(
        superseded.failure_code.as_deref(),
        Some("WORKSPACE_DIVIDER_APPEARANCE_SUPERSEDED")
    );
    assert!(!superseded.changed);
    assert_eq!(superseded.topology_revision, started.topology_revision);
    let terminal = drive_divider(
        Arc::clone(&core),
        gesture.event(
            3,
            crate::model::BrowserWorkspaceDividerPointerPhase::End,
            superseded.topology_revision,
            None,
        ),
    );
    assert_eq!(
        terminal.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert!(core
        .workspace_divider_runtime
        .lock()
        .unwrap()
        .superseded_gestures
        .is_empty());
    core.shutdown();
}

#[test]
fn appkit_workspace_appearance_uses_one_exact_observation_for_projection() {
    let (_directory, core) = workspace_appearance_core("darwin");
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = create_mixed_divider_workspace(&core, &role_id);
    let window_id = create_saved_window(&core, "AppKit appearance window");
    launch_divider_workspace(Arc::clone(&core), &workspace_id, &window_id);
    let observation = current_appkit_layout_event(&core, &window_id);
    let expected_bounds = observation.hosts[0].content_bounds.clone();
    let revision = observation.hosts[0].topology_revision;

    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        workspace_appearance_patch(16),
        |effect| match &effect.action {
            CoreEffectAction::EmbeddedObserveAppKitWorkspaceAppearance { window_ids } => {
                assert_eq!(window_ids, std::slice::from_ref(&window_id));
                workspace_appearance_observation_result(effect, &observation)
            }
            CoreEffectAction::EmbeddedApplyAppKitProjection { .. } => {
                assert_eq!(effect.target.handle_id, window_id);
                effect_result(effect, None)
            }
            _ => effect_result(effect, None),
        },
    );
    assert_eq!(result.unwrap()["workspace"]["gap"], 16);
    let projection = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedApplyAppKitProjection { projection } => {
                Some(projection)
            }
            _ => None,
        })
        .expect("live AppKit appearance projection");
    assert_eq!(projection.windows.len(), 1);
    assert_eq!(projection.windows[0].content_bounds, Some(expected_bounds));
    assert_eq!(projection.windows[0].topology_revision, revision);
    assert_eq!(projection.windows[0].workspace_dividers.len(), 1);
    assert_eq!(projection.windows[0].workspace_dividers[0].bounds.width, 16);
    assert_eq!(
        core.browser_runtime.snapshot().unwrap().windows[&window_id].revision,
        revision
    );
    core.shutdown();
}

#[test]
fn appkit_workspace_appearance_quarantines_uncompensated_native_projection() {
    for destroy_fails in [false, true] {
        let (_directory, core) = workspace_appearance_core("darwin");
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let workspace_id = create_mixed_divider_workspace(&core, &role_id);
        let window_id = create_saved_window(&core, "AppKit appearance quarantine");
        launch_divider_workspace(Arc::clone(&core), &workspace_id, &window_id);
        let observation = current_appkit_layout_event(&core, &window_id);
        let confirmed = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();

        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            workspace_appearance_patch(16),
            |effect| match &effect.action {
                CoreEffectAction::EmbeddedObserveAppKitWorkspaceAppearance { .. } => {
                    workspace_appearance_observation_result(effect, &observation)
                }
                CoreEffectAction::EmbeddedApplyAppKitProjection { .. } => CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(CoreErrorPayload {
                        code: "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED".to_owned(),
                        message: "Injected unverified appearance compensation.".to_owned(),
                    }),
                },
                CoreEffectAction::EmbeddedDestroyTab { .. } if destroy_fails => {
                    effect_result(effect, Some("embeddedDestroyTab"))
                }
                _ => effect_result(effect, None),
            },
        );
        assert_eq!(
            result.unwrap_err().code(),
            if destroy_fails {
                "WORKSPACE_APPEARANCE_PROJECTION_INDETERMINATE"
            } else {
                "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED"
            }
        );
        assert_eq!(
            core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap(),
            confirmed
        );
        assert_eq!(
            core.browser_runtime
                .snapshot()
                .unwrap()
                .windows
                .contains_key(&window_id),
            destroy_fails
        );
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedDestroyTab { .. }
        )));
        core.shutdown();
    }
}

#[test]
fn three_slot_workspace_dividers_update_only_their_linked_axes_and_persist_terminal_moves() {
    let (_directory, core) = workspace_appearance_core("win32");
    let game_id = first_game_id(&core);
    let primary_role_id = create_role(&core, &game_id, 1);
    let secondary_role_id = create_role(&core, &game_id, 2);
    let workspace_id = create_three_slot_divider_workspace(
        &core,
        &primary_role_id,
        &secondary_role_id,
    );
    let window_id = create_saved_window(&core, "Three-slot divider persistence");
    let (tab_id, attempt_generation, window_generation) =
        launch_divider_workspace(Arc::clone(&core), &workspace_id, &window_id);
    let initial = core.browser_runtime.snapshot().unwrap().windows[&window_id].tabs[0]
        .workspace_slots
        .clone();
    let initial_revision = core.browser_runtime.snapshot().unwrap().windows[&window_id].revision;

    let vertical_id = uuid::Uuid::new_v4().to_string();
    let vertical = DividerGesture {
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &vertical_id,
        host_generation: 1,
        window_generation,
    };
    let vertical_start = drive_divider(
        Arc::clone(&core),
        vertical.event(
            1,
            crate::model::BrowserWorkspaceDividerPointerPhase::Start,
            initial_revision,
            None,
        ),
    );
    let vertical_move = drive_divider(
        Arc::clone(&core),
        vertical.event(
            2,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            vertical_start.topology_revision,
            Some(0.62),
        ),
    );
    let vertical_end = drive_divider(
        Arc::clone(&core),
        vertical.event(
            3,
            crate::model::BrowserWorkspaceDividerPointerPhase::End,
            vertical_move.topology_revision,
            None,
        ),
    );
    assert!(vertical_move.changed);
    assert!(vertical_end.durable);
    for (after, before) in vertical_end.workspace_slots.iter().zip(&initial) {
        assert_eq!(after.rect.y, before.rect.y);
        assert_eq!(after.rect.height, before.rect.height);
    }
    assert_ne!(
        vertical_end.workspace_slots[0].rect.width,
        initial[0].rect.width
    );

    let horizontal_id = uuid::Uuid::new_v4().to_string();
    let horizontal = DividerGesture {
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &horizontal_id,
        host_generation: 1,
        window_generation,
    };
    let mut horizontal_start_event = horizontal.event(
        1,
        crate::model::BrowserWorkspaceDividerPointerPhase::Start,
        vertical_end.topology_revision,
        None,
    );
    horizontal_start_event.divider_index = 1;
    let horizontal_start = drive_divider(Arc::clone(&core), horizontal_start_event);
    let mut horizontal_move_event = horizontal.event(
        2,
        crate::model::BrowserWorkspaceDividerPointerPhase::Move,
        horizontal_start.topology_revision,
        Some(0.65),
    );
    horizontal_move_event.divider_index = 1;
    let horizontal_move = drive_divider(Arc::clone(&core), horizontal_move_event);
    let mut horizontal_end_event = horizontal.event(
        3,
        crate::model::BrowserWorkspaceDividerPointerPhase::End,
        horizontal_move.topology_revision,
        None,
    );
    horizontal_end_event.divider_index = 1;
    let horizontal_end = drive_divider(Arc::clone(&core), horizontal_end_event);
    assert!(horizontal_move.changed);
    assert!(horizontal_end.durable);
    assert_eq!(horizontal_end.workspace_slots[0], vertical_end.workspace_slots[0]);
    for index in [1, 2] {
        assert_eq!(
            horizontal_end.workspace_slots[index].rect.x,
            vertical_end.workspace_slots[index].rect.x
        );
        assert_eq!(
            horizontal_end.workspace_slots[index].rect.width,
            vertical_end.workspace_slots[index].rect.width
        );
    }
    assert_ne!(
        horizontal_end.workspace_slots[1].rect.height,
        vertical_end.workspace_slots[1].rect.height
    );
    let saved: crate::model::StateGameWindowRecord = serde_json::from_value(
        core.invoke(CoreCommand::GameWindowGet { id: window_id })
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved.tabs[0].workspace_slots, horizontal_end.workspace_slots);
    core.shutdown();
}
