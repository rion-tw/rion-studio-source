#[test]
fn workspace_slot_loads_fence_duplicates_retries_and_retired_tabs_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = chromium_web_core(platform);
        let workspace = create_web_only_workspace(&core, "Independent loading");
        let (result, actions) = drive_command(
            Arc::clone(&core),
            web_workspace_launch(&workspace, "slot-loading-window"),
            None,
        );
        result.unwrap();
        let tab = actions
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
                _ => None,
            })
            .unwrap();
        let snapshot = core.browser_runtime.snapshot().unwrap();
        let window = &snapshot.windows[&tab.target.window_id];
        let mut initial = crate::model::WorkspaceSlotLoadRecord {
            tab_id: tab.tab_id.clone(),
            slot_id: tab.slots[0].slot_id.clone(),
            surface_id: tab.slots[0].role.id.clone(),
            window_id: tab.target.window_id.clone(),
            attempt_generation: tab.attempt_generation.clone().unwrap(),
            load_id: tab.attempt_generation.clone().unwrap(),
            window_generation: window.window_generation,
            owner_generation: 0,
            surface_generation: 0,
            revision: 0,
            phase: "loading".to_owned(),
            retryable: false,
            loading_label: None,
            failure_label: None,
            retry_label: None,
        };
        let mut loading = core
            .report_workspace_slot_load(initial.clone())
            .unwrap()
            .unwrap();
        assert_eq!(loading.revision, 1, "{platform}");
        assert!(
            core.report_workspace_slot_load(initial.clone())
                .unwrap()
                .is_none()
        );
        initial.window_generation += 1;
        assert!(core.report_workspace_slot_load(initial).unwrap().is_none());
        let target_workspace = create_web_only_workspace(&core, "Loading move destination");
        drive_command(
            Arc::clone(&core),
            web_workspace_launch(&target_workspace, "slot-loading-destination"),
            None,
        )
        .0
        .unwrap();
        let before_move = core.browser_runtime.snapshot().unwrap();
        let source = &before_move.windows[&loading.window_id];
        let target = &before_move.windows["slot-loading-destination"];
        let moved = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedTabMove {
                operation_id: "move-loading-slot".to_owned(),
                tab_id: loading.tab_id.clone(),
                source_window_id: source.window_id.clone(),
                source_window_generation: source.window_generation,
                source_topology_revision: source.revision,
                target_window_id: target.window_id.clone(),
                target_window_generation: target.window_generation,
                target_topology_revision: target.revision,
                before_tab_id: None,
            },
            None,
        )
        .0
        .unwrap();
        assert_eq!(moved["status"], "applied", "{platform}: {moved}");
        assert!(
            core.report_workspace_slot_load(crate::model::WorkspaceSlotLoadRecord {
                phase: "ready".to_owned(),
                surface_generation: 1,
                ..loading.clone()
            })
            .unwrap()
            .is_none(),
            "the old window cannot complete a moved load"
        );
        loading.window_id = target.window_id.clone();
        loading.window_generation = target.window_generation;
        let failed = core
            .report_workspace_slot_load(crate::model::WorkspaceSlotLoadRecord {
                phase: "failed".to_owned(),
                surface_generation: 1,
                retryable: true,
                ..loading
            })
            .unwrap()
            .unwrap();
        assert_eq!(failed.revision, 2);
        assert!(
            core.report_workspace_slot_load(failed.clone())
                .unwrap()
                .is_none()
        );
        let (retry, effects, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::WorkspaceSlotRetry {
                record: failed.clone(),
            },
            None,
        );
        assert_eq!(retry.unwrap(), json!(true));
        let retry_loading = effects
            .iter()
            .find_map(|action| match action {
                CoreEffectAction::EmbeddedRetryWorkspaceSlot { record } => Some(record.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(retry_loading.surface_generation, 0);
        assert_ne!(retry_loading.load_id, failed.load_id);
        assert!(!core.retry_workspace_slot(failed.clone()).unwrap());
        assert!(
            core.report_workspace_slot_load(crate::model::WorkspaceSlotLoadRecord {
                phase: "ready".to_owned(),
                ..failed
            })
            .unwrap()
            .is_none()
        );
        let ready = core
            .report_workspace_slot_load(crate::model::WorkspaceSlotLoadRecord {
                phase: "ready".to_owned(),
                surface_generation: 2,
                ..retry_loading
            })
            .unwrap()
            .unwrap();
        assert!(!ready.retryable);
        assert_eq!(ready.surface_generation, 2);
        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedWorkspaceStop {
                workspace_id: workspace,
            },
            None,
        );
        stopped.unwrap();
        assert!(core.report_workspace_slot_load(ready).unwrap().is_none());
    }
}

#[test]
fn workspace_slot_effects_are_event_bound() {
    let action = CoreEffectAction::EmbeddedLoadWorkspaceSlots {
        tab_id: "tab".to_owned(),
        attempt_generation: "attempt".to_owned(),
        roles: vec![],
        profile: None,
        surfaces: vec![],
    };
    assert_eq!(
        action.completion_policy(),
        crate::model::OperationCompletionPolicy::EventBound
    );
}
