#[cfg(any(feature = "desktop-e2e", test))]
fn runtime_tab_activation_terminal_details(
    tab_id: &str,
    error: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "error": error,
        "status": if error.is_none() { "completed" } else { "failed" },
        "tabId": tab_id,
    })
}
