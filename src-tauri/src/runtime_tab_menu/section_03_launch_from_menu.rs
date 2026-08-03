fn launch_from_menu(
    app: &AppHandle,
    state: &crate::CoreState,
    target: EmbeddedLaunchTargetRecord,
    source_id: &str,
    workspace: bool,
) {
    let action_started = Instant::now();
    let native_action_at = chrono::Utc::now().to_rfc3339();
    let tab_type = if workspace { "workspace" } else { "role" };
    capture_launcher_action_event(
        Arc::clone(&state.core),
        "tab.launch-menu-selected",
        "A runtime launcher menu selection was received.",
        LogLevel::Debug,
        &target,
        source_id,
        workspace,
        None,
    );
    let preview = if let Some(tab_id) = state
        .runtime
        .presented_tab_for_launcher_source(source_id, tab_type)
    {
        if let Err(message) = crate::preview_and_commit_native_tab_selection(app, state, &tab_id) {
            reveal_menu_error(app, message);
            return;
        }
        state.runtime.retry_failed_tab_launch(source_id, tab_type)
    } else {
        // The launcher menu belongs to an already-live game window. Commit its
        // provisional presentation before returning from the native menu action so
        // Tokio scheduling, Core work and controller creation cannot delay the tab.
        match state
            .runtime
            .preview_tab_launch(&target, source_id, tab_type)
        {
            Ok(preview) => Some(preview),
            Err(error) => {
                let payload = rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                };
                capture_launcher_action_event(
                    Arc::clone(&state.core),
                    "tab.launch-preview-rejected",
                    "The runtime launcher could not reserve its provisional tab.",
                    LogLevel::Error,
                    &target,
                    source_id,
                    workspace,
                    Some(&payload),
                );
                crate::reveal_shell_error(app, payload);
                return;
            }
        }
    };
    let Some(preview) = preview else {
        if state
            .runtime
            .presented_tab_for_launcher_source(source_id, tab_type)
            .is_some()
        {
            return;
        }
        reveal_menu_error(app, "The provisional runtime tab could not be reserved.");
        return;
    };
    let preview_committed_ms = action_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let preview_committed_at = chrono::Utc::now().to_rfc3339();
    if let Err(message) = state.launch_intents.try_launch(LaunchIntent {
        action_started,
        native_action_at,
        preview_committed_at,
        preview_committed_ms,
        launch_preview_id: preview.launch_preview_id.clone(),
        source_id: source_id.to_owned(),
        target: target.clone(),
        workspace,
    }) {
        state
            .runtime
            .cancel_tab_launch_preview(&preview.launch_preview_id);
        let payload = rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_LAUNCH_QUEUE_FAILED".to_owned(),
            message,
        };
        capture_launcher_action_event(
            Arc::clone(&state.core),
            "tab.launch-queue-rejected",
            "The provisional tab could not enter the background launch queue.",
            LogLevel::Error,
            &target,
            source_id,
            workspace,
            Some(&payload),
        );
        crate::reveal_shell_error(app, payload);
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_launcher_action_event(
    core: Arc<AppCore>,
    event: &'static str,
    message: &'static str,
    level: LogLevel,
    target: &EmbeddedLaunchTargetRecord,
    source_id: &str,
    workspace: bool,
    error: Option<&rion_core::CoreErrorPayload>,
) {
    let context = serde_json::json!({
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "sourceId": source_id,
        "sourceType": if workspace { "workspace" } else { "role" },
        "windowId": target.window_id,
    });
    let error = error.map(|error| LogErrorDetails {
        name: error.code.clone(),
        message: error.message.clone(),
        stack: None,
        cause: None,
    });
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level,
                    source: LogSource::Browser,
                    event: event.to_owned(),
                    message: message.to_owned(),
                    context_raw_json: serde_json::to_string(&context).ok(),
                    error,
                }],
            })
            .await;
    });
}

fn reveal_menu_error(app: &AppHandle, message: impl Into<String>) {
    crate::reveal_shell_error(
        app,
        rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_MENU_FAILED".to_owned(),
            message: message.into(),
        },
    );
}

fn current_tab_muted(state: &crate::CoreState, tab_id: &str) -> Result<bool, String> {
    state.runtime.tab_audio_muted(tab_id)
}

fn snapshot(core: &rion_core::AppCore) -> Result<BrowserRuntimeSnapshot, String> {
    core.invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}

struct Labels {
    hide: &'static str,
    loading: &'static str,
    move_to_window: &'static str,
    move_to_new_window: &'static str,
    mute: &'static str,
    no_roles: &'static str,
    no_workspaces: &'static str,
    reload: &'static str,
    roles: &'static str,
    save_window: &'static str,
    stop: &'static str,
    unmute: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            hide: "隱藏分頁（保持運行）",
            loading: "正在準備角色與工作區…",
            move_to_window: "移至遊戲視窗",
            move_to_new_window: "移至新遊戲視窗",
            mute: "將分頁靜音",
            no_roles: "沒有角色",
            no_workspaces: "沒有工作區",
            reload: "重新整理",
            roles: "角色",
            save_window: "儲存為新遊戲視窗",
            stop: "停止並關閉",
            unmute: "取消分頁靜音",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            hide: "隐藏标签页（保持运行）",
            loading: "正在准备角色与工作区…",
            move_to_window: "移至游戏窗口",
            move_to_new_window: "移至新游戏窗口",
            mute: "将标签页静音",
            no_roles: "没有角色",
            no_workspaces: "没有工作区",
            reload: "重新加载",
            roles: "角色",
            save_window: "保存为新游戏窗口",
            stop: "停止并关闭",
            unmute: "取消标签页静音",
            workspaces: "工作区",
        },
        "ja" => Labels {
            hide: "タブを非表示（実行を継続）",
            loading: "ロールとワークスペースを準備中…",
            move_to_window: "ゲームウィンドウへ移動",
            move_to_new_window: "新しいゲームウィンドウへ移動",
            mute: "タブをミュート",
            no_roles: "ロールなし",
            no_workspaces: "ワークスペースなし",
            reload: "再読み込み",
            roles: "ロール",
            save_window: "新しいゲームウインドウとして保存",
            stop: "停止して閉じる",
            unmute: "タブのミュートを解除",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            hide: "Hide tab (keeps running)",
            loading: "Preparing roles and workspaces…",
            move_to_window: "Move to Game Window",
            move_to_new_window: "Move to New Game Window",
            mute: "Mute Tab",
            no_roles: "No Roles",
            no_workspaces: "No Workspaces",
            reload: "Reload",
            roles: "Roles",
            save_window: "Save as New Game Window",
            stop: "Stop and Close",
            unmute: "Unmute Tab",
            workspaces: "Workspaces",
        },
    }
}
