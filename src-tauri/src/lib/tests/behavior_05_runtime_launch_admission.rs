use super::{
    LaunchAdmissionResolution, RuntimeLaunchEventBatch, SavedWindowHydrationStep,
    resolve_launch_admission, saved_window_hydration_plan,
};
use crate::system_runtime::LaunchPreviewHandle;
use rion_core::{
    BrowserLaunchAdmissionCompletion, RuntimeLaunchIntentRecord, StateGameWindowRecord,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[test]
fn launch_diagnostics_queue_in_order_without_waiting_for_the_logging_worker() {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let intent = RuntimeLaunchIntentRecord {
        intent_id: "intent-a".to_owned(),
        adapter_sequence: 1,
        source_id: "workspace-a".to_owned(),
        source_type: "workspace".to_owned(),
    };
    let mut events = RuntimeLaunchEventBatch::new(sender);
    events.record("launch.intent-admitted", &intent, None, Some("appkit"));
    events.record(
        "launch.destination-resolved",
        &intent,
        Some("window-2"),
        Some("authenticated-source-window"),
    );

    events.submit();

    let entries = receiver
        .try_recv()
        .expect("the batch must be queued before the logging worker runs");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].event, "launch.intent-admitted");
    assert_eq!(entries[1].event, "launch.destination-resolved");
}

#[test]
fn launch_latency_uses_the_enqueue_clock_instead_of_log_write_time() {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let intent = RuntimeLaunchIntentRecord {
        intent_id: "intent-latency".to_owned(),
        adapter_sequence: 2,
        source_id: "role-latency".to_owned(),
        source_type: "role".to_owned(),
    };
    let started_at = Instant::now() - Duration::from_millis(60);
    let mut events = RuntimeLaunchEventBatch::with_timing(sender, started_at, 37);
    events.record("launch.intent-admitted", &intent, None, Some("renderer-role-list"));
    events.submit();

    let entries = receiver.try_recv().expect("latency event must be queued");
    let context: Value = serde_json::from_str(
        entries[0]
            .context_raw_json
            .as_deref()
            .expect("latency context must be serialized"),
    )
    .expect("latency context must be valid JSON");
    assert_eq!(context["queueWaitMs"], 37);
    assert!(context["elapsedMs"].as_u64().is_some_and(|elapsed| elapsed >= 60));
    assert!(context.get("url").is_none());
}

fn hydration_window() -> StateGameWindowRecord {
    serde_json::from_value(json!({
        "id": "window-latency",
        "name": "Latency",
        "targetDisplay": { "id": 1 },
        "placement": {
            "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
            "presentation": "normal"
        },
        "tabs": [
            {
                "id": "tab-first", "tabType": "role", "sourceId": "role-first",
                "name": "First", "hidden": false, "audioMuted": false,
                "roleSlots": [{
                    "slotId": "slot-first", "roleId": "role-first",
                    "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }]
            },
            {
                "id": "tab-active", "tabType": "role", "sourceId": "role-active",
                "name": "Active", "hidden": false, "audioMuted": false,
                "roleSlots": [{
                    "slotId": "slot-active", "roleId": "role-active",
                    "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }]
            }
        ],
        "activeTabId": "tab-active",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    }))
    .expect("hydration window fixture must be valid")
}

fn hydration_step_identity(step: &SavedWindowHydrationStep<'_>) -> (String, bool) {
    match step {
        SavedWindowHydrationStep::Appended { preview } => {
            (preview.provisional_tab_id.clone(), true)
        }
        SavedWindowHydrationStep::Saved { foreground, tab } => {
            (tab.id.clone(), *foreground)
        }
    }
}

#[test]
fn dormant_hydration_always_schedules_the_requested_foreground_first() {
    let window = hydration_window();
    let existing = saved_window_hydration_plan(&window, Some("tab-active"), None);
    assert_eq!(
        existing
            .steps
            .iter()
            .map(hydration_step_identity)
            .collect::<Vec<_>>(),
        [("tab-active".to_owned(), true), ("tab-first".to_owned(), false)]
    );

    let preview = LaunchPreviewHandle {
        launch_preview_id: "attempt-appended".to_owned(),
        provisional_tab_id: "tab-appended".to_owned(),
        source_key: "role:role-appended".to_owned(),
    };
    let appended = saved_window_hydration_plan(&window, None, Some(&preview));
    assert_eq!(
        appended
            .steps
            .iter()
            .map(hydration_step_identity)
            .collect::<Vec<_>>(),
        [
            ("tab-appended".to_owned(), true),
            ("tab-active".to_owned(), false),
            ("tab-first".to_owned(), false),
        ]
    );
}

#[test]
fn pending_launch_admission_keeps_the_provisional_owner() {
    assert_eq!(
        resolve_launch_admission(
            BrowserLaunchAdmissionCompletion::PendingNativeCompletion,
            "admitted",
            "tab-a",
        ),
        LaunchAdmissionResolution::AwaitNativeCompletion,
    );
}

#[test]
fn existing_or_joined_admission_returns_the_kernel_tab_owner() {
    for completion in [
        BrowserLaunchAdmissionCompletion::PendingNativeCompletion,
        BrowserLaunchAdmissionCompletion::Completed,
    ] {
        assert_eq!(
            resolve_launch_admission(completion, "existing", "stable-tab"),
            LaunchAdmissionResolution::UseStableOwner("stable-tab".to_owned()),
        );
    }
}

#[test]
fn completed_launch_without_a_live_owner_is_an_explicit_divergence() {
    assert_eq!(
        resolve_launch_admission(BrowserLaunchAdmissionCompletion::Completed, "admitted", ""),
        LaunchAdmissionResolution::OwnershipDiverged,
    );
}
