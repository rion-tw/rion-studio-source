use super::{LaunchAdmissionResolution, RuntimeLaunchEventBatch, resolve_launch_admission};
use rion_core::{BrowserLaunchAdmissionCompletion, RuntimeLaunchIntentRecord};

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
