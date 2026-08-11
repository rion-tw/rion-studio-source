use crate::model::{DisplayTargetRecord, GameWindowPlacementRecord, StatePixelBoundsRecord};
use crate::{
    RuntimeCommitStatus, RuntimeIntent, RuntimeKernel, RuntimeWindowContextInitializeInput,
    RuntimeWindowPlacementCommitInput,
};

use super::{tab, topology};

fn placement(x: i32, presentation: &str) -> GameWindowPlacementRecord {
    GameWindowPlacementRecord {
        normal_bounds: StatePixelBoundsRecord {
            x,
            y: 40,
            width: 960,
            height: 640,
        },
        saved_work_area: StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        },
        presentation: presentation.to_owned(),
    }
}

fn display(id: i64) -> DisplayTargetRecord {
    DisplayTargetRecord {
        id,
        fingerprint: None,
    }
}

#[test]
fn window_context_initialization_is_atomic_and_placement_has_an_independent_sequence() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "context-topology",
            "window-a",
            vec![("window-a", 7, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();

    let initialized = kernel
        .apply(RuntimeIntent::InitializeWindowContext(
            RuntimeWindowContextInitializeInput {
                operation_id: "context-generation-2".to_owned(),
                persisted_name: Some("Game Window 1".to_owned()),
                placement: placement(20, "normal"),
                target_display: display(1),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    assert_eq!(initialized.status, RuntimeCommitStatus::Applied);
    let after_initialize = kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(
        after_initialize.persisted_name.as_deref(),
        Some("Game Window 1")
    );
    assert_eq!(after_initialize.window_generation, 2);
    assert_eq!(after_initialize.ui_sequence, 7);
    assert_eq!(after_initialize.placement_sequence, 0);
    assert_eq!(after_initialize.tab_ids(), ["tab-a"]);

    let placement_commit = kernel
        .apply(RuntimeIntent::CommitPlacement(
            RuntimeWindowPlacementCommitInput {
                operation_id: "native-placement-1".to_owned(),
                placement: placement(120, "normal"),
                placement_sequence: 1,
                source: "appKit".to_owned(),
                target_display: display(2),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    assert_eq!(placement_commit.status, RuntimeCommitStatus::Applied);
    let after_placement = kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(after_placement.ui_sequence, 7);
    assert_eq!(after_placement.placement_sequence, 1);
    assert_eq!(after_placement.placement.unwrap().normal_bounds.x, 120);

    let same_generation_seed = kernel
        .apply(RuntimeIntent::InitializeWindowContext(
            RuntimeWindowContextInitializeInput {
                operation_id: "context-generation-2-repeat".to_owned(),
                persisted_name: None,
                placement: placement(20, "normal"),
                target_display: display(1),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    assert_eq!(same_generation_seed.status, RuntimeCommitStatus::Applied);
    let after_repeat = kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(
        after_repeat.persisted_name.as_deref(),
        Some("Game Window 1")
    );
    assert_eq!(after_repeat.placement_sequence, 1);
    assert_eq!(after_repeat.placement.unwrap().normal_bounds.x, 120);
}

#[test]
fn newer_window_context_preserves_topology_and_rejects_stale_identity() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "identity-topology",
            "window-a",
            vec![("window-a", 3, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::InitializeWindowContext(
            RuntimeWindowContextInitializeInput {
                operation_id: "identity-generation-2".to_owned(),
                persisted_name: Some("Game Window 1".to_owned()),
                placement: placement(30, "normal"),
                target_display: display(1),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::CommitPlacement(
            RuntimeWindowPlacementCommitInput {
                operation_id: "identity-placement".to_owned(),
                placement: placement(200, "maximized"),
                placement_sequence: 9,
                source: "appKit".to_owned(),
                target_display: display(2),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();

    kernel
        .apply(RuntimeIntent::InitializeWindowContext(
            RuntimeWindowContextInitializeInput {
                operation_id: "identity-generation-3".to_owned(),
                persisted_name: None,
                placement: placement(200, "maximized"),
                target_display: display(2),
                window_generation: 3,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    let advanced = kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(advanced.persisted_name.as_deref(), Some("Game Window 1"));
    assert_eq!(advanced.tab_ids(), ["tab-a"]);
    assert_eq!(advanced.ui_sequence, 3);
    assert_eq!(advanced.placement_sequence, 0);

    let stale = kernel
        .apply(RuntimeIntent::InitializeWindowContext(
            RuntimeWindowContextInitializeInput {
                operation_id: "identity-stale-generation".to_owned(),
                persisted_name: Some("Stale title".to_owned()),
                placement: placement(5, "normal"),
                target_display: display(1),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    let current = kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(current.persisted_name.as_deref(), Some("Game Window 1"));
    assert_eq!(current.window_generation, 3);
}
