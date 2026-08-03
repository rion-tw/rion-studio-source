fn preview_and_commit_launcher_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<(), String> {
    let (window_id, provisional, resolved_tab_id, operation_id) =
        state.runtime.preview_launcher_tab_activation(tab_id)?;
    if !provisional {
        commit_previewed_tab_selection(app, state, &window_id, &resolved_tab_id)?;
    }
    crate::runtime_operation_receipt_result(
        state.runtime.wait_native_operation_summary(&operation_id)?,
    )
}

async fn begin_shell_launch_presentation(
    app: &AppHandle,
    state: &CoreState,
    target: &EmbeddedLaunchTargetRecord,
    source_id: &str,
    tab_type: &'static str,
) -> Result<Option<String>, CoreErrorPayload> {
    if let Some(tab_id) = state
        .runtime
        .presented_tab_for_launcher_source(source_id, tab_type)
    {
        preview_and_commit_launcher_tab_selection(app, state, &tab_id).map_err(|message| {
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

fn fail_shell_launch_presentation(state: &CoreState, preview_key: Option<&str>) {
    if let Some(preview_key) = preview_key {
        state.runtime.fail_tab_launch_preview(preview_key);
    }
}

fn launched_source_window_id(
    runtime: &Value,
    source_id: &str,
    tab_type: &str,
) -> Option<String> {
    runtime["tabs"]
        .as_array()?
        .iter()
        .find(|tab| {
            (tab["sourceId"].as_str() == Some(source_id)
                && tab["tabType"].as_str() == Some(tab_type))
                || (tab_type == "role"
                    && tab["roleIds"].as_array().is_some_and(|role_ids| {
                        role_ids.iter().any(|role_id| role_id.as_str() == Some(source_id))
                    }))
        })?["windowId"]
        .as_str()
        .map(str::to_owned)
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
            zoom_factor: None,
        })
        .await
    {
        Ok(statuses) => statuses,
        Err(error) => {
            fail_shell_launch_presentation(state, launch_preview.as_deref());
            return Err(error_payload(error));
        }
    };
    let status = statuses
        .as_array()
        .and_then(|statuses| statuses.first())
        .cloned()
        .unwrap_or(Value::Null);
    let runtime = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)?;
    let window_id = launched_source_window_id(&runtime, &role_id, "role")
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
    let input = args.get(1);
    let requested_window_id = input
        .and_then(|value| value.get("windowId"))
        .and_then(Value::as_str);
    let stop_conflicts = input
        .and_then(|value| value.get("stopConflicts"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let target = game_window_launch_target(app, state, window, requested_window_id)?;
    let requested_window_id = target.window_id.clone();
    let workspace = state
        .core
        .invoke(CoreCommand::WorkspaceGet {
            id: workspace_id.clone(),
        })
        .map_err(error_payload)?;
    let workspace_role_ids = workspace["slots"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|slot| slot["roleId"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    let runtime = invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
    let already_running = runtime["tabs"].as_array().is_some_and(|tabs| {
        tabs.iter().any(|tab| {
            tab["tabType"].as_str() == Some("workspace")
                && tab["sourceId"].as_str() == Some(workspace_id.as_str())
        })
    });
    let game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)?;
    let roles = state
        .core
        .invoke(CoreCommand::RolesList)
        .map_err(error_payload)?;
    let conflicting_tabs = if already_running {
        Vec::new()
    } else {
        runtime["tabs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|tab| {
                tab["roleIds"].as_array().is_some_and(|role_ids| {
                    role_ids.iter().any(|role_id| {
                        role_id
                            .as_str()
                            .is_some_and(|role_id| workspace_role_ids.contains(role_id))
                    })
                })
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    if !conflicting_tabs.is_empty() && !stop_conflicts {
        let conflicts = conflicting_tabs
            .iter()
            .map(|tab| {
                let role_ids = tab["roleIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|role_id| workspace_role_ids.contains(*role_id))
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                let role_names = role_ids
                    .iter()
                    .filter_map(|role_id| {
                        roles.as_array()?.iter().find(|role| {
                            role["id"].as_str() == Some(role_id.as_str())
                        })?["name"]
                            .as_str()
                            .map(str::to_owned)
                    })
                    .collect::<Vec<_>>();
                let source_window_id = tab["windowId"].as_str().unwrap_or_default();
                let window_name = game_windows
                    .as_array()
                    .and_then(|windows| {
                        windows
                            .iter()
                            .find(|window| window["id"].as_str() == Some(source_window_id))
                    })
                    .and_then(|window| window["name"].as_str())
                    .unwrap_or(source_window_id);
                json!({
                    "roleIds": role_ids,
                    "roleNames": role_names,
                    "tabId": tab["id"],
                    "tabName": tab["name"],
                    "windowId": source_window_id,
                    "windowName": window_name
                })
            })
            .collect::<Vec<_>>();
        return Ok(json!({
            "kind": "conflict",
            "windowId": requested_window_id,
            "conflicts": conflicts
        }));
    }
    let (rollback_plans, recovery_records) = if stop_conflicts {
        let runtime_snapshot = serde_json::from_value::<BrowserRuntimeSnapshot>(runtime.clone())
            .map_err(|error| {
                shell_error("TAURI_RUNTIME_SNAPSHOT_INVALID", error.to_string())
            })?;
        let game_window_records =
            serde_json::from_value::<Vec<StateGameWindowRecord>>(game_windows.clone())
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))?;
        let mut affected_window_ids = HashSet::new();
        let mut plans = Vec::with_capacity(conflicting_tabs.len());
        for tab in &conflicting_tabs {
            let source_id = tab["sourceId"].as_str().ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_SNAPSHOT_INVALID",
                    "A conflicting runtime tab has no source id.",
                )
            })?;
            let tab_id = tab["id"].as_str().ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_SNAPSHOT_INVALID",
                    "A conflicting runtime tab has no tab id.",
                )
            })?;
            let window_id = tab["windowId"].as_str().ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_SNAPSHOT_INVALID",
                    "A conflicting runtime tab has no window id.",
                )
            })?;
            let runtime_window = runtime_snapshot
                .windows
                .iter()
                .find(|candidate| candidate.window_id == window_id)
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_RUNTIME_SNAPSHOT_INVALID",
                        "A conflicting runtime tab has no runtime window.",
                    )
                })?;
            let window_index = runtime_window
                .tab_ids
                .iter()
                .position(|candidate| candidate == tab_id)
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_RUNTIME_SNAPSHOT_INVALID",
                        "A conflicting runtime tab is missing from its window order.",
                    )
                })?;
            let game_window = game_window_records
                .iter()
                .find(|candidate| candidate.id == window_id)
                .ok_or_else(|| {
                    shell_error(
                        "SHELL_GAME_WINDOW_INVALID",
                        "A conflicting runtime tab has no persisted Game Window.",
                    )
                })?;
            let game_tab = game_window
                .tabs
                .iter()
                .find(|candidate| candidate.id == tab_id)
                .ok_or_else(|| {
                    shell_error(
                        "SHELL_GAME_WINDOW_INVALID",
                        "A conflicting runtime tab has no persisted tab metadata.",
                    )
                })?;
            affected_window_ids.insert(window_id.to_owned());
            plans.push(WorkspaceConflictRollbackPlan {
                active: runtime_window.active_tab_id.as_deref() == Some(tab_id),
                audio_muted: game_tab.audio_muted,
                before_tab_id: runtime_window.tab_ids.get(window_index + 1).cloned(),
                hidden: tab["hidden"].as_bool().unwrap_or(false),
                role_zoom_factor: if tab["tabType"].as_str() == Some("workspace") {
                    None
                } else {
                    Some(
                        state
                            .runtime
                            .role_zoom_factor_for_tab(tab_id, source_id)
                            .map_err(|error| {
                                shell_error("TAURI_RUNTIME_ROLE_NOT_FOUND", error)
                            })?,
                    )
                },
                role_views: state
                    .runtime
                    .runtime_tab_role_views(tab_id)
                    .map_err(|error| shell_error("TAURI_RUNTIME_ROLE_NOT_FOUND", error))?,
                source_id: source_id.to_owned(),
                tab_id: tab_id.to_owned(),
                tab_type: tab["tabType"].as_str().unwrap_or("role").to_owned(),
                target: state
                    .runtime
                    .launch_target_for_window_id(window_id)
                    .map_err(|error| shell_error("TAURI_RUNTIME_DISPLAY_NOT_FOUND", error))?,
                window_index,
            });
        }
        sort_workspace_conflict_rollback_plans(&mut plans);
        let records = game_window_records
            .into_iter()
            .filter(|record| affected_window_ids.contains(&record.id))
            .collect::<Vec<_>>();
        (plans, records)
    } else {
        (Vec::new(), Vec::new())
    };

    let mut stopped_count = 0;
    for (index, plan) in rollback_plans.iter().enumerate() {
        if let Err(error) = stop_workspace_conflict(state, plan).await {
            let rollback_errors =
                rollback_workspace_conflicts(state, &rollback_plans[..=index]).await;
            return Err(workspace_conflict_transaction_error(
                state,
                error,
                rollback_errors,
                &recovery_records,
            ));
        }
        stopped_count += 1;
    }
    let launch_preview = match begin_shell_launch_presentation(
        app,
        state,
        &target,
        &workspace_id,
        "workspace",
    )
    .await
    {
        Ok(preview) => preview,
        Err(error) => {
            let rollback_errors =
                rollback_workspace_conflicts(state, &rollback_plans[..stopped_count]).await;
            return Err(workspace_conflict_transaction_error(
                state,
                error,
                rollback_errors,
                &recovery_records,
            ));
        }
    };
    let statuses = match Arc::clone(&state.core)
        .invoke_async(CoreCommand::BrowserWorkspaceLaunch {
            workspace_id: workspace_id.clone(),
            target,
        })
        .await
    {
        Ok(statuses) => statuses,
        Err(error) => {
            fail_shell_launch_presentation(state, launch_preview.as_deref());
            let rollback_errors =
                rollback_workspace_conflicts(state, &rollback_plans[..stopped_count]).await;
            return Err(workspace_conflict_transaction_error(
                state,
                error_payload(error),
                rollback_errors,
                &recovery_records,
            ));
        }
    };
    let runtime = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)?;
    let window_id = launched_source_window_id(&runtime, &workspace_id, "workspace")
        .unwrap_or(requested_window_id);
    Ok(json!({
        "kind": "launched",
        "windowId": window_id,
        "statuses": statuses
    }))
}
