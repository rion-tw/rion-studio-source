fn preview_and_schedule_launcher_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<(), String> {
    let (window_id, provisional, resolved_tab_id, operation_id) =
        match state.runtime.preview_launcher_tab_activation_background(tab_id) {
            Err(message) if stale_live_tab_action_error(&message) => return Ok(()),
            result => result?,
        };
    if !provisional {
        commit_previewed_tab_selection(
            app,
            state,
            &window_id,
            &resolved_tab_id,
        )?;
    }
    monitor_background_tab_presentation(Arc::clone(&state.runtime), operation_id);
    Ok(())
}

async fn launch_role_from_shell(
    _app: &AppHandle,
    state: &CoreState,
    _window: &WebviewWindow,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let role_id = string_argument(args, 0, "Role ID")?;
    let destination = runtime_launch_destination_argument(args)?;
    let outcome = state
        .launch_intents
        .submit(&role_id, false, destination, "renderer-role-list")
        .await
        ?;
    let status = outcome
        .statuses
        .as_array()
        .and_then(|statuses| statuses.first())
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "windowId": outcome.receipt.window_id,
        "status": status,
        "launchReceipt": outcome.receipt
    }))
}

async fn launch_workspace_from_shell(
    _app: &AppHandle,
    state: &CoreState,
    _window: &WebviewWindow,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let workspace_id = string_argument(args, 0, "Workspace ID")?;
    let destination = runtime_launch_destination_argument(args)?;
    let outcome = state
        .launch_intents
        .submit(
            &workspace_id,
            true,
            destination,
            "renderer-workspace-list",
        )
        .await
        ?;
    Ok(json!({
        "kind": "launched",
        "windowId": outcome.receipt.window_id,
        "statuses": outcome.statuses,
        "launchReceipt": outcome.receipt
    }))
}

fn runtime_launch_destination_argument(
    args: &[Value],
) -> Result<rion_core::RuntimeLaunchDestinationRequest, CoreErrorPayload> {
    match args.get(1) {
        None | Some(Value::Null) => Ok(rion_core::RuntimeLaunchDestinationRequest::Automatic),
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
            shell_error(
                "TAURI_RUNTIME_LAUNCH_DESTINATION_INVALID",
                format!("Runtime launch destination is invalid: {error}"),
            )
        }),
    }
}
