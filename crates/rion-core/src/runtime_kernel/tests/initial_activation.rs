use super::*;

#[test]
fn fresh_tab_activation_is_fenced_without_emitting_a_second_native_effect() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-fresh-activation",
            "window-a",
            vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let attempt = id::<OperationId>("fresh-activation-a");
    let started = kernel
        .apply(RuntimeIntent::BeginTabActivation {
            operation_id: attempt.clone(),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(started.status, RuntimeCommitStatus::Applied);
    assert!(started.desired_effects.is_empty());
    assert!(started.revision > before.revision);
    let activating = kernel.snapshot().unwrap();
    assert_eq!(
        activating.tab_activations["tab-a"].phase,
        RuntimeTabActivationPhaseRecord::Activating
    );
    assert_eq!(activating.windows["window-a"].revision, started.revision);

    let replay = kernel
        .apply(RuntimeIntent::BeginTabActivation {
            operation_id: attempt.clone(),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(replay.status, RuntimeCommitStatus::Duplicate);
    assert!(replay.desired_effects.is_empty());
    let conflict = kernel
        .apply(RuntimeIntent::BeginTabActivation {
            operation_id: id::<OperationId>("fresh-activation-conflict"),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(conflict.status, RuntimeCommitStatus::Superseded);

    let ready = kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id: attempt,
            operation_id: "fresh-activation-ready".to_owned(),
            phase: RuntimeTabActivationPhaseRecord::Ready,
            tab_id: id::<RuntimeTabId>("tab-a"),
        })
        .unwrap();
    assert_eq!(ready.status, RuntimeCommitStatus::Applied);
    assert_eq!(
        kernel.snapshot().unwrap().tab_activations["tab-a"].phase,
        RuntimeTabActivationPhaseRecord::Ready
    );
}
