// A Workspace may intentionally leave slots empty. Empty slots stay in the
// complete runtime layout but own no native surface or divider of their own.

fn create_stacked_workspace_with_empty_slot(core: &AppCore, role_id: &str) -> String {
    core.invoke(command(json!({
        "type": "workspaceCreate",
        "input": {
            "name": "Stacked workspace with an empty slot",
            "template": "main_left_stack_right",
            "slots": [
                {
                    "id": "main-role",
                    "roleId": role_id,
                    "browserZoomPercent": 100,
                    "rect": {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
                },
                {
                    "id": "top-web",
                    "web": {"lastUrl": "https://fixture.example.test/top"},
                    "rect": {"x": 0.5, "y": 0.0, "width": 0.5, "height": 0.5}
                },
                {
                    "id": "bottom-empty",
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

fn create_two_column_workspace_with_empty_slot(core: &AppCore, role_id: &str) -> String {
    core.invoke(command(json!({
        "type": "workspaceCreate",
        "input": {
            "name": "Two columns with an empty slot",
            "template": "two_columns",
            "slots": [
                {
                    "id": "left-role",
                    "roleId": role_id,
                    "browserZoomPercent": 100,
                    "rect": {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
                },
                {
                    "id": "right-empty",
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

fn empty_slot_live_slots(
    core: &AppCore,
    window_id: &str,
    tab_id: &str,
) -> Vec<crate::model::StateWorkspaceSlotRecord> {
    core.browser_runtime.snapshot().unwrap().windows[window_id]
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .unwrap()
        .workspace_slots
        .clone()
}

fn assert_complete_workspace_tiling(slots: &[crate::model::StateWorkspaceSlotRecord]) {
    let area = slots
        .iter()
        .map(|slot| slot.rect.width * slot.rect.height)
        .sum::<f64>();
    assert!(
        (area - 1.0).abs() < 1e-6,
        "slots must tile the workspace: {slots:?}"
    );
    for (index, left) in slots.iter().enumerate() {
        for right in &slots[index + 1..] {
            let overlap_x = (left.rect.x + left.rect.width).min(right.rect.x + right.rect.width)
                - left.rect.x.max(right.rect.x);
            let overlap_y = (left.rect.y + left.rect.height).min(right.rect.y + right.rect.height)
                - left.rect.y.max(right.rect.y);
            assert!(
                overlap_x <= 1e-6 || overlap_y <= 1e-6,
                "workspace slots overlap: {left:?} {right:?}"
            );
        }
    }
}

fn assert_stacked_line_moved_with_empty_slot(
    initial: &[crate::model::StateWorkspaceSlotRecord],
    moved: &[crate::model::StateWorkspaceSlotRecord],
) {
    assert_eq!(moved.len(), 3);
    assert_eq!(moved[2].id, "bottom-empty");
    assert!(moved[2].role_id.is_none() && moved[2].web.is_none());
    assert_ne!(moved[0].rect.width, initial[0].rect.width);
    // The empty slot follows the complete grid line instead of keeping a stale
    // rectangle beneath the resized main Role.
    assert_eq!(moved[1].rect.x, moved[0].rect.width);
    assert_eq!(moved[2].rect.x, moved[0].rect.width);
    assert_eq!(moved[2].rect.width, moved[1].rect.width);
    for (after, before) in moved.iter().zip(initial) {
        assert_eq!(after.rect.y, before.rect.y);
        assert_eq!(after.rect.height, before.rect.height);
    }
    assert_complete_workspace_tiling(moved);
}

struct AppKitEmptySlotDivider<'a> {
    core: &'a AppCore,
    window_id: &'a str,
    tab_id: &'a str,
    attempt_generation: &'a str,
    gesture_id: &'a str,
}

impl AppKitEmptySlotDivider<'_> {
    fn event(
        &self,
        sequence: u64,
        phase: crate::model::BrowserWorkspaceDividerPointerPhase,
        requested_position: Option<f64>,
    ) -> crate::model::BrowserWorkspaceDividerPointerRecord {
        let window = self.core.browser_runtime.snapshot().unwrap().windows[self.window_id].clone();
        let mut host = appkit_test_observation(self.window_id, 1);
        host.window_generation = window.window_generation;
        host.topology_revision = window.revision;
        crate::model::BrowserWorkspaceDividerPointerRecord {
            event_id: uuid::Uuid::new_v4().to_string(),
            gesture_id: self.gesture_id.to_owned(),
            pointer_sequence: sequence,
            phase,
            platform: crate::model::BrowserWorkspaceDividerPlatform::Macos,
            host_identity: crate::model::BrowserWorkspaceDividerHostIdentityRecord::Appkit {
                identity: host.identity.clone(),
            },
            appkit_host: Some(host),
            appkit_adapter_sequence: Some(sequence),
            window_id: self.window_id.to_owned(),
            tab_id: self.tab_id.to_owned(),
            attempt_generation: self.attempt_generation.to_owned(),
            window_generation: window.window_generation,
            topology_revision: window.revision,
            divider_index: 0,
            requested_position,
        }
    }
}

#[test]
fn appkit_projection_and_layout_events_skip_empty_workspace_slots() {
    let (_directory, core) = workspace_appearance_core("darwin");
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let two_column = create_two_column_workspace_with_empty_slot(&core, &role_id);
    let window_id = create_saved_window(&core, "AppKit empty-slot window");
    let (tab_id, _, _) = launch_divider_workspace(Arc::clone(&core), &two_column, &window_id);
    assert_eq!(empty_slot_live_slots(&core, &window_id, &tab_id).len(), 2);

    let observation = current_appkit_layout_event(&core, &window_id);
    let content_width = observation.hosts[0].content_bounds.width;
    let projection = core
        .build_appkit_projection(&observation)
        .expect("an empty slot must not invalidate the AppKit projection");
    let window = &projection.windows[0];
    assert_eq!(window.roles.len(), 1);
    assert_eq!(window.roles[0].role_id, role_id);
    assert_eq!(window.roles[0].bounds.x, 0);
    assert!(window.roles[0].bounds.width <= content_width / 2);
    assert!(window.web_surfaces.is_empty());
    assert!(window.workspace_dividers.is_empty());

    let (result, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event: observation },
        None,
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.expect("AppKit layout event")).unwrap();
    assert_eq!(
        receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows[0].roles.len() == 1
    )));

    let second_role_id = create_role(&core, &first_game_id(&core), 2);
    let stacked = create_stacked_workspace_with_empty_slot(&core, &second_role_id);
    let stacked_window_id = create_saved_window(&core, "AppKit stacked empty-slot window");
    launch_divider_workspace(Arc::clone(&core), &stacked, &stacked_window_id);
    let mut stacked_event = current_appkit_layout_event(&core, &stacked_window_id);
    stacked_event.hosts[0].attached_web_surfaces =
        Some(attached_web_test_evidence(&core, &stacked_window_id));
    let stacked_projection = core.build_appkit_projection(&stacked_event).unwrap();
    let stacked_window = &stacked_projection.windows[0];
    assert_eq!(stacked_window.roles.len(), 1);
    assert_eq!(stacked_window.web_surfaces.len(), 1);
    assert_eq!(stacked_window.workspace_dividers.len(), 1);
    assert_eq!(stacked_window.workspace_dividers[0].axis, "vertical");
    core.shutdown();
}

#[test]
fn appkit_workspace_divider_moves_the_complete_line_including_empty_slots() {
    let (_directory, core) = workspace_appearance_core("darwin");
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = create_stacked_workspace_with_empty_slot(&core, &role_id);
    let window_id = create_saved_window(&core, "AppKit empty-slot divider window");
    let (tab_id, attempt_generation, _) =
        launch_divider_workspace(Arc::clone(&core), &workspace_id, &window_id);
    let initial = empty_slot_live_slots(&core, &window_id, &tab_id);
    let gesture_id = uuid::Uuid::new_v4().to_string();
    let gesture = AppKitEmptySlotDivider {
        core: &core,
        window_id: &window_id,
        tab_id: &tab_id,
        attempt_generation: &attempt_generation,
        gesture_id: &gesture_id,
    };

    let started = drive_divider(
        Arc::clone(&core),
        gesture.event(
            1,
            crate::model::BrowserWorkspaceDividerPointerPhase::Start,
            None,
        ),
    );
    assert_eq!(
        started.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    let (moved, move_actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserWorkspaceDividerPointer {
            event: gesture.event(
                2,
                crate::model::BrowserWorkspaceDividerPointerPhase::Move,
                Some(0.62),
            ),
        },
        None,
    );
    let moved: crate::model::BrowserWorkspaceDividerPointerReceiptRecord =
        serde_json::from_value(moved.unwrap()).unwrap();
    assert_eq!(
        moved.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(moved.changed);
    assert_stacked_line_moved_with_empty_slot(&initial, &moved.workspace_slots);
    assert!(move_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedApplyAppKitProjection { projection }
            if projection.windows[0].roles.len() == 1
                && projection.windows[0].workspace_dividers.len() == 1
    )));

    let ended = drive_divider(
        Arc::clone(&core),
        gesture.event(
            3,
            crate::model::BrowserWorkspaceDividerPointerPhase::End,
            None,
        ),
    );
    assert_eq!(
        ended.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(ended.durable);
    let saved: crate::model::StateGameWindowRecord = serde_json::from_value(
        core.invoke(CoreCommand::GameWindowGet { id: window_id })
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved.tabs[0].workspace_slots, ended.workspace_slots);
    core.shutdown();
}

#[test]
fn windows_workspace_divider_moves_the_complete_line_including_empty_slots() {
    let (_directory, core) = workspace_appearance_core("win32");
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = create_stacked_workspace_with_empty_slot(&core, &role_id);
    let window_id = create_saved_window(&core, "Windows empty-slot divider window");
    let (tab_id, attempt_generation, window_generation) =
        launch_divider_workspace(Arc::clone(&core), &workspace_id, &window_id);
    let initial = empty_slot_live_slots(&core, &window_id, &tab_id);
    let initial_revision = core.browser_runtime.snapshot().unwrap().windows[&window_id].revision;
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
            initial_revision,
            None,
        ),
    );
    assert_eq!(
        started.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    let moved = drive_divider(
        Arc::clone(&core),
        gesture.event(
            2,
            crate::model::BrowserWorkspaceDividerPointerPhase::Move,
            started.topology_revision,
            Some(0.62),
        ),
    );
    assert_eq!(
        moved.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(moved.changed);
    assert_stacked_line_moved_with_empty_slot(&initial, &moved.workspace_slots);
    let ended = drive_divider(
        Arc::clone(&core),
        gesture.event(
            3,
            crate::model::BrowserWorkspaceDividerPointerPhase::End,
            moved.topology_revision,
            None,
        ),
    );
    assert_eq!(
        ended.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(ended.durable);
    let saved: crate::model::StateGameWindowRecord = serde_json::from_value(
        core.invoke(CoreCommand::GameWindowGet {
            id: window_id.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(saved.tabs[0].workspace_slots, ended.workspace_slots);
    assert_eq!(
        empty_slot_live_slots(&core, &window_id, &tab_id),
        ended.workspace_slots
    );

    // A Role beside an empty slot has no shared content edge, so no native
    // divider exists and index 0 is stale rather than an invalid slot.
    let second_role_id = create_role(&core, &first_game_id(&core), 2);
    let two_column = create_two_column_workspace_with_empty_slot(&core, &second_role_id);
    let two_column_window_id = create_saved_window(&core, "Windows two-column empty slot");
    let (two_column_tab_id, two_column_attempt, two_column_generation) =
        launch_divider_workspace(Arc::clone(&core), &two_column, &two_column_window_id);
    let two_column_revision =
        core.browser_runtime.snapshot().unwrap().windows[&two_column_window_id].revision;
    let two_column_gesture_id = uuid::Uuid::new_v4().to_string();
    let two_column_gesture = DividerGesture {
        window_id: &two_column_window_id,
        tab_id: &two_column_tab_id,
        attempt_generation: &two_column_attempt,
        gesture_id: &two_column_gesture_id,
        host_generation: 1,
        window_generation: two_column_generation,
    };
    let (result, _, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserWorkspaceDividerPointer {
            event: two_column_gesture.event(
                1,
                crate::model::BrowserWorkspaceDividerPointerPhase::Start,
                two_column_revision,
                None,
            ),
        },
        None,
    );
    assert_eq!(result.unwrap_err().code(), "WORKSPACE_DIVIDER_INDEX_STALE");
    core.shutdown();
}

#[test]
fn workspace_appearance_projects_empty_slots_on_windows_and_appkit() {
    let (_windows_directory, windows_core) = workspace_appearance_core("win32");
    let windows_role_id = create_role(&windows_core, &first_game_id(&windows_core), 1);
    let windows_workspace =
        create_stacked_workspace_with_empty_slot(&windows_core, &windows_role_id);
    let windows_window_id = create_saved_window(&windows_core, "Windows empty-slot appearance");
    launch_divider_workspace(
        Arc::clone(&windows_core),
        &windows_workspace,
        &windows_window_id,
    );
    let (changed, actions, _) = drive_async_command(
        Arc::clone(&windows_core),
        workspace_appearance_patch(16),
        None,
    );
    assert_eq!(changed.unwrap()["workspace"]["gap"], 16);
    let projected_slots = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. } => windows
                .iter()
                .find(|window| window.window_id == windows_window_id)?
                .workspace_tabs
                .first()
                .map(|tab| tab.workspace_slots.clone()),
            _ => None,
        })
        .expect("Windows workspace appearance projection");
    // Windows receives the complete authoritative layout, including the empty
    // slot that has no native surface in the live tab specification.
    assert_eq!(projected_slots.len(), 3);
    assert!(projected_slots[2].role_id.is_none() && projected_slots[2].web.is_none());
    windows_core.shutdown();

    let (_appkit_directory, appkit_core) = workspace_appearance_core("darwin");
    let appkit_role_id = create_role(&appkit_core, &first_game_id(&appkit_core), 1);
    let appkit_workspace = create_stacked_workspace_with_empty_slot(&appkit_core, &appkit_role_id);
    let appkit_window_id = create_saved_window(&appkit_core, "AppKit empty-slot appearance");
    launch_divider_workspace(
        Arc::clone(&appkit_core),
        &appkit_workspace,
        &appkit_window_id,
    );
    let observation = current_appkit_layout_event(&appkit_core, &appkit_window_id);
    let (result, appkit_actions, _) = drive_async_command_with(
        Arc::clone(&appkit_core),
        workspace_appearance_patch(16),
        |effect| match &effect.action {
            CoreEffectAction::EmbeddedObserveAppKitWorkspaceAppearance { .. } => {
                workspace_appearance_observation_result(effect, &observation)
            }
            _ => effect_result(effect, None),
        },
    );
    assert_eq!(
        result.expect("AppKit appearance with an empty slot")["workspace"]["gap"],
        16
    );
    let projection = appkit_actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedApplyAppKitProjection { projection } => Some(projection),
            _ => None,
        })
        .expect("live AppKit appearance projection");
    assert_eq!(projection.windows[0].roles.len(), 1);
    assert_eq!(projection.windows[0].workspace_dividers.len(), 1);
    assert_eq!(projection.windows[0].workspace_dividers[0].bounds.width, 16);
    appkit_core.shutdown();
}
