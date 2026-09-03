use serde_json::json;

use crate::error::CoreError;

use super::*;

const TAB_ID: &str = "10000000-0000-4000-8000-0000000000aa";

#[test]
fn browser_create_reopens_terminally_closed_saved_tab_under_a_new_attempt() {
    let kernel = terminally_closed_tab();

    let created = kernel
        .apply(RuntimeIntent::BrowserRuntime(create_tab(
            "attempt-new",
            "window-a",
        )))
        .unwrap();
    assert_eq!(created.status, RuntimeCommitStatus::Applied);
    assert_eq!(
        created.browser_result.unwrap().created_tab_id.as_deref(),
        Some(TAB_ID)
    );
    assert!(!kernel.snapshot().unwrap().tombstones.contains_key(TAB_ID));

    kernel
        .apply(topology(
            "native-reopen",
            "window-a",
            vec![("window-a", 2, vec![tab(TAB_ID, "role-a")])],
        ))
        .unwrap();
    let snapshot = kernel.snapshot().unwrap();
    assert!(snapshot.windows["window-a"].contains_tab(TAB_ID));
    assert_eq!(
        snapshot.browser_runtime.tabs[0]
            .attempt_generation
            .as_deref(),
        Some("attempt-new")
    );
}

#[test]
fn browser_create_keeps_close_tombstone_for_stale_attempt_or_wrong_window() {
    for (attempt, window_id) in [("attempt-old", "window-a"), ("attempt-new", "window-b")] {
        let kernel = terminally_closed_tab();
        let error = kernel
            .apply(RuntimeIntent::BrowserRuntime(create_tab(
                attempt, window_id,
            )))
            .unwrap_err();
        assert!(matches!(
            error,
            CoreError::Domain {
                code: "RUNTIME_TAB_RELAUNCH_STALE",
                ..
            }
        ));
        let snapshot = kernel.snapshot().unwrap();
        assert!(snapshot.tombstones.contains_key(TAB_ID));
        assert!(snapshot.browser_runtime.tabs.is_empty());
    }
}

#[test]
fn browser_create_keeps_nonterminal_close_tombstone() {
    let kernel = closing_tab();
    let error = kernel
        .apply(RuntimeIntent::BrowserRuntime(create_tab(
            "attempt-new",
            "window-a",
        )))
        .unwrap_err();
    assert!(matches!(
        error,
        CoreError::Domain {
            code: "RUNTIME_TAB_RELAUNCH_STALE",
            ..
        }
    ));
    assert!(kernel.snapshot().unwrap().tombstones.contains_key(TAB_ID));
}

fn terminally_closed_tab() -> RuntimeKernel {
    let kernel = closing_tab();
    kernel
        .apply(RuntimeIntent::NativeEvent(native_event(
            "close-old",
            "attempt-old",
            TAB_ID,
            "closed",
        )))
        .unwrap();
    kernel
}

fn closing_tab() -> RuntimeKernel {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-relaunch",
            "window-a",
            vec![("window-a", 1, vec![tab(TAB_ID, "role-a")])],
        ))
        .unwrap();
    kernel
        .apply(RuntimeIntent::BeginOperation(operation(
            "launch-old",
            "attempt-old",
            TAB_ID,
        )))
        .unwrap();
    kernel
        .apply(RuntimeIntent::CloseTab {
            attempt_id: Some(id::<LaunchAttemptId>("attempt-old")),
            expected_revision: Some(kernel.snapshot().unwrap().windows["window-a"].revision),
            operation_id: id::<OperationId>("close-old"),
            surface_generation: RuntimeSurfaceGeneration(1),
            successor_tab_id: None,
            tab_id: id::<RuntimeTabId>(TAB_ID),
            window_generation: RuntimeWindowGeneration(1),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    kernel
}

fn create_tab(attempt_generation: &str, window_id: &str) -> BrowserRuntimeCommand {
    browser_command(json!({
        "type": "createTab",
        "tabId": TAB_ID,
        "sourceId": "role-a",
        "name": "Role A",
        "tabType": "role",
        "attemptGeneration": attempt_generation,
        "windowId": window_id,
        "roleSlots": ["role-a"]
    }))
}
