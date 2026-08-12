use super::*;
use crate::RuntimeWindowPlacementCommitInput;
use crate::model::{DisplayTargetRecord, GameWindowPlacementRecord, StatePixelBoundsRecord};

fn single_window_topology_at_generation(
    operation_id: &str,
    window_generation: u64,
) -> RuntimeIntent {
    RuntimeIntent::CommitTopology(RuntimeTopologyCommitInput {
        commit_id: operation_id.to_owned(),
        source: "restore".to_owned(),
        primary_window_id: "window-a".to_owned(),
        windows: vec![RuntimeWindowTopologyCommit {
            active_tab_id: Some("tab-a".to_owned()),
            hidden_tab_ids: HashSet::new(),
            tabs: vec![tab("tab-a", "role-a")],
            ui_sequence: window_generation,
            window_generation,
            window_id: "window-a".to_owned(),
        }],
    })
}

#[test]
fn dormant_seed_retires_a_degraded_surface_from_the_previous_window_generation() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(single_window_topology_at_generation(
            "seed-generation-one",
            1,
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-dormant-one".to_owned(),
            tab_ids: vec!["tab-a".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let before_activation = kernel.snapshot().unwrap();
    let activation_attempt = id::<OperationId>("activate-one");
    kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(before_activation.windows["window-a"].revision),
            operation_id: activation_attempt.clone(),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "native-one",
            "native-attempt-one",
            "tab-a",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "native-one",
            "native-attempt-one",
            "tab-a",
            "ready",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id: activation_attempt,
            operation_id: "degrade-one".to_owned(),
            phase: RuntimeTabActivationPhaseRecord::Degraded,
            tab_id: id::<RuntimeTabId>("tab-a"),
        })
        .unwrap();

    kernel
        .apply(single_window_topology_at_generation(
            "restore-generation-two",
            2,
        ))
        .unwrap();
    assert_eq!(
        kernel.snapshot().unwrap().logical_surfaces["tab-a"].window_generation,
        RuntimeWindowGeneration(1)
    );
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-dormant-two".to_owned(),
            tab_ids: vec!["tab-a".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let dormant = kernel.snapshot().unwrap();
    assert!(!dormant.logical_surfaces.contains_key("tab-a"));
    assert_eq!(
        dormant.tab_activations["tab-a"].phase,
        RuntimeTabActivationPhaseRecord::Dormant
    );
    assert_eq!(
        dormant.tab_activations["tab-a"].window_generation,
        RuntimeWindowGeneration(2)
    );

    let relaunched = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(dormant.windows["window-a"].revision),
            operation_id: id::<OperationId>("activate-two"),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert!(matches!(
        relaunched.desired_effects.as_slice(),
        [RuntimeDesiredEffect::ActivateTab { tab_id, window_id, .. }]
            if tab_id.as_str() == "tab-a" && window_id == "window-a"
    ));
}

#[test]
fn unfenced_dormant_activation_survives_an_unrelated_placement_revision() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(single_window_topology_at_generation(
            "seed-placement-race",
            1,
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-dormant-placement-race".to_owned(),
            tab_ids: vec!["tab-a".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let stale_revision = kernel.snapshot().unwrap().windows["window-a"].revision;
    kernel
        .apply(RuntimeIntent::CommitPlacement(
            RuntimeWindowPlacementCommitInput {
                operation_id: "native-placement-race".to_owned(),
                placement: GameWindowPlacementRecord {
                    normal_bounds: StatePixelBoundsRecord {
                        x: 20,
                        y: 40,
                        width: 960,
                        height: 640,
                    },
                    presentation: "normal".to_owned(),
                    saved_work_area: StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 1440,
                        height: 900,
                    },
                },
                placement_sequence: 1,
                source: "native".to_owned(),
                target_display: DisplayTargetRecord {
                    fingerprint: None,
                    id: 1,
                },
                window_generation: 1,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();

    let stale = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(stale_revision),
            operation_id: id::<OperationId>("stale-placement-activation"),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);

    let current = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: None,
            operation_id: id::<OperationId>("current-placement-activation"),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert!(matches!(
        current.desired_effects.as_slice(),
        [RuntimeDesiredEffect::ActivateTab { tab_id, window_id, .. }]
            if tab_id.as_str() == "tab-a" && window_id == "window-a"
    ));
}

#[test]
fn restored_selection_cannot_overwrite_a_newer_visible_tab_choice() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(RuntimeIntent::CommitTopology(RuntimeTopologyCommitInput {
            commit_id: "seed-restored-selection-race".to_owned(),
            source: "restore".to_owned(),
            primary_window_id: "window-a".to_owned(),
            windows: vec![RuntimeWindowTopologyCommit {
                active_tab_id: Some("tab-c".to_owned()),
                hidden_tab_ids: HashSet::new(),
                tabs: vec![tab("tab-a", "role-a"), tab("tab-c", "role-c")],
                ui_sequence: 1,
                window_generation: 1,
                window_id: "window-a".to_owned(),
            }],
        }))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-restored-dormant-tabs".to_owned(),
            tab_ids: vec!["tab-a".to_owned(), "tab-c".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let restored_revision = kernel.snapshot().unwrap().windows["window-a"].revision;

    let visible_choice = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: None,
            operation_id: id::<OperationId>("visible-activate-a"),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(visible_choice.status, RuntimeCommitStatus::Applied);

    let stale_restore = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(restored_revision),
            operation_id: id::<OperationId>("automatic-restore-c"),
            tab_id: id::<RuntimeTabId>("tab-c"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(stale_restore.status, RuntimeCommitStatus::Superseded);
    let snapshot = kernel.snapshot().unwrap();
    assert_eq!(
        snapshot.windows["window-a"].selected_tab_id.as_deref(),
        Some("tab-a")
    );
    assert_eq!(
        snapshot.tab_activations["tab-c"].phase,
        RuntimeTabActivationPhaseRecord::Dormant
    );
}
