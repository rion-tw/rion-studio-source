use std::collections::HashSet;
use std::sync::{Arc, Barrier};
use std::thread;

use serde_json::json;

use crate::model::{
    BrowserRuntimeCommand, GameWindowRoleSlotRecord, RuntimeTabActivationPhaseRecord,
    StateNormalizedRectRecord,
};

use super::{
    FocusPort, LaunchAttemptId, NativeRuntimeEvent, OperationId, RuntimeCommitStatus,
    RuntimeDesiredEffect, RuntimeIntent, RuntimeKernel, RuntimeLiveTabRecord,
    RuntimeNativeProjection, RuntimeOperationPhase, RuntimeOperationRecord,
    RuntimeSurfaceGeneration, RuntimeSurfaceLifecycle, RuntimeTabId, RuntimeTopologyCommitInput,
    RuntimeWindowGeneration, RuntimeWindowTopologyCommit, SurfacePort, TabChromePort, WindowPort,
    apply_runtime_native_projection,
};

mod generation_restore;
mod initial_activation;
mod tombstone_relaunch;
mod window_context;
mod workspace_layout;

fn tab(id: &str, source_id: &str) -> RuntimeLiveTabRecord {
    RuntimeLiveTabRecord {
        audio_muted: false,
        closable: true,
        icon_data_url: None,
        id: id.to_owned(),
        persistable: true,
        role_ids: vec![source_id.to_owned()],
        role_slots: Vec::new(),
        workspace_slots: Vec::new(),
        source_id: source_id.to_owned(),
        tab_type: "role".to_owned(),
        title: source_id.to_owned(),
        workspace_template: None,
    }
}

fn role_slot(slot_id: &str, role_id: &str, zoom: Option<f64>) -> GameWindowRoleSlotRecord {
    GameWindowRoleSlotRecord {
        slot_id: slot_id.to_owned(),
        role_id: role_id.to_owned(),
        rect: StateNormalizedRectRecord {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
        browser_zoom_percent: zoom,
    }
}

fn tab_with_role_slot(id: &str, source_id: &str) -> RuntimeLiveTabRecord {
    let mut record = tab(id, source_id);
    record.role_slots = vec![role_slot("slot-a", source_id, None)];
    record
}

fn browser_command(value: serde_json::Value) -> BrowserRuntimeCommand {
    serde_json::from_value(value).unwrap()
}

#[derive(Default)]
struct FakeNativePort {
    platform: &'static str,
    transcript: Vec<(String, RuntimeNativeProjection)>,
}

impl FakeNativePort {
    fn record(&mut self, stage: &str, projection: &RuntimeNativeProjection) {
        self.transcript.push((stage.to_owned(), projection.clone()));
    }
}

impl WindowPort for FakeNativePort {
    type Error = String;

    fn apply_window(&mut self, projection: &RuntimeNativeProjection) -> Result<(), Self::Error> {
        self.record("window", projection);
        Ok(())
    }
}

impl TabChromePort for FakeNativePort {
    type Error = String;

    fn apply_tab_chrome(
        &mut self,
        projection: &RuntimeNativeProjection,
    ) -> Result<(), Self::Error> {
        self.record("tabChrome", projection);
        Ok(())
    }
}

impl SurfacePort for FakeNativePort {
    type Error = String;

    fn apply_surfaces(&mut self, projection: &RuntimeNativeProjection) -> Result<(), Self::Error> {
        self.record("surfaces", projection);
        Ok(())
    }
}

impl FocusPort for FakeNativePort {
    type Error = String;

    fn apply_focus(&mut self, projection: &RuntimeNativeProjection) -> Result<(), Self::Error> {
        self.record("focus", projection);
        Ok(())
    }
}

fn project_all(kernel: &RuntimeKernel, ports: &mut [&mut FakeNativePort], window_ids: &[&str]) {
    let snapshot = kernel.snapshot().unwrap();
    for window_id in window_ids {
        if let Some(projection) = snapshot.native_projection(window_id) {
            for port in ports.iter_mut() {
                apply_runtime_native_projection(*port, &projection).unwrap();
            }
        }
    }
}

#[test]
fn fake_macos_and_windows_ports_replay_the_same_complete_projection_transcript() {
    let kernel = RuntimeKernel::default();
    let mut macos = FakeNativePort {
        platform: "macos",
        ..FakeNativePort::default()
    };
    let mut windows = FakeNativePort {
        platform: "windows",
        ..FakeNativePort::default()
    };
    assert_ne!(macos.platform, windows.platform);

    kernel
        .apply(topology(
            "port-seed",
            "window-a",
            vec![(
                "window-a",
                1,
                vec![tab("tab-a", "role-a"), tab("tab-b", "role-b")],
            )],
        ))
        .unwrap();
    project_all(&kernel, &mut [&mut macos, &mut windows], &["window-a"]);

    kernel
        .apply(RuntimeIntent::CommitTopology(RuntimeTopologyCommitInput {
            commit_id: "port-select-and-move".to_owned(),
            source: "appKit".to_owned(),
            primary_window_id: "window-b".to_owned(),
            windows: vec![
                RuntimeWindowTopologyCommit {
                    active_tab_id: Some("tab-a".to_owned()),
                    hidden_tab_ids: HashSet::new(),
                    tabs: vec![tab("tab-a", "role-a")],
                    ui_sequence: 2,
                    window_generation: 1,
                    window_id: "window-a".to_owned(),
                },
                RuntimeWindowTopologyCommit {
                    active_tab_id: Some("tab-b".to_owned()),
                    hidden_tab_ids: HashSet::new(),
                    tabs: vec![tab("tab-b", "role-b")],
                    ui_sequence: 1,
                    window_generation: 1,
                    window_id: "window-b".to_owned(),
                },
            ],
        }))
        .unwrap();
    project_all(
        &kernel,
        &mut [&mut macos, &mut windows],
        &["window-a", "window-b"],
    );

    kernel
        .apply(topology(
            "port-close",
            "window-a",
            vec![("window-a", 3, Vec::new())],
        ))
        .unwrap();
    project_all(&kernel, &mut [&mut macos, &mut windows], &["window-a"]);

    kernel
        .apply(topology(
            "port-restore",
            "window-a",
            vec![("window-a", 4, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    project_all(&kernel, &mut [&mut macos, &mut windows], &["window-a"]);

    assert_eq!(macos.transcript, windows.transcript);
    assert!(macos.transcript.iter().all(|(_, projection)| {
        projection.revision > 0
            && projection.window_generation > 0
            && projection.tabs.iter().filter(|tab| tab.selected).count() <= 1
    }));
}

#[test]
fn concurrent_source_admission_creates_exactly_one_logical_tab() {
    let kernel = Arc::new(RuntimeKernel::default());
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for tab_id in [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
    ] {
        let kernel = Arc::clone(&kernel);
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            barrier.wait();
            kernel
                .apply(RuntimeIntent::BrowserRuntime(browser_command(json!({
                    "type":"createTab",
                    "tabId":tab_id,
                    "sourceId":"role-a",
                    "name":"Role A",
                    "tabType":"role",
                    "roleSlots":["role-a"]
                }))))
                .unwrap()
                .browser_result
                .unwrap()
        }));
    }
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        results.iter().filter(|result| result.tab_created).count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .map(|result| result.created_tab_id.as_deref().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    assert_eq!(kernel.snapshot().unwrap().browser_runtime.tabs.len(), 1);
}

fn topology(
    operation_id: &str,
    primary_window_id: &str,
    windows: Vec<(&str, u64, Vec<RuntimeLiveTabRecord>)>,
) -> RuntimeIntent {
    RuntimeIntent::CommitTopology(RuntimeTopologyCommitInput {
        commit_id: operation_id.to_owned(),
        source: "command".to_owned(),
        primary_window_id: primary_window_id.to_owned(),
        windows: windows
            .into_iter()
            .map(|(window_id, sequence, tabs)| RuntimeWindowTopologyCommit {
                active_tab_id: tabs.first().map(|tab| tab.id.clone()),
                hidden_tab_ids: HashSet::new(),
                tabs,
                ui_sequence: sequence,
                window_generation: 1,
                window_id: window_id.to_owned(),
            })
            .collect(),
    })
}

#[test]
fn dormant_topology_creates_no_surface_and_repeated_activation_joins_one_attempt() {
    let kernel = RuntimeKernel::default();
    let tabs = (0..50)
        .map(|index| tab(&format!("tab-{index}"), &format!("role-{index}")))
        .collect::<Vec<_>>();
    kernel
        .apply(topology(
            "seed-fifty",
            "window-a",
            vec![("window-a", 1, tabs)],
        ))
        .unwrap();
    let seeded = kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-dormant".to_owned(),
            tab_ids: (0..50).map(|index| format!("tab-{index}")).collect(),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert!(seeded.desired_effects.is_empty());
    let snapshot = kernel.snapshot().unwrap();
    assert!(snapshot.logical_surfaces.is_empty());
    assert_eq!(snapshot.tab_activations.len(), 50);
    assert!(
        snapshot
            .tab_activations
            .values()
            .all(|activation| { activation.phase == RuntimeTabActivationPhaseRecord::Dormant })
    );

    let first_attempt = id::<OperationId>("activate-25");
    let first = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(snapshot.windows["window-a"].revision),
            operation_id: first_attempt.clone(),
            tab_id: id::<RuntimeTabId>("tab-25"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert!(matches!(
        first.desired_effects.as_slice(),
        [RuntimeDesiredEffect::ActivateTab { activation_attempt_id, tab_id, window_id }]
            if activation_attempt_id == &first_attempt
                && tab_id.as_str() == "tab-25"
                && window_id == "window-a"
    ));

    let after_first = kernel.snapshot().unwrap();
    let repeated = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(after_first.windows["window-a"].revision),
            operation_id: id::<OperationId>("activate-25-again"),
            tab_id: id::<RuntimeTabId>("tab-25"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert!(repeated.desired_effects.is_empty());
    assert_eq!(
        kernel.snapshot().unwrap().tab_activations["tab-25"].attempt_id,
        first_attempt
    );
}

#[test]
fn activation_completion_never_steals_selection_and_failed_retry_rotates_its_fence() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-two",
            "window-a",
            vec![(
                "window-a",
                1,
                vec![tab("tab-a", "role-a"), tab("tab-b", "role-b")],
            )],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-dormant-two".to_owned(),
            tab_ids: vec!["tab-a".to_owned(), "tab-b".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let before_b = kernel.snapshot().unwrap();
    let attempt_b = id::<OperationId>("activate-b");
    kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(before_b.windows["window-a"].revision),
            operation_id: attempt_b.clone(),
            tab_id: id::<RuntimeTabId>("tab-b"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let before_a = kernel.snapshot().unwrap();
    let attempt_a = id::<OperationId>("activate-a");
    kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(before_a.windows["window-a"].revision),
            operation_id: attempt_a.clone(),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "native-b",
            "native-attempt-b",
            "tab-b",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "native-b",
            "native-attempt-b",
            "tab-b",
            "ready",
        )))
        .unwrap();
    assert_eq!(
        kernel.snapshot().unwrap().windows["window-a"]
            .selected_tab_id
            .as_deref(),
        Some("tab-a")
    );

    kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id: attempt_a.clone(),
            operation_id: "fail-a".to_owned(),
            phase: RuntimeTabActivationPhaseRecord::Failed,
            tab_id: id::<RuntimeTabId>("tab-a"),
        })
        .unwrap();
    let before_retry = kernel.snapshot().unwrap();
    let retry_attempt = id::<OperationId>("retry-a");
    let retry = kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(before_retry.windows["window-a"].revision),
            operation_id: retry_attempt.clone(),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(retry.desired_effects.len(), 1);
    let stale = kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id: attempt_a,
            operation_id: "stale-ready-a".to_owned(),
            phase: RuntimeTabActivationPhaseRecord::Ready,
            tab_id: id::<RuntimeTabId>("tab-a"),
        })
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    let retried = &kernel.snapshot().unwrap().tab_activations["tab-a"];
    assert_eq!(retried.attempt_id, retry_attempt);
    assert_eq!(retried.phase, RuntimeTabActivationPhaseRecord::Activating);
}

#[test]
fn degraded_activation_precedes_terminal_native_failure_and_remains_degraded() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-degraded-failure",
            "window-a",
            vec![("window-a", 1, vec![tab("tab-a", "workspace-a")])],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-degraded-dormant".to_owned(),
            tab_ids: vec!["tab-a".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let activation_attempt = id::<OperationId>("activate-degraded");
    kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(before.windows["window-a"].revision),
            operation_id: activation_attempt.clone(),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "native-degraded",
            "native-attempt-degraded",
            "tab-a",
        )))
        .unwrap();

    let degraded = kernel
        .apply(RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id: activation_attempt,
            operation_id: "degrade-before-native-failure".to_owned(),
            phase: RuntimeTabActivationPhaseRecord::Degraded,
            tab_id: id::<RuntimeTabId>("tab-a"),
        })
        .unwrap();
    assert_eq!(degraded.status, RuntimeCommitStatus::Applied);
    let failed = kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "native-degraded",
            "native-attempt-degraded",
            "tab-a",
            "failed",
        )))
        .unwrap();
    assert_eq!(failed.status, RuntimeCommitStatus::Applied);

    let snapshot = kernel.snapshot().unwrap();
    assert_eq!(
        snapshot.tab_activations["tab-a"].phase,
        RuntimeTabActivationPhaseRecord::Degraded
    );
    assert_eq!(
        snapshot.operations["native-degraded"].phase,
        RuntimeOperationPhase::Failed
    );
}

#[test]
fn closing_a_dormant_tab_removes_topology_without_a_teardown_effect() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-close-dormant",
            "window-a",
            vec![(
                "window-a",
                1,
                vec![tab("tab-a", "role-a"), tab("tab-b", "role-b")],
            )],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-close-phases".to_owned(),
            tab_ids: vec!["tab-a".to_owned(), "tab-b".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let snapshot = kernel.snapshot().unwrap();
    let close = kernel
        .apply(RuntimeIntent::CloseTab {
            attempt_id: None,
            expected_revision: Some(snapshot.windows["window-a"].revision),
            operation_id: id::<OperationId>("close-dormant-b"),
            successor_tab_id: Some(id::<RuntimeTabId>("tab-a")),
            surface_generation: RuntimeSurfaceGeneration(1),
            tab_id: id::<RuntimeTabId>("tab-b"),
            window_generation: RuntimeWindowGeneration(1),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert!(close.desired_effects.is_empty());
    let after = kernel.snapshot().unwrap();
    assert!(!after.windows["window-a"].contains_tab("tab-b"));
    assert!(!after.tab_activations.contains_key("tab-b"));
    assert!(!after.tombstones.contains_key("tab-b"));
}

#[test]
fn moving_an_activating_tab_fences_its_old_owner_completion() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-move-activation",
            "window-a",
            vec![
                ("window-a", 1, vec![tab("tab-a", "role-a")]),
                ("window-b", 1, Vec::new()),
            ],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::SeedDormantTabs {
            operation_id: "seed-moving-dormant".to_owned(),
            tab_ids: vec!["tab-a".to_owned()],
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    let snapshot = kernel.snapshot().unwrap();
    kernel
        .apply(RuntimeIntent::ActivateTab {
            expected_revision: Some(snapshot.windows["window-a"].revision),
            operation_id: id::<OperationId>("activate-before-move"),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "native-before-move",
            "native-attempt-before-move",
            "tab-a",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::CommitTopology(RuntimeTopologyCommitInput {
            commit_id: "move-while-activating".to_owned(),
            source: "appKit".to_owned(),
            primary_window_id: "window-b".to_owned(),
            windows: vec![
                RuntimeWindowTopologyCommit {
                    active_tab_id: None,
                    hidden_tab_ids: HashSet::new(),
                    tabs: Vec::new(),
                    ui_sequence: 2,
                    window_generation: 1,
                    window_id: "window-a".to_owned(),
                },
                RuntimeWindowTopologyCommit {
                    active_tab_id: Some("tab-a".to_owned()),
                    hidden_tab_ids: HashSet::new(),
                    tabs: vec![tab("tab-a", "role-a")],
                    ui_sequence: 2,
                    window_generation: 1,
                    window_id: "window-b".to_owned(),
                },
            ],
        }))
        .unwrap();
    let stale = kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "native-before-move",
            "native-attempt-before-move",
            "tab-a",
            "ready",
        )))
        .unwrap();
    assert!(matches!(
        stale.status,
        RuntimeCommitStatus::Duplicate | RuntimeCommitStatus::Superseded
    ));
    let after = kernel.snapshot().unwrap();
    assert!(!after.logical_surfaces.contains_key("tab-a"));
    assert_eq!(
        after.tab_activations["tab-a"].phase,
        RuntimeTabActivationPhaseRecord::Failed
    );
    assert_eq!(after.tab_activations["tab-a"].owner_window_id, "window-b");
}

#[test]
fn cross_window_commit_and_snapshot_are_one_aggregate_revision() {
    let kernel = Arc::new(RuntimeKernel::default());
    kernel
        .apply(topology(
            "seed",
            "a",
            vec![("a", 1, vec![tab("tab-1", "role-1")]), ("b", 1, Vec::new())],
        ))
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let writer_kernel = Arc::clone(&kernel);
    let writer_barrier = Arc::clone(&barrier);
    let writer = thread::spawn(move || {
        writer_barrier.wait();
        writer_kernel
            .apply(topology(
                "move",
                "b",
                vec![("a", 2, Vec::new()), ("b", 2, vec![tab("tab-1", "role-1")])],
            ))
            .unwrap()
    });
    barrier.wait();
    for _ in 0..1_000 {
        let snapshot = kernel.snapshot().unwrap();
        let owners = snapshot
            .windows
            .values()
            .filter(|window| window.contains_tab("tab-1"))
            .count();
        assert_eq!(owners, 1);
        assert!(
            snapshot
                .windows
                .values()
                .all(|window| window.revision <= snapshot.revision)
        );
    }
    assert_eq!(writer.join().unwrap().status, RuntimeCommitStatus::Applied);
}

#[test]
fn operation_identity_is_idempotent() {
    let kernel = RuntimeKernel::default();
    let first = kernel
        .apply(topology(
            "same-operation",
            "a",
            vec![("a", 1, vec![tab("tab-1", "role-1")])],
        ))
        .unwrap();
    let duplicate = kernel
        .apply(topology(
            "same-operation",
            "a",
            vec![("a", 2, vec![tab("tab-2", "role-2")])],
        ))
        .unwrap();
    assert_eq!(first.status, RuntimeCommitStatus::Applied);
    assert_eq!(duplicate.status, RuntimeCommitStatus::Duplicate);
    assert!(kernel.snapshot().unwrap().windows["a"].contains_tab("tab-1"));
}

#[test]
fn tab_audio_is_a_revision_fenced_kernel_transaction() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-audio",
            "window-a",
            vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let applied = kernel
        .apply(RuntimeIntent::SetTabAudioMuted {
            audio_muted: true,
            expected_revision: Some(before.windows["window-a"].revision),
            operation_id: "mute-a".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(applied.status, RuntimeCommitStatus::Applied);
    assert!(applied.revision > before.revision);
    assert!(kernel.snapshot().unwrap().windows["window-a"].tabs[0].audio_muted);

    let stale = kernel
        .apply(RuntimeIntent::SetTabAudioMuted {
            audio_muted: false,
            expected_revision: Some(before.windows["window-a"].revision),
            operation_id: "stale-unmute-a".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    assert!(kernel.snapshot().unwrap().windows["window-a"].tabs[0].audio_muted);
}

#[test]
fn window_zoom_is_a_revision_fenced_kernel_transaction() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-window-zoom",
            "window-a",
            vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let applied = kernel
        .apply(RuntimeIntent::SetWindowZoomFactor {
            expected_revision: Some(before.windows["window-a"].revision),
            operation_id: "zoom-window-a".to_owned(),
            window_id: "window-a".to_owned(),
            zoom_factor: 1.25,
        })
        .unwrap();
    assert_eq!(applied.status, RuntimeCommitStatus::Applied);
    assert_eq!(
        kernel.snapshot().unwrap().windows["window-a"].window_zoom_factor,
        Some(1.25)
    );
    assert!(
        kernel
            .apply(RuntimeIntent::SetWindowZoomFactor {
                expected_revision: Some(applied.revision),
                operation_id: "invalid-window-zoom".to_owned(),
                window_id: "window-a".to_owned(),
                zoom_factor: f64::NAN,
            })
            .is_err()
    );
    assert_eq!(
        kernel.snapshot().unwrap().windows["window-a"].window_zoom_factor,
        Some(1.25)
    );
}

#[test]
fn role_zoom_is_a_revision_fenced_kernel_transaction() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-role-zoom",
            "window-a",
            vec![("window-a", 1, vec![tab_with_role_slot("tab-a", "role-a")])],
        ))
        .unwrap();
    let revision = kernel.snapshot().unwrap().windows["window-a"].revision;
    let applied = kernel
        .apply(RuntimeIntent::SetRoleZoom {
            browser_zoom_percent: Some(125.0),
            expected_revision: Some(revision),
            operation_id: "role-zoom-1".to_owned(),
            role_id: "role-a".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(applied.status, RuntimeCommitStatus::Applied);
    let stale = kernel
        .apply(RuntimeIntent::SetRoleZoom {
            browser_zoom_percent: Some(80.0),
            expected_revision: Some(revision),
            operation_id: "role-zoom-stale".to_owned(),
            role_id: "role-a".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    assert_eq!(
        kernel.snapshot().unwrap().windows["window-a"].tabs[0].role_slots[0].browser_zoom_percent,
        Some(125.0)
    );
}

#[test]
fn role_slot_replacement_is_atomic_and_rejects_partial_membership() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-role-layout",
            "window-a",
            vec![("window-a", 1, vec![tab_with_role_slot("tab-a", "role-a")])],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let invalid = kernel.apply(RuntimeIntent::ReplaceTabRoleSlots {
        expected_revision: Some(before.windows["window-a"].revision),
        operation_id: "invalid-role-layout".to_owned(),
        role_slots: vec![role_slot("slot-other", "role-other", Some(110.0))],
        tab_id: "tab-a".to_owned(),
        window_id: "window-a".to_owned(),
    });
    assert_eq!(invalid.unwrap().status, RuntimeCommitStatus::Superseded);
    let after = kernel.snapshot().unwrap();
    assert_eq!(after.revision, before.revision);
    assert_eq!(
        after.windows["window-a"].tabs[0].role_slots,
        before.windows["window-a"].tabs[0].role_slots
    );
}

#[test]
fn stale_cross_window_commit_cannot_partially_apply() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed",
            "a",
            vec![
                ("a", 2, vec![tab("tab-a", "role-a")]),
                ("b", 2, vec![tab("tab-b", "role-b")]),
            ],
        ))
        .unwrap();
    let stale = kernel
        .apply(topology(
            "stale",
            "b",
            vec![("a", 1, Vec::new()), ("b", 3, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    let snapshot = kernel.snapshot().unwrap();
    assert!(snapshot.windows["a"].contains_tab("tab-a"));
    assert!(snapshot.windows["b"].contains_tab("tab-b"));
}

#[test]
fn close_tombstone_rejects_late_attach_and_terminalizes_once() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed",
            "window-a",
            vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "launch-a",
            "attempt-a",
            "tab-a",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "launch-a",
            "attempt-a",
            "tab-a",
            "ready",
        )))
        .unwrap();
    assert_eq!(
        kernel.snapshot().unwrap().logical_surfaces["tab-a"].lifecycle,
        RuntimeSurfaceLifecycle::Ready
    );
    let close = kernel
        .apply(RuntimeIntent::CloseTab {
            attempt_id: Some(id::<LaunchAttemptId>("attempt-a")),
            expected_revision: Some(kernel.snapshot().unwrap().windows["window-a"].revision),
            operation_id: id::<OperationId>("close-a"),
            surface_generation: RuntimeSurfaceGeneration(1),
            successor_tab_id: None,
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_generation: RuntimeWindowGeneration(1),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(close.status, RuntimeCommitStatus::Applied);
    assert_eq!(close.window_ids, vec!["window-a"]);
    assert_eq!(close.desired_effects.len(), 1);
    assert_eq!(
        kernel.snapshot().unwrap().logical_surfaces["tab-a"].lifecycle,
        RuntimeSurfaceLifecycle::Closing
    );

    let late_attach = kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "launch-a",
            "attempt-a",
            "tab-a",
            "attached",
        )))
        .unwrap();
    assert_eq!(late_attach.status, RuntimeCommitStatus::Duplicate);

    let closed = kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "close-a",
            "attempt-a",
            "tab-a",
            "closed",
        )))
        .unwrap();
    assert_eq!(closed.status, RuntimeCommitStatus::Applied);
    assert_eq!(closed.window_ids, vec!["window-a"]);
    assert_eq!(closed.terminal_events.len(), 1);
    let duplicate = kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "close-a",
            "attempt-a",
            "tab-a",
            "closed",
        )))
        .unwrap();
    assert_eq!(duplicate.status, RuntimeCommitStatus::Duplicate);

    let snapshot = kernel.snapshot().unwrap();
    assert!(!snapshot.windows["window-a"].contains_tab("tab-a"));
    assert!(snapshot.tombstones.contains_key("tab-a"));
    assert!(!snapshot.logical_surfaces.contains_key("tab-a"));
    assert_eq!(
        snapshot.operations["close-a"].phase,
        RuntimeOperationPhase::Completed
    );
    assert_eq!(kernel.audit().unwrap().pending_operation_count, 0);
}

#[test]
fn removed_window_retires_terminal_close_tombstones_in_either_event_order() {
    fn close_tab(kernel: &RuntimeKernel, operation_id: &str, attempt_id: &str, tab_id: &str) {
        kernel
            .apply(RuntimeIntent::CloseTab {
                attempt_id: Some(id::<LaunchAttemptId>(attempt_id)),
                expected_revision: Some(kernel.snapshot().unwrap().windows["window-a"].revision),
                operation_id: id::<OperationId>(operation_id),
                surface_generation: RuntimeSurfaceGeneration(1),
                successor_tab_id: None,
                tab_id: id::<RuntimeTabId>(tab_id),
                window_generation: RuntimeWindowGeneration(1),
                window_id: "window-a".to_owned(),
            })
            .unwrap();
    }

    for close_event_precedes_window_removal in [false, true] {
        let kernel = RuntimeKernel::default();
        kernel
            .apply(topology(
                "seed-window-retirement",
                "window-a",
                vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
            ))
            .unwrap();
        kernel
            .apply(RuntimeIntent::BeginOperation(operation(
                "launch-a",
                "attempt-a",
                "tab-a",
            )))
            .unwrap();
        close_tab(&kernel, "close-a", "attempt-a", "tab-a");

        if close_event_precedes_window_removal {
            kernel
                .apply(RuntimeIntent::NativeEvent(native_event(
                    "close-a",
                    "attempt-a",
                    "tab-a",
                    "closed",
                )))
                .unwrap();
        }
        kernel
            .apply(RuntimeIntent::RemoveWindow {
                operation_id: "remove-window-a".to_owned(),
                window_id: "window-a".to_owned(),
            })
            .unwrap();
        if !close_event_precedes_window_removal {
            kernel
                .apply(RuntimeIntent::NativeEvent(native_event(
                    "close-a",
                    "attempt-a",
                    "tab-a",
                    "closed",
                )))
                .unwrap();
        }

        let snapshot = kernel.snapshot().unwrap();
        assert!(!snapshot.windows.contains_key("window-a"));
        assert!(!snapshot.tombstones.contains_key("tab-a"));
        assert!(!snapshot.logical_surfaces.contains_key("tab-a"));
        assert_eq!(
            snapshot.operations["close-a"].phase,
            RuntimeOperationPhase::Completed
        );
        let audit = kernel.audit().unwrap();
        assert_eq!(audit.pending_operation_count, 0);
        assert_eq!(audit.tombstone_count, 0);

        let duplicate = kernel
            .apply(RuntimeIntent::NativeEvent(native_event(
                "close-a",
                "attempt-a",
                "tab-a",
                "closed",
            )))
            .unwrap();
        assert_eq!(duplicate.status, RuntimeCommitStatus::Duplicate);
    }
}

#[test]
fn removed_window_preserves_a_close_fence_without_exact_surface_terminal() {
    let terminalizations = [
        Some((
            RuntimeOperationPhase::Indeterminate,
            "NATIVE_TAB_TEARDOWN_INDETERMINATE",
        )),
        Some((
            RuntimeOperationPhase::Cancelled,
            "NATIVE_TAB_TEARDOWN_CANCELLED",
        )),
        Some((RuntimeOperationPhase::Failed, "NATIVE_TAB_TEARDOWN_FAILED")),
        None,
    ];
    for terminalization in terminalizations {
        let kernel = RuntimeKernel::default();
        kernel
            .apply(topology(
                "seed-indeterminate-window-retirement",
                "window-a",
                vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
            ))
            .unwrap();
        kernel
            .apply(RuntimeIntent::BeginOperation(operation(
                "launch-a",
                "attempt-a",
                "tab-a",
            )))
            .unwrap();
        kernel
            .apply(RuntimeIntent::CloseTab {
                attempt_id: Some(id::<LaunchAttemptId>("attempt-a")),
                expected_revision: Some(kernel.snapshot().unwrap().windows["window-a"].revision),
                operation_id: id::<OperationId>("close-a"),
                surface_generation: RuntimeSurfaceGeneration(1),
                successor_tab_id: None,
                tab_id: id::<RuntimeTabId>("tab-a"),
                window_generation: RuntimeWindowGeneration(1),
                window_id: "window-a".to_owned(),
            })
            .unwrap();
        let expected_phase = if let Some((phase, terminal_code)) = terminalization {
            kernel
                .apply(RuntimeIntent::TerminalizeOperation {
                    operation_id: id::<OperationId>("close-a"),
                    phase,
                    terminal_code: Some(terminal_code.to_owned()),
                })
                .unwrap();
            phase
        } else {
            kernel
                .apply(RuntimeIntent::FailEventStream {
                    operation_ids: vec![id::<OperationId>("close-a")],
                    source: "nativeEventStream".to_owned(),
                    stream_id: id::<OperationId>("stream-a"),
                    terminal_code: "NATIVE_EVENT_STREAM_STOPPED".to_owned(),
                })
                .unwrap();
            RuntimeOperationPhase::Indeterminate
        };
        kernel
            .apply(RuntimeIntent::RemoveWindow {
                operation_id: "remove-window-a".to_owned(),
                window_id: "window-a".to_owned(),
            })
            .unwrap();

        let snapshot = kernel.snapshot().unwrap();
        assert!(!snapshot.windows.contains_key("window-a"));
        assert!(snapshot.tombstones.contains_key("tab-a"));
        assert_eq!(
            snapshot.logical_surfaces["tab-a"].lifecycle,
            RuntimeSurfaceLifecycle::Closing
        );
        assert_eq!(snapshot.operations["close-a"].phase, expected_phase);
        let audit = kernel.audit().unwrap();
        assert_eq!(audit.pending_operation_count, 0);
        assert_eq!(audit.logical_surface_count, 1);
        assert_eq!(audit.tombstone_count, 1);

        let late_ready = kernel
            .apply(RuntimeIntent::NativeEvent(native_event(
                "close-a",
                "attempt-a",
                "tab-a",
                "ready",
            )))
            .unwrap();
        assert_eq!(late_ready.status, RuntimeCommitStatus::Duplicate);
        assert!(kernel.snapshot().unwrap().tombstones.contains_key("tab-a"));
    }
}

#[test]
fn completed_close_allows_new_attempt_without_reopening_old_surface() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-relaunch",
            "window-a",
            vec![("window-a", 1, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "launch-old",
            "attempt-old",
            "tab-a",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::CloseTab {
            attempt_id: Some(id::<LaunchAttemptId>("attempt-old")),
            expected_revision: Some(kernel.snapshot().unwrap().windows["window-a"].revision),
            operation_id: id::<OperationId>("close-old"),
            surface_generation: RuntimeSurfaceGeneration(1),
            successor_tab_id: None,
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_generation: RuntimeWindowGeneration(1),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "close-old",
            "attempt-old",
            "tab-a",
            "closed",
        )))
        .unwrap();

    let mut relaunch = operation("launch-new", "attempt-new", "tab-a");
    relaunch.surface_generation = RuntimeSurfaceGeneration(2);
    let admitted = kernel
        .apply(RuntimeIntent::BeginOperation(relaunch))
        .unwrap();
    assert_eq!(admitted.status, RuntimeCommitStatus::Applied);
    assert!(admitted.terminal_events.is_empty());
    let snapshot = kernel.snapshot().unwrap();
    assert!(!snapshot.tombstones.contains_key("tab-a"));
    assert_eq!(
        snapshot.operations["launch-old"].phase,
        RuntimeOperationPhase::Cancelled
    );
    assert_eq!(
        snapshot.logical_surfaces["tab-a"].attempt_id.as_str(),
        "attempt-new"
    );

    let late_old_ready = kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "launch-old",
            "attempt-old",
            "tab-a",
            "ready",
        )))
        .unwrap();
    assert_eq!(late_old_ready.status, RuntimeCommitStatus::Duplicate);
    assert_eq!(
        kernel.snapshot().unwrap().logical_surfaces["tab-a"]
            .attempt_id
            .as_str(),
        "attempt-new"
    );
}

#[test]
fn stale_native_generation_cannot_advance_operation() {
    let kernel = RuntimeKernel::default();
    let mut pending = operation("launch-a", "attempt-a", "tab-a");
    pending.window_generation = RuntimeWindowGeneration(4);
    pending.surface_generation = RuntimeSurfaceGeneration(9);
    kernel
        .apply(RuntimeIntent::BeginOperation(pending))
        .unwrap();
    let stale = kernel
        .apply(RuntimeIntent::NativeEvent(NativeRuntimeEvent {
            attempt_id: id::<LaunchAttemptId>("attempt-a"),
            event_kind: "ready".to_owned(),
            operation_id: id::<OperationId>("launch-a"),
            surface_generation: RuntimeSurfaceGeneration(8),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_generation: RuntimeWindowGeneration(4),
        }))
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    assert_eq!(
        kernel.snapshot().unwrap().operations["launch-a"].phase,
        RuntimeOperationPhase::Pending
    );
}

#[test]
fn actor_restart_restores_desired_topology_and_rejects_old_stream_events() {
    let first = RuntimeKernel::default();
    first
        .apply(topology(
            "restart-seed",
            "window-a",
            vec![("window-a", 3, vec![tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let mut old_operation = operation("launch-old", "attempt-old", "tab-a");
    old_operation.window_generation = RuntimeWindowGeneration(3);
    old_operation.surface_generation = RuntimeSurfaceGeneration(7);
    first
        .apply(RuntimeIntent::BeginOperation(old_operation))
        .unwrap();
    let persisted = first.snapshot().unwrap().windows["window-a"].clone();
    drop(first);

    let restarted = RuntimeKernel::default();
    restarted
        .apply(RuntimeIntent::CommitTopology(RuntimeTopologyCommitInput {
            commit_id: "restart-restore".to_owned(),
            source: "restore".to_owned(),
            primary_window_id: persisted.window_id.clone(),
            windows: vec![RuntimeWindowTopologyCommit {
                active_tab_id: persisted.selected_tab_id,
                hidden_tab_ids: persisted.hidden_tab_ids,
                tabs: persisted.tabs,
                ui_sequence: 1,
                window_generation: persisted.window_generation,
                window_id: persisted.window_id,
            }],
        }))
        .unwrap();
    let stale = restarted
        .apply(RuntimeIntent::NativeEvent(NativeRuntimeEvent {
            attempt_id: id::<LaunchAttemptId>("attempt-old"),
            event_kind: "ready".to_owned(),
            operation_id: id::<OperationId>("launch-old"),
            surface_generation: RuntimeSurfaceGeneration(7),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_generation: RuntimeWindowGeneration(3),
        }))
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);

    let mut new_operation = operation("launch-new", "attempt-new", "tab-a");
    new_operation.window_generation = RuntimeWindowGeneration(3);
    new_operation.surface_generation = RuntimeSurfaceGeneration(8);
    restarted
        .apply(RuntimeIntent::BeginOperation(new_operation))
        .unwrap();
    let ready = restarted
        .apply(RuntimeIntent::NativeEvent(NativeRuntimeEvent {
            attempt_id: id::<LaunchAttemptId>("attempt-new"),
            event_kind: "ready".to_owned(),
            operation_id: id::<OperationId>("launch-new"),
            surface_generation: RuntimeSurfaceGeneration(8),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_generation: RuntimeWindowGeneration(3),
        }))
        .unwrap();
    assert_eq!(ready.status, RuntimeCommitStatus::Applied);
    assert_eq!(
        restarted.snapshot().unwrap().logical_surfaces["tab-a"].lifecycle,
        RuntimeSurfaceLifecycle::Ready
    );
    assert_eq!(restarted.audit().unwrap().pending_operation_count, 0);
}

#[test]
fn terminal_outcome_is_unique() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "operation-a",
            "attempt-a",
            "tab-a",
        )))
        .unwrap();
    let completed = kernel
        .apply(RuntimeIntent::TerminalizeOperation {
            operation_id: id::<OperationId>("operation-a"),
            phase: RuntimeOperationPhase::Cancelled,
            terminal_code: Some("SUPERSEDED".to_owned()),
        })
        .unwrap();
    assert_eq!(completed.terminal_events.len(), 1);
    let conflict = kernel
        .apply(RuntimeIntent::TerminalizeOperation {
            operation_id: id::<OperationId>("operation-a"),
            phase: RuntimeOperationPhase::Failed,
            terminal_code: Some("FAILED_LATE".to_owned()),
        })
        .unwrap();
    assert_eq!(conflict.status, RuntimeCommitStatus::Superseded);
    assert_eq!(conflict.terminal_events.len(), 0);
}

#[test]
fn event_stream_failure_terminalizes_only_exact_pending_operations() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "stream-failure-seed",
            "window-a",
            vec![(
                "window-a",
                1,
                vec![tab("tab-a", "role-a"), tab("tab-b", "role-b")],
            )],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "launch-a",
            "attempt-a",
            "tab-a",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "launch-b",
            "attempt-b",
            "tab-b",
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "launch-a",
            "attempt-a",
            "tab-a",
            "ready",
        )))
        .unwrap();

    let failed = kernel
        .apply(RuntimeIntent::FailEventStream {
            operation_ids: vec![
                id::<OperationId>("launch-a"),
                id::<OperationId>("launch-b"),
                id::<OperationId>("launch-b"),
                id::<OperationId>("missing"),
            ],
            source: "nativeEventStream".to_owned(),
            stream_id: id::<OperationId>("native-stream-failed-1"),
            terminal_code: "NATIVE_EVENT_STREAM_FAILED".to_owned(),
        })
        .unwrap();
    assert_eq!(failed.status, RuntimeCommitStatus::Applied);
    assert_eq!(failed.terminal_events.len(), 1);
    assert_eq!(failed.window_ids, ["window-a"]);

    let snapshot = kernel.snapshot().unwrap();
    assert_eq!(
        snapshot.operations["launch-a"].phase,
        RuntimeOperationPhase::Completed
    );
    assert_eq!(
        snapshot.operations["launch-b"].phase,
        RuntimeOperationPhase::Indeterminate
    );
    assert_eq!(
        snapshot.logical_surfaces["tab-a"].lifecycle,
        RuntimeSurfaceLifecycle::Ready
    );
    assert_eq!(
        snapshot.logical_surfaces["tab-b"].lifecycle,
        RuntimeSurfaceLifecycle::Failed
    );
    assert_eq!(kernel.audit().unwrap().pending_operation_count, 0);

    let duplicate = kernel
        .apply(RuntimeIntent::FailEventStream {
            operation_ids: vec![id::<OperationId>("launch-b")],
            source: "nativeEventStream".to_owned(),
            stream_id: id::<OperationId>("native-stream-failed-1"),
            terminal_code: "NATIVE_EVENT_STREAM_FAILED".to_owned(),
        })
        .unwrap();
    assert_eq!(duplicate.status, RuntimeCommitStatus::Duplicate);
}

#[test]
fn invalid_close_successor_cannot_partially_mutate_state() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-invalid-close",
            "window-a",
            vec![(
                "window-a",
                1,
                vec![tab("tab-a", "role-a"), tab("tab-b", "role-b")],
            )],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let result = kernel
        .apply(RuntimeIntent::CloseTab {
            attempt_id: Some(id::<LaunchAttemptId>("attempt-a")),
            expected_revision: Some(before.windows["window-a"].revision),
            operation_id: id::<OperationId>("invalid-close"),
            surface_generation: RuntimeSurfaceGeneration(1),
            successor_tab_id: Some(id::<RuntimeTabId>("missing-tab")),
            tab_id: id::<RuntimeTabId>("tab-a"),
            window_generation: RuntimeWindowGeneration(1),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(result.status, RuntimeCommitStatus::Superseded);
    let after = kernel.snapshot().unwrap();
    assert_eq!(after.revision, before.revision);
    assert!(after.windows["window-a"].contains_tab("tab-a"));
    assert!(!after.tombstones.contains_key("tab-a"));
}

#[test]
fn deterministic_state_machine_stress_audits_every_interleaving() {
    const STEPS: usize = 10_000;
    let kernel = RuntimeKernel::default();
    let window_ids = ["window-a", "window-b", "window-c"];
    let mut sequence = 0_u64;
    let mut tab_generation = 0_u64;
    let mut live_tabs = (0..12)
        .map(|index| (format!("stress-tab-{index}"), index % window_ids.len()))
        .collect::<Vec<_>>();

    for step in 0..STEPS {
        sequence += 1;
        let selected = step % live_tabs.len();
        live_tabs[selected].1 = (live_tabs[selected].1 + 1 + (step % 2)) % window_ids.len();
        let windows = window_ids
            .iter()
            .enumerate()
            .map(|(window_index, window_id)| {
                let tabs = live_tabs
                    .iter()
                    .filter(|(_, owner)| *owner == window_index)
                    .map(|(tab_id, _)| tab(tab_id, &format!("role-{tab_id}")))
                    .collect::<Vec<_>>();
                (*window_id, sequence, tabs)
            })
            .collect::<Vec<_>>();
        let commit = kernel
            .apply(topology(
                &format!("stress-topology-{step}"),
                window_ids[live_tabs[selected].1],
                windows,
            ))
            .unwrap();
        assert_eq!(commit.status, RuntimeCommitStatus::Applied);
        let mut expected_live_tab_count = live_tabs.len();

        if step % 113 == 0 {
            let (closing_tab_id, owner) = live_tabs.remove(0);
            let before_close = kernel.snapshot().unwrap();
            let close_operation_id = format!("stress-close-{step}");
            let attempt_id = format!("stress-attempt-{step}");
            let close = kernel
                .apply(RuntimeIntent::CloseTab {
                    attempt_id: Some(id::<LaunchAttemptId>(&attempt_id)),
                    expected_revision: Some(before_close.windows[window_ids[owner]].revision),
                    operation_id: id::<OperationId>(&close_operation_id),
                    surface_generation: RuntimeSurfaceGeneration(step as u64 + 1),
                    successor_tab_id: None,
                    tab_id: id::<RuntimeTabId>(&closing_tab_id),
                    window_generation: RuntimeWindowGeneration(1),
                    window_id: window_ids[owner].to_owned(),
                })
                .unwrap();
            assert_eq!(close.status, RuntimeCommitStatus::Applied);
            let closed = kernel
                .apply(RuntimeIntent::NativeEvent(NativeRuntimeEvent {
                    attempt_id: id::<LaunchAttemptId>(&attempt_id),
                    event_kind: "closed".to_owned(),
                    operation_id: id::<OperationId>(&close_operation_id),
                    surface_generation: RuntimeSurfaceGeneration(step as u64 + 1),
                    tab_id: id::<RuntimeTabId>(&closing_tab_id),
                    window_generation: RuntimeWindowGeneration(1),
                }))
                .unwrap();
            assert_eq!(closed.status, RuntimeCommitStatus::Applied);
            expected_live_tab_count -= 1;
            tab_generation += 1;
            live_tabs.push((
                format!("stress-replacement-{tab_generation}"),
                (owner + 1) % window_ids.len(),
            ));
        }

        let audit = kernel.audit().unwrap();
        assert_eq!(audit.live_tab_count, expected_live_tab_count);
        assert_eq!(audit.pending_operation_count, 0);
        assert!(audit.revision >= sequence);
    }

    let final_audit = kernel.audit().unwrap();
    assert_eq!(final_audit.pending_operation_count, 0);
    assert_eq!(final_audit.live_tab_count, live_tabs.len());
}

fn operation(operation_id: &str, attempt_id: &str, tab_id: &str) -> RuntimeOperationRecord {
    RuntimeOperationRecord {
        attempt_id: Some(id::<LaunchAttemptId>(attempt_id)),
        kind: "launch".to_owned(),
        operation_id: id::<OperationId>(operation_id),
        phase: RuntimeOperationPhase::Pending,
        surface_generation: RuntimeSurfaceGeneration(1),
        tab_id: Some(id::<RuntimeTabId>(tab_id)),
        terminal_code: None,
        window_generation: RuntimeWindowGeneration(1),
        window_id: Some("window-a".to_owned()),
    }
}

fn native_event(
    operation_id: &str,
    attempt_id: &str,
    tab_id: &str,
    event_kind: &str,
) -> NativeRuntimeEvent {
    NativeRuntimeEvent {
        attempt_id: id::<LaunchAttemptId>(attempt_id),
        event_kind: event_kind.to_owned(),
        operation_id: id::<OperationId>(operation_id),
        surface_generation: RuntimeSurfaceGeneration(1),
        tab_id: id::<RuntimeTabId>(tab_id),
        window_generation: RuntimeWindowGeneration(1),
    }
}

trait TestIdentity: Sized {
    fn from_test(value: &str) -> Self;
}

macro_rules! test_identity {
    ($type:ty) => {
        impl TestIdentity for $type {
            fn from_test(value: &str) -> Self {
                <$type>::new(value).unwrap()
            }
        }
    };
}

test_identity!(LaunchAttemptId);
test_identity!(OperationId);
test_identity!(RuntimeTabId);

fn id<T: TestIdentity>(value: &str) -> T {
    T::from_test(value)
}
