fn preview_and_schedule_launcher_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<(), String> {
    let (window_id, provisional, resolved_tab_id, operation_id) = state
        .runtime
        .preview_launcher_tab_activation_background(tab_id)?;
    if !provisional {
        commit_previewed_tab_selection(
            app,
            state,
            &window_id,
            &resolved_tab_id,
            None,
        )?;
    }
    monitor_background_tab_presentation(Arc::clone(&state.runtime), operation_id);
    Ok(())
}

async fn begin_shell_launch_presentation(
    app: &AppHandle,
    state: &CoreState,
    target: &EmbeddedLaunchTargetRecord,
    source_id: &str,
    tab_type: &'static str,
) -> Result<Option<crate::system_runtime::LaunchPreviewHandle>, CoreErrorPayload> {
    for _ in 0..400 {
        if !state
            .runtime
            .launcher_source_is_closing(source_id, tab_type)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if let Some(tab_id) = state
        .runtime
        .presented_tab_for_launcher_source(source_id, tab_type)
    {
        preview_and_schedule_launcher_tab_selection(app, state, &tab_id).map_err(|message| {
            shell_error("TAURI_RUNTIME_TAB_ACTIVATION_FAILED", message)
        })?;
        return Ok(state.runtime.retry_failed_tab_launch(source_id, tab_type));
    }

    let runtime = Arc::clone(&state.runtime);
    let target = target.clone();
    let source_id = source_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.preview_tab_launch(&target, &source_id, tab_type)
    })
    .await
    .map_err(|error| shell_error("TAURI_RUNTIME_LAUNCH_PREVIEW_FAILED", error.to_string()))?
    .map(Some)
    .map_err(|error| shell_error(error.code, error.message))
}

fn cancel_shell_launch_presentation(
    state: &CoreState,
    preview: Option<&crate::system_runtime::LaunchPreviewHandle>,
) {
    if let Some(preview) = preview {
        state
            .runtime
            .cancel_tab_launch_preview(&preview.launch_preview_id);
    }
}

async fn prepare_core_launch_preview(
    state: &CoreState,
    command: &mut CoreCommand,
) -> Result<Option<crate::system_runtime::LaunchPreviewHandle>, CoreErrorPayload> {
    let request = match command {
        CoreCommand::BrowserRoleLaunch {
            role_id, target, ..
        } => Some((role_id.clone(), target.clone(), "role")),
        CoreCommand::BrowserWorkspaceLaunch {
            workspace_id,
            target,
            ..
        } => Some((workspace_id.clone(), target.clone(), "workspace")),
        _ => None,
    };
    let Some(request) = request else {
        return Ok(None);
    };
    let runtime = Arc::clone(&state.runtime);
    let preview = tauri::async_runtime::spawn_blocking(move || {
        runtime.preview_tab_launch(&request.1, &request.0, request.2)
    })
    .await
    .map_err(|error| shell_error("TAURI_RUNTIME_LAUNCH_PREVIEW_FAILED", error.to_string()))?
    .map_err(|error| shell_error(error.code, error.message))?;
    match command {
        CoreCommand::BrowserRoleLaunch {
            launch_preview_id,
            ..
        }
        | CoreCommand::BrowserWorkspaceLaunch {
            launch_preview_id,
            ..
        } => *launch_preview_id = Some(preview.launch_preview_id.clone()),
        _ => return Ok(None),
    }
    Ok(Some(preview))
}

fn launched_source_window_id(
    runtime: &SystemRuntimeExecutor,
    source_id: &str,
    tab_type: &str,
) -> Option<String> {
    runtime
        .presented_tab_for_launcher_source(source_id, tab_type)
        .and_then(|tab_id| runtime.live_tab_window_id(&tab_id))
}

async fn launch_role_from_shell(
    app: &AppHandle,
    state: &CoreState,
    window: &WebviewWindow,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let role_id = string_argument(args, 0, "Role ID")?;
    let requested_window_id = args
        .get(1)
        .and_then(|value| value.get("windowId"))
        .and_then(Value::as_str);
    let target = game_window_launch_target(app, state, window, requested_window_id)?;
    let requested_window_id = target.window_id.clone();
    let launch_preview =
        begin_shell_launch_presentation(app, state, &target, &role_id, "role").await?;
    let statuses = match Arc::clone(&state.core)
        .invoke_async(CoreCommand::BrowserRoleLaunch {
            role_id: role_id.clone(),
            target,
            launch_preview_id: launch_preview
                .as_ref()
                .map(|preview| preview.launch_preview_id.clone()),
            zoom_factor: None,
        })
        .await
    {
        Ok(statuses) => statuses,
        Err(error) => {
            cancel_shell_launch_presentation(state, launch_preview.as_ref());
            return Err(error_payload(error));
        }
    };
    let status = statuses
        .as_array()
        .and_then(|statuses| statuses.first())
        .cloned()
        .unwrap_or(Value::Null);
    let window_id = launched_source_window_id(&state.runtime, &role_id, "role")
        .unwrap_or(requested_window_id);
    Ok(json!({ "windowId": window_id, "status": status }))
}

async fn launch_workspace_from_shell(
    app: &AppHandle,
    state: &CoreState,
    window: &WebviewWindow,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let workspace_id = string_argument(args, 0, "Workspace ID")?;
    let requested_window_id = args
        .get(1)
        .and_then(|value| value.get("windowId"))
        .and_then(Value::as_str);
    let target = game_window_launch_target(app, state, window, requested_window_id)?;
    let requested_window_id = target.window_id.clone();
    let launch_preview =
        begin_shell_launch_presentation(app, state, &target, &workspace_id, "workspace").await?;
    let statuses = match Arc::clone(&state.core)
        .invoke_async(CoreCommand::BrowserWorkspaceLaunch {
            workspace_id: workspace_id.clone(),
            target,
            launch_preview_id: launch_preview
                .as_ref()
                .map(|preview| preview.launch_preview_id.clone()),
            restore_role_slots: None,
        })
        .await
    {
        Ok(statuses) => statuses,
        Err(error) => {
            cancel_shell_launch_presentation(state, launch_preview.as_ref());
            return Err(error_payload(error));
        }
    };
    let window_id = launched_source_window_id(&state.runtime, &workspace_id, "workspace")
        .unwrap_or(requested_window_id);
    Ok(json!({
        "kind": "launched",
        "windowId": window_id,
        "statuses": statuses
    }))
}
