impl Drop for RestoreProgressGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = replace_restore_progress(self.state, Vec::new());
        }
    }
}

#[derive(Default)]
struct StartupWindowState {
    failure: Mutex<Option<String>>,
    native_startup_changed: tokio::sync::Notify,
    native_startup_phase: Mutex<NativeStartupPhase>,
    renderer_ready: AtomicBool,
    revealed: AtomicBool,
    windows_mica_enabled: AtomicBool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum NativeStartupPhase {
    #[default]
    Pending,
    Ready,
    Failed(String),
}

impl StartupWindowState {
    fn failure(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|value| value.clone())
    }

    fn mark_renderer_ready(&self) {
        self.renderer_ready.store(true, Ordering::Release);
        let native_startup_failed = self
            .native_startup_phase
            .lock()
            .map(|phase| matches!(*phase, NativeStartupPhase::Failed(_)))
            .unwrap_or(true);
        if !native_startup_failed && let Ok(mut failure) = self.failure.lock() {
            *failure = None;
        }
    }

    fn mark_native_startup_failed(&self, message: String) {
        if let Ok(mut phase) = self.native_startup_phase.lock()
            && matches!(*phase, NativeStartupPhase::Pending)
        {
            *phase = NativeStartupPhase::Failed(message.clone());
        }
        self.set_failure(message);
        self.native_startup_changed.notify_waiters();
    }

    fn mark_native_startup_ready(&self) {
        if let Ok(mut phase) = self.native_startup_phase.lock()
            && matches!(*phase, NativeStartupPhase::Pending)
        {
            *phase = NativeStartupPhase::Ready;
        }
        self.native_startup_changed.notify_waiters();
    }

    fn native_startup_result(&self) -> Result<Option<()>, CoreErrorPayload> {
        let phase = self.native_startup_phase.lock().map_err(|_| {
            shell_error(
                "SHELL_STARTUP_FAILED",
                "Rion Studio could not read the native startup state.",
            )
        })?;
        match &*phase {
            NativeStartupPhase::Pending => Ok(None),
            NativeStartupPhase::Ready => Ok(Some(())),
            NativeStartupPhase::Failed(message) => {
                Err(shell_error("SHELL_STARTUP_FAILED", message.clone()))
            }
        }
    }

    async fn wait_for_native_startup(&self) -> Result<bool, CoreErrorPayload> {
        loop {
            let changed = self.native_startup_changed.notified();
            if self.native_startup_result()?.is_some() {
                return Ok(self.windows_mica_enabled.load(Ordering::Acquire));
            }
            changed.await;
        }
    }

    #[cfg(windows)]
    fn set_windows_mica_enabled(&self, enabled: bool) {
        self.windows_mica_enabled.store(enabled, Ordering::Release);
    }

    fn renderer_ready(&self) -> bool {
        self.renderer_ready.load(Ordering::Acquire)
    }

    fn should_report_timeout(&self) -> bool {
        !self.renderer_ready() && self.failure().is_none()
    }

    fn reveal_once(&self) -> bool {
        !self.revealed.swap(true, Ordering::AcqRel)
    }

    fn set_failure(&self, message: String) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message);
        }
    }
}

fn show_startup_failure_message(app: &AppHandle, message: String) {
    if let Some(state) = app.try_state::<StartupWindowState>() {
        state.set_failure(message.clone());
    }
    eprintln!("Rion Studio startup failure: {message}");
    if let Some(window) = app.get_webview_window("main") {
        let encoded = serde_json::to_string(&message)
            .unwrap_or_else(|_| "\"Rion Studio could not finish starting.\"".to_owned());
        let _ = window.eval(format!("window.__rionShowStartupFailure?.({encoded});"));
    }
    request_main_window_show(app, true, "startup-failure");
}

fn startup_failure_message(error: &dyn std::fmt::Display) -> String {
    format!("Rion Studio could not finish starting.\n\n{error}")
}

fn platform_name() -> Result<&'static str, String> {
    if cfg!(target_os = "macos") {
        Ok("darwin")
    } else if cfg!(target_os = "windows") {
        Ok("win32")
    } else {
        Err("Rion Studio supports only macOS and Windows.".to_owned())
    }
}

fn shared_user_data_dir<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("RION_STUDIO_USER_DATA_DIR") {
        if !cfg!(debug_assertions) {
            return Err("RION_STUDIO_USER_DATA_DIR is restricted to debug builds.".to_owned());
        }
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Ok(path);
        }
        return Err("RION_STUDIO_USER_DATA_DIR must be an absolute path.".to_owned());
    }
    app.path()
        .data_dir()
        .map(|path| path.join(SHARED_DATA_DIRECTORY_NAME))
        .map_err(|error| error.to_string())
}

fn error_payload(error: rion_core::CoreError) -> CoreErrorPayload {
    error.payload()
}

fn shell_error(code: &str, message: impl Into<String>) -> CoreErrorPayload {
    CoreErrorPayload {
        code: code.to_owned(),
        message: message.into(),
    }
}

pub(crate) fn reveal_shell_error(app: &AppHandle, error: CoreErrorPayload) {
    request_main_window_show(app, true, "shell-error");
    let _ = app.emit("rion://shell-error", error);
}

fn request_main_window_show(app: &AppHandle, focus: bool, trigger: &'static str) {
    if let Some(state) = app.try_state::<CoreState>() {
        let _ = state.runtime.request_main_window_show(focus, trigger);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(not(windows))]
        let _ = window.unminimize();
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            use windows::Win32::UI::WindowsAndMessaging::{
                SW_SHOWNOACTIVATE, ShowWindowAsync,
            };
            let _ = unsafe { ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE) };
        }
        #[cfg(not(windows))]
        let _ = window.show();
        if focus {
            #[cfg(target_os = "macos")]
            let _ = crate::quick_menu_macos::activate_application();
            #[cfg(not(windows))]
            let _ = window.set_focus();
        }
    }
}

fn game_window_update_input_from_record(
    record: &StateGameWindowRecord,
) -> GameWindowUpdateInputRecord {
    GameWindowUpdateInputRecord {
        name: Some(record.name.clone()),
        target_display: Some(record.target_display.clone()),
        placement: Some(record.placement.clone()),
        tabs: Some(record.tabs.clone()),
        active_tab_id: Some(record.active_tab_id.clone()),
    }
}

fn game_window_record(
    core: &AppCore,
    window_id: &str,
) -> Result<StateGameWindowRecord, CoreErrorPayload> {
    core.invoke(CoreCommand::GameWindowGet {
        id: window_id.to_owned(),
    })
    .map_err(error_payload)
    .and_then(|value| {
        serde_json::from_value::<StateGameWindowRecord>(value)
            .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GameWindowClosePreview {
    launching: bool,
    name: String,
    role_count: usize,
    running_macro_count: usize,
}

impl GameWindowClosePreview {
    fn requires_confirmation(&self) -> bool {
        self.launching || self.running_macro_count > 0
    }
}

struct GameWindowCloseCopy {
    cancel: String,
    confirm: String,
    message: String,
    title: String,
}

fn preview_game_window_close(
    core: &AppCore,
    runtime: &SystemRuntimeExecutor,
    window_id: &str,
) -> Result<GameWindowClosePreview, CoreErrorPayload> {
    let name = match game_window_record(core, window_id) {
        Ok(record) => record.name,
        Err(error) if error.code == "GAME_WINDOW_NOT_FOUND" => String::new(),
        Err(error) => return Err(error),
    };
    let snapshot = core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                .map_err(|error| shell_error("CORE_INTERNAL_FAILED", error.to_string()))
        })?;
    let snapshot = runtime.live_runtime_snapshot(snapshot).ok_or_else(|| {
        shell_error(
            "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
            "The live tab topology could not be read while closing the window.",
        )
    })?;
    let role_ids = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.window_id == window_id)
        .flat_map(|tab| tab.slots.iter().map(|slot| slot.role_id.clone()))
        .collect::<HashSet<_>>();
    let launching = snapshot
        .roles
        .iter()
        .any(|role| role_ids.contains(&role.role_id) && role.state == "launching")
        || snapshot.workspaces.iter().any(|workspace| {
            workspace.window_id == window_id && workspace.state == "launching"
        });
    let macro_statuses = core
        .invoke(CoreCommand::MacroStatuses)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<MacroRunStatus>>(value)
                .map_err(|error| shell_error("CORE_INTERNAL_FAILED", error.to_string()))
        })?;
    let running_macro_count = macro_statuses
        .into_iter()
        .filter(|status| status.state == "running" && role_ids.contains(&status.role_id))
        .map(|status| status.macro_id)
        .collect::<HashSet<_>>()
        .len();
    Ok(GameWindowClosePreview {
        launching,
        name,
        role_count: role_ids.len(),
        running_macro_count,
    })
}

fn game_window_close_copy(language: &str, preview: &GameWindowClosePreview) -> GameWindowCloseCopy {
    let roles = preview.role_count;
    let macros = preview.running_macro_count;
    match language {
        "zh-TW" => {
            let name = if preview.name.is_empty() {
                "暫存遊戲視窗"
            } else {
                &preview.name
            };
            GameWindowCloseCopy {
                title: format!("停止並關閉「{name}」？"),
                message: if preview.launching && macros > 0 {
                    format!(
                        "此視窗有 {roles} 個角色、{macros} 個執行中巨集，且仍有角色正在啟動。停止並關閉會取消這些工作。"
                    )
                } else if preview.launching {
                    format!("此視窗有 {roles} 個角色，且仍有角色正在啟動。停止並關閉會取消啟動。")
                } else {
                    format!(
                        "此視窗有 {roles} 個角色與 {macros} 個執行中巨集。停止並關閉會結束這些工作。"
                    )
                },
                confirm: "停止並關閉".to_owned(),
                cancel: "取消".to_owned(),
            }
        }
        "zh-CN" => {
            let name = if preview.name.is_empty() {
                "临时游戏窗口"
            } else {
                &preview.name
            };
            GameWindowCloseCopy {
                title: format!("停止并关闭“{name}”？"),
                message: if preview.launching && macros > 0 {
                    format!(
                        "此窗口有 {roles} 个角色、{macros} 个运行中的宏，且仍有角色正在启动。停止并关闭会取消这些工作。"
                    )
                } else if preview.launching {
                    format!("此窗口有 {roles} 个角色，且仍有角色正在启动。停止并关闭会取消启动。")
                } else {
                    format!(
                        "此窗口有 {roles} 个角色和 {macros} 个运行中的宏。停止并关闭会结束这些工作。"
                    )
                },
                confirm: "停止并关闭".to_owned(),
                cancel: "取消".to_owned(),
            }
        }
        "ja" => {
            let name = if preview.name.is_empty() {
                "一時ゲームウインドウ"
            } else {
                &preview.name
            };
            GameWindowCloseCopy {
                title: format!("「{name}」を停止して閉じますか？"),
                message: if preview.launching && macros > 0 {
                    format!(
                        "このウインドウでは {roles} 個のロールと {macros} 個のマクロが実行され、起動中のロールもあります。停止して閉じると、これらの処理をキャンセルします。"
                    )
                } else if preview.launching {
                    format!(
                        "このウインドウでは {roles} 個のロールがあり、起動中のロールもあります。停止して閉じると起動をキャンセルします。"
                    )
                } else {
                    format!(
                        "このウインドウでは {roles} 個のロールと {macros} 個のマクロが実行中です。停止して閉じると、これらの処理を終了します。"
                    )
                },
                confirm: "停止して閉じる".to_owned(),
                cancel: "キャンセル".to_owned(),
            }
        }
        _ => {
            let role_label = if roles == 1 { "role" } else { "roles" };
            let macro_label = if macros == 1 { "macro" } else { "macros" };
            let name = if preview.name.is_empty() {
                "Temporary Game Window"
            } else {
                &preview.name
            };
            GameWindowCloseCopy {
                title: format!("Stop and close “{name}”?"),
                message: if preview.launching && macros > 0 {
                    format!(
                        "This window has {roles} {role_label}, {macros} running {macro_label}, and roles that are still launching. Stopping and closing cancels this work."
                    )
                } else if preview.launching {
                    format!(
                        "This window has {roles} {role_label}, including roles that are still launching. Stopping and closing cancels their launch."
                    )
                } else {
                    format!(
                        "This window has {roles} {role_label} and {macros} running {macro_label}. Stopping and closing ends this work."
                    )
                },
                confirm: "Stop and close".to_owned(),
                cancel: "Cancel".to_owned(),
            }
        }
    }
}

async fn confirm_game_window_close(
    app: &AppHandle,
    window: &Window,
    copy: GameWindowCloseCopy,
) -> Result<bool, CoreErrorPayload> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(copy.message)
        .title(copy.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            copy.confirm,
            copy.cancel,
        ))
        .parent(window)
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });
    let accepted = receiver.await.map_err(|_| {
        shell_error(
            "SHELL_CLOSE_CONFIRMATION_FAILED",
            "The game window close confirmation did not return a result.",
        )
    })?;

    // AppKit can deliver the sheet completion before its parent window has
    // finished the final modal teardown turn. Queue a main-thread barrier so an
    // accepted close never destroys that parent while the sheet is still
    // relinquishing it. This is harmless on Windows and keeps one shared flow.
    let (settled_sender, settled_receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = settled_sender.send(());
    })
    .map_err(|error| shell_error("SHELL_CLOSE_CONFIRMATION_FAILED", error.to_string()))?;
    settled_receiver.await.map_err(|_| {
        shell_error(
            "SHELL_CLOSE_CONFIRMATION_FAILED",
            "The game window close confirmation did not finish native cleanup.",
        )
    })?;
    Ok(accepted)
}

async fn process_game_window_close_requested(
    app: AppHandle,
    label: String,
    operation_id: String,
    window_id: String,
    window: Window,
) {
    let (core, runtime, language) = {
        let Some(state) = app.try_state::<CoreState>() else {
            return;
        };
        let language = state
            .menu_language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        (
            Arc::clone(&state.core),
            Arc::clone(&state.runtime),
            language,
        )
    };

    let preview_core = Arc::clone(&core);
    let preview_runtime = Arc::clone(&runtime);
    let preview_window_id = window_id.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        preview_game_window_close(&preview_core, &preview_runtime, &preview_window_id)
    })
    .await
    .map_err(|error| shell_error("CORE_INTERNAL_FAILED", error.to_string()))
    .and_then(|result| result);
    let preview = match preview {
        Ok(preview) => preview,
        Err(error) => {
            let receipt = runtime.fail_window_close_operation(
                &operation_id,
                "windowClosePolicyFailed",
                "SYSTEM_WINDOW_CLOSE_POLICY_FAILED",
            );
            let _ = app.emit("rion://window-lifecycle", receipt);
            reveal_shell_error(&app, error);
            return;
        }
    };

    if preview.requires_confirmation() {
        let copy = game_window_close_copy(&language, &preview);
        match confirm_game_window_close(&app, &window, copy).await {
            Ok(true) => {}
            Ok(false) => {
                let receipt = runtime.cancel_window_close_operation(&operation_id);
                let _ = app.emit("rion://window-lifecycle", receipt);
                return;
            }
            Err(error) => {
                let receipt = runtime.fail_window_close_operation(
                    &operation_id,
                    "windowCloseConfirmationFailed",
                    "SYSTEM_WINDOW_CLOSE_CONFIRMATION_FAILED",
                );
                let _ = app.emit("rion://window-lifecycle", receipt);
                reveal_shell_error(&app, error);
                return;
            }
        }
    }

    if let Err(error) = runtime.flush_live_window_state(&window_id) {
        eprintln!(
            "Final live Game Window snapshot flush will retry after close: window={window_id} error={error}"
        );
    }
    if let Err(error) = runtime.persist_game_window_placement(&label) {
        eprintln!(
            "Final Game Window placement flush failed; close will continue: window={window_id} error={error}"
        );
    }

    let (live_tab_ids, receipt) = match runtime.commit_visible_window_close(
        &operation_id,
        &window_id,
    ) {
        Ok(result) => result,
        Err(error) => {
            let receipt = runtime.fail_window_close_operation(
                &operation_id,
                "windowCloseLiveCommitFailed",
                error.code,
            );
            let _ = app.emit("rion://window-lifecycle", receipt);
            eprintln!(
                "Live Game Window close commit failed: window={window_id} error={}",
                error.message
            );
            return;
        }
    };
    let _ = app.emit("rion://window-lifecycle", receipt);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = core
            .invoke_async(CoreCommand::BrowserWindowStop {
                window_id: window_id.clone(),
                tab_ids: live_tab_ids,
            })
            .await
        {
            eprintln!(
                "Background Game Window owner cleanup failed: window={window_id} error={}",
                error.payload().message
            );
        }
    });
}

async fn execute_game_window_close_transaction(
    app: &AppHandle,
    state: &CoreState,
    window_id: String,
    delete: bool,
    trigger: &'static str,
) -> Result<Value, CoreErrorPayload> {
    let operation = state
        .runtime
        .begin_window_close_operation(&window_id, trigger)
        .map_err(|error| shell_error(error.code, error.message))?;
    let receipt = if operation.should_execute {
        if let Err(error) = state.runtime.flush_live_window_state(&window_id) {
            eprintln!(
                "Final live Game Window snapshot flush will retry after close: window={window_id} error={error}"
            );
        }
        if let Some(label) = operation.label.as_deref()
            && let Err(error) = state.runtime.persist_game_window_placement(label)
        {
            eprintln!(
                "Final Game Window placement flush failed; close will continue: window={window_id} error={error}"
            );
        }
        let (live_tab_ids, receipt) = state
            .runtime
            .commit_visible_window_close(&operation.operation_id, &window_id)
            .map_err(|error| shell_error(error.code, error.message))?;
        let command = if delete {
            CoreCommand::BrowserWindowDelete {
                window_id: window_id.clone(),
                tab_ids: live_tab_ids,
            }
        } else {
            CoreCommand::BrowserWindowStop {
                window_id: window_id.clone(),
                tab_ids: live_tab_ids,
            }
        };
        let core = Arc::clone(&state.core);
        let cleanup_window_id = window_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = core.invoke_async(command).await {
                eprintln!(
                    "Background Game Window owner cleanup failed: window={cleanup_window_id} error={}",
                    error.payload().message
                );
            }
        });
        receipt
    } else {
        state
            .runtime
            .current_window_close_summary(&operation.operation_id)
    };
    let _ = app.emit("rion://window-lifecycle", &receipt);
    serde_json::to_value(receipt)
        .map_err(|error| shell_error("SYSTEM_WINDOW_CLOSE_SERIALIZE_FAILED", error.to_string()))
}

fn same_game_window_record(left: &StateGameWindowRecord, right: &StateGameWindowRecord) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

fn game_window_recovery_error(
    code: &str,
    native_error: &CoreErrorPayload,
    recovery_error: impl std::fmt::Display,
) -> CoreErrorPayload {
    shell_error(
        code,
        format!(
            "Game Window update failed ({}: {}), and native reconciliation also failed: {recovery_error}",
            native_error.code, native_error.message
        ),
    )
}

fn core_command_refreshes_runtime_projection(command: &CoreCommand) -> bool {
    matches!(command, CoreCommand::RuntimeWindowPreferencesReplace { .. })
}

fn core_command_refreshes_browser_fonts(command: &CoreCommand) -> bool {
    matches!(
        command,
        CoreCommand::GameBrowserSettingsReplace { .. }
            | CoreCommand::BrowserFontPackInstall { .. }
            | CoreCommand::BrowserFontFamilyInstall { .. }
            | CoreCommand::BrowserFontPackRemove { .. }
    )
}

fn overlay_request_activates_webview(payload: &Value) -> bool {
    payload.get("type").and_then(Value::as_str) == Some("activate")
}

#[tauri::command]
async fn rion_core_invoke(
    app: AppHandle,
    state: State<'_, CoreState>,
    command: Value,
) -> Result<Value, CoreErrorPayload> {
    let mut command =
        serde_json::from_value::<CoreCommand>(command).map_err(|error| CoreErrorPayload {
            code: "CORE_INPUT_INVALID".to_owned(),
            message: error.to_string(),
        })?;
    let menu_language = match &command {
        CoreCommand::OverlayLanguageSet { language } => Some(language.clone()),
        _ => None,
    };
    let runtime_theme = match &command {
        CoreCommand::RuntimeThemeSet { theme } => Some(theme.clone()),
        _ => None,
    };
    let cancelled_operation_id = match &command {
        CoreCommand::OperationCancel { operation_id } => Some(operation_id.clone()),
        _ => None,
    };
    let legal_acceptance_changed = matches!(&command, CoreCommand::LegalAcceptanceAccept { .. });
    let runtime_window_preferences_changed = core_command_refreshes_runtime_projection(&command);
    let browser_fonts_changed = core_command_refreshes_browser_fonts(&command);
    let launch_preview = prepare_core_launch_preview(&state, &mut command).await?;
    let result = if command.requires_async_dispatch() {
        Arc::clone(&state.core)
            .invoke_async(command)
            .await
            .map_err(error_payload)
    } else {
        let core = Arc::clone(&state.core);
        tauri::async_runtime::spawn_blocking(move || core.invoke(command))
            .await
            .map_err(|error| CoreErrorPayload {
                code: "CORE_INTERNAL_FAILED".to_owned(),
                message: error.to_string(),
            })?
            .map_err(error_payload)
    };
    if let Some(preview) = launch_preview
        && result.is_err()
    {
        state
            .runtime
            .cancel_tab_launch_preview(&preview.launch_preview_id);
    }
    if result
        .as_ref()
        .is_ok_and(|value| value.get("cancelled").and_then(Value::as_bool) == Some(true))
        && let Some(operation_id) = cancelled_operation_id.as_deref()
    {
        state.runtime.cancel_surface_close_operation(operation_id);
    }
    if result.is_ok()
        && let Some(language) = menu_language
    {
        if let Ok(mut current) = state.menu_language.lock() {
            *current = language.clone();
        }
        state.runtime.set_language(&language);
        let _ = application_menu::install(&app, &state.core, &language);
        let _ = state.quick_menu_refresh.request(
            app.clone(),
            Arc::clone(&state.core),
            Arc::clone(&state.runtime),
            language.clone(),
        );
        let _ =
            state
                .runtime_launcher_refresh
                .request(app.clone(), Arc::clone(&state.core), language);
    }
    if result.is_ok()
        && let Some(theme) = runtime_theme
    {
        state.runtime.set_theme(&theme);
    }
    if result.is_ok() && runtime_window_preferences_changed {
        state.runtime.publish_projection();
        if let Ok(language) = state.menu_language.lock().map(|value| value.clone()) {
            let _ = application_menu::install(&app, &state.core, &language);
        }
    }
    if result.is_ok() && browser_fonts_changed {
        state.runtime.refresh_browser_fonts();
    }
    if result.is_ok() && legal_acceptance_changed {
        state.updates.mark_legal_accepted();
    }
    result
}

#[tauri::command]
async fn rion_browser_font_payload(
    webview: Webview,
    state: State<'_, CoreState>,
) -> Result<Value, CoreErrorPayload> {
    state
        .runtime
        .role_id_for_webview(webview.label())
        .map_err(|message| shell_error("BROWSER_FONT_ROLE_UNAVAILABLE", message))?;
    let core = Arc::clone(&state.core);
    tauri::async_runtime::spawn_blocking(move || {
        core.invoke(CoreCommand::BrowserFontRuntimePayload { settings: None })
    })
    .await
    .map_err(|error| CoreErrorPayload {
        code: "CORE_INTERNAL_FAILED".to_owned(),
        message: error.to_string(),
    })?
    .map_err(error_payload)
}
