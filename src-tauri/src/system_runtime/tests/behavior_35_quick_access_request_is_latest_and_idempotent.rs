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
