fn handle_menu_event(app: &AppHandle, core: &Arc<AppCore>, id: &str) {
    match id {
        "open-app" | "review-terms" => show_main_window(app),
        "restore-windows" => {
            show_main_window(app);
            let _ = app.emit("rion://quick-menu-restore", ());
        }
        _ if id.starts_with(SHOW_DISPLAY_PREFIX) => {
            let window_id = id.trim_start_matches(SHOW_DISPLAY_PREFIX).to_owned();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(state) = app.try_state::<crate::CoreState>() else {
                    return;
                };
                let is_live = state
                    .runtime
                    .live_window_tab_ids(&window_id)
                    .is_ok_and(|tab_ids| !tab_ids.is_empty());
                if is_live {
                    let runtime = Arc::clone(&state.runtime);
                    let mut failure = None;
                    for attempt in 0_u64..8 {
                        match runtime.focus_live_runtime_window(&window_id) {
                            Ok(()) => return,
                            Err(error) => failure = Some(error),
                        }
                        tokio::time::sleep(Duration::from_millis(
                            25_u64.saturating_mul(1_u64 << attempt.min(5)),
                        ))
                        .await;
                    }
                    eprintln!(
                        "Quick Menu live window focus remains pending: window={window_id} error={}",
                        failure.unwrap_or_else(|| "native host unavailable".to_owned())
                    );
                    return;
                }
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                let _ = crate::restore_saved_game_windows(
                    &state,
                    &window,
                    &[serde_json::json!({ "scope": "window", "windowId": window_id })],
                )
                .await;
            });
        }
        _ if id.starts_with(RESTORE_WINDOW_PREFIX) => {
            let window_id = id.trim_start_matches(RESTORE_WINDOW_PREFIX).to_owned();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(state) = app.try_state::<crate::CoreState>() else {
                    return;
                };
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                let _ = crate::restore_saved_game_windows(
                    &state,
                    &window,
                    &[serde_json::json!({ "scope": "window", "windowId": window_id })],
                )
                .await;
            });
        }
        "quit-app" => app.exit(0),
        "stop-all" => {
            let role_ids = core
                .invoke(CoreCommand::BrowserStatuses)
                .ok()
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|status| status["roleId"].as_str().map(str::to_owned))
                .collect::<Vec<_>>();
            let core = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                for role_id in role_ids {
                    let _ = core
                        .invoke_async(CoreCommand::BrowserRoleStop { role_id })
                        .await;
                }
            });
        }
        _ if id.starts_with(STOP_WORKSPACE_PREFIX) => {
            stop_workspace(core, id.trim_start_matches(STOP_WORKSPACE_PREFIX));
        }
        _ if id.starts_with(ROLE_PREFIX) || id.starts_with(WORKSPACE_PREFIX) => {
            if !legal_is_accepted(core) {
                show_main_window(app);
                return;
            }
            let source_id = id
                .strip_prefix(ROLE_PREFIX)
                .or_else(|| id.strip_prefix(WORKSPACE_PREFIX))
                .unwrap_or_default()
                .to_owned();
            if source_id.is_empty() {
                return;
            }
            let workspace = id.starts_with(WORKSPACE_PREFIX);
            let Some(state) = app.try_state::<crate::CoreState>() else {
                return;
            };
            let Some(main_window) = app.get_webview_window("main") else {
                return;
            };
            let target = match crate::game_window_launch_target(app, &state, &main_window, None) {
                Ok(target) => target,
                Err(error) => {
                    crate::reveal_shell_error(app, error);
                    return;
                }
            };
            let runtime = Arc::clone(&state.runtime);
            let core = Arc::clone(core);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Native menu events run on the main thread. Never wait there for the
                // native creation lane or a host-window callback.
                let preview_runtime = Arc::clone(&runtime);
                let preview_target = target.clone();
                let preview_source_id = source_id.clone();
                let preview = match tauri::async_runtime::spawn_blocking(move || {
                    preview_runtime.preview_tab_launch(
                        &preview_target,
                        &preview_source_id,
                        if workspace { "workspace" } else { "role" },
                    )
                })
                .await
                {
                    Ok(Ok(preview)) => preview,
                    Ok(Err(error)) => {
                        crate::reveal_shell_error(
                            &app,
                            rion_core::CoreErrorPayload {
                                code: error.code.to_owned(),
                                message: error.message,
                            },
                        );
                        return;
                    }
                    Err(error) => {
                        crate::reveal_shell_error(
                            &app,
                            rion_core::CoreErrorPayload {
                                code: "TAURI_RUNTIME_LAUNCH_PREVIEW_FAILED".to_owned(),
                                message: error.to_string(),
                            },
                        );
                        return;
                    }
                };
                let command = if workspace {
                    CoreCommand::BrowserWorkspaceLaunch {
                        workspace_id: source_id,
                        target,
                        launch_preview_id: Some(preview.launch_preview_id.clone()),
                        restore_role_slots: None,
                    }
                } else {
                    CoreCommand::BrowserRoleLaunch {
                        role_id: source_id,
                        target,
                        launch_preview_id: Some(preview.launch_preview_id.clone()),
                        zoom_factor: None,
                    }
                };
                let result = core.invoke_async(command).await;
                if let Err(error) = result {
                    runtime.cancel_tab_launch_preview(&preview.launch_preview_id);
                    crate::reveal_shell_error(&app, error.payload());
                }
            });
        }
        _ => {}
    }
}

fn legal_is_accepted(core: &AppCore) -> bool {
    core.invoke(CoreCommand::LegalAcceptanceStatus)
        .ok()
        .and_then(|value| value["isAccepted"].as_bool())
        .unwrap_or(false)
}

fn status_state<'a>(statuses: &'a serde_json::Value, key: &str, id: &str) -> Option<&'a str> {
    statuses.as_array()?.iter().find_map(|status| {
        (status[key].as_str() == Some(id))
            .then(|| status["state"].as_str())
            .flatten()
    })
}

fn stop_workspace(core: &Arc<AppCore>, workspace_id: &str) {
    if workspace_id.is_empty() {
        return;
    }
    let core = Arc::clone(core);
    let workspace_id = workspace_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::BrowserWorkspaceStop { workspace_id })
            .await;
    });
}

fn show_main_window(app: &AppHandle) {
    crate::request_main_window_show(app, true, "quick-menu");
}

#[derive(Clone, Copy)]
struct Labels {
    no_roles: &'static str,
    no_windows: &'static str,
    no_workspaces: &'static str,
    open: &'static str,
    quit: &'static str,
    review_terms: &'static str,
    roles: &'static str,
    stop_all: &'static str,
    temporary_window: &'static str,
    windows: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            no_roles: "沒有角色",
            no_windows: "沒有視窗",
            no_workspaces: "沒有工作區",
            open: "開啟 Rion Studio",
            quit: "結束 Rion Studio",
            review_terms: "啟動前請先檢閱條款",
            roles: "角色",
            stop_all: "停止所有執行中的角色",
            temporary_window: "臨時視窗",
            windows: "視窗",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            no_roles: "没有角色",
            no_windows: "没有窗口",
            no_workspaces: "没有工作区",
            open: "打开 Rion Studio",
            quit: "退出 Rion Studio",
            review_terms: "启动前请先查看条款",
            roles: "角色",
            stop_all: "停止所有运行中的角色",
            temporary_window: "临时窗口",
            windows: "窗口",
            workspaces: "工作区",
        },
        "ja" => Labels {
            no_roles: "ロールなし",
            no_windows: "ウインドウなし",
            no_workspaces: "ワークスペースなし",
            open: "Rion Studio を開く",
            quit: "Rion Studio を終了",
            review_terms: "起動前に利用規約を確認",
            roles: "ロール",
            stop_all: "実行中のロールをすべて停止",
            temporary_window: "一時ウインドウ",
            windows: "ウインドウ",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            no_roles: "No Roles",
            no_windows: "No Windows",
            no_workspaces: "No Workspaces",
            open: "Open Rion Studio",
            quit: "Quit Rion Studio",
            review_terms: "Review terms before launching",
            roles: "Roles",
            stop_all: "Stop All Running Roles",
            temporary_window: "Temporary Window",
            windows: "Windows",
            workspaces: "Workspaces",
        },
    }
}
