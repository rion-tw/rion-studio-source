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

fn presentation_kernel() -> RuntimeKernel {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(RuntimeIntent::InitializeWindowContext(
            RuntimeWindowContextInitializeInput {
                operation_id: "presentation-context".to_owned(),
                persisted_name: Some("Presentation Window".to_owned()),
                placement: placement(30, "normal"),
                target_display: display(1),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    kernel
}

#[test]
fn acknowledged_presentation_preserves_native_placement_sequence_and_geometry() {
    let kernel = presentation_kernel();
    for (index, presentation) in ["maximized", "fullscreen", "normal", "normal"]
        .into_iter()
        .enumerate()
    {
        let before = kernel.snapshot_window("window-a").unwrap().unwrap();
        let operation_id = format!("presentation-{index}");
        let intent = RuntimeIntent::SetWindowPresentation {
            expected_revision: before.revision,
            operation_id: operation_id.clone(),
            presentation: presentation.to_owned(),
            window_generation: before.window_generation,
            window_id: before.window_id.clone(),
        };
        let applied = kernel.apply(intent.clone()).unwrap();
        assert_eq!(applied.status, RuntimeCommitStatus::Applied);
        let after = kernel.snapshot_window("window-a").unwrap().unwrap();
        assert!(after.revision > before.revision);
        assert_eq!(after.placement_sequence, 0);
        assert_eq!(after.target_display.unwrap().id, 1);
        assert_eq!(after.persisted_name.as_deref(), Some("Presentation Window"));
        let after_placement = after.placement.unwrap();
        let before_placement = before.placement.unwrap();
        assert_eq!(after_placement.presentation, presentation);
        assert_eq!(
            after_placement.normal_bounds,
            before_placement.normal_bounds
        );
        assert_eq!(
            after_placement.saved_work_area,
            before_placement.saved_work_area
        );
        assert_eq!(
            kernel.apply(intent).unwrap().status,
            RuntimeCommitStatus::Duplicate
        );
        assert_eq!(
            kernel
                .snapshot_window("window-a")
                .unwrap()
                .unwrap()
                .revision,
            applied.revision
        );
    }
    let native = kernel
        .apply(RuntimeIntent::CommitPlacement(
            RuntimeWindowPlacementCommitInput {
                operation_id: "next-native-placement".to_owned(),
                placement: placement(120, "normal"),
                placement_sequence: 1,
                source: "appKit".to_owned(),
                target_display: display(2),
                window_generation: 2,
                window_id: "window-a".to_owned(),
            },
        ))
        .unwrap();
    assert_eq!(native.status, RuntimeCommitStatus::Applied);
    let current = kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(current.placement_sequence, 1);
    assert_eq!(current.placement.unwrap().normal_bounds.x, 120);
}

#[test]
fn acknowledged_presentation_requires_exact_window_revision_generation_and_context() {
    let kernel = presentation_kernel();
    let before = kernel.snapshot_window("window-a").unwrap().unwrap();
    for (index, window_id, window_generation, expected_revision) in [
        (0, "window-a", 1, before.revision),
        (1, "window-a", 3, before.revision),
        (2, "window-a", 2, before.revision - 1),
        (3, "window-a", 2, before.revision + 1),
        (4, "missing-window", 2, before.revision),
    ] {
        let result = kernel
            .apply(RuntimeIntent::SetWindowPresentation {
                expected_revision,
                operation_id: format!("stale-presentation-{index}"),
                presentation: "fullscreen".to_owned(),
                window_generation,
                window_id: window_id.to_owned(),
            })
            .unwrap();
        assert_eq!(result.status, RuntimeCommitStatus::Superseded);
        assert_eq!(
            kernel
                .snapshot_window("window-a")
                .unwrap()
                .unwrap()
                .revision,
            before.revision
        );
    }
    kernel
        .apply(RuntimeIntent::EnsureWindow {
            operation_id: "uninitialized-window".to_owned(),
            window_id: "no-placement".to_owned(),
        })
        .unwrap();
    let uninitialized = kernel.snapshot_window("no-placement").unwrap().unwrap();
    let result = kernel
        .apply(RuntimeIntent::SetWindowPresentation {
            expected_revision: uninitialized.revision,
            operation_id: "uninitialized-presentation".to_owned(),
            presentation: "fullscreen".to_owned(),
            window_generation: uninitialized.window_generation,
            window_id: uninitialized.window_id,
        })
        .unwrap();
    assert_eq!(result.status, RuntimeCommitStatus::Superseded);
    let error = kernel
        .apply(RuntimeIntent::SetWindowPresentation {
            expected_revision: before.revision,
            operation_id: "invalid-presentation".to_owned(),
            presentation: "minimized".to_owned(),
            window_generation: before.window_generation,
            window_id: before.window_id,
        })
        .unwrap_err();
    assert!(matches!(error, crate::CoreError::InvalidInput(_)));
}
