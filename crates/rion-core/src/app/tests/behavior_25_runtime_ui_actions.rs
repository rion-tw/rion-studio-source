fn runtime_ui_test_tab(tab_id: &str, source_id: &str) -> crate::RuntimeLiveTabRecord {
    crate::RuntimeLiveTabRecord {
        audio_muted: false,
        closable: true,
        icon_data_url: None,
        id: tab_id.to_owned(),
        persistable: true,
        role_ids: Vec::new(),
        role_slots: Vec::new(),
        workspace_slots: Vec::new(),
        source_id: source_id.to_owned(),
        tab_type: "role".to_owned(),
        title: source_id.to_owned(),
        workspace_template: None,
    }
}

fn seed_runtime_ui_topology(
    core: &AppCore,
    commit_id: &str,
    windows: Vec<(&str, &str, &str)>,
) {
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: commit_id.to_owned(),
            source: "command".to_owned(),
            primary_window_id: windows[0].0.to_owned(),
            windows: windows
                .into_iter()
                .map(|(window_id, tab_id, source_id)| crate::RuntimeWindowTopologyCommit {
                    active_tab_id: Some(tab_id.to_owned()),
                    hidden_tab_ids: std::collections::HashSet::new(),
                    tabs: vec![runtime_ui_test_tab(tab_id, source_id)],
                    ui_sequence: 1,
                    window_generation: 3,
                    window_id: window_id.to_owned(),
                })
                .collect(),
        },
    ))
    .unwrap();
}

#[test]
fn windows_projection_carries_core_activation_phase_until_authoritative_ready() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    let tab_id = "runtime-phase-tab";
    let window_id = "runtime-phase-window";
    seed_runtime_ui_topology(
        &core,
        "runtime-phase-seed",
        vec![(window_id, tab_id, "runtime-phase-role")],
    );
    core.apply_runtime_intent(crate::RuntimeIntent::SeedDormantTabs {
        operation_id: "runtime-phase-dormant".to_owned(),
        tab_ids: vec![tab_id.to_owned()],
        window_id: window_id.to_owned(),
    })
    .unwrap();
    let before = core.browser_runtime.snapshot().unwrap();
    let attempt = crate::OperationId::new("runtime-phase-attempt").unwrap();
    core.apply_runtime_intent(crate::RuntimeIntent::ActivateTab {
        expected_revision: Some(before.windows[window_id].revision),
        operation_id: attempt.clone(),
        tab_id: crate::RuntimeTabId::new(tab_id).unwrap(),
        window_id: window_id.to_owned(),
    })
    .unwrap();
    core.apply_runtime_intent(crate::RuntimeIntent::SetTabActivationPhase {
        activation_attempt_id: attempt.clone(),
        operation_id: "runtime-phase-loading".to_owned(),
        phase: crate::model::RuntimeTabActivationPhaseRecord::Loading,
        tab_id: crate::RuntimeTabId::new(tab_id).unwrap(),
    })
    .unwrap();
    let loading = core.embedded_runtime_window_projections().unwrap();
    assert_eq!(
        loading[0].tab_phases[0].phase,
        crate::model::RuntimeTabActivationPhaseRecord::Loading
    );

    core.apply_runtime_intent(crate::RuntimeIntent::SetTabActivationPhase {
        activation_attempt_id: attempt,
        operation_id: "runtime-phase-ready".to_owned(),
        phase: crate::model::RuntimeTabActivationPhaseRecord::Ready,
        tab_id: crate::RuntimeTabId::new(tab_id).unwrap(),
    })
    .unwrap();
    let ready = core.embedded_runtime_window_projections().unwrap();
    assert_eq!(
        ready[0].tab_phases[0].phase,
        crate::model::RuntimeTabActivationPhaseRecord::Ready
    );
    assert!(ready[0].topology_revision > loading[0].topology_revision);
}

#[test]
fn runtime_ui_actions_are_fenced_replayable_and_move_the_last_tab_exactly_once() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let source_tab = "runtime-ui-source-tab".to_owned();
    let target_tab = "runtime-ui-target-tab".to_owned();
    seed_runtime_ui_topology(
        &core,
        "runtime-ui-seed",
        vec![
            ("runtime-ui-source", &source_tab, "source-role"),
            ("runtime-ui-target", &target_tab, "target-role"),
        ],
    );
    let mut restore_session = core.runtime_restore_session().unwrap();
    restore_session.live_window_ids = Some(vec!["runtime-ui-source".to_owned()]);
    core.replace_runtime_restore_session(restore_session).unwrap();

    let before_hide = core.browser_runtime.snapshot().unwrap();
    let source = before_hide.windows.get("runtime-ui-source").unwrap();
    let hide = CoreCommand::EmbeddedTabHide {
        operation_id: "runtime-ui-hide-1".to_owned(),
        tab_id: source_tab.clone(),
        window_id: source.window_id.clone(),
        window_generation: source.window_generation,
        topology_revision: source.revision,
        hidden: true,
    };
    let (hidden, hide_actions) = drive_command(Arc::clone(&core), hide.clone(), None);
    let hidden: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(hidden.unwrap()).unwrap();
    assert_eq!(
        hidden.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(hide_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. }
            if windows.iter().any(|window| {
                window.window_id == "runtime-ui-source"
                    && window.active_tab_id.is_none()
                    && window.hidden_tab_ids == [source_tab.clone()]
            })
    )));
    let source_after_hide = core.browser_runtime.snapshot().unwrap();
    let source_after_hide = source_after_hide.windows.get("runtime-ui-source").unwrap();
    assert!(source_after_hide.selected_tab_id.is_none());
    assert!(source_after_hide.hidden_tab_ids.contains(&source_tab));
    assert_eq!(
        core.runtime_restore_session().unwrap().live_window_ids,
        Some(vec!["runtime-ui-source".to_owned()]),
        "a dormant logical window must not enter the crash-recovery cohort"
    );

    let (hide_replay, hide_replay_actions) = drive_command(Arc::clone(&core), hide, None);
    let hide_replay: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(hide_replay.unwrap()).unwrap();
    assert_eq!(hide_replay.operation_id, hidden.operation_id);
    assert!(hide_replay_actions.is_empty());

    let (stale_hide, stale_hide_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedTabHide {
            operation_id: "runtime-ui-hide-stale".to_owned(),
            tab_id: source_tab.clone(),
            window_id: "runtime-ui-source".to_owned(),
            window_generation: source.window_generation,
            topology_revision: source.revision,
            hidden: false,
        },
        None,
    );
    let stale_hide: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(stale_hide.unwrap()).unwrap();
    assert_eq!(
        stale_hide.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert!(stale_hide_actions.is_empty());

    let before_move = core.browser_runtime.snapshot().unwrap();
    let source = before_move.windows.get("runtime-ui-source").unwrap();
    let target = before_move.windows.get("runtime-ui-target").unwrap();
    let move_command = CoreCommand::EmbeddedTabMove {
        operation_id: "runtime-ui-move-1".to_owned(),
        tab_id: source_tab.clone(),
        source_window_id: source.window_id.clone(),
        source_window_generation: source.window_generation,
        source_topology_revision: source.revision,
        target_window_id: target.window_id.clone(),
        target_window_generation: target.window_generation,
        target_topology_revision: target.revision,
        before_tab_id: None,
    };
    let (moved, move_actions) =
        drive_command(Arc::clone(&core), move_command.clone(), None);
    let moved: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(moved.unwrap()).unwrap();
    assert_eq!(
        moved.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );
    assert!(move_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. }
            if {
                let source = windows.iter().find(|window| {
                    window.window_id == "runtime-ui-source"
                }).unwrap();
                let target = windows.iter().find(|window| {
                    window.window_id == "runtime-ui-target"
                }).unwrap();
                source.tab_ids.is_empty()
                    && source.active_tab_id.is_none()
                    && target.tab_ids == [target_tab.clone(), source_tab.clone()]
                    && target.active_tab_id.as_deref() == Some(source_tab.as_str())
            }
    )));
    let after_move = core.browser_runtime.snapshot().unwrap();
    assert!(after_move
        .windows
        .get("runtime-ui-source")
        .unwrap()
        .tabs
        .is_empty());
    let target_after_move = after_move.windows.get("runtime-ui-target").unwrap();
    assert_eq!(
        target_after_move.tab_ids(),
        vec![target_tab.clone(), source_tab.clone()]
    );
    assert_eq!(
        target_after_move.selected_tab_id.as_deref(),
        Some(source_tab.as_str())
    );
    assert!(!target_after_move.hidden_tab_ids.contains(&source_tab));
    assert_eq!(
        core.runtime_restore_session().unwrap().live_window_ids,
        Some(vec![
            "runtime-ui-source".to_owned(),
            "runtime-ui-target".to_owned()
        ])
    );

    let (move_replay, move_replay_actions) =
        drive_command(Arc::clone(&core), move_command, None);
    let move_replay: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(move_replay.unwrap()).unwrap();
    assert_eq!(move_replay.operation_id, moved.operation_id);
    assert!(move_replay_actions.is_empty());

    let (stale_move, stale_move_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedTabMove {
            operation_id: "runtime-ui-move-stale".to_owned(),
            tab_id: source_tab.clone(),
            source_window_id: "runtime-ui-source".to_owned(),
            source_window_generation: source.window_generation,
            source_topology_revision: source.revision,
            target_window_id: "runtime-ui-target".to_owned(),
            target_window_generation: target.window_generation,
            target_topology_revision: target.revision,
            before_tab_id: None,
        },
        None,
    );
    let stale_move: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(stale_move.unwrap()).unwrap();
    assert_eq!(
        stale_move.status,
        crate::model::SystemRuntimeOperationStatus::Superseded
    );
    assert!(stale_move_actions.is_empty());
    core.shutdown();
}

#[test]
fn core_generates_replayable_empty_window_identity_and_retires_only_exact_state() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let tab_id = "runtime-provision-tab".to_owned();
    seed_runtime_ui_topology(
        &core,
        "runtime-provision-seed",
        vec![("runtime-provision-source", &tab_id, "provision-role")],
    );
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let source = snapshot.windows.get("runtime-provision-source").unwrap();
    let provision = CoreCommand::EmbeddedWindowProvisionForTabMove {
        operation_id: "runtime-provision-1".to_owned(),
        tab_id: tab_id.clone(),
        source_window_id: source.window_id.clone(),
        source_window_generation: source.window_generation,
        source_topology_revision: source.revision,
        target: crate::model::RuntimeWindowProvisionTargetRecord {
            persisted_name: Some("Provisioned Window".to_owned()),
            display_id: 1,
            scale_factor: 1.0,
            work_area: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
            bounds: StatePixelBoundsRecord {
                x: 100,
                y: 80,
                width: 900,
                height: 640,
            },
            presentation: "normal".to_owned(),
        },
    };
    let (created, create_actions) =
        drive_command(Arc::clone(&core), provision.clone(), None);
    let created: crate::model::RuntimeWindowProvisionReceiptRecord =
        serde_json::from_value(created.unwrap()).unwrap();
    assert_ne!(created.target.window_id, "runtime-provision-source");
    assert!(uuid::Uuid::parse_str(&created.target.window_id).is_ok());
    assert!(create_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedProvisionWindowForTabMove {
            tab_id: effect_tab,
            source_window_id,
            target,
            target_window_generation,
            target_topology_revision,
            ..
        } if effect_tab == &tab_id
            && source_window_id == "runtime-provision-source"
            && target.window_id == created.target.window_id
            && *target_window_generation == created.window_generation
            && *target_topology_revision == created.topology_revision
    )));
    let reserved = core.browser_runtime.snapshot().unwrap();
    let reserved_window = reserved.windows.get(&created.target.window_id).unwrap();
    assert!(reserved_window.tabs.is_empty());
    assert_eq!(reserved_window.window_generation, created.window_generation);
    assert_eq!(reserved_window.revision, created.topology_revision);
    assert_eq!(
        reserved.windows.get("runtime-provision-source").unwrap().tab_ids(),
        vec![tab_id.clone()]
    );

    let (replayed, replay_actions) =
        drive_command(Arc::clone(&core), provision, None);
    let replayed: crate::model::RuntimeWindowProvisionReceiptRecord =
        serde_json::from_value(replayed.unwrap()).unwrap();
    assert_eq!(replayed.target.window_id, created.target.window_id);
    assert_eq!(replayed.window_generation, created.window_generation);
    assert!(replay_actions.is_empty());
    let resumed: Option<crate::model::RuntimeWindowProvisionReceiptRecord> =
        serde_json::from_value(
            core.invoke(CoreCommand::EmbeddedWindowProvisionResume {
                operation_id: "runtime-provision-1".to_owned(),
                tab_id: tab_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let resumed = resumed.expect("Core must retain the exact provision receipt");
    assert_eq!(resumed.source_window_id, "runtime-provision-source");
    assert_eq!(resumed.target.window_id, created.target.window_id);
    assert_eq!(
        core.invoke(CoreCommand::EmbeddedWindowProvisionResume {
            operation_id: "runtime-provision-1".to_owned(),
            tab_id: "different-tab".to_owned(),
        })
        .unwrap_err()
        .code(),
        "RUNTIME_UI_OPERATION_ID_REUSED"
    );

    let retire = CoreCommand::EmbeddedWindowRetireProvision {
        operation_id: "runtime-provision-retire-1".to_owned(),
        window_id: created.target.window_id.clone(),
        window_generation: created.window_generation,
        topology_revision: created.topology_revision,
    };
    let (retired, retire_actions) = drive_command(Arc::clone(&core), retire, None);
    assert_eq!(retired.unwrap(), json!({ "retired": true }));
    assert!(retire_actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedRetireProvisionedWindow { window_id, .. }
            if window_id == &created.target.window_id
    )));
    assert!(!core
        .browser_runtime
        .snapshot()
        .unwrap()
        .windows
        .contains_key(&created.target.window_id));

    let (stale, stale_actions) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedWindowProvisionForTabMove {
            operation_id: "runtime-provision-stale".to_owned(),
            tab_id: "missing-tab".to_owned(),
            source_window_id: "runtime-provision-source".to_owned(),
            source_window_generation: source.window_generation,
            source_topology_revision: source.revision,
            target: crate::model::RuntimeWindowProvisionTargetRecord {
                persisted_name: None,
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
                    width: 900,
                    height: 640,
                },
                presentation: "normal".to_owned(),
            },
        },
        None,
    );
    assert_eq!(stale.unwrap_err().code(), "RUNTIME_UI_ACTION_STALE");
    assert!(stale_actions.is_empty());
    core.shutdown();
}

#[test]
fn failed_cross_window_native_projection_compensates_core_topology() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    let source_tab = "runtime-compensate-source-tab".to_owned();
    let target_tab = "runtime-compensate-target-tab".to_owned();
    seed_runtime_ui_topology(
        &core,
        "runtime-compensate-seed",
        vec![
            ("runtime-compensate-source", &source_tab, "source-role"),
            ("runtime-compensate-target", &target_tab, "target-role"),
        ],
    );
    let before = core.browser_runtime.snapshot().unwrap();
    let source = before.windows.get("runtime-compensate-source").unwrap();
    let target = before.windows.get("runtime-compensate-target").unwrap();
    let command = CoreCommand::EmbeddedTabMove {
        operation_id: "runtime-compensate-move".to_owned(),
        tab_id: source_tab.clone(),
        source_window_id: source.window_id.clone(),
        source_window_generation: source.window_generation,
        source_topology_revision: source.revision,
        target_window_id: target.window_id.clone(),
        target_window_generation: target.window_generation,
        target_topology_revision: target.revision,
        before_tab_id: None,
    };
    let mut rejected_first_projection = false;
    let (result, actions) = drive_command_with(Arc::clone(&core), command, |effect| {
        let is_projection = matches!(
            effect.action,
            CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
        );
        let failed = is_projection && !rejected_first_projection;
        if failed {
            rejected_first_projection = true;
        }
        CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: !failed,
            value_json: None,
            error: failed.then(|| CoreErrorPayload {
                code: "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_APPLY_FAILED".to_owned(),
                message: "Injected exact native projection failure.".to_owned(),
            }),
        }
    });
    let summary: crate::model::SystemRuntimeOperationSummaryRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        summary.status,
        crate::model::SystemRuntimeOperationStatus::Failed
    );
    assert_eq!(summary.stage, "runtimeTabMoveNativeProjectionCompensated");
    assert_eq!(
        summary.failure_code.as_deref(),
        Some("ELECTRON_CHROMIUM_WINDOWS_PROJECTION_APPLY_FAILED")
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
            ))
            .count(),
        2
    );
    let after = core.browser_runtime.snapshot().unwrap();
    assert_eq!(
        after
            .windows
            .get("runtime-compensate-source")
            .unwrap()
            .all_tab_ids(),
        vec![source_tab]
    );
    assert_eq!(
        after
            .windows
            .get("runtime-compensate-target")
            .unwrap()
            .all_tab_ids(),
        vec![target_tab]
    );
    core.shutdown();
}
