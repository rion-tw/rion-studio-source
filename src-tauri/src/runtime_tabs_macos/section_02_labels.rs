struct Labels {
    add: &'static str,
    muted: &'static str,
    playing: &'static str,
    close: &'static str,
    scroll_left: &'static str,
    scroll_right: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            add: "開啟角色或工作區",
            muted: "分頁已靜音",
            playing: "正在播放音訊",
            close: "停止並關閉分頁",
            scroll_left: "向左捲動分頁",
            scroll_right: "向右捲動分頁",
        },
        "zh-CN" => Labels {
            add: "打开角色或工作区",
            muted: "标签页已静音",
            playing: "正在播放音频",
            close: "停止并关闭标签页",
            scroll_left: "向左滚动标签页",
            scroll_right: "向右滚动标签页",
        },
        "ja" => Labels {
            add: "ロールまたはワークスペースを開く",
            muted: "タブはミュート中",
            playing: "音声を再生中",
            close: "停止してタブを閉じる",
            scroll_left: "タブを左へスクロール",
            scroll_right: "タブを右へスクロール",
        },
        _ => Labels {
            add: "Open role or workspace",
            muted: "Tab muted",
            playing: "Playing audio",
            close: "Stop and close tab",
            scroll_left: "Scroll tabs left",
            scroll_right: "Scroll tabs right",
        },
    }
}

struct NativeTabStrings {
    icon: Option<CString>,
    id: CString,
    name: CString,
    tab_type: CString,
    tooltip: CString,
    workspace_template: Option<CString>,
}

fn c_string(value: &str) -> CString {
    CString::new(value.replace('\0', "")).expect("sanitized string contains no NUL")
}

unsafe extern "C" fn action_callback(
    context: *mut c_void,
    action_type: *const c_char,
    session_id: *const c_char,
    tab_id: *const c_char,
    source_window_id: *const c_char,
    target_window_id: *const c_char,
    before_tab_id: *const c_char,
    ordered_tab_ids_json: *const c_char,
    screen_x: f64,
    screen_y: f64,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
    tab_width: f64,
    tab_height: f64,
    cancelled: bool,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() || action_type.is_null() {
            return;
        }
        let context = unsafe { &*(context as *const CallbackContext) };
        let action_type = unsafe { CStr::from_ptr(action_type) }
            .to_string_lossy()
            .into_owned();
        let session_id = c_string_from_pointer(session_id);
        let tab_id = c_string_from_pointer(tab_id);
        let before_tab_id = c_string_from_pointer(before_tab_id);
        let ordered_tab_ids = c_string_from_pointer(ordered_tab_ids_json)
            .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok());
        let source_window_id = c_string_from_pointer(source_window_id);
        let target_window_id = c_string_from_pointer(target_window_id);
        if matches!(
            action_type.as_str(),
            "modifierHandoffStarted" | "modifierHandoffCompleted" | "modifierHandoffAbandoned"
        ) {
            let (Some(window_id), Some(state)) = (
                source_window_id.as_deref(),
                context.app.try_state::<crate::CoreState>(),
            ) else {
                return;
            };
            if action_type == "modifierHandoffStarted" {
                if let Some(tab_id) = tab_id.as_deref() {
                    state
                        .runtime
                        .begin_macos_shortcut_modifier_handoff(window_id, tab_id);
                }
            } else {
                let runtime = Arc::clone(&state.runtime);
                let window_id = window_id.to_owned();
                let abandoned = action_type == "modifierHandoffAbandoned";
                tauri::async_runtime::spawn_blocking(move || {
                    runtime.finish_macos_shortcut_modifier_handoff(
                        &window_id,
                        tab_id.as_deref(),
                        abandoned,
                    );
                });
            }
            return;
        }
        if action_type == "openLauncher" {
            // AppKit invokes this callback inside the plus button's mouse event. The launcher
            // model and native Menu are prebuilt, so popup can run in this same event turn
            // instead of entering Tauri's async queue behind surface setup or navigation work.
            let Some(window_id) = source_window_id else {
                return;
            };
            if let Err(message) = crate::runtime_tab_menu::open_launcher(&context.app, &window_id) {
                crate::reveal_shell_error(
                    &context.app,
                    crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                );
            }
            return;
        }
        if action_type == "stop"
            && let (Some(tab_id), Some(state)) = (
                tab_id.as_deref(),
                context.app.try_state::<crate::CoreState>(),
            )
        {
            // AppKit already removed the visible tab. Commit its tombstone to the live
            // topology in this callback turn; Core stop and surface release continue on the
            // background action lane and cannot restore the visible tab.
            if let Err(error) = state.runtime.preview_tab_close(tab_id) {
                eprintln!("Live AppKit tab close intent will retry in background: tab={tab_id} error={error}");
            }
        }
        dispatch_action(
            context.app.clone(),
            context.window_label.clone(),
            NativeTabAction {
                action_type,
                session_id,
                tab_id,
                source_window_id,
                target_window_id,
                before_tab_id,
                ordered_tab_ids,
                screen_x,
                screen_y,
                grab_ratio_x,
                grab_ratio_y,
                tab_width,
                tab_height,
                cancelled,
                event_sequence: 0,
                intent_generation: 0,
            },
        );
    }));
}

unsafe extern "C" fn layout_callback(
    context: *mut c_void,
    _height_inset: f64,
    _y_offset: f64,
    valid: bool,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() || !valid {
            return;
        }
        let context = unsafe { &*(context as *const CallbackContext) };
        let app = context.app.clone();
        let label = context.window_label.clone();
        let layout_updates = Arc::clone(&context.layout_updates);
        if !request_layout_update(&layout_updates) {
            return;
        }
        tauri::async_runtime::spawn_blocking(move || {
            loop {
                layout_updates.requested.store(false, Ordering::Release);
                if let Some(window) = app.get_window(&label)
                    && let Ok(size) = window.inner_size()
                    && let Some(state) = app.try_state::<crate::CoreState>()
                {
                    state.runtime.resize_window(&label, size.width, size.height);
                }
                if !continue_layout_updates(&layout_updates) {
                    break;
                }
            }
        });
    }));
}

fn request_layout_update(state: &LayoutUpdateState) -> bool {
    state.requested.store(true, Ordering::Release);
    state
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn continue_layout_updates(state: &LayoutUpdateState) -> bool {
    if state.requested.swap(false, Ordering::AcqRel) {
        return true;
    }
    state.running.store(false, Ordering::Release);
    state.requested.load(Ordering::Acquire)
        && state
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
}

fn c_string_from_pointer(value: *const c_char) -> Option<String> {
    (!value.is_null()).then(|| {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    })
}

pub(crate) struct NativeTabAction {
    action_type: String,
    session_id: Option<String>,
    tab_id: Option<String>,
    source_window_id: Option<String>,
    target_window_id: Option<String>,
    before_tab_id: Option<String>,
    ordered_tab_ids: Option<Vec<String>>,
    screen_x: f64,
    screen_y: f64,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
    tab_width: f64,
    tab_height: f64,
    cancelled: bool,
    event_sequence: u64,
    intent_generation: u64,
}

pub(crate) struct QueuedNativeTabAction {
    action: NativeTabAction,
    window_label: String,
}

fn native_tab_drag_action(action_type: &str) -> bool {
    matches!(
        action_type,
        "tabDragStart"
            | "tabDragMove"
            | "tabDragHover"
            | "tabDragDrop"
            | "tabDragEnd"
            | "tabDragCancel"
    )
}

fn coalesce_native_tab_drag_actions(
    current_type: &str,
    current_session_id: Option<&str>,
    next_type: &str,
    next_session_id: Option<&str>,
) -> bool {
    let same_session = current_session_id.is_some() && current_session_id == next_session_id;
    same_session
        && matches!(current_type, "tabDragMove" | "tabDragHover")
        && matches!(
            next_type,
            "tabDragMove" | "tabDragHover" | "tabDragDrop" | "tabDragEnd" | "tabDragCancel"
        )
}

fn release_terminal_tab_drag_pointer_passthrough(
    state: &crate::CoreState,
    session_id: Option<&str>,
    target_window_id: Option<&str>,
) {
    let mut window_ids = target_window_id.map(str::to_owned).into_iter().collect::<Vec<_>>();
    if let Some(session_id) = session_id
        && let Some(session) = state
            .tab_drag
            .lock()
            .ok()
            .and_then(|current| current.as_ref().filter(|session| session.id == session_id).cloned())
    {
        for window_id in [
            session.source_window_id,
            session.current_window_id,
            session.provisional_window_id,
        ] {
            if !window_ids.contains(&window_id) {
                window_ids.push(window_id);
            }
        }
    }
    for window_id in window_ids {
        if let Err(error) = state.runtime.release_tab_drag_pointer_passthrough(&window_id) {
            eprintln!(
                "Runtime tab drag pointer passthrough could not be released: window={window_id} error={error}"
            );
        }
    }
}

fn dispatch_action(app: AppHandle, window_label: String, mut action: NativeTabAction) {
    if native_tab_drag_action(&action.action_type) {
        let Some(state) = app.try_state::<crate::CoreState>() else {
            crate::reveal_shell_error(
                &app,
                crate::shell_error("SHELL_STATE_UNAVAILABLE", "App state is unavailable."),
            );
            return;
        };
        if matches!(
            action.action_type.as_str(),
            "tabDragDrop" | "tabDragEnd" | "tabDragCancel"
        ) {
            release_terminal_tab_drag_pointer_passthrough(
                &state,
                action.session_id.as_deref(),
                action.target_window_id.as_deref(),
            );
        }
        let stamp = state.runtime.stamp_native_tab_drag_action(
            &action.action_type,
            action.session_id.as_deref(),
            action.tab_id.as_deref(),
            action.source_window_id.as_deref(),
            action.target_window_id.as_deref(),
        );
        action.event_sequence = stamp.event_sequence;
        action.intent_generation = stamp.intent_generation;
        if action.action_type == "tabDragHover"
            && let (Some(window_id), Some(ordered_tab_ids)) = (
                action.target_window_id.as_deref(),
                action.ordered_tab_ids.as_deref(),
            )
            && let Err(error) = state
                .runtime
                .commit_live_tab_order_intent(window_id, ordered_tab_ids)
        {
            eprintln!(
                "Live AppKit tab order intent was retired: window={window_id} error={error}"
            );
        }
        let sender = state.macos_tab_drag_actions.get_or_init(|| {
            let (sender, mut receiver) =
                tokio::sync::mpsc::unbounded_channel::<QueuedNativeTabAction>();
            let worker_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut carried = None;
                loop {
                    let Some(mut queued) = carried.take().or(receiver.recv().await) else {
                        break;
                    };
                    while let Ok(candidate) = receiver.try_recv() {
                        if coalesce_native_tab_drag_actions(
                            &queued.action.action_type,
                            queued.action.session_id.as_deref(),
                            &candidate.action.action_type,
                            candidate.action.session_id.as_deref(),
                        ) {
                            queued = candidate;
                        } else {
                            carried = Some(candidate);
                            break;
                        }
                    }
                    process_action(worker_app.clone(), queued.window_label, queued.action).await;
                }
            });
            sender
        });
        if sender
            .send(QueuedNativeTabAction {
                action,
                window_label,
            })
            .is_err()
        {
            crate::reveal_shell_error(
                &app,
                crate::shell_error(
                    "TAURI_TAB_DRAG_FAILED",
                    "The native tab drag action queue is unavailable.",
                ),
            );
        }
        return;
    }
    tauri::async_runtime::spawn(process_action(app, window_label, action));
}

async fn process_action(app: AppHandle, window_label: String, action: NativeTabAction) {
    let NativeTabAction {
        action_type,
        session_id,
        tab_id,
        source_window_id,
        target_window_id,
        before_tab_id,
        ordered_tab_ids,
        screen_x,
        screen_y,
        grab_ratio_x,
        grab_ratio_y,
        tab_width,
        tab_height,
        cancelled,
        event_sequence,
        intent_generation,
    } = action;
    let Some(state) = app.try_state::<crate::CoreState>() else {
        crate::reveal_shell_error(
            &app,
            crate::shell_error("SHELL_STATE_UNAVAILABLE", "App state is unavailable."),
        );
        return;
    };
    let host_window_id = state.runtime.window_id_for_label(&window_label);
    if matches!(
        action_type.as_str(),
        "tabDragStart"
            | "tabDragMove"
            | "tabDragHover"
            | "tabDragDrop"
            | "tabDragEnd"
            | "tabDragCancel"
    ) {
        let source_window_id = source_window_id.or_else(|| host_window_id.clone());
        let Some(source_window_id) = source_window_id else {
            return;
        };
        let mut action = serde_json::json!({
            "type": action_type,
            "cancelled": cancelled,
            "screenX": screen_x,
            "screenY": screen_y,
            "grabRatioX": grab_ratio_x,
            "grabRatioY": grab_ratio_y,
            "tabWidth": tab_width,
            "tabHeight": tab_height,
            "eventSequence": event_sequence,
            "intentGeneration": intent_generation,
        });
        if action_type != "tabDragStart"
            && let Some(value) = action.as_object_mut()
        {
            value.remove("grabRatioX");
            value.remove("grabRatioY");
        }
        if action_type != "tabDragStart"
            && action_type != "tabDragHover"
            && let Some(value) = action.as_object_mut()
        {
            value.remove("tabWidth");
            value.remove("tabHeight");
        }
        if let Some(session_id) = session_id {
            action["sessionId"] = serde_json::Value::String(session_id);
        }
        if let Some(tab_id) = tab_id {
            action["tabId"] = serde_json::Value::String(tab_id);
        }
        if let Some(target_window_id) = target_window_id {
            action["windowId"] = serde_json::Value::String(target_window_id);
        }
        if let Some(before_tab_id) = before_tab_id {
            action["beforeTabId"] = serde_json::Value::String(before_tab_id);
        }
        if let Some(ordered_tab_ids) = ordered_tab_ids {
            action["orderedTabIds"] = serde_json::json!(ordered_tab_ids);
        }
        if let Err(error) =
            crate::handle_game_window_tab_drag(&app, &state, &source_window_id, &action).await
            && error.code != "TAURI_TAB_DRAG_STALE"
        {
            crate::reveal_shell_error(
                &app,
                rion_core::CoreErrorPayload {
                    code: error.code,
                    message: error.message,
                },
            );
        }
        return;
    }
    let target_window_id = target_window_id.or(host_window_id);
    if matches!(
        action_type.as_str(),
        "activate" | "hide" | "reorder" | "move" | "stop" | "openTabMenu"
    ) && tab_id.is_none()
    {
        crate::reveal_shell_error(
            &app,
            crate::shell_error(
                "TAURI_RUNTIME_TAB_MENU_FAILED",
                "Runtime tab ID is required.",
            ),
        );
        return;
    }
    if action_type == "activate" {
        if let Some(tab_id) = tab_id.as_deref()
            && let Err(message) =
                crate::preview_and_schedule_native_tab_selection(&app, &state, tab_id)
        {
            crate::reveal_shell_error(
                &app,
                crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
            );
        }
        return;
    }
    if matches!(action_type.as_str(), "hide" | "reorder" | "move" | "stop") {
        let Some(tab_id) = tab_id.as_deref() else {
            return;
        };
        let target = if action_type == "move" {
            let Some(window_id) = target_window_id.as_deref() else {
                crate::reveal_shell_error(
                    &app,
                    crate::shell_error(
                        "TAURI_RUNTIME_TAB_MENU_FAILED",
                        "Target Game Window was not found.",
                    ),
                );
                return;
            };
            match crate::launch_target_for_game_window(&app, window_id) {
                Ok(target) => Some(target),
                Err(error) => {
                    crate::reveal_shell_error(&app, error);
                    return;
                }
            }
        } else {
            None
        };
        let result = if action_type == "stop" {
            crate::execute_tab_stop(&state, tab_id).await
        } else {
            crate::execute_tab_mutation(&state, &action_type, tab_id, target, before_tab_id).await
        };
        let result = result.and_then(|receipt| {
            crate::runtime_operation_receipt_result(receipt)
                .map_err(|code| crate::shell_error(&code, "Runtime tab mutation did not converge."))
        });
        if let Err(error) = result {
            crate::reveal_shell_error(&app, error);
        }
        return;
    }
    match action_type.as_str() {
        "openLauncher" => {
            if let Some(window_id) = target_window_id.as_deref()
                && let Err(message) = crate::runtime_tab_menu::open_launcher(&app, window_id)
            {
                crate::reveal_shell_error(
                    &app,
                    crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                );
            }
        }
        "openTabMenu" => {
            if let Some(tab_id) = tab_id.as_deref()
                && let Err(message) = crate::runtime_tab_menu::open_tab(&app, tab_id)
            {
                crate::reveal_shell_error(
                    &app,
                    crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                );
            }
        }
        _ => {}
    }
    let _ = source_window_id;
}

pub fn runtime_window_preferences(core: &rion_core::AppCore) -> RuntimeWindowPreferencesRecord {
    core.invoke(CoreCommand::RuntimeWindowPreferencesGet)
        .ok()
        .and_then(|value| serde_json::from_value::<RuntimeWindowPreferencesRecord>(value).ok())
        .unwrap_or(RuntimeWindowPreferencesRecord {
            always_hide_tab_close_button: false,
            always_show_toolbar_in_full_screen: false,
            restore_game_windows_on_startup: true,
        })
}
