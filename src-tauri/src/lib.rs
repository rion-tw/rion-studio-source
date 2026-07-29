use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use rion_core::{
    AppCore, AppCoreOptions, BrowserRuntimeSnapshot, CoreCommand, CoreEffectAction,
    CoreEffectResult, CoreErrorPayload, CoreEvent, DisplayFingerprintRecord, DisplayTargetRecord,
    EmbeddedLaunchTargetRecord, GameWindowCreateInputRecord, GameWindowPlacementRecord,
    GameWindowTabRecord, GameWindowUpdateInputRecord, StateCollection, StateGameRecord,
    StateGameWindowRecord, StatePixelBoundsRecord, StateResolutionRecord, StateRoleRecord,
    migrate_legacy_data_root,
};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewWindow, webview::PageLoadEvent};

mod activation;
mod application_menu;
mod native_shell;
mod quick_menu;
mod runtime_tab_menu;
#[cfg(target_os = "macos")]
mod runtime_tabs_macos;
mod system_runtime;
mod update_manager;

use activation::ActivationServer;
use system_runtime::SystemRuntimeExecutor;

const CORE_EVENTS_EVENT: &str = "rion://core-events";
const OVERLAY_REQUEST_MAX_BYTES: usize = 64 * 1024;
const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio";
const LEGACY_DATA_DIRECTORY_NAME: &str = "rion-studio";
const RENDERER_READY_TIMEOUT: Duration = Duration::from_secs(15);

fn core_effect_action_name(action: &CoreEffectAction) -> &'static str {
    match action {
        CoreEffectAction::LocalStorageSyncRefresh { .. } => "localStorageSyncRefresh",
        CoreEffectAction::RoleBrowserDataClearSession { .. } => "roleBrowserDataClearSession",
        CoreEffectAction::LegacySessionRestore { .. } => "legacySessionRestore",
        CoreEffectAction::ChromeProfileImportSnapshot { .. } => "chromeProfileImportSnapshot",
        CoreEffectAction::ChromeProfileImportApply { .. } => "chromeProfileImportApply",
        CoreEffectAction::ChromeProfileImportVerify { .. } => "chromeProfileImportVerify",
        CoreEffectAction::ChromeProfileImportRollback { .. } => "chromeProfileImportRollback",
        CoreEffectAction::ChromeProfileImportCommit { .. } => "chromeProfileImportCommit",
        CoreEffectAction::EmbeddedCreateTab { .. } => "embeddedCreateTab",
        CoreEffectAction::EmbeddedConfigureRoleSessions { .. } => "embeddedConfigureRoleSessions",
        CoreEffectAction::EmbeddedLoadRoles { .. } => "embeddedLoadRoles",
        CoreEffectAction::EmbeddedInstallOverlays { .. } => "embeddedInstallOverlays",
        CoreEffectAction::EmbeddedFocusRole { .. } => "embeddedFocusRole",
        CoreEffectAction::EmbeddedDestroyRole { .. } => "embeddedDestroyRole",
        CoreEffectAction::EmbeddedDestroyTab { .. } => "embeddedDestroyTab",
        CoreEffectAction::EmbeddedApplyRuntime { .. } => "embeddedApplyRuntime",
        CoreEffectAction::OverlayOpenMacroPage { .. } => "overlayOpenMacroPage",
        CoreEffectAction::OverlayCopyCoordinate { .. } => "overlayCopyCoordinate",
        CoreEffectAction::BrowserAction { .. } => "browserAction",
    }
}

struct CoreState {
    _activation: ActivationServer,
    _quick_menu: tauri::tray::TrayIcon,
    core: Arc<AppCore>,
    application_exit_guard: ApplicationExitGuard,
    main_window_zoom: Mutex<f64>,
    menu_language: Mutex<String>,
    runtime: Arc<SystemRuntimeExecutor>,
    tab_drag: Mutex<Option<GameWindowTabDragSession>>,
    tab_drag_finished: Mutex<VecDeque<String>>,
    tab_drag_lane: tokio::sync::Mutex<()>,
    updates: Arc<update_manager::UpdateManager>,
}

#[derive(Default)]
struct ApplicationExitGuard {
    permitted: AtomicBool,
}

impl ApplicationExitGuard {
    fn permit(&self) {
        self.permitted.store(true, Ordering::Release);
    }

    fn should_prevent(&self) -> bool {
        !self.permitted.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
struct GameWindowTabDragSession {
    detached: bool,
    detach_requested: bool,
    id: String,
    name: String,
    prepared: bool,
    provisional_window_id: String,
    source_window_id: String,
    tab_id: String,
    target: EmbeddedLaunchTargetRecord,
    target_display: DisplayTargetRecord,
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimeRestoreTabMatch {
    Missing,
    InTarget { hidden: bool, id: String },
    Conflict { window_id: String },
}

struct RestoreProgressGuard<'a> {
    active: bool,
    state: &'a CoreState,
}

impl<'a> RestoreProgressGuard<'a> {
    fn new(state: &'a CoreState) -> Self {
        Self {
            active: true,
            state,
        }
    }

    fn finish(mut self) -> Result<(), CoreErrorPayload> {
        replace_restore_progress(self.state, Vec::new())?;
        self.active = false;
        Ok(())
    }
}

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

    async fn wait_for_native_startup(&self) -> Result<(), CoreErrorPayload> {
        loop {
            let changed = self.native_startup_changed.notified();
            if self.native_startup_result()?.is_some() {
                return Ok(());
            }
            changed.await;
        }
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
        let _ = window.show();
        let _ = window.set_focus();
    }
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("rion://shell-error", error);
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
    let command =
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
    let runtime_window_preferences_changed = core_command_refreshes_runtime_projection(&command);
    let browser_fonts_changed = core_command_refreshes_browser_fonts(&command);
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
    if result.is_ok()
        && let Some(language) = menu_language
    {
        if let Ok(mut current) = state.menu_language.lock() {
            *current = language.clone();
        }
        state.runtime.set_language(&language);
        let _ = application_menu::install(&app, &state.core, &language);
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

#[tauri::command]
async fn rion_overlay_request(
    webview: Webview,
    state: State<'_, CoreState>,
    capability: String,
    payload: Value,
) -> Result<Value, CoreErrorPayload> {
    let role_id = state
        .runtime
        .authorize_overlay_request(webview.label(), &capability)
        .map_err(|message| shell_error("OVERLAY_REQUEST_UNAUTHORIZED", message))?;
    let request_json = serde_json::to_string(&payload).map_err(|error| CoreErrorPayload {
        code: "OVERLAY_REQUEST_INVALID".to_owned(),
        message: error.to_string(),
    })?;
    if request_json.len() > OVERLAY_REQUEST_MAX_BYTES {
        return Err(shell_error(
            "OVERLAY_REQUEST_TOO_LARGE",
            "The overlay request exceeds the allowed size.",
        ));
    }
    if overlay_request_activates_webview(&payload) {
        webview.set_focus().map_err(|error| {
            shell_error(
                "OVERLAY_WEBVIEW_FOCUS_FAILED",
                format!("Unable to focus the active role WebView: {error}"),
            )
        })?;
    }
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::OverlayRequest {
            role_id,
            request_json,
            language: None,
        })
        .await
        .map_err(error_payload)
}

#[tauri::command]
async fn rion_runtime_audio_state(
    webview: Webview,
    state: State<'_, CoreState>,
    audible: bool,
) -> Result<(), CoreErrorPayload> {
    let role_id = state
        .runtime
        .role_id_for_webview(webview.label())
        .map_err(|message| shell_error("TAURI_RUNTIME_AUDIO_UNAUTHORIZED", message))?;
    state
        .runtime
        .set_webview_audible(webview.label(), &role_id, audible)
        .map_err(|message| shell_error("TAURI_RUNTIME_AUDIO_FAILED", message))
}

#[tauri::command]
async fn rion_local_storage_sync_changed(
    webview: Webview,
    state: State<'_, CoreState>,
    token: String,
    generation: u64,
    sequence: u64,
    entries: Vec<(String, Option<String>)>,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .local_storage_sync_changed(webview.label(), &token, generation, sequence, entries)
        .map_err(|message| shell_error("TAURI_LOCAL_STORAGE_SYNC_REJECTED", message))
}

#[tauri::command]
async fn rion_divider_pointer(
    app: AppHandle,
    webview: Webview,
    state: State<'_, CoreState>,
    payload: system_runtime::DividerPointerPayload,
) -> Result<(), CoreErrorPayload> {
    match state
        .runtime
        .handle_divider_pointer(webview.label(), payload)
    {
        Ok(()) => Ok(()),
        Err(message) => {
            let error = shell_error("TAURI_DIVIDER_FAILED", message);
            reveal_shell_error(
                &app,
                CoreErrorPayload {
                    code: error.code.clone(),
                    message: error.message.clone(),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn rion_runtime_tab_action(
    app: AppHandle,
    webview: Webview,
    state: State<'_, CoreState>,
    action: Value,
) -> Result<(), CoreErrorPayload> {
    let window_id = state
        .runtime
        .tab_strip_window_for_webview(webview.label())
        .ok_or_else(|| {
            shell_error(
                "TAURI_RUNTIME_CHROME_UNAUTHORIZED",
                "Runtime tab actions are restricted to the local tab-strip WebView.",
            )
        })?;
    match runtime_tab_menu::handle_scoped_action(&app, &state, window_id, action).await {
        Ok(()) => Ok(()),
        Err(message) => {
            let error = shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message);
            reveal_shell_error(
                &app,
                CoreErrorPayload {
                    code: error.code.clone(),
                    message: error.message.clone(),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn rion_dispatch_core_effect_results(
    state: State<'_, CoreState>,
    results: Vec<CoreEffectResult>,
) -> Result<Value, CoreErrorPayload> {
    let core = Arc::clone(&state.core);
    tauri::async_runtime::spawn_blocking(move || {
        core.dispatch_core_effect_results(results)
            .and_then(|report| {
                serde_json::to_value(report)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            })
    })
    .await
    .map_err(|error| CoreErrorPayload {
        code: "CORE_INTERNAL_FAILED".to_owned(),
        message: error.to_string(),
    })?
    .map_err(error_payload)
}

#[tauri::command]
fn rion_shared_user_data_dir(state: State<'_, CoreState>) -> String {
    state.core.user_data_dir().to_string_lossy().into_owned()
}

fn monitor_id(monitor: &tauri::Monitor) -> i64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    monitor.name().hash(&mut hasher);
    monitor.position().x.hash(&mut hasher);
    monitor.position().y.hash(&mut hasher);
    monitor.size().width.hash(&mut hasher);
    monitor.size().height.hash(&mut hasher);
    safe_display_id(hasher.finish())
}

fn safe_display_id(hash: u64) -> i64 {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    (hash % MAX_SAFE_INTEGER) as i64
}

fn display_inventory(window: &WebviewWindow) -> Result<Value, CoreErrorPayload> {
    let primary = window
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_id = primary.as_ref().map(monitor_id);
    let monitors = window
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    Ok(Value::Array(
        monitors
            .iter()
            .map(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                let scale_factor = monitor.scale_factor();
                let logical_width = (size.width as f64 / scale_factor).round() as i64;
                let logical_height = (size.height as f64 / scale_factor).round() as i64;
                let work_area = monitor.work_area();
                let id = monitor_id(monitor);
                json!({
                    "id": id,
                    "label": monitor.name().cloned().unwrap_or_else(|| format!("Display {id}")),
                    "bounds": {
                        "x": (position.x as f64 / scale_factor).round() as i64,
                        "y": (position.y as f64 / scale_factor).round() as i64,
                        "width": logical_width,
                        "height": logical_height
                    },
                    "workArea": {
                        "x": (work_area.position.x as f64 / scale_factor).round() as i64,
                        "y": (work_area.position.y as f64 / scale_factor).round() as i64,
                        "width": (work_area.size.width as f64 / scale_factor).round() as i64,
                        "height": (work_area.size.height as f64 / scale_factor).round() as i64
                    },
                    "resolution": {
                        "width": size.width,
                        "height": size.height
                    },
                    "scaleFactor": scale_factor,
                    "isPrimary": primary_id == Some(id),
                    "isInternal": false
                })
            })
            .collect(),
    ))
}

fn start_display_watcher(app: AppHandle) -> Result<(), String> {
    thread::Builder::new()
        .name("rion-tauri-display-watcher".to_owned())
        .spawn(move || {
            let mut previous = None;
            loop {
                thread::sleep(std::time::Duration::from_secs(2));
                let Some(window) = app.get_webview_window("main") else {
                    break;
                };
                let Ok(displays) = display_inventory(&window) else {
                    continue;
                };
                if previous.as_ref() == Some(&displays) {
                    continue;
                }
                let Some(state) = app.try_state::<CoreState>() else {
                    break;
                };
                let records = match serde_json::from_value::<Vec<rion_core::DisplayInfoRecord>>(
                    displays.clone(),
                ) {
                    Ok(records) => records,
                    Err(error) => {
                        let _ = app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "TAURI_DISPLAY_STATE_INVALID",
                                "message": error.to_string()
                            }),
                        );
                        continue;
                    }
                };
                let available_ids = records
                    .iter()
                    .map(|display| display.id)
                    .collect::<HashSet<_>>();
                let game_windows =
                    match state
                        .core
                        .invoke(CoreCommand::GameWindowsList)
                        .and_then(|value| {
                            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                                .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
                        }) {
                        Ok(game_windows) => game_windows,
                        Err(error) => {
                            reveal_shell_error(&app, error_payload(error));
                            continue;
                        }
                    };
                let mut reconcile_failed = false;
                for game_window in game_windows
                    .iter()
                    .filter(|game_window| !available_ids.contains(&game_window.target_display.id))
                {
                    let result = resolve_game_window_launch_target(&app, game_window).and_then(
                        |resolution| {
                            let Some(remap) = resolution.remap else {
                                return Ok(());
                            };
                            let target = resolution.target;
                            relocate_before_display_remap(
                                || {
                                    state
                                        .runtime
                                        .relocate_game_window_if_live(target.clone())
                                        .map(|_| ())
                                        .map_err(|error| {
                                            shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", error)
                                        })
                                },
                                || {
                                    persist_game_window_display_remap(
                                        &app,
                                        &state,
                                        &game_window.id,
                                        target.display_id,
                                        remap,
                                    )
                                },
                            )
                        },
                    );
                    if let Err(error) = result {
                        reveal_shell_error(&app, error);
                        reconcile_failed = true;
                    }
                }
                if reconcile_failed {
                    continue;
                }
                if let Err(error) = state.runtime.persist_restore_session(false) {
                    reveal_shell_error(&app, shell_error("TAURI_RESTORE_PERSIST_FAILED", error));
                    continue;
                }
                state.runtime.publish_projection();
                let _ = app.emit("rion://displays", &displays);
                previous = Some(displays);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn embedded_runtime_state(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let snapshot = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)?;
    let snapshot = serde_json::from_value(snapshot)
        .map_err(|error| shell_error("CORE_INTERNAL_FAILED", error.to_string()))?;
    Ok(state.runtime.projection(&snapshot))
}

fn app_snapshot(state: &CoreState, window: &WebviewWindow) -> Result<Value, CoreErrorPayload> {
    let snapshot = state
        .core
        .invoke(CoreCommand::StateSnapshot)
        .map_err(error_payload)?;
    let role_statuses = state
        .core
        .invoke(CoreCommand::BrowserStatuses)
        .map_err(error_payload)?;
    let macro_statuses = state
        .core
        .invoke(CoreCommand::MacroStatuses)
        .map_err(error_payload)?;
    Ok(json!({
        "embeddedRuntimeState": embedded_runtime_state(state)?,
        "games": snapshot["games"].clone(),
        "gameWindows": snapshot["gameWindows"].clone(),
        "roles": snapshot["roles"].clone(),
        "roleStatuses": role_statuses,
        "launchWorkspaces": snapshot["launchWorkspaces"].clone(),
        "displays": display_inventory(window)?,
        "macros": snapshot["macros"].clone(),
        "macroStatuses": macro_statuses
    }))
}

#[tauri::command]
async fn rion_shell_invoke(
    app: tauri::AppHandle,
    window: WebviewWindow,
    startup: State<'_, StartupWindowState>,
    operation: String,
    args: Vec<Value>,
) -> Result<Value, CoreErrorPayload> {
    match operation.as_str() {
        "waitForNativeStartup" => {
            startup.wait_for_native_startup().await?;
            return Ok(Value::Null);
        }
        "rendererStartupFailed" => {
            let message = string_argument(&args, 0, "Renderer startup failure")?;
            show_startup_failure_message(&app, message);
            return Ok(Value::Null);
        }
        _ => {}
    }

    startup.wait_for_native_startup().await?;
    let state = app.try_state::<CoreState>().ok_or_else(|| {
        shell_error(
            "SHELL_STARTUP_FAILED",
            "Rion Studio native startup completed without managed core state.",
        )
    })?;

    match operation.as_str() {
        "rendererReady" => {
            startup.mark_renderer_ready();
            window
                .show()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "appSnapshot" => app_snapshot(&state, &window),
        "createGameWindow" => {
            let input = args
                .first()
                .cloned()
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_SHELL_INPUT_INVALID",
                        "Game window create input is required.",
                    )
                })
                .and_then(|value| {
                    serde_json::from_value::<GameWindowCreateInputRecord>(value).map_err(|error| {
                        shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string())
                    })
                })?;
            create_game_window_transaction(&app, &state, input).await
        }
        "currentWindowState" => Ok(json!({ "fullscreen": window.is_fullscreen()
            .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))? })),
        "refreshQuickMenu" => quick_menu::refresh(
            &app,
            &state.core,
            &state.runtime,
            &state
                .menu_language
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| "en".to_owned()),
        )
        .map(|()| Value::Null)
        .map_err(|error| shell_error("SHELL_MENU_FAILED", error)),
        "quitApplication" => {
            app.exit(0);
            Ok(Value::Null)
        }
        "confirmApplicationQuit" => {
            state.application_exit_guard.permit();
            app.exit(0);
            Ok(Value::Null)
        }
        "requestCurrentWindowClose" => {
            window
                .close()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "startCurrentWindowDrag" => {
            window
                .start_dragging()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "toggleCurrentWindowMaximize" => {
            let maximized = window
                .is_maximized()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            if maximized {
                window
                    .unmaximize()
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            } else {
                window
                    .maximize()
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            }
            Ok(Value::Null)
        }
        "executeApplicationShortcut" => {
            if window.label() != "main" {
                return Err(shell_error(
                    "TAURI_SHELL_UNAUTHORIZED",
                    "Application shortcuts from the renderer are restricted to the main window.",
                ));
            }
            let command = string_argument(&args, 0, "Application shortcut command")?;
            let command = application_menu::ApplicationShortcutCommand::parse(&command)
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_SHELL_INPUT_INVALID",
                        "Application shortcut command is not supported.",
                    )
                })?;
            application_menu::execute_shortcut(
                &app,
                &state,
                command,
                application_menu::ApplicationShortcutTarget::MainWindow(&window),
            )
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_APPLICATION_SHORTCUT_FAILED", error))
        }
        "displays" => display_inventory(&window),
        "launchRole" => {
            let role_id = string_argument(&args, 0, "Role ID")?;
            let requested_window_id = args
                .get(1)
                .and_then(|value| value.get("windowId"))
                .and_then(Value::as_str);
            let target = game_window_launch_target(&app, &state, &window, requested_window_id)?;
            let requested_window_id = target.window_id.clone();
            let statuses = Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserRoleLaunch {
                    role_id: role_id.clone(),
                    target,
                    zoom_factor: None,
                })
                .await
                .map_err(error_payload)?;
            let status = statuses
                .as_array()
                .and_then(|statuses| statuses.first())
                .cloned()
                .unwrap_or(Value::Null);
            let runtime = state
                .core
                .invoke(CoreCommand::BrowserRuntimeSnapshot)
                .map_err(error_payload)?;
            let window_id = runtime["tabs"]
                .as_array()
                .and_then(|tabs| {
                    tabs.iter()
                        .find(|tab| tab["sourceId"].as_str() == Some(role_id.as_str()))
                })
                .and_then(|tab| tab["windowId"].as_str())
                .unwrap_or(&requested_window_id);
            Ok(json!({ "windowId": window_id, "status": status }))
        }
        "launchWorkspace" => {
            let workspace_id = string_argument(&args, 0, "Workspace ID")?;
            let input = args.get(1);
            let requested_window_id = input
                .and_then(|value| value.get("windowId"))
                .and_then(Value::as_str);
            let stop_conflicts = input
                .and_then(|value| value.get("stopConflicts"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let target = game_window_launch_target(&app, &state, &window, requested_window_id)?;
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
            let runtime = invoke_core_sync(&state, json!({ "type": "browserRuntimeSnapshot" }))?;
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
            if stop_conflicts {
                for tab in &conflicting_tabs {
                    let Some(source_id) = tab["sourceId"].as_str() else {
                        continue;
                    };
                    let command = if tab["tabType"].as_str() == Some("workspace") {
                        CoreCommand::BrowserWorkspaceStop {
                            workspace_id: source_id.to_owned(),
                        }
                    } else {
                        CoreCommand::BrowserRoleStop {
                            role_id: source_id.to_owned(),
                        }
                    };
                    Arc::clone(&state.core)
                        .invoke_async(command)
                        .await
                        .map_err(error_payload)?;
                }
            }
            let statuses = Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWorkspaceLaunch {
                    workspace_id: workspace_id.clone(),
                    target,
                })
                .await
                .map_err(error_payload)?;
            let runtime = state
                .core
                .invoke(CoreCommand::BrowserRuntimeSnapshot)
                .map_err(error_payload)?;
            let window_id = runtime["tabs"]
                .as_array()
                .and_then(|tabs| {
                    tabs.iter()
                        .find(|tab| tab["sourceId"].as_str() == Some(workspace_id.as_str()))
                })
                .and_then(|tab| tab["windowId"].as_str())
                .unwrap_or(&requested_window_id);
            Ok(json!({
                "kind": "launched",
                "windowId": window_id,
                "statuses": statuses
            }))
        }
        "showGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            let target = launch_target_for_game_window(&app, &window_id)?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedWindowRegister { target })
                .await
                .map_err(error_payload)
        }
        "updateGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            let input = args
                .get(1)
                .cloned()
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_SHELL_INPUT_INVALID",
                        "Game window update input is required.",
                    )
                })
                .and_then(|value| {
                    serde_json::from_value::<GameWindowUpdateInputRecord>(value).map_err(|error| {
                        shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string())
                    })
                })?;
            let should_relocate = input.target_display.is_some() || input.placement.is_some();
            let previous = game_window_record(&state.core, &window_id)?;
            let updated = state
                .core
                .invoke(CoreCommand::GameWindowUpdate {
                    id: window_id.clone(),
                    input,
                })
                .map_err(error_payload)
                .and_then(|value| {
                    serde_json::from_value::<StateGameWindowRecord>(value).map_err(|error| {
                        shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let mut operation_record = updated;
            if let Some(runtime_window) = state.runtime.window_for_id(&window_id) {
                let native_result = (|| {
                    runtime_window
                        .set_title(crate::system_runtime::native_runtime_window_title(
                            &operation_record.name,
                        ))
                        .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
                    if should_relocate {
                        let target = launch_target_for_game_window(&app, &window_id)?;
                        operation_record = game_window_record(&state.core, &window_id)?;
                        state
                            .runtime
                            .relocate_game_window(target)
                            .map_err(|error| {
                                shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", error)
                            })?;
                    }
                    Ok::<(), CoreErrorPayload>(())
                })();
                if let Err(native_error) = native_result {
                    let current = game_window_record(&state.core, &window_id)?;
                    let authoritative = if same_game_window_record(&current, &operation_record) {
                        match state
                            .core
                            .invoke(CoreCommand::GameWindowUpdate {
                                id: window_id.clone(),
                                input: game_window_update_input_from_record(&previous),
                            })
                            .map_err(error_payload)
                            .and_then(|value| {
                                serde_json::from_value::<StateGameWindowRecord>(value).map_err(
                                    |error| {
                                        shell_error(
                                            "SHELL_GAME_WINDOW_ROLLBACK_FAILED",
                                            error.to_string(),
                                        )
                                    },
                                )
                            }) {
                            Ok(record) => record,
                            Err(rollback_error) => {
                                return Err(game_window_recovery_error(
                                    "SHELL_GAME_WINDOW_ROLLBACK_FAILED",
                                    &native_error,
                                    format!("{}: {}", rollback_error.code, rollback_error.message),
                                ));
                            }
                        }
                    } else {
                        current
                    };
                    if let Err(error) = runtime_window.set_title(
                        crate::system_runtime::native_runtime_window_title(&authoritative.name),
                    ) {
                        return Err(game_window_recovery_error(
                            "SHELL_GAME_WINDOW_RECONCILE_FAILED",
                            &native_error,
                            error,
                        ));
                    }
                    if should_relocate {
                        let target =
                            launch_target_for_game_window(&app, &window_id).map_err(|error| {
                                game_window_recovery_error(
                                    "SHELL_GAME_WINDOW_RECONCILE_FAILED",
                                    &native_error,
                                    format!("{}: {}", error.code, error.message),
                                )
                            })?;
                        state
                            .runtime
                            .relocate_game_window(target)
                            .map_err(|error| {
                                game_window_recovery_error(
                                    "SHELL_GAME_WINDOW_RECONCILE_FAILED",
                                    &native_error,
                                    error,
                                )
                            })?;
                    }
                    return Err(native_error);
                }
            }
            let authoritative = game_window_record(&state.core, &window_id)?;
            serde_json::to_value(authoritative)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        }
        "closeGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            if core_game_window_is_empty(&state.core, &window_id) {
                delete_empty_game_window(&state, &window_id).await?;
                return Ok(Value::Null);
            }
            if let Some(runtime_window) = state.runtime.window_for_id(&window_id) {
                runtime_window
                    .hide()
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            }
            state.runtime.publish_projection();
            Ok(Value::Null)
        }
        "stopGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWindowStop { window_id })
                .await
                .map_err(error_payload)
        }
        "deleteGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWindowDelete { window_id })
                .await
                .map_err(error_payload)
        }
        "showGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabActivate { tab_id })
                .await
                .map_err(error_payload)
        }
        "moveGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let window_id = string_argument(&args, 1, "Game window ID")?;
            let target = launch_target_for_game_window(&app, &window_id)?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabMove { tab_id, target })
                .await
                .map_err(error_payload)
        }
        "moveGameWindowTabToNewWindow" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let created = move_game_window_tab_to_new_window(&app, &state, &tab_id, None).await?;
            serde_json::to_value(created)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        }
        "setGameWindowTabMuted" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let muted = args.get(1).and_then(Value::as_bool).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Muted state is required.")
            })?;
            state
                .runtime
                .set_tab_audio_muted(&tab_id, muted)
                .map_err(|error| shell_error("TAURI_RUNTIME_AUDIO_FAILED", error))?;
            Ok(Value::Null)
        }
        "setGameWindowTabHidden" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let hidden = args.get(1).and_then(Value::as_bool).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Hidden state is required.")
            })?;
            let command = if hidden {
                CoreCommand::EmbeddedTabHide { tab_id }
            } else {
                CoreCommand::EmbeddedTabActivate { tab_id }
            };
            Arc::clone(&state.core)
                .invoke_async(command)
                .await
                .map_err(error_payload)
        }
        "stopGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let snapshot = invoke_core_sync(&state, json!({ "type": "browserRuntimeSnapshot" }))?;
            let tab = snapshot["tabs"]
                .as_array()
                .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_str() == Some(&tab_id)))
                .ok_or_else(|| {
                    shell_error("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
                })?;
            let source_id = tab["sourceId"].as_str().ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_INVALID",
                    "Runtime tab source is invalid.",
                )
            })?;
            let command = if tab["tabType"].as_str() == Some("workspace") {
                json!({ "type": "browserWorkspaceStop", "workspaceId": source_id })
            } else {
                json!({ "type": "browserRoleStop", "roleId": source_id })
            };
            invoke_core_async(&state, command).await
        }
        "restoreSavedGameWindows" => restore_saved_game_windows(&state, &window, &args).await,
        "autoRestoreSavedGameWindows" => {
            if !state.runtime.begin_auto_restore() {
                return Ok(Value::Null);
            }
            restore_saved_game_windows(&state, &window, &[json!({ "scope": "all" })]).await
        }
        "discardSavedGameWindows" => discard_saved_game_windows(&state, &args),
        "stopEmbeddedRuntimeWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWindowStop { window_id })
                .await
                .map_err(error_payload)
        }
        "embeddedRuntimeState" => embedded_runtime_state(&state),
        "startMacro" => {
            let macro_id = string_argument(&args, 0, "Macro ID")?;
            invoke_core_async(
                &state,
                json!({
                    "type": "macroStart",
                    "request": { "macroId": macro_id, "sourceRoleId": null }
                }),
            )
            .await
        }
        "exportPortableData" => export_portable_data(&state, &args).await,
        "previewPortableImport" => preview_portable_import(&state).await,
        "applyPortableImport" => {
            let input = args.first().cloned().ok_or_else(|| {
                shell_error(
                    "TAURI_SHELL_INPUT_INVALID",
                    "Portable import input is required.",
                )
            })?;
            let result = invoke_core_async(
                &state,
                json!({
                    "type": "portableApply",
                    "importId": input["importId"],
                    "selection": input["selection"],
                    "resolutions": input.get("resolutions").cloned().unwrap_or_else(|| json!([]))
                }),
            )
            .await?;
            if input["selection"]["gameWindows"].as_bool() == Some(true) {
                let windows = state
                    .core
                    .invoke(CoreCommand::GameWindowsList)
                    .map_err(error_payload)
                    .and_then(|value| {
                        serde_json::from_value::<Vec<StateGameWindowRecord>>(value).map_err(
                            |error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()),
                        )
                    })?;
                for game_window in windows {
                    launch_target_for_game_window(&app, &game_window.id)?;
                }
            }
            Ok(result)
        }
        "previewChromeProfileImport" => preview_chrome_profile_import(&state).await,
        "revealLogs" => reveal_logs(&state).await,
        "collectBrowserPerformanceDiagnostics" => {
            let runtime = Arc::clone(&state.runtime);
            let diagnostics = tauri::async_runtime::spawn_blocking(move || {
                thread::sleep(std::time::Duration::from_millis(1_500));
                runtime.collect_browser_performance_diagnostics(std::time::Duration::from_millis(
                    1_500,
                ))
            })
            .await
            .map_err(|error| shell_error("PERFORMANCE_DIAGNOSTIC_FAILED", error.to_string()))?
            .map_err(|error| shell_error("PERFORMANCE_DIAGNOSTIC_FAILED", error))?;
            serde_json::to_value(diagnostics)
                .map_err(|error| shell_error("PERFORMANCE_DIAGNOSTIC_FAILED", error.to_string()))
        }
        "exportDiagnostics" => export_diagnostics(&app, &window, &state).await,
        "appVersion" => Ok(Value::String(app.package_info().version.to_string())),
        "updateStatus" => Ok(state.updates.status()),
        "checkForUpdates" => {
            let updates = Arc::clone(&state.updates);
            Ok(updates.check().await)
        }
        "setAutoUpdateEnabled" => {
            let enabled = args.first().and_then(Value::as_bool).ok_or_else(|| {
                shell_error(
                    "TAURI_SHELL_INPUT_INVALID",
                    "Auto-update enabled state is required.",
                )
            })?;
            state
                .updates
                .set_auto_update_enabled(enabled)
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error))
        }
        "openUpdateDownload" => state
            .updates
            .open_release_page()
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error)),
        "installDownloadedUpdate" => {
            state
                .runtime
                .persist_restore_session(true)
                .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
            state
                .updates
                .install_downloaded()
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error))?;
            state.application_exit_guard.permit();
            app.restart();
        }
        "consumePendingMacroPageRequest" => Ok(state
            .runtime
            .take_macro_page_request()
            .unwrap_or(Value::Null)),
        _ => Err(shell_error(
            "TAURI_SHELL_OPERATION_UNAVAILABLE",
            format!(
                "Tauri shell operation {operation} is not available ({} argument(s)).",
                args.len()
            ),
        )),
    }
}

async fn invoke_core_async(state: &CoreState, command: Value) -> Result<Value, CoreErrorPayload> {
    let command = serde_json::from_value::<CoreCommand>(command)
        .map_err(|error| shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string()))?;
    Arc::clone(&state.core)
        .invoke_async(command)
        .await
        .map_err(error_payload)
}

fn invoke_core_sync(state: &CoreState, command: Value) -> Result<Value, CoreErrorPayload> {
    let command = serde_json::from_value::<CoreCommand>(command)
        .map_err(|error| shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string()))?;
    state.core.invoke(command).map_err(error_payload)
}

async fn export_portable_data(
    state: &CoreState,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    state
        .runtime
        .persist_all_game_window_placements()
        .map_err(|error| shell_error("TAURI_GAME_WINDOW_FLUSH_FAILED", error))?;
    let default_name = "rion-studio-export.json".to_owned();
    let path = tauri::async_runtime::spawn_blocking(move || {
        native_shell::save_file("Export Rion Studio JSON", &default_name, "json")
    })
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error.to_string()))?
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let input = args.first().cloned().unwrap_or(Value::Null);
    let selection = input.get("selection").cloned().unwrap_or_else(|| {
        json!({
            "games": true,
            "roles": true,
            "launchWorkspaces": true,
            "gameWindows": true,
            "macros": true,
            "preferences": true
        })
    });
    let mut command = json!({
        "type": "portableExportTo",
        "path": path.to_string_lossy(),
        "selection": selection
    });
    if let Some(preferences) = input.get("preferences") {
        command["preferences"] = preferences.clone();
    }
    invoke_core_sync(state, command)
}

async fn preview_portable_import(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let path = tauri::async_runtime::spawn_blocking(|| {
        native_shell::pick_file("Import Rion Studio JSON", "json")
    })
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error.to_string()))?
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    invoke_core_sync(
        state,
        json!({ "type": "portablePreviewFile", "path": path.to_string_lossy() }),
    )
}

async fn preview_chrome_profile_import(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let default_path = invoke_core_sync(state, json!({ "type": "chromeProfileDefaultPath" }))?
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| {
            shell_error(
                "CHROME_PROFILE_PATH_UNAVAILABLE",
                "The default Chrome User Data folder is unavailable.",
            )
        })?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        native_shell::pick_directory("Choose Chrome User Data", &default_path)
    })
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error.to_string()))?
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = selected else {
        return Ok(Value::Null);
    };
    invoke_core_sync(
        state,
        json!({
            "type": "chromeProfilePreview",
            "sourceUserDataDir": path.to_string_lossy()
        }),
    )
}

async fn reveal_logs(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let directory = invoke_core_sync(state, json!({ "type": "logsStatus" }))?
        .get("directory")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| shell_error("SHELL_REVEAL_FAILED", "Log directory is unavailable."))?;
    tauri::async_runtime::spawn_blocking(move || native_shell::reveal_in_file_manager(&directory))
        .await
        .map_err(|error| shell_error("SHELL_REVEAL_FAILED", error.to_string()))?
        .map_err(|error| shell_error("SHELL_REVEAL_FAILED", error))?;
    Ok(Value::Null)
}

async fn export_diagnostics(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &CoreState,
) -> Result<Value, CoreErrorPayload> {
    let path = tauri::async_runtime::spawn_blocking(|| {
        native_shell::save_file(
            "Export Rion Studio Diagnostics",
            "Rion-Studio-Diagnostics.zip",
            "zip",
        )
    })
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error.to_string()))?
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let displays = display_inventory(window)?
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|display| {
            json!({
                "bounds": display["bounds"].clone(),
                "resolution": display["resolution"].clone(),
                "scaleFactor": display["scaleFactor"].clone()
            })
        })
        .collect::<Vec<_>>();
    let versions = runtime_versions(app, state)?;
    invoke_core_async(
        state,
        json!({
            "type": "diagnosticsExport",
            "path": path.to_string_lossy(),
            "snapshot": {
                "applicationName": app.package_info().name,
                "applicationVersion": app.package_info().version.to_string(),
                "packaged": !cfg!(debug_assertions),
                "engine": versions["engine"].clone(),
                "engineVersion": versions["engineVersion"].clone(),
                "shell": versions["shell"].clone(),
                "shellVersion": versions["shellVersion"].clone(),
                "locale": "system",
                "systemVersion": std::env::consts::OS,
                "displays": displays,
                "gpuFeatureStatusRawJson": "{}",
                "browserPerformance": state.runtime.last_browser_performance_diagnostics()
            }
        }),
    )
    .await
}

fn runtime_versions(_app: &tauri::AppHandle, state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let probe = invoke_core_sync(state, json!({ "type": "systemWebViewProbe" }))?;
    Ok(json!({
        "engine": probe["engine"].clone(),
        "engineVersion": probe["runtimeVersion"]
            .as_str()
            .unwrap_or("unknown"),
        "shell": "tauri",
        "shellVersion": tauri::VERSION
    }))
}

async fn create_game_window_transaction(
    app: &AppHandle,
    state: &CoreState,
    input: GameWindowCreateInputRecord,
) -> Result<Value, CoreErrorPayload> {
    let created = Arc::clone(&state.core)
        .invoke_async(CoreCommand::GameWindowCreate { input })
        .await
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<StateGameWindowRecord>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
    let window_id = created.id.clone();
    let creation_result = async {
        let target = launch_target_for_game_window(app, &window_id)?;
        Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedWindowRegister { target })
            .await
            .map_err(error_payload)?;
        game_window_record(&state.core, &window_id)
    }
    .await;

    match creation_result {
        Ok(authoritative) => serde_json::to_value(authoritative)
            .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())),
        Err(native_error) => {
            if let Err(rollback_error) = rollback_created_game_window(state, &window_id).await {
                return Err(game_window_create_rollback_error(
                    &window_id,
                    &native_error,
                    rollback_error,
                ));
            }
            Err(native_error)
        }
    }
}

async fn rollback_created_game_window(state: &CoreState, window_id: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedWindowDelete {
            window_id: window_id.to_owned(),
        })
        .await
    {
        errors.push(format!("native cleanup: {}: {}", error.code(), error));
    }
    state.runtime.discard_provisional_game_window(window_id);
    if let Err(error) = Arc::clone(&state.core)
        .invoke_async(CoreCommand::GameWindowDelete {
            id: window_id.to_owned(),
        })
        .await
    {
        errors.push(format!("metadata cleanup: {}: {}", error.code(), error));
    }

    match state.core.invoke(CoreCommand::GameWindowsList) {
        Ok(game_windows) => {
            if game_windows.as_array().is_some_and(|game_windows| {
                game_windows
                    .iter()
                    .any(|game_window| game_window["id"].as_str() == Some(window_id))
            }) {
                errors.push("metadata verification: Game Window record still exists".to_owned());
            }
        }
        Err(error) => errors.push(format!(
            "metadata verification: {}: {}",
            error.code(),
            error
        )),
    }
    match state.core.invoke(CoreCommand::BrowserRuntimeSnapshot) {
        Ok(snapshot) => {
            if snapshot["windows"].as_array().is_some_and(|windows| {
                windows
                    .iter()
                    .any(|window| window["windowId"].as_str() == Some(window_id))
            }) {
                errors.push("runtime verification: Game Window is still registered".to_owned());
            }
        }
        Err(error) => errors.push(format!("runtime verification: {}: {}", error.code(), error)),
    }
    if state.runtime.window_for_id(window_id).is_some() {
        errors.push("native verification: Game Window handle still exists".to_owned());
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn game_window_create_rollback_error(
    window_id: &str,
    native_error: &CoreErrorPayload,
    rollback_error: impl AsRef<str>,
) -> CoreErrorPayload {
    shell_error(
        "SHELL_GAME_WINDOW_ROLLBACK_FAILED",
        format!(
            "Game Window {window_id} creation failed ({}: {}); rollback failed: {}",
            native_error.code,
            native_error.message,
            rollback_error.as_ref()
        ),
    )
}

fn core_game_window_is_empty(core: &AppCore, window_id: &str) -> bool {
    core.invoke(CoreCommand::BrowserRuntimeSnapshot)
        .ok()
        .and_then(|snapshot| {
            snapshot["windows"]
                .as_array()?
                .iter()
                .find(|window| window["windowId"].as_str() == Some(window_id))
                .and_then(|window| window["tabIds"].as_array())
                .map(Vec::is_empty)
        })
        .unwrap_or(false)
}

fn prune_empty_game_window_records(core: &AppCore) {
    let Ok(snapshot) = core.invoke(CoreCommand::BrowserRuntimeSnapshot) else {
        return;
    };
    let empty_ids = snapshot["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|window| window["tabIds"].as_array().is_some_and(Vec::is_empty))
        .filter_map(|window| window["windowId"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    for id in empty_ids {
        let _ = core.invoke(CoreCommand::GameWindowDelete { id });
    }
}

async fn delete_empty_game_window(
    state: &CoreState,
    window_id: &str,
) -> Result<(), CoreErrorPayload> {
    if !core_game_window_is_empty(&state.core, window_id) {
        return Ok(());
    }
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedWindowDelete {
            window_id: window_id.to_owned(),
        })
        .await
        .map_err(error_payload)?;
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::GameWindowDelete {
            id: window_id.to_owned(),
        })
        .await
        .map_err(error_payload)?;
    Ok(())
}

fn schedule_empty_game_window_prune(app: &AppHandle, label: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            thread::sleep(Duration::from_millis(250));
        })
        .await;
        let Some(state) = app.try_state::<CoreState>() else {
            return;
        };
        let Some(window_id) = state.runtime.window_id_for_label(&label) else {
            return;
        };
        if state
            .runtime
            .window_for_id(&window_id)
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false)
            || !core_game_window_is_empty(&state.core, &window_id)
        {
            return;
        }
        if let Err(error) = delete_empty_game_window(&state, &window_id).await {
            let _ = app.emit(
                "rion://shell-error",
                json!({ "code": error.code, "message": error.message }),
            );
        }
    });
}

async fn restore_saved_game_windows(
    state: &CoreState,
    window: &WebviewWindow,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let input = args
        .first()
        .cloned()
        .unwrap_or_else(|| json!({ "scope": "all" }));
    let scope = input["scope"].as_str().ok_or_else(|| {
        shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window restore scope is invalid.",
        )
    })?;
    if !matches!(scope, "all" | "last-visible" | "window") {
        return Err(shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window restore scope is invalid.",
        ));
    }
    let mut game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))
        })?;
    for saved in game_windows.iter().filter(|saved| saved.tabs.is_empty()) {
        state
            .core
            .invoke(CoreCommand::GameWindowDelete {
                id: saved.id.clone(),
            })
            .map_err(error_payload)?;
    }
    game_windows.retain(|saved| !saved.tabs.is_empty());
    let selected = game_windows
        .iter()
        .filter(|saved| match scope {
            "window" => Some(saved.id.as_str()) == input["windowId"].as_str(),
            // Visibility is deliberately not duplicated in the lifecycle
            // journal. Every permanent window reopens after a clean launch.
            "last-visible" | "all" => true,
            _ => false,
        })
        .cloned()
        .collect::<Vec<_>>();
    let recovery_flow = state.runtime.recovery_required();
    replace_restore_progress(
        state,
        selected.iter().map(|saved| saved.id.clone()).collect(),
    )?;
    let restore_progress = RestoreProgressGuard::new(state);
    let mut restored_ids = Vec::new();
    let mut failures = Vec::new();
    for saved in selected {
        let target = match launch_target_for_game_window(window.app_handle(), &saved.id) {
            Ok(target) => target,
            Err(error) => {
                failures.push(json!({
                    "windowId": saved.id,
                    "code": error.code,
                    "message": error.message
                }));
                continue;
            }
        };
        let mut window_failed = false;
        if saved.tabs.is_empty()
            && let Err(error) = Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedWindowRegister {
                    target: target.clone(),
                })
                .await
        {
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_WINDOW_FAILED",
                "message": error.to_string()
            }));
            window_failed = true;
        }
        let mut active_runtime_tab_id = None;
        for tab in &saved.tabs {
            let before = browser_runtime_snapshot(state)?;
            let ready_before = match_runtime_restore_tab(&before, &saved.id, tab);
            let launch_succeeded = match ready_before {
                RuntimeRestoreTabMatch::InTarget { .. } => true,
                RuntimeRestoreTabMatch::Conflict { window_id } => {
                    failures.push(json!({
                        "windowId": saved.id,
                        "tabId": tab.id,
                        "sourceId": tab.source_id,
                        "code": "TAURI_RESTORE_SOURCE_CONFLICT",
                        "message": format!(
                            "The saved source is already running in Game Window {window_id}."
                        )
                    }));
                    window_failed = true;
                    false
                }
                RuntimeRestoreTabMatch::Missing => {
                    let launch_result = if tab.tab_type == "workspace" {
                        invoke_core_async(
                            state,
                            json!({
                                "type": "browserWorkspaceLaunch",
                                "workspaceId": tab.source_id,
                                "target": target
                            }),
                        )
                        .await
                    } else {
                        invoke_core_async(
                            state,
                            json!({
                                "type": "browserRoleLaunch",
                                "roleId": tab.source_id,
                                "target": target
                            }),
                        )
                        .await
                    };
                    match launch_result {
                        Ok(_) => true,
                        Err(error) => {
                            failures.push(json!({
                                "windowId": saved.id,
                                "tabId": tab.id,
                                "sourceId": tab.source_id,
                                "code": error.code,
                                "message": error.message
                            }));
                            window_failed = true;
                            false
                        }
                    }
                }
            };

            // A launch publishes a partial runtime snapshot. Reapply the full
            // saved list until every tab is materialized so later tabs retain
            // their stable IDs and a failed tab stays retryable.
            state
                .core
                .invoke(CoreCommand::GameWindowUpdate {
                    id: saved.id.clone(),
                    input: rion_core::GameWindowUpdateInputRecord {
                        tabs: Some(saved.tabs.clone()),
                        active_tab_id: Some(saved.active_tab_id.clone()),
                        ..rion_core::GameWindowUpdateInputRecord::default()
                    },
                })
                .map_err(error_payload)?;
            if !launch_succeeded {
                continue;
            }
            let snapshot = browser_runtime_snapshot(state)?;
            let (restored_tab_id, restored_hidden) =
                match match_runtime_restore_tab(&snapshot, &saved.id, tab) {
                    RuntimeRestoreTabMatch::InTarget { hidden, id } => (id, hidden),
                    RuntimeRestoreTabMatch::Missing | RuntimeRestoreTabMatch::Conflict { .. } => {
                        failures.push(json!({
                            "windowId": saved.id,
                            "tabId": tab.id,
                            "sourceId": tab.source_id,
                            "code": "TAURI_RESTORE_TAB_MISSING",
                            "message": "The restored tab was not found in its target Game Window."
                        }));
                        window_failed = true;
                        continue;
                    }
                };
            if saved.active_tab_id.as_deref() == Some(tab.id.as_str()) {
                active_runtime_tab_id = Some(restored_tab_id.clone());
            }
            if let Err(error) = state
                .runtime
                .restore_tab_role_views(&restored_tab_id, &tab.role_views)
            {
                failures.push(json!({
                    "windowId": saved.id,
                    "tabId": tab.id,
                    "sourceId": tab.source_id,
                    "code": "TAURI_RESTORE_LAYOUT_FAILED",
                    "message": error
                }));
                window_failed = true;
            }
            if tab.audio_muted
                && let Err(error) = state.runtime.restore_tab_audio_muted(&tab.source_id, true)
            {
                failures.push(json!({
                    "windowId": saved.id,
                    "tabId": tab.id,
                    "sourceId": tab.source_id,
                    "code": "TAURI_RESTORE_AUDIO_FAILED",
                    "message": error
                }));
                window_failed = true;
            }
            if tab.hidden
                && !restored_hidden
                && saved.active_tab_id.as_deref() != Some(tab.id.as_str())
                && let Err(error) = invoke_core_async(
                    state,
                    json!({ "type": "embeddedTabHide", "tabId": restored_tab_id }),
                )
                .await
            {
                failures.push(json!({
                    "windowId": saved.id,
                    "tabId": tab.id,
                    "sourceId": tab.source_id,
                    "code": error.code,
                    "message": error.message
                }));
                window_failed = true;
            }
        }
        if let Some(active_tab_id) = active_runtime_tab_id.as_deref()
            && let Err(error) = invoke_core_async(
                state,
                json!({ "type": "embeddedTabActivate", "tabId": active_tab_id }),
            )
            .await
        {
            failures.push(json!({
                "windowId": saved.id,
                "tabId": active_tab_id,
                "code": error.code,
                "message": error.message
            }));
            window_failed = true;
        }
        if !window_failed {
            restored_ids.push(saved.id.clone());
        }
    }
    let remaining_windows = game_windows
        .iter()
        .filter(|saved| {
            !saved.tabs.is_empty() && !restored_ids.iter().any(|restored| restored == &saved.id)
        })
        .map(game_window_restore_record)
        .collect::<Vec<_>>();
    let focus_window_id = state
        .core
        .invoke(CoreCommand::RuntimeRestoreSessionGet)
        .ok()
        .and_then(|session| session["lastFocusedWindowId"].as_str().map(str::to_owned))
        .filter(|window_id| restored_ids.contains(window_id))
        .or_else(|| restored_ids.last().cloned());
    restore_progress.finish()?;
    state.runtime.replace_dormant_windows(
        remaining_windows.clone(),
        recovery_flow && !remaining_windows.is_empty(),
    );
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    if let Some(window_id) = focus_window_id {
        Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedWindowsShow {
                window_id: Some(window_id),
            })
            .await
            .map_err(error_payload)?;
    }
    Ok(json!({
        "restoredWindowIds": restored_ids,
        "failures": failures
    }))
}

fn browser_runtime_snapshot(state: &CoreState) -> Result<BrowserRuntimeSnapshot, CoreErrorPayload> {
    state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)
        .and_then(|snapshot| {
            serde_json::from_value(snapshot)
                .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))
        })
}

fn match_runtime_restore_tab(
    snapshot: &BrowserRuntimeSnapshot,
    window_id: &str,
    saved: &GameWindowTabRecord,
) -> RuntimeRestoreTabMatch {
    let Some(tab) = snapshot
        .tabs
        .iter()
        .find(|tab| tab.source_id == saved.source_id && tab.tab_type == saved.tab_type)
    else {
        return RuntimeRestoreTabMatch::Missing;
    };
    if tab.window_id == window_id {
        RuntimeRestoreTabMatch::InTarget {
            hidden: tab.hidden,
            id: tab.id.clone(),
        }
    } else {
        RuntimeRestoreTabMatch::Conflict {
            window_id: tab.window_id.clone(),
        }
    }
}

fn game_window_restore_record(
    window: &StateGameWindowRecord,
) -> rion_core::RuntimeRestoreWindowRecord {
    let active_source_id = window.active_tab_id.as_ref().and_then(|active_tab_id| {
        window
            .tabs
            .iter()
            .find(|tab| &tab.id == active_tab_id && !tab.hidden)
            .map(|tab| tab.source_id.clone())
    });
    rion_core::RuntimeRestoreWindowRecord {
        id: window.id.clone(),
        target_display: window.target_display.clone(),
        was_visible: true,
        active_source_id,
        tabs: window
            .tabs
            .iter()
            .map(|tab| rion_core::RuntimeRestoreTabRecord {
                tab_type: tab.tab_type.clone(),
                source_id: tab.source_id.clone(),
                name: tab.name.clone(),
                role_ids: tab.role_ids.clone(),
                hidden: tab.hidden,
                audio_muted: tab.audio_muted,
            })
            .collect(),
    }
}

fn replace_restore_progress(
    state: &CoreState,
    window_ids: Vec<String>,
) -> Result<(), CoreErrorPayload> {
    let mut session = state
        .core
        .invoke(CoreCommand::RuntimeRestoreSessionGet)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<rion_core::RuntimeRestoreSessionRecord>(value)
                .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))
        })?;
    session.schema_version = 2;
    session.updated_at = chrono::Utc::now().to_rfc3339();
    session.clean_exit = false;
    session.restore_in_progress_window_ids = window_ids;
    session.windows.clear();
    state
        .core
        .invoke(CoreCommand::RuntimeRestoreSessionReplace { session })
        .map(|_| ())
        .map_err(error_payload)
}

fn discard_saved_game_windows(
    state: &CoreState,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let input = args
        .first()
        .cloned()
        .unwrap_or_else(|| json!({ "scope": "all" }));
    let scope = input["scope"].as_str().ok_or_else(|| {
        shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window discard scope is invalid.",
        )
    })?;
    if !matches!(scope, "all" | "window") {
        return Err(shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window discard scope is invalid.",
        ));
    }
    let requested_window_id = if scope == "window" {
        Some(input["windowId"].as_str().ok_or_else(|| {
            shell_error(
                "TAURI_SHELL_INPUT_INVALID",
                "Saved Game Window ID is required.",
            )
        })?)
    } else {
        None
    };
    let game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))
        })?;
    let selected = game_windows
        .iter()
        .filter(|window| requested_window_id.is_none_or(|id| id == window.id))
        .collect::<Vec<_>>();
    for window in &selected {
        state
            .core
            .invoke(CoreCommand::GameWindowUpdate {
                id: window.id.clone(),
                input: rion_core::GameWindowUpdateInputRecord {
                    tabs: Some(Vec::new()),
                    active_tab_id: Some(None),
                    ..rion_core::GameWindowUpdateInputRecord::default()
                },
            })
            .map_err(error_payload)?;
    }
    replace_restore_progress(state, Vec::new())?;
    let remaining_windows = game_windows
        .iter()
        .filter(|window| {
            !window.tabs.is_empty() && !selected.iter().any(|item| item.id == window.id)
        })
        .map(game_window_restore_record)
        .collect::<Vec<_>>();
    state
        .runtime
        .replace_dormant_windows(remaining_windows, false);
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    Ok(json!({
        "discardedWindowIds": selected.iter().map(|window| window.id.clone()).collect::<Vec<_>>()
    }))
}

fn string_argument(args: &[Value], index: usize, label: &str) -> Result<String, CoreErrorPayload> {
    args.get(index)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| shell_error("TAURI_SHELL_INPUT_INVALID", format!("{label} is required.")))
}

pub(crate) fn game_window_launch_target(
    app: &AppHandle,
    state: &CoreState,
    main_window: &WebviewWindow,
    requested_window_id: Option<&str>,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    game_window_launch_target_internal(app, state, main_window, requested_window_id, false)
}

pub(crate) fn new_game_window_launch_target(
    app: &AppHandle,
    state: &CoreState,
    main_window: &WebviewWindow,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    game_window_launch_target_internal(app, state, main_window, None, true)
}

fn game_window_launch_target_internal(
    app: &AppHandle,
    state: &CoreState,
    main_window: &WebviewWindow,
    requested_window_id: Option<&str>,
    force_new: bool,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let mut game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
    let last_focused = state
        .core
        .invoke(CoreCommand::RuntimeRestoreSessionGet)
        .ok()
        .and_then(|session| session["lastFocusedWindowId"].as_str().map(str::to_owned));
    let selected_id = (!force_new)
        .then(|| {
            requested_window_id
                .filter(|id| game_windows.iter().any(|window| window.id == *id))
                .map(str::to_owned)
                .or_else(|| {
                    last_focused.filter(|id| game_windows.iter().any(|window| &window.id == id))
                })
                .or_else(|| game_windows.first().map(|window| window.id.clone()))
        })
        .flatten();
    let selected_id = if let Some(id) = selected_id {
        id
    } else {
        let base_target = default_display_launch_target(main_window, None)?;
        let display_id = base_target.display_id;
        let work_area = base_target.work_area;
        let existing_on_display = game_windows
            .iter()
            .filter(|window| window.target_display.id == display_id)
            .count() as i32;
        let width = if work_area.width >= 960 {
            ((work_area.width as f64 * 0.8).round() as i32).max(960)
        } else {
            work_area.width
        }
        .min(work_area.width)
        .max(640.min(work_area.width));
        let height = if work_area.height >= 640 {
            ((work_area.height as f64 * 0.8).round() as i32).max(640)
        } else {
            work_area.height
        }
        .min(work_area.height)
        .max(480.min(work_area.height));
        let cascade = (existing_on_display * 24).min(240);
        let max_x = work_area.x + (work_area.width - width).max(0);
        let max_y = work_area.y + (work_area.height - height).max(0);
        let x = (work_area.x + (work_area.width - width) / 2 + cascade).min(max_x);
        let y = (work_area.y + (work_area.height - height) / 2 + cascade).min(max_y);
        let language = state
            .menu_language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let name = next_game_window_name(&game_windows, &language);
        let primary_id = app
            .primary_monitor()
            .ok()
            .flatten()
            .as_ref()
            .map(monitor_id);
        let target_display = app
            .available_monitors()
            .ok()
            .and_then(|monitors| {
                monitors
                    .into_iter()
                    .find(|monitor| monitor_id(monitor) == display_id)
            })
            .map(|monitor| display_target_and_work_area(&monitor, primary_id).0)
            .unwrap_or(DisplayTargetRecord {
                id: display_id,
                fingerprint: None,
            });
        let created = state
            .core
            .invoke(CoreCommand::GameWindowCreate {
                input: GameWindowCreateInputRecord {
                    id: None,
                    name,
                    target_display,
                    placement: GameWindowPlacementRecord {
                        normal_bounds: StatePixelBoundsRecord {
                            x,
                            y,
                            width,
                            height,
                        },
                        saved_work_area: work_area,
                        presentation: "normal".to_owned(),
                    },
                },
            })
            .map_err(error_payload)
            .and_then(|value| {
                serde_json::from_value::<StateGameWindowRecord>(value)
                    .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
            })?;
        let id = created.id.clone();
        game_windows.push(created);
        id
    };
    launch_target_for_game_window(app, &selected_id)
}

fn default_display_launch_target(
    window: &WebviewWindow,
    requested_display_id: Option<i64>,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let monitors = window
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let monitor = if let Some(display_id) = requested_display_id {
        monitors
            .iter()
            .find(|monitor| monitor_id(monitor) == display_id)
            .cloned()
    } else {
        window
            .current_monitor()
            .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?
            .or_else(|| window.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned())
    }
    .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    Ok(EmbeddedLaunchTargetRecord {
        window_id: uuid::Uuid::new_v4().to_string(),
        display_id: monitor_id(&monitor),
        scale_factor,
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        bounds: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        presentation: "normal".to_owned(),
    })
}

fn embedded_target_for_monitor(monitor: &tauri::Monitor) -> EmbeddedLaunchTargetRecord {
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    EmbeddedLaunchTargetRecord {
        window_id: uuid::Uuid::new_v4().to_string(),
        display_id: monitor_id(monitor),
        scale_factor,
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        bounds: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        presentation: "normal".to_owned(),
    }
}

pub(crate) fn launch_target_for_game_window(
    app: &AppHandle,
    window_id: &str,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let state = app
        .try_state::<CoreState>()
        .ok_or_else(|| shell_error("SHELL_STATE_UNAVAILABLE", "App state is unavailable."))?;
    let record = game_window_record(&state.core, window_id)?;
    let resolution = resolve_game_window_launch_target(app, &record)?;
    if let Some(remap) = resolution.remap {
        persist_game_window_display_remap(
            app,
            &state,
            window_id,
            resolution.target.display_id,
            remap,
        )?;
    }
    Ok(resolution.target)
}

struct GameWindowLaunchResolution {
    target: EmbeddedLaunchTargetRecord,
    remap: Option<GameWindowUpdateInputRecord>,
}

fn resolve_game_window_launch_target(
    app: &AppHandle,
    record: &StateGameWindowRecord,
) -> Result<GameWindowLaunchResolution, CoreErrorPayload> {
    let monitors = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_monitor = app
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_id = primary_monitor.as_ref().map(monitor_id);
    let current_monitor = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten());
    let exact = monitors.iter().find(|monitor| {
        monitor_id(monitor) == record.target_display.id
            && record
                .target_display
                .fingerprint
                .as_ref()
                .is_none_or(|saved| {
                    display_fingerprint_matches(
                        saved,
                        &display_target_and_work_area(monitor, primary_id)
                            .0
                            .fingerprint
                            .expect("native monitor targets include fingerprints"),
                    )
                })
    });
    let selected = exact
        .cloned()
        .or_else(|| {
            record
                .target_display
                .fingerprint
                .as_ref()
                .and_then(|saved| {
                    monitors
                        .iter()
                        .max_by_key(|monitor| {
                            let current = display_target_and_work_area(monitor, primary_id)
                                .0
                                .fingerprint
                                .expect("native monitor targets include fingerprints");
                            display_fingerprint_score(saved, &current)
                        })
                        .cloned()
                })
        })
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| primary_id == Some(monitor_id(monitor)))
                .cloned()
        })
        .or(primary_monitor)
        .or(current_monitor)
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let remapped = exact.is_none();
    let mut target = embedded_target_for_monitor(&selected);
    target.window_id = record.id.clone();
    target.presentation = record.placement.presentation.clone();
    let remap = if remapped {
        target.bounds = remap_window_bounds(
            &record.placement.normal_bounds,
            &record.placement.saved_work_area,
            &target.work_area,
        );
        Some(GameWindowUpdateInputRecord {
            target_display: Some(DisplayTargetRecord {
                id: target.display_id,
                fingerprint: display_target_and_work_area(&selected, primary_id)
                    .0
                    .fingerprint,
            }),
            placement: Some(GameWindowPlacementRecord {
                normal_bounds: target.bounds.clone(),
                saved_work_area: target.work_area.clone(),
                presentation: target.presentation.clone(),
            }),
            ..GameWindowUpdateInputRecord::default()
        })
    } else {
        target.bounds = clamp_window_bounds(&record.placement.normal_bounds, &target.work_area);
        None
    };
    Ok(GameWindowLaunchResolution { target, remap })
}

fn persist_game_window_display_remap(
    app: &AppHandle,
    state: &CoreState,
    window_id: &str,
    display_id: i64,
    input: GameWindowUpdateInputRecord,
) -> Result<(), CoreErrorPayload> {
    state
        .core
        .invoke(CoreCommand::GameWindowUpdate {
            id: window_id.to_owned(),
            input,
        })
        .map_err(error_payload)?;
    let _ = app.emit(
        "rion://game-window-display-remapped",
        json!({ "windowId": window_id, "displayId": display_id }),
    );
    Ok(())
}

fn relocate_before_display_remap(
    relocate: impl FnOnce() -> Result<(), CoreErrorPayload>,
    persist: impl FnOnce() -> Result<(), CoreErrorPayload>,
) -> Result<(), CoreErrorPayload> {
    relocate()?;
    persist()
}

fn display_fingerprint_matches(
    saved: &DisplayFingerprintRecord,
    current: &DisplayFingerprintRecord,
) -> bool {
    saved.label == current.label
        && saved.bounds.x == current.bounds.x
        && saved.bounds.y == current.bounds.y
        && saved.bounds.width == current.bounds.width
        && saved.bounds.height == current.bounds.height
        && saved.resolution.width == current.resolution.width
        && saved.resolution.height == current.resolution.height
        && (saved.scale_factor - current.scale_factor).abs() < 0.001
        && saved.is_primary == current.is_primary
        && saved.is_internal == current.is_internal
}

fn display_fingerprint_score(
    saved: &DisplayFingerprintRecord,
    current: &DisplayFingerprintRecord,
) -> u16 {
    u16::from(saved.is_internal == current.is_internal) * 100
        + u16::from(saved.is_primary == current.is_primary) * 80
        + u16::from(
            saved.resolution.width == current.resolution.width
                && saved.resolution.height == current.resolution.height,
        ) * 60
        + u16::from((saved.scale_factor - current.scale_factor).abs() < 0.001) * 30
        + u16::from(saved.label == current.label) * 20
        + u16::from(
            saved.bounds.width == current.bounds.width
                && saved.bounds.height == current.bounds.height,
        ) * 10
}

pub(crate) async fn handle_game_window_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    source_window_id: &str,
    action: &Value,
) -> Result<bool, CoreErrorPayload> {
    let Some(action_type) = action["type"].as_str() else {
        return Ok(false);
    };
    if !matches!(
        action_type,
        "tabDragStart" | "tabDragMove" | "tabDragDrop" | "tabDragEnd" | "tabDragCancel"
    ) {
        return Ok(false);
    }
    let _lane = state.tab_drag_lane.lock().await;
    let session_id = action["sessionId"]
        .as_str()
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| {
            shell_error(
                "TAURI_TAB_DRAG_INVALID",
                "Runtime tab drag session ID is invalid.",
            )
        })?;

    match action_type {
        "tabDragStart" => {
            if tab_drag_session_finished(state, session_id)? {
                return Ok(true);
            }
            let tab_id = action["tabId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error("TAURI_TAB_DRAG_INVALID", "Runtime tab ID is required.")
                })?;
            let (screen_x, screen_y) = drag_screen_point(app, action)?;
            let runtime = state
                .core
                .invoke(CoreCommand::BrowserRuntimeSnapshot)
                .map_err(error_payload)?;
            let tab = runtime["tabs"]
                .as_array()
                .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_str() == Some(tab_id)))
                .filter(|tab| tab["windowId"].as_str() == Some(source_window_id))
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Runtime tab is outside the source Game Window.",
                    )
                })?;
            let source = state
                .core
                .invoke(CoreCommand::GameWindowGet {
                    id: source_window_id.to_owned(),
                })
                .map_err(error_payload)
                .and_then(|value| {
                    serde_json::from_value::<StateGameWindowRecord>(value).map_err(|error| {
                        shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let windows = state
                .core
                .invoke(CoreCommand::GameWindowsList)
                .map_err(error_payload)
                .and_then(|value| {
                    serde_json::from_value::<Vec<StateGameWindowRecord>>(value).map_err(|error| {
                        shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let source_will_empty = source.tabs.len() == 1;
            if windows.len() >= 32 && !source_will_empty {
                return Err(shell_error(
                    "GAME_WINDOW_LIMIT_REACHED",
                    "No more than 32 game windows can be saved.",
                ));
            }
            if state
                .tab_drag
                .lock()
                .map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?
                .is_some()
            {
                return Err(shell_error(
                    "TAURI_TAB_DRAG_BUSY",
                    "Another runtime tab drag is already active.",
                ));
            }
            let provisional_window_id = uuid::Uuid::new_v4().to_string();
            let (target, target_display) = provisional_target_for_screen(
                app,
                &source,
                &provisional_window_id,
                screen_x,
                screen_y,
            )?;
            let language = state
                .menu_language
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| "en".to_owned());
            let name = next_game_window_name(&windows, &language);
            let title = tab["name"].as_str().unwrap_or(&name).to_owned();
            let initial_target = target.clone();
            *state.tab_drag.lock().map_err(|_| {
                shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
            })? = Some(GameWindowTabDragSession {
                detached: false,
                detach_requested: false,
                id: session_id.to_owned(),
                name,
                prepared: false,
                provisional_window_id,
                source_window_id: source_window_id.to_owned(),
                tab_id: tab_id.to_owned(),
                target,
                target_display,
            });
            if let Err(message) = state
                .runtime
                .prepare_provisional_game_window(&initial_target, &title)
            {
                return Err(abort_tab_drag_start(
                    state,
                    session_id,
                    shell_error("TAURI_TAB_DRAG_FAILED", message),
                ));
            }
            let prepared = {
                let mut current = state.tab_drag.lock().map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?;
                let Some(session) = current.as_mut().filter(|session| session.id == session_id)
                else {
                    state
                        .runtime
                        .discard_provisional_game_window(&initial_target.window_id);
                    return Ok(true);
                };
                session.prepared = true;
                session.clone()
            };
            if let Err(message) = state
                .runtime
                .position_provisional_game_window(&prepared.target)
            {
                return Err(abort_tab_drag_start(
                    state,
                    session_id,
                    shell_error("TAURI_TAB_DRAG_FAILED", message),
                ));
            }
            if prepared.detach_requested && !prepared.detached {
                if let Err(message) = state
                    .runtime
                    .provisionally_move_tab(&prepared.tab_id, &prepared.provisional_window_id)
                {
                    return Err(abort_tab_drag_start(
                        state,
                        session_id,
                        shell_error("TAURI_TAB_DRAG_FAILED", message),
                    ));
                }
                if let Ok(mut current) = state.tab_drag.lock()
                    && let Some(session) =
                        current.as_mut().filter(|session| session.id == session_id)
                {
                    session.detached = true;
                }
            }
        }
        "tabDragMove" => {
            let (screen_x, screen_y) = drag_screen_point(app, action)?;
            let session = state
                .tab_drag
                .lock()
                .map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?
                .clone()
                .filter(|session| session.id == session_id)
                .map_or_else(
                    || {
                        if tab_drag_session_finished(state, session_id)? {
                            Ok(None)
                        } else {
                            Err(shell_error(
                                "TAURI_TAB_DRAG_STALE",
                                "Runtime tab drag session is stale.",
                            ))
                        }
                    },
                    |session| Ok(Some(session)),
                )?;
            let Some(session) = session else {
                return Ok(true);
            };
            let source = state
                .core
                .invoke(CoreCommand::GameWindowGet {
                    id: session.source_window_id.clone(),
                })
                .map_err(error_payload)
                .and_then(|value| {
                    serde_json::from_value::<StateGameWindowRecord>(value).map_err(|error| {
                        shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let (target, target_display) = provisional_target_for_screen(
                app,
                &source,
                &session.provisional_window_id,
                screen_x,
                screen_y,
            )?;
            let outside_source = !state.runtime.window_contains_screen_point(
                &session.source_window_id,
                screen_x,
                screen_y,
            );
            let ready = {
                let mut current = state.tab_drag.lock().map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?;
                let Some(current) = current.as_mut().filter(|current| current.id == session_id)
                else {
                    return Ok(true);
                };
                current.target = target;
                current.target_display = target_display;
                current.detach_requested |= outside_source;
                current.clone()
            };
            if !ready.prepared {
                return Ok(true);
            }
            state
                .runtime
                .position_provisional_game_window(&ready.target)
                .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
            if ready.detach_requested && !ready.detached {
                state
                    .runtime
                    .provisionally_move_tab(&ready.tab_id, &ready.provisional_window_id)
                    .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
                if let Ok(mut current) = state.tab_drag.lock()
                    && let Some(session) =
                        current.as_mut().filter(|session| session.id == session_id)
                {
                    session.detached = true;
                }
            }
        }
        "tabDragDrop" => {
            let target_window_id = action["windowId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Drop target window ID is required.",
                    )
                })?;
            mark_tab_drag_session_finished(state, session_id)?;
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            if target_window_id == session.provisional_window_id {
                if let Err(error) = commit_tab_drag_to_new_window(state, &session).await {
                    return Err(cancel_tab_drag_preserving_error(state, &session, error));
                }
            } else if target_window_id == session.source_window_id {
                cancel_tab_drag_session_recoverable(state, &session)?;
                if let Some(before_tab_id) = action["beforeTabId"].as_str() {
                    Arc::clone(&state.core)
                        .invoke_async(CoreCommand::EmbeddedTabReorder {
                            tab_id: session.tab_id,
                            before_tab_id: Some(before_tab_id.to_owned()),
                        })
                        .await
                        .map_err(error_payload)?;
                }
            } else {
                let target = match launch_target_for_game_window(app, target_window_id) {
                    Ok(target) => target,
                    Err(error) => {
                        return Err(cancel_tab_drag_preserving_error(state, &session, error));
                    }
                };
                let result = Arc::clone(&state.core)
                    .invoke_async(CoreCommand::EmbeddedTabMoveOrdered {
                        tab_id: session.tab_id.clone(),
                        target,
                        before_tab_id: action["beforeTabId"].as_str().map(str::to_owned),
                    })
                    .await;
                if let Err(error) = result {
                    return Err(cancel_tab_drag_preserving_error(
                        state,
                        &session,
                        error_payload(error),
                    ));
                }
                state
                    .runtime
                    .discard_provisional_game_window(&session.provisional_window_id);
            }
        }
        "tabDragEnd" => {
            let cancelled = action["cancelled"].as_bool().unwrap_or(false);
            mark_tab_drag_session_finished(state, session_id)?;
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            if cancelled || !session.detached {
                cancel_tab_drag_session_recoverable(state, &session)?;
            } else if let Err(error) = commit_tab_drag_to_new_window(state, &session).await {
                return Err(cancel_tab_drag_preserving_error(state, &session, error));
            }
        }
        "tabDragCancel" => {
            mark_tab_drag_session_finished(state, session_id)?;
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            cancel_tab_drag_session_recoverable(state, &session)?;
        }
        _ => unreachable!(),
    }
    Ok(true)
}

const FINISHED_TAB_DRAG_LIMIT: usize = 128;

fn tab_drag_session_finished(
    state: &CoreState,
    session_id: &str,
) -> Result<bool, CoreErrorPayload> {
    state
        .tab_drag_finished
        .lock()
        .map(|finished| finished.iter().any(|id| id == session_id))
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))
}

fn mark_tab_drag_session_finished(
    state: &CoreState,
    session_id: &str,
) -> Result<(), CoreErrorPayload> {
    let mut finished = state
        .tab_drag_finished
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if !finished.iter().any(|id| id == session_id) {
        finished.push_back(session_id.to_owned());
    }
    while finished.len() > FINISHED_TAB_DRAG_LIMIT {
        finished.pop_front();
    }
    Ok(())
}

fn abort_tab_drag_start(
    state: &CoreState,
    session_id: &str,
    error: CoreErrorPayload,
) -> CoreErrorPayload {
    let _ = mark_tab_drag_session_finished(state, session_id);
    match take_tab_drag_session(state, session_id) {
        Ok(Some(session)) => cancel_tab_drag_preserving_error(state, &session, error),
        Ok(None) => error,
        Err(cleanup) => tab_drag_rollback_error(&error, &cleanup),
    }
}

fn cancel_tab_drag_preserving_error(
    state: &CoreState,
    session: &GameWindowTabDragSession,
    error: CoreErrorPayload,
) -> CoreErrorPayload {
    match cancel_tab_drag_session(state, session) {
        Ok(()) => error,
        Err(cleanup) => {
            reopen_tab_drag_session(state, session);
            tab_drag_rollback_error(&error, &cleanup)
        }
    }
}

fn cancel_tab_drag_session_recoverable(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    cancel_tab_drag_session(state, session).inspect_err(|_| {
        reopen_tab_drag_session(state, session);
    })
}

fn reopen_tab_drag_session(state: &CoreState, session: &GameWindowTabDragSession) {
    if let Ok(mut finished) = state.tab_drag_finished.lock() {
        finished.retain(|id| id != &session.id);
    }
    if let Ok(mut current) = state.tab_drag.lock()
        && current.is_none()
    {
        *current = Some(session.clone());
    }
}

fn tab_drag_rollback_error(
    error: &CoreErrorPayload,
    cleanup: &CoreErrorPayload,
) -> CoreErrorPayload {
    shell_error(
        "TAURI_TAB_DRAG_ROLLBACK_FAILED",
        format!(
            "Runtime tab drag failed ({}: {}); rollback failed ({}: {}).",
            error.code, error.message, cleanup.code, cleanup.message
        ),
    )
}

fn drag_screen_point(app: &AppHandle, action: &Value) -> Result<(f64, f64), CoreErrorPayload> {
    let screen_x = action["screenX"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen X is invalid."))?;
    let screen_y = action["screenY"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen Y is invalid."))?;
    if cfg!(windows) {
        app.cursor_position()
            .map(|point| (point.x, point.y))
            .map_err(|error| shell_error("TAURI_TAB_DRAG_FAILED", error.to_string()))
    } else {
        Ok((screen_x, screen_y))
    }
}

fn take_tab_drag_session(
    state: &CoreState,
    session_id: &str,
) -> Result<Option<GameWindowTabDragSession>, CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if current
        .as_ref()
        .is_none_or(|session| session.id != session_id)
    {
        return Ok(None);
    }
    Ok(current.take())
}

fn cancel_tab_drag_session(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .cancel_provisional_tab_move(
            &session.tab_id,
            &session.source_window_id,
            &session.provisional_window_id,
        )
        .map_err(|message| shell_error("TAURI_TAB_DRAG_ROLLBACK_FAILED", message))
}

async fn commit_tab_drag_to_new_window(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .make_provisional_game_window_interactive(&session.provisional_window_id)
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::GameWindowCreateAndMoveTab {
            input: GameWindowCreateInputRecord {
                id: Some(session.provisional_window_id.clone()),
                name: session.name.clone(),
                target_display: session.target_display.clone(),
                placement: GameWindowPlacementRecord {
                    normal_bounds: session.target.bounds.clone(),
                    saved_work_area: session.target.work_area.clone(),
                    presentation: "normal".to_owned(),
                },
            },
            tab_id: session.tab_id.clone(),
            target: session.target.clone(),
            before_tab_id: None,
        })
        .await
        .map_err(error_payload)?;
    Ok(())
}

fn provisional_target_for_screen(
    app: &AppHandle,
    source: &StateGameWindowRecord,
    provisional_window_id: &str,
    screen_x: f64,
    screen_y: f64,
) -> Result<(EmbeddedLaunchTargetRecord, DisplayTargetRecord), CoreErrorPayload> {
    let monitors = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary = app
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_id = primary.as_ref().map(monitor_id);
    let monitor = monitor_near_screen_point(&monitors, screen_x, screen_y)
        .or(primary)
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let (target_display, work_area) = display_target_and_work_area(&monitor, primary_id);
    let (screen_x, screen_y) = if cfg!(windows) {
        let scale = monitor.scale_factor().max(f64::EPSILON);
        (screen_x / scale, screen_y / scale)
    } else {
        (screen_x, screen_y)
    };
    let mut bounds = source.placement.normal_bounds.clone();
    bounds.x = (screen_x - f64::from(bounds.width) / 2.0).round() as i32;
    bounds.y = (screen_y - 28.0).round() as i32;
    bounds = clamp_window_bounds(&bounds, &work_area);
    Ok((
        EmbeddedLaunchTargetRecord {
            window_id: provisional_window_id.to_owned(),
            display_id: monitor_id(&monitor),
            scale_factor: monitor.scale_factor().max(f64::EPSILON),
            work_area,
            bounds,
            presentation: "normal".to_owned(),
        },
        target_display,
    ))
}

pub(crate) async fn move_game_window_tab_to_new_window(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
    screen_point: Option<(f64, f64)>,
) -> Result<StateGameWindowRecord, CoreErrorPayload> {
    let runtime = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)?;
    let source_window_id = runtime["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_str() == Some(tab_id)))
        .and_then(|tab| tab["windowId"].as_str())
        .ok_or_else(|| shell_error("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
    let source = state
        .core
        .invoke(CoreCommand::GameWindowGet {
            id: source_window_id.to_owned(),
        })
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<StateGameWindowRecord>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
    let windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    let name = next_game_window_name(&windows, &language);

    let monitors = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_id = app
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?
        .as_ref()
        .map(monitor_id);
    let monitor = screen_point
        .and_then(|(x, y)| monitor_near_screen_point(&monitors, x, y))
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| monitor_id(monitor) == source.target_display.id)
                .cloned()
        })
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let (target_display, work_area) = display_target_and_work_area(&monitor, primary_id);
    let mut bounds = source.placement.normal_bounds.clone();
    if let Some((x, y)) = screen_point {
        bounds.x = (x - f64::from(bounds.width) / 2.0).round() as i32;
        bounds.y = (y - 28.0).round() as i32;
    } else {
        bounds.x = bounds.x.saturating_add(24);
        bounds.y = bounds.y.saturating_add(24);
    }
    bounds = clamp_window_bounds(&bounds, &work_area);

    let window_id = uuid::Uuid::new_v4().to_string();
    let target = EmbeddedLaunchTargetRecord {
        window_id: window_id.clone(),
        display_id: target_display.id,
        scale_factor: monitor.scale_factor().max(f64::EPSILON),
        work_area: work_area.clone(),
        bounds: bounds.clone(),
        presentation: "normal".to_owned(),
    };
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::GameWindowCreateAndMoveTab {
            input: GameWindowCreateInputRecord {
                id: Some(window_id),
                name,
                target_display,
                placement: GameWindowPlacementRecord {
                    normal_bounds: bounds,
                    saved_work_area: work_area,
                    presentation: "normal".to_owned(),
                },
            },
            tab_id: tab_id.to_owned(),
            target,
            before_tab_id: None,
        })
        .await
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<StateGameWindowRecord>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })
}

fn next_game_window_name(windows: &[StateGameWindowRecord], language: &str) -> String {
    let stem = match language {
        "zh-TW" => "遊戲視窗",
        "zh-CN" => "游戏窗口",
        "ja" => "ゲームウィンドウ",
        _ => "Game Window",
    };
    let existing = windows
        .iter()
        .map(|window| window.name.to_lowercase())
        .collect::<HashSet<_>>();
    (1..)
        .map(|number| format!("{stem} {number}"))
        .find(|candidate| !existing.contains(&candidate.to_lowercase()))
        .expect("a finite Game Window collection always has a free numeric name")
}

fn monitor_near_screen_point(
    monitors: &[tauri::Monitor],
    x: f64,
    y: f64,
) -> Option<tauri::Monitor> {
    let drag_rect = |monitor: &tauri::Monitor| {
        let scale = if cfg!(windows) {
            1.0
        } else {
            monitor.scale_factor()
        };
        let position = monitor.position();
        let size = monitor.size();
        (
            position.x as f64 / scale,
            position.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        )
    };
    let rects = monitors.iter().map(drag_rect).collect::<Vec<_>>();
    nearest_drag_rect_index(&rects, x, y).map(|index| monitors[index].clone())
}

fn nearest_drag_rect_index(rects: &[(f64, f64, f64, f64)], x: f64, y: f64) -> Option<usize> {
    rects
        .iter()
        .position(|(left, top, width, height)| {
            x >= *left && x < left + width && y >= *top && y < top + height
        })
        .or_else(|| {
            rects
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| {
                    let distance = |(left, top, width, height): &(f64, f64, f64, f64)| {
                        (x - (left + width / 2.0)).powi(2) + (y - (top + height / 2.0)).powi(2)
                    };
                    distance(left).total_cmp(&distance(right))
                })
                .map(|(index, _)| index)
        })
}

fn display_target_and_work_area(
    monitor: &tauri::Monitor,
    primary_id: Option<i64>,
) -> (DisplayTargetRecord, StatePixelBoundsRecord) {
    let id = monitor_id(monitor);
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let work_area = monitor.work_area();
    (
        DisplayTargetRecord {
            id,
            fingerprint: Some(DisplayFingerprintRecord {
                label: monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("Display {id}")),
                bounds: StatePixelBoundsRecord {
                    x: (position.x as f64 / scale).round() as i32,
                    y: (position.y as f64 / scale).round() as i32,
                    width: (size.width as f64 / scale).round() as i32,
                    height: (size.height as f64 / scale).round() as i32,
                },
                resolution: StateResolutionRecord {
                    width: size.width,
                    height: size.height,
                },
                scale_factor: scale,
                is_primary: primary_id == Some(id),
                is_internal: false,
            }),
        },
        StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale).round() as i32,
            y: (work_area.position.y as f64 / scale).round() as i32,
            width: (work_area.size.width as f64 / scale).round() as i32,
            height: (work_area.size.height as f64 / scale).round() as i32,
        },
    )
}

fn remap_window_bounds(
    bounds: &StatePixelBoundsRecord,
    old_work_area: &StatePixelBoundsRecord,
    new_work_area: &StatePixelBoundsRecord,
) -> StatePixelBoundsRecord {
    if old_work_area.width <= 0 || old_work_area.height <= 0 {
        return clamp_window_bounds(bounds, new_work_area);
    }
    let relative_x = (bounds.x - old_work_area.x) as f64 / old_work_area.width as f64;
    let relative_y = (bounds.y - old_work_area.y) as f64 / old_work_area.height as f64;
    let relative_width = bounds.width as f64 / old_work_area.width as f64;
    let relative_height = bounds.height as f64 / old_work_area.height as f64;
    clamp_window_bounds(
        &StatePixelBoundsRecord {
            x: new_work_area.x + (relative_x * new_work_area.width as f64).round() as i32,
            y: new_work_area.y + (relative_y * new_work_area.height as f64).round() as i32,
            width: (relative_width * new_work_area.width as f64).round() as i32,
            height: (relative_height * new_work_area.height as f64).round() as i32,
        },
        new_work_area,
    )
}

fn clamp_window_bounds(
    bounds: &StatePixelBoundsRecord,
    work_area: &StatePixelBoundsRecord,
) -> StatePixelBoundsRecord {
    let width = bounds
        .width
        .max(640.min(work_area.width))
        .min(work_area.width.max(1));
    let height = bounds
        .height
        .max(480.min(work_area.height))
        .min(work_area.height.max(1));
    let max_x = work_area.x + (work_area.width - width).max(0);
    let max_y = work_area.y + (work_area.height - height).max(0);
    StatePixelBoundsRecord {
        x: bounds.x.clamp(work_area.x, max_x),
        y: bounds.y.clamp(work_area.y, max_y),
        width,
        height,
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(StartupWindowState::default())
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }
            let app = webview.app_handle();
            let startup = app.try_state::<StartupWindowState>();
            if startup.as_ref().is_some_and(|state| state.reveal_once())
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if payload.event() == PageLoadEvent::Finished
                && let Some(message) = startup.and_then(|state| state.failure())
            {
                let encoded = serde_json::to_string(&message)
                    .unwrap_or_else(|_| "\"Rion Studio could not finish starting.\"".to_owned());
                let _ = webview.eval(format!("window.__rionShowStartupFailure?.({encoded});"));
            }
        });
    let builder = if update_manager::embedded_updater_public_key().is_some() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if let Some(state) = webview.app_handle().try_state::<CoreState>() {
            state.runtime.handle_web_content_process_terminated(
                webview.label(),
                "web-content-process-terminated",
            );
        }
    });
    let builder = builder.on_menu_event(|app, event| {
        application_menu::handle_event(app, event.id().as_ref());
    });
    builder
        .setup(|app| {
            let setup_result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let user_data_dir = shared_user_data_dir(app)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let app_version = app.package_info().version.to_string();
            if std::env::var_os("RION_STUDIO_USER_DATA_DIR").is_none() {
                let data_parent = app
                    .path()
                    .data_dir()
                    .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
                migrate_legacy_data_root(
                    &data_parent.join(LEGACY_DATA_DIRECTORY_NAME),
                    &user_data_dir,
                    &app_version,
                )?;
            }
            let core = match AppCore::create_with_startup_backup(
                AppCoreOptions {
                    app_version: app_version.clone(),
                    platform: platform_name()
                        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?
                        .to_owned(),
                    user_data_dir: user_data_dir.to_string_lossy().into_owned(),
                    performance_telemetry_path: None,
                },
                "tauri-stable",
            ) {
                Ok(core) => Arc::new(core),
                Err(error) if error.code() == "APP_INSTANCE_LOCKED" => {
                    for _ in 0..20 {
                        if activation::forward_activation(&user_data_dir) {
                            std::process::exit(0);
                        }
                        thread::sleep(std::time::Duration::from_millis(75));
                    }
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            };
            let activation_app_handle = app.handle().clone();
            let activation = ActivationServer::start(&user_data_dir, move || {
                let dispatch_handle = activation_app_handle.clone();
                let window_handle = dispatch_handle.clone();
                let _ = dispatch_handle.run_on_main_thread(move || {
                    if let Some(window) = window_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            })?;
            let runtime = Arc::new(SystemRuntimeExecutor::new(
                app.handle().clone(),
                user_data_dir.clone(),
                Arc::clone(&core),
            )?);
            runtime.start_effect_executor()?;
            core.invoke(CoreCommand::SystemWebViewRuntimeRegister {
                registration: runtime.registration(),
            })?;
            let receiver = core.subscribe()?;
            let quick_menu = quick_menu::create(
                &app.handle().clone(),
                Arc::clone(&core),
                Arc::clone(&runtime),
            )?;
            let updates = Arc::new(update_manager::UpdateManager::new(
                app.handle().clone(),
                app.package_info().version.to_string(),
                &user_data_dir,
            ));
            let app_handle = app.handle().clone();
            let effect_core = Arc::clone(&core);
            let effect_runtime = Arc::clone(&runtime);
            thread::Builder::new()
                .name("rion-tauri-core-events".to_owned())
                .spawn(move || {
                    while let Ok(events) = receiver.recv() {
                        let mut renderer_events = Vec::new();
                        let mut shutdown = false;
                        for event in events {
                            match event {
                                CoreEvent::CoreEffects { effects } => {
                                    for effect in effects {
                                        let action_name = core_effect_action_name(&effect.action);
                                        let persist_runtime = matches!(
                                                &effect.action,
                                            rion_core::CoreEffectAction::EmbeddedApplyRuntime { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyRole { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyTab { .. }
                                        );
                                        if let Err(error) = effect_runtime.enqueue_effect(
                                            effect,
                                            action_name,
                                            persist_runtime,
                                        ) {
                                            eprintln!(
                                                "System WebView effect executor failed: {error}"
                                            );
                                            if let Some(state) =
                                                app_handle.try_state::<CoreState>()
                                            {
                                                state.application_exit_guard.permit();
                                            }
                                            app_handle.exit(9);
                                            break;
                                        }
                                    }
                                }
                                CoreEvent::OverlayChanged { role_ids } => {
                                    effect_runtime.refresh_macro_overlays(&role_ids);
                                    renderer_events.push(CoreEvent::OverlayChanged { role_ids });
                                }
                                CoreEvent::Shutdown => {
                                    shutdown = true;
                                    renderer_events.push(CoreEvent::Shutdown);
                                }
                                event => {
                                    if matches!(
                                        &event,
                                        CoreEvent::StateChanged { changed_collections, .. }
                                            if changed_collections.iter().any(|collection| {
                                                matches!(collection, StateCollection::Roles | StateCollection::Games)
                                            })
                                    ) {
                                        let roles: Option<Vec<StateRoleRecord>> = effect_core
                                            .invoke(CoreCommand::RolesList)
                                            .ok()
                                            .and_then(|value| serde_json::from_value(value).ok());
                                        let games: Option<Vec<StateGameRecord>> = effect_core
                                            .invoke(CoreCommand::GamesList)
                                            .ok()
                                            .and_then(|value| serde_json::from_value(value).ok());
                                        if let (Some(roles), Some(games)) = (roles, games) {
                                            let _ = effect_runtime
                                                .refresh_local_storage_sync_metadata(&roles, &games);
                                        }
                                    }
                                    if matches!(&event, CoreEvent::BrowserStatuses { .. })
                                        || matches!(
                                        &event,
                                        CoreEvent::StateChanged {
                                            changed_collections,
                                            ..
                                        }
                                            if changed_collections.iter().any(|collection| {
                                                matches!(
                                                    collection,
                                                     StateCollection::Roles
                                                        | StateCollection::LaunchWorkspaces
                                                        | StateCollection::GameWindows
                                                )
                                            })
                                    )
                                    {
                                        let menu_app = app_handle.clone();
                                        let menu_core = Arc::clone(&effect_core);
                                        let menu_runtime = Arc::clone(&effect_runtime);
                                        let _ = app_handle.run_on_main_thread(move || {
                                            let language = menu_app
                                                .try_state::<CoreState>()
                                                .and_then(|state| {
                                                    state
                                                        .menu_language
                                                        .lock()
                                                        .ok()
                                                        .map(|value| value.clone())
                                                })
                                                .unwrap_or_else(|| "en".to_owned());
                                            let _ = quick_menu::refresh(
                                                &menu_app,
                                                &menu_core,
                                                &menu_runtime,
                                                &language,
                                            );
                                        });
                                    }
                                    renderer_events.push(event);
                                }
                            }
                        }
                        if !renderer_events.is_empty() {
                            let _ = app_handle.emit(CORE_EVENTS_EVENT, &renderer_events);
                        }
                        if shutdown {
                            break;
                        }
                    }
                })?;
            let recovery_core = Arc::clone(&core);
            app.manage(CoreState {
                _activation: activation,
                _quick_menu: quick_menu,
                core,
                application_exit_guard: ApplicationExitGuard::default(),
                main_window_zoom: Mutex::new(1.0),
                menu_language: Mutex::new("en".to_owned()),
                runtime,
                tab_drag: Mutex::new(None),
                tab_drag_finished: Mutex::new(VecDeque::new()),
                tab_drag_lane: tokio::sync::Mutex::new(()),
                updates,
            });
            tauri::async_runtime::spawn(async move {
                if let Err(error) = recovery_core.recover_pending_chrome_profile_imports().await {
                    eprintln!("Chrome profile import recovery failed: {error}");
                }
            });
            if let Some(state) = app.try_state::<CoreState>() {
                application_menu::install(app.handle(), &state.core, "en")?;
            }
            start_display_watcher(app.handle().clone())?;
            let ready_app = app.handle().clone();
            thread::Builder::new()
                .name("rion-tauri-renderer-ready".to_owned())
                .spawn(move || {
                    thread::sleep(RENDERER_READY_TIMEOUT);
                    if ready_app
                        .try_state::<StartupWindowState>()
                        .is_some_and(|state| !state.should_report_timeout())
                    {
                        return;
                    }
                    let dispatch_app = ready_app.clone();
                    let _ = ready_app.run_on_main_thread(move || {
                        if dispatch_app
                            .try_state::<StartupWindowState>()
                            .is_some_and(|state| !state.should_report_timeout())
                        {
                            return;
                        }
                        show_startup_failure_message(
                            &dispatch_app,
                            "The desktop renderer did not become ready within 15 seconds. Check the diagnostics log and restart Rion Studio.".to_owned(),
                        );
                    });
                })?;
                Ok(())
            })();
            match setup_result {
                Ok(()) => {
                    if let Some(startup) = app.try_state::<StartupWindowState>() {
                        startup.mark_native_startup_ready();
                    }
                }
                Err(error) => {
                    let message = startup_failure_message(error.as_ref());
                    if let Some(startup) = app.try_state::<StartupWindowState>() {
                        startup.mark_native_startup_failed(message.clone());
                    }
                    show_startup_failure_message(app.handle(), message);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rion_core_invoke,
            rion_browser_font_payload,
            rion_divider_pointer,
            rion_overlay_request,
            rion_local_storage_sync_changed,
            rion_runtime_audio_state,
            rion_runtime_tab_action,
            rion_dispatch_core_effect_results,
            rion_shared_user_data_dir,
            rion_shell_invoke
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Rion Studio")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let Some(state) = app_handle.try_state::<CoreState>() else {
                        return;
                    };
                    if state.application_exit_guard.should_prevent() {
                        api.prevent_exit();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app_handle.emit("rion://application-quit-requested", ());
                        return;
                    }
                    prune_empty_game_window_records(&state.core);
                    let _ = state.runtime.persist_all_game_window_placements();
                    if let Err(error) = state.runtime.persist_restore_session(true) {
                        let _ = app_handle.emit(
                            "rion://shell-error",
                            json!({
                                "code": "TAURI_RESTORE_PERSIST_FAILED",
                                "message": error
                            }),
                        );
                    }
                    state.runtime.close_all();
                }
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    let Some(state) = app_handle.try_state::<CoreState>() else {
                        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                            && label == "main"
                        {
                            app_handle.exit(1);
                        }
                        return;
                    };
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } if label == "main" => {
                            api.prevent_close();
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } if label != "main" => {
                            let empty_window_id = state
                                .runtime
                                .window_id_for_label(&label)
                                .filter(|window_id| {
                                    core_game_window_is_empty(&state.core, window_id)
                                });
                            if let Some(window_id) = empty_window_id {
                                api.prevent_close();
                                let app = app_handle.clone();
                                tauri::async_runtime::spawn(async move {
                                    let Some(state) = app.try_state::<CoreState>() else {
                                        return;
                                    };
                                    if let Err(error) =
                                        delete_empty_game_window(&state, &window_id).await
                                    {
                                        let _ = app.emit(
                                            "rion://shell-error",
                                            json!({
                                                "code": error.code,
                                                "message": error.message
                                            }),
                                        );
                                    }
                                });
                            } else {
                                match state.runtime.handle_window_close_requested(&label) {
                                    Ok(true) => api.prevent_close(),
                                    Ok(false) => {}
                                    Err(error) => {
                                        api.prevent_close();
                                        let _ = app_handle.emit(
                                            "rion://shell-error",
                                            json!({
                                                "code": error.code,
                                                "message": error.message,
                                                "windowLabel": label
                                            }),
                                        );
                                    }
                                }
                            }
                        }
                        tauri::WindowEvent::Resized(size) => {
                            #[cfg(target_os = "macos")]
                            if let Some(window) = app_handle.get_window(&label)
                                && let Ok(fullscreen) = window.is_fullscreen()
                            {
                                state
                                    .runtime
                                    .prepare_runtime_window_fullscreen(&label, fullscreen);
                            }
                            state.runtime.schedule_resize_window(
                                label.clone(),
                                size.width,
                                size.height,
                            );
                            if label == "main"
                                && let Some(window) = app_handle.get_webview_window("main")
                            {
                                if let Ok(displays) = display_inventory(&window) {
                                    let _ = app_handle.emit("rion://displays", displays);
                                }
                                if let Ok(fullscreen) = window.is_fullscreen() {
                                    let _ = app_handle.emit(
                                        "rion://window-state",
                                        json!({ "fullscreen": fullscreen }),
                                    );
                                }
                            }
                        }
                        tauri::WindowEvent::Moved(position) if label != "main" => {
                            state.runtime.move_window(&label, position.x, position.y);
                        }
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                            if label == "main" => {
                            if let Some(window) = app_handle.get_webview_window("main")
                                && let Ok(displays) = display_inventory(&window)
                            {
                                let _ = app_handle.emit("rion://displays", displays);
                            }
                        }
                        tauri::WindowEvent::Focused(true) if label != "main" => {
                            state.runtime.focus_window(&label);
                            let runtime = Arc::clone(&state.runtime);
                            let _ = thread::Builder::new()
                                .name("rion-runtime-focus-persist".to_owned())
                                .spawn(move || {
                                    let _ = runtime.persist_restore_session(false);
                                });
                        }
                        tauri::WindowEvent::Focused(false) if label != "main" => {
                            schedule_empty_game_window_prune(app_handle, label.clone());
                        }
                        tauri::WindowEvent::Destroyed => {
                            state.runtime.forget_popup(&label);
                        }
                        _ => {}
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    let last_focused = app_handle
                        .try_state::<CoreState>()
                        .and_then(|state| {
                            state
                                .core
                                .invoke(CoreCommand::RuntimeRestoreSessionGet)
                                .ok()
                                .and_then(|value| {
                                    value["lastFocusedWindowId"].as_str().map(str::to_owned)
                                })
                                .map(|window_id| (Arc::clone(&state.core), window_id))
                        });
                    if let Some((core, window_id)) = last_focused {
                        tauri::async_runtime::spawn(async move {
                            let _ = core
                                .invoke_async(CoreCommand::EmbeddedWindowsShow {
                                    window_id: Some(window_id),
                                })
                                .await;
                        });
                    } else if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<CoreState>() {
                        state.runtime.close_all();
                        state.core.shutdown();
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_name_matches_the_build_target() {
        #[cfg(target_os = "macos")]
        assert_eq!(platform_name().unwrap(), "darwin");
        #[cfg(target_os = "windows")]
        assert_eq!(platform_name().unwrap(), "win32");
    }

    #[test]
    fn application_exit_guard_requires_explicit_renderer_confirmation() {
        for platform in ["darwin", "win32"] {
            let guard = ApplicationExitGuard::default();
            assert!(guard.should_prevent(), "{platform}");
            guard.permit();
            assert!(!guard.should_prevent(), "{platform}");
        }
    }

    #[test]
    fn display_ids_always_round_trip_through_javascript_numbers() {
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

        for hash in [0, 1, u64::MAX / 2, u64::MAX] {
            let id = safe_display_id(hash);
            assert!((0..MAX_SAFE_INTEGER).contains(&id));
            assert_eq!(id as f64 as i64, id);
        }
    }

    #[test]
    fn physical_drag_monitor_selection_does_not_overlap_mixed_dpi_displays() {
        let physical_rects = [
            (0.0, 0.0, 1920.0, 1080.0),
            (1920.0, 0.0, 2560.0, 1440.0),
            (-1600.0, 0.0, 1600.0, 900.0),
        ];

        assert_eq!(
            nearest_drag_rect_index(&physical_rects, 2100.0, 400.0),
            Some(1)
        );
        assert_eq!(
            nearest_drag_rect_index(&physical_rects, -400.0, 300.0),
            Some(2)
        );
        assert_eq!(
            nearest_drag_rect_index(&physical_rects, 800.0, 300.0),
            Some(0)
        );
    }

    #[test]
    fn display_remap_persists_only_after_native_relocation_succeeds() {
        for platform in ["darwin", "win32"] {
            let steps = Mutex::new(Vec::new());
            relocate_before_display_remap(
                || {
                    steps.lock().unwrap().push("relocate");
                    Ok(())
                },
                || {
                    steps.lock().unwrap().push("persist");
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                *steps.lock().unwrap(),
                ["relocate", "persist"],
                "{platform}"
            );

            let persisted = AtomicBool::new(false);
            let error = relocate_before_display_remap(
                || Err(shell_error("MOVE_FAILED", "move failed")),
                || {
                    persisted.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .unwrap_err();
            assert_eq!(error.code, "MOVE_FAILED", "{platform}");
            assert!(!persisted.load(Ordering::Acquire), "{platform}");
        }
    }

    #[test]
    fn replacing_runtime_window_preferences_refreshes_open_runtime_windows() {
        assert!(core_command_refreshes_runtime_projection(
            &CoreCommand::RuntimeWindowPreferencesReplace {
                preferences: rion_core::RuntimeWindowPreferencesRecord {
                    always_hide_tab_close_button: true,
                    always_show_toolbar_in_full_screen: false,
                    restore_game_windows_on_startup: true,
                },
            }
        ));
        assert!(!core_command_refreshes_runtime_projection(
            &CoreCommand::RuntimeWindowPreferencesGet
        ));
    }

    #[test]
    fn game_window_native_compensation_restores_every_mutable_field() {
        let record = serde_json::from_value::<StateGameWindowRecord>(json!({
            "id": "window-1",
            "name": "Before",
            "targetDisplay": { "id": 7 },
            "placement": {
                "normalBounds": { "x": 20, "y": 30, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [{
                "id": "tab-1",
                "tabType": "role",
                "sourceId": "role-1",
                "name": "Role",
                "roleIds": ["role-1"],
                "hidden": false,
                "audioMuted": false,
                "roleViews": []
            }],
            "activeTabId": "tab-1",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();

        let input = game_window_update_input_from_record(&record);

        assert_eq!(input.name.as_deref(), Some("Before"));
        assert_eq!(input.target_display.unwrap().id, 7);
        assert_eq!(input.placement.unwrap().normal_bounds.x, 20);
        assert_eq!(input.tabs.unwrap()[0].id, "tab-1");
        assert_eq!(input.active_tab_id, Some(Some("tab-1".to_owned())));

        let mut remapped = record.clone();
        remapped.target_display.id = 8;
        remapped.updated_at = "2026-01-02T00:00:00Z".to_owned();
        let current_after_own_remap = remapped.clone();
        assert!(same_game_window_record(&current_after_own_remap, &remapped));
        let mut concurrent = remapped.clone();
        concurrent.name = "Concurrent edit".to_owned();
        assert!(!same_game_window_record(&concurrent, &remapped));

        let recovery_error = game_window_recovery_error(
            "SHELL_GAME_WINDOW_RECONCILE_FAILED",
            &shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", "move failed"),
            "restore failed",
        );
        assert_eq!(recovery_error.code, "SHELL_GAME_WINDOW_RECONCILE_FAILED");
        assert!(recovery_error.message.contains("move failed"));
        assert!(recovery_error.message.contains("restore failed"));
    }

    #[test]
    fn game_window_create_rollback_error_preserves_window_and_both_failures() {
        let error = game_window_create_rollback_error(
            "window-created",
            &shell_error("SHELL_WINDOW_FAILED", "native create failed"),
            "metadata cleanup failed",
        );

        assert_eq!(error.code, "SHELL_GAME_WINDOW_ROLLBACK_FAILED");
        assert!(error.message.contains("window-created"));
        assert!(error.message.contains("SHELL_WINDOW_FAILED"));
        assert!(error.message.contains("native create failed"));
        assert!(error.message.contains("metadata cleanup failed"));
    }

    #[test]
    fn tab_drag_rollback_error_preserves_primary_and_cleanup_failures() {
        let error = tab_drag_rollback_error(
            &shell_error("TAURI_TAB_DRAG_FAILED", "position failed"),
            &shell_error("TAURI_TAB_DRAG_ROLLBACK_FAILED", "reparent failed"),
        );

        assert_eq!(error.code, "TAURI_TAB_DRAG_ROLLBACK_FAILED");
        assert!(error.message.contains("TAURI_TAB_DRAG_FAILED"));
        assert!(error.message.contains("position failed"));
        assert!(error.message.contains("reparent failed"));
    }

    #[test]
    fn restore_tab_matching_is_idempotent_and_window_scoped() {
        let snapshot = serde_json::from_value::<BrowserRuntimeSnapshot>(json!({
            "roles": [],
            "tabs": [{
                "id": "runtime-tab-1",
                "sourceId": "role-1",
                "name": "Role 1",
                "windowId": "window-1",
                "tabType": "role",
                "roleIds": ["role-1"],
                "hidden": true
            }],
            "windows": [],
            "workspaces": []
        }))
        .unwrap();
        let saved = GameWindowTabRecord {
            id: "saved-tab-1".to_owned(),
            tab_type: "role".to_owned(),
            source_id: "role-1".to_owned(),
            name: "Role 1".to_owned(),
            role_ids: vec!["role-1".to_owned()],
            hidden: true,
            audio_muted: false,
            role_views: Vec::new(),
        };

        assert_eq!(
            match_runtime_restore_tab(&snapshot, "window-1", &saved),
            RuntimeRestoreTabMatch::InTarget {
                hidden: true,
                id: "runtime-tab-1".to_owned(),
            }
        );
        assert_eq!(
            match_runtime_restore_tab(&snapshot, "window-2", &saved),
            RuntimeRestoreTabMatch::Conflict {
                window_id: "window-1".to_owned(),
            }
        );

        let mut missing = saved;
        missing.source_id = "role-2".to_owned();
        assert_eq!(
            match_runtime_restore_tab(&snapshot, "window-1", &missing),
            RuntimeRestoreTabMatch::Missing
        );
    }

    #[test]
    fn only_overlay_activation_requests_focus_the_invoking_webview() {
        assert!(overlay_request_activates_webview(&json!({
            "type": "activate"
        })));
        assert!(overlay_request_activates_webview(&json!({
            "type": "activate",
            "roleId": "untrusted-role"
        })));
        for payload in [
            json!({ "type": "list" }),
            json!({ "type": "toggle", "macroId": "macro-a" }),
            json!({ "type": "press", "macroId": "macro-a", "pressId": "press-a" }),
            json!({ "type": "release", "macroId": "macro-a", "pressId": "press-a" }),
            json!({ "active": true, "type": "game-input-context" }),
        ] {
            assert!(!overlay_request_activates_webview(&payload));
        }
    }

    #[test]
    fn startup_window_reveals_only_once_across_page_reloads() {
        let state = StartupWindowState::default();

        assert!(state.reveal_once());
        assert!(!state.reveal_once());
    }

    #[test]
    fn renderer_readiness_cancels_the_startup_watchdog_and_clears_failure() {
        let state = StartupWindowState::default();
        assert!(state.should_report_timeout());

        state.set_failure("startup failed".to_owned());

        assert!(!state.should_report_timeout());
        assert_eq!(state.failure().as_deref(), Some("startup failed"));

        state.mark_renderer_ready();

        assert!(!state.should_report_timeout());
        assert_eq!(state.failure(), None);
    }

    #[tokio::test]
    async fn native_startup_readiness_releases_pending_waiters() {
        let state = Arc::new(StartupWindowState::default());
        let first_state = Arc::clone(&state);
        let second_state = Arc::clone(&state);
        let first = tokio::spawn(async move { first_state.wait_for_native_startup().await });
        let second = tokio::spawn(async move { second_state.wait_for_native_startup().await });

        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());

        state.mark_native_startup_ready();

        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn native_startup_failure_preserves_the_original_message() {
        let state = StartupWindowState::default();
        state.mark_native_startup_failed("native database failed".to_owned());

        state.mark_renderer_ready();

        let error = state.wait_for_native_startup().await.unwrap_err();
        assert_eq!(error.code, "SHELL_STARTUP_FAILED");
        assert_eq!(error.message, "native database failed");
        assert_eq!(state.failure().as_deref(), Some("native database failed"));
    }
}
