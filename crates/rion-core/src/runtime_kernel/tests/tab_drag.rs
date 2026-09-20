use super::{tab, topology};
use crate::{RuntimeKernel, model::RuntimeTabDragEventRecord as Event};
fn event(id: &str, phase: &str, sequence: u64) -> Event {
    Event {
        session_id: id.into(),
        tab_id: "tab-a".into(),
        source_window_id: "a".into(),
        source_window_generation: 1,
        lifecycle_epoch: 3,
        sequence,
        phase: phase.into(),
        floating_window_id: None,
    }
}
fn kernel() -> RuntimeKernel {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "initial",
            "a",
            vec![("a", 1, vec![tab("tab-a", "role-a"), tab("tab-b", "role-b")])],
        ))
        .unwrap();
    kernel
}
#[test]
fn drag_keeps_original_fence_but_resolves_the_current_owner() {
    let kernel = kernel();
    assert_eq!(
        kernel
            .tab_drag(event("drag", "start", 1), 3)
            .unwrap()
            .status,
        "applied"
    );
    kernel
        .apply(topology(
            "transfer",
            "b",
            vec![
                ("a", 2, vec![tab("tab-b", "role-b")]),
                ("b", 1, vec![tab("tab-a", "role-a")]),
            ],
        ))
        .unwrap();
    let receipt = kernel.tab_drag(event("drag", "sample", 2), 3).unwrap();
    assert_eq!(receipt.current_window_id.as_deref(), Some("b"));
    assert!(!receipt.single_tab);
    assert_eq!(
        kernel
            .tab_drag(event("drag", "sample", 2), 3)
            .unwrap()
            .status,
        "superseded"
    );
    assert_eq!(
        kernel.tab_drag(event("drag", "end", 3), 3).unwrap().status,
        "applied"
    );
    assert_eq!(
        kernel
            .tab_drag(event("drag", "sample", 4), 3)
            .unwrap()
            .status,
        "superseded"
    );
}
#[test]
fn cancelled_drag_keeps_committed_topology_and_late_start_cannot_revive_it() {
    let kernel = kernel();
    kernel.tab_drag(event("drag", "start", 1), 3).unwrap();
    let before = kernel.snapshot().unwrap();
    assert_eq!(
        kernel
            .tab_drag(event("drag", "cancel", 2), 3)
            .unwrap()
            .status,
        "cancelled"
    );
    assert_eq!(
        kernel.snapshot().unwrap().windows["a"].tab_ids(),
        before.windows["a"].tab_ids()
    );
    assert_eq!(kernel.snapshot().unwrap().revision, before.revision);
    assert_eq!(
        kernel
            .tab_drag(event("drag", "start", 1), 3)
            .unwrap()
            .status,
        "superseded"
    );
}
#[test]
fn newer_gesture_epoch_and_owner_loss_retire_only_the_matching_session() {
    let kernel = kernel();
    kernel.tab_drag(event("old", "start", 1), 3).unwrap();
    kernel.tab_drag(event("new", "start", 1), 3).unwrap();
    assert_eq!(
        kernel
            .tab_drag(event("old", "cancel", 2), 3)
            .unwrap()
            .status,
        "superseded"
    );
    assert_eq!(
        kernel
            .tab_drag(event("new", "sample", 2), 3)
            .unwrap()
            .status,
        "applied"
    );
    assert_eq!(
        kernel
            .tab_drag(event("new", "sample", 3), 4)
            .unwrap()
            .status,
        "superseded"
    );
    assert_eq!(
        kernel.tab_drag(event("new", "start", 1), 4).unwrap().status,
        "superseded"
    );
}
#[test]
fn floating_window_is_bound_once_and_single_tab_reuses_its_source() {
    let kernel = kernel();
    kernel.tab_drag(event("drag", "start", 1), 3).unwrap();
    let mut bind = event("drag", "bindFloating", 2);
    bind.floating_window_id = Some("missing".into());
    assert!(kernel.tab_drag(bind, 3).is_err());
    kernel
        .apply(topology(
            "single",
            "a",
            vec![("a", 2, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let receipt = kernel.tab_drag(event("single", "start", 1), 3).unwrap();
    assert!(receipt.single_tab);
    assert_eq!(receipt.floating_window_id.as_deref(), Some("a"));
}

#[test]
fn live_drag_preserves_pending_chromium_activation_and_completion_after_escape() {
    use crate::model::RuntimeTabActivationPhaseRecord as Phase;
    use crate::{OperationId, RuntimeIntent, RuntimeTabId};
    let kernel = kernel();
    let activation = OperationId::new("load-attempt").unwrap();
    let tab_id = RuntimeTabId::new("tab-a").unwrap();
    kernel
        .apply(RuntimeIntent::BeginTabActivation {
            operation_id: activation.clone(),
            tab_id: tab_id.clone(),
            window_id: "a".into(),
        })
        .unwrap();
    kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            operation_id: "loading".into(),
            activation_attempt_id: activation.clone(),
            tab_id: tab_id.clone(),
            phase: Phase::Loading,
        })
        .unwrap();
    kernel.tab_drag(event("drag", "start", 1), 3).unwrap();
    kernel
        .apply(topology(
            "live-transfer",
            "b",
            vec![
                ("a", 2, vec![tab("tab-b", "role-b")]),
                ("b", 1, vec![tab("tab-a", "role-a")]),
            ],
        ))
        .unwrap();
    let moved = kernel.snapshot().unwrap();
    assert_eq!(moved.tab_activations["tab-a"].phase, Phase::Loading);
    assert_eq!(moved.tab_activations["tab-a"].owner_window_id, "b");
    kernel.tab_drag(event("drag", "cancel", 2), 3).unwrap();
    kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            operation_id: "loaded".into(),
            activation_attempt_id: activation,
            tab_id,
            phase: Phase::Ready,
        })
        .unwrap();
    let finished = kernel.snapshot().unwrap();
    assert_eq!(finished.tab_activations["tab-a"].phase, Phase::Ready);
    assert!(finished.windows["b"].contains_tab("tab-a"));
}
