#[test]
fn quick_access_request_ledger_is_latest_wins_and_resolution_is_idempotent() {
    let mut ledger = QuickAccessRequestLedger::default();
    let first = ledger.begin(QuickAccessOrigin::RuntimeTab {
        tab_id: "tab-a".to_owned(),
    });
    let first_id = first["requestId"].as_str().unwrap().to_owned();
    assert_eq!(ledger.consume(), Some(first));
    assert!(ledger.is_presentable(&first_id));

    let latest = ledger.begin(QuickAccessOrigin::Popup {
        role_id: "role-b".to_owned(),
        webview_label: "popup-b".to_owned(),
    });
    let latest_id = latest["requestId"].as_str().unwrap().to_owned();
    assert!(!ledger.is_presentable(&first_id));
    assert_eq!(ledger.resolve(&first_id), None);
    assert_eq!(ledger.consume(), Some(latest));
    assert_eq!(ledger.consume(), None);
    assert!(ledger.is_presentable(&latest_id));
    assert_eq!(
        ledger.resolve(&latest_id),
        Some(QuickAccessOrigin::Popup {
            role_id: "role-b".to_owned(),
            webview_label: "popup-b".to_owned(),
        })
    );
    assert_eq!(ledger.resolve(&latest_id), None);
}

#[test]
fn quick_access_source_restore_requires_a_completed_native_presentation() {
    for trigger in ["game-quick-access", "quick-access-cancel"] {
        assert_eq!(
            native_focus_intent_origin(trigger),
            NativeFocusIntentOrigin::UserGesture,
            "{trigger} must preserve its exact visible user gesture"
        );
    }
    assert!(quick_access_restore_completed(
        &SystemRuntimeOperationStatus::Applied
    ));
    assert!(quick_access_restore_completed(
        &SystemRuntimeOperationStatus::Degraded
    ));
    for status in [
        SystemRuntimeOperationStatus::Cancelled,
        SystemRuntimeOperationStatus::Failed,
        SystemRuntimeOperationStatus::Indeterminate,
        SystemRuntimeOperationStatus::Superseded,
    ] {
        assert!(!quick_access_restore_completed(&status));
    }
}
