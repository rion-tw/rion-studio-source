#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MacroInputContextLossRequest {
    reason: String,
    revision: u64,
}

impl MacroInputContextLossRequest {
    fn validate(&self) -> Result<(), CoreErrorPayload> {
        if self.revision == 0 || !matches!(self.reason.as_str(), "blur" | "hidden") {
            return Err(shell_error(
                "MACRO_INPUT_CONTEXT_LOSS_INVALID",
                "The macro input-context-loss request is invalid.",
            ));
        }
        Ok(())
    }
}

#[tauri::command]
async fn rion_macro_input_context_lost(
    webview: Webview,
    state: State<'_, CoreState>,
    capability: String,
    request: MacroInputContextLossRequest,
) -> Result<Value, CoreErrorPayload> {
    let role_id = state
        .runtime
        .authorize_overlay_request(webview.label(), &capability)
        .map_err(|message| shell_error("MACRO_INPUT_CONTEXT_LOSS_UNAUTHORIZED", message))?;
    request.validate()?;
    let runtime = Arc::clone(&state.runtime);
    let reason = request.reason.clone();
    let revision = request.revision;
    let dispatch_role_id = role_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.restore_held_keys_after_input_context_loss(
            &dispatch_role_id,
            &reason,
            revision,
        )
    })
    .await
    .map_err(|error| shell_error("MACRO_INPUT_CONTEXT_LOSS_FAILED", error.to_string()))?;

    #[cfg(feature = "desktop-e2e")]
    system_runtime::record_desktop_e2e_held_key_continuity(
        state.runtime.window_id_for_webview(webview.label()).as_deref(),
        &role_id,
        &request.reason,
        request.revision,
        &result,
    );

    serde_json::to_value(result.map_err(|error| shell_error(error.code, error.message))?)
        .map_err(|error| shell_error("MACRO_INPUT_CONTEXT_LOSS_FAILED", error.to_string()))
}
