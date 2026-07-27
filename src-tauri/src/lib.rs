use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

#[cfg(any(windows, target_os = "macos"))]
use std::fs;

use rion_core::{
    AppCore, AppCoreOptions, CoreCommand, CoreEffectAction, CoreEffectResult, CoreErrorPayload,
    CoreEvent, DisplayFingerprintRecord, DisplayTargetRecord, EmbeddedLaunchTargetRecord,
    GameWindowCreateInputRecord, GameWindowPlacementRecord, GameWindowUpdateInputRecord,
    PORTABLE_SCHEMA_VERSION, StateCollection, StateGameRecord, StateGameWindowRecord,
    StatePixelBoundsRecord, StateResolutionRecord, StateRoleRecord, migrate_legacy_data_root,
};
#[cfg(any(windows, target_os = "macos"))]
use rusty_leveldb::{DB, Options};
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
const INPUT_ATTESTATION_OUTPUT_ENV: &str = "RION_STUDIO_INPUT_ATTESTATION_OUTPUT";
const MACRO_GAME_ATTESTATION_FIXTURE_URL_ENV: &str =
    "RION_STUDIO_MACRO_GAME_ATTESTATION_FIXTURE_URL";
const MACRO_GAME_ATTESTATION_OUTPUT_ENV: &str = "RION_STUDIO_MACRO_GAME_ATTESTATION_OUTPUT";
const FILE_OPERATIONS_ATTESTATION_OUTPUT_ENV: &str =
    "RION_STUDIO_FILE_OPERATIONS_ATTESTATION_OUTPUT";
const RESTORE_ATTESTATION_FIXTURE_URL_ENV: &str =
    "RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_FIXTURE_URL";
const RESTORE_ATTESTATION_OUTPUT_ENV: &str = "RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_OUTPUT";
const RESTORE_ATTESTATION_STAGE_ENV: &str = "RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_STAGE";
const SESSION_IMPORT_ATTESTATION_FIXTURE_URL_ENV: &str =
    "RION_STUDIO_SESSION_IMPORT_ATTESTATION_FIXTURE_URL";
const SESSION_IMPORT_ATTESTATION_OUTPUT_ENV: &str = "RION_STUDIO_SESSION_IMPORT_ATTESTATION_OUTPUT";
const SESSION_IMPORT_ATTESTATION_SOURCE_ENV: &str = "RION_STUDIO_SESSION_IMPORT_ATTESTATION_SOURCE";
const SESSION_IMPORT_ATTESTATION_STAGE_ENV: &str = "RION_STUDIO_SESSION_IMPORT_ATTESTATION_STAGE";
const LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL_ENV: &str =
    "RION_STUDIO_LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL";
const LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT_ENV: &str =
    "RION_STUDIO_LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT";
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
        CoreEffectAction::CompatibilityCreateWindow { .. } => "compatibilityCreateWindow",
        CoreEffectAction::CompatibilityConfigureSession { .. } => "compatibilityConfigureSession",
        CoreEffectAction::CompatibilityLoadUrl { .. } => "compatibilityLoadUrl",
        CoreEffectAction::CompatibilityProbeGraphics { .. } => "compatibilityProbeGraphics",
        CoreEffectAction::CompatibilityCleanupWindow { .. } => "compatibilityCleanupWindow",
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

struct RuntimeRestoreAttestationRequest {
    fixture_url: String,
    output_path: PathBuf,
    stage: String,
}

struct SessionImportAttestationRequest {
    fixture_url: String,
    output_path: PathBuf,
    source_path: PathBuf,
    stage: String,
}

struct MacroGameAttestationRequest {
    fixture_url: String,
    output_path: PathBuf,
}

struct LocalStorageSyncAttestationRequest {
    fixture_url: String,
    output_path: PathBuf,
}

struct CoreState {
    _activation: ActivationServer,
    _quick_menu: tauri::tray::TrayIcon,
    core: Arc<AppCore>,
    main_window_zoom: Mutex<f64>,
    menu_language: Mutex<String>,
    runtime: Arc<SystemRuntimeExecutor>,
    tab_drag: Mutex<Option<GameWindowTabDragSession>>,
    updates: Arc<update_manager::UpdateManager>,
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

#[derive(Default)]
struct StartupWindowState {
    failure: Mutex<Option<String>>,
    renderer_ready: AtomicBool,
    revealed: AtomicBool,
}

impl StartupWindowState {
    fn failure(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|value| value.clone())
    }

    fn mark_renderer_ready(&self) {
        self.renderer_ready.store(true, Ordering::Release);
        if let Ok(mut failure) = self.failure.lock() {
            *failure = None;
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

fn show_startup_failure(app: &AppHandle, error: &dyn std::fmt::Display) {
    show_startup_failure_message(
        app,
        format!("Rion Studio could not finish starting.\n\n{error}"),
    );
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
        if !user_data_override_allowed() {
            return Err(
                "RION_STUDIO_USER_DATA_DIR is restricted to debug and native attestation builds."
                    .to_owned(),
            );
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

fn user_data_override_allowed() -> bool {
    cfg!(debug_assertions)
        || [
            INPUT_ATTESTATION_OUTPUT_ENV,
            MACRO_GAME_ATTESTATION_OUTPUT_ENV,
            FILE_OPERATIONS_ATTESTATION_OUTPUT_ENV,
            RESTORE_ATTESTATION_OUTPUT_ENV,
            SESSION_IMPORT_ATTESTATION_OUTPUT_ENV,
            LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT_ENV,
        ]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
}

fn input_attestation_output_path() -> Result<Option<PathBuf>, String> {
    let Some(path) = std::env::var_os(INPUT_ATTESTATION_OUTPUT_ENV) else {
        return Ok(None);
    };
    validate_input_attestation_output_path(PathBuf::from(path)).map(Some)
}

fn macro_game_attestation_request() -> Result<Option<MacroGameAttestationRequest>, String> {
    let output = std::env::var_os(MACRO_GAME_ATTESTATION_OUTPUT_ENV);
    let fixture_url = std::env::var(MACRO_GAME_ATTESTATION_FIXTURE_URL_ENV).ok();
    if output.is_none() && fixture_url.is_none() {
        return Ok(None);
    }
    let output_path = output
        .map(PathBuf::from)
        .ok_or_else(|| format!("{MACRO_GAME_ATTESTATION_OUTPUT_ENV} is required."))?;
    if !output_path.is_absolute() {
        return Err(format!(
            "{MACRO_GAME_ATTESTATION_OUTPUT_ENV} must be absolute."
        ));
    }
    let fixture_url = fixture_url
        .ok_or_else(|| format!("{MACRO_GAME_ATTESTATION_FIXTURE_URL_ENV} is required."))?;
    let parsed = tauri::Url::parse(&fixture_url)
        .map_err(|_| format!("{MACRO_GAME_ATTESTATION_FIXTURE_URL_ENV} is invalid."))?;
    if parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "::1" | "localhost"))
    {
        return Err(format!(
            "{MACRO_GAME_ATTESTATION_FIXTURE_URL_ENV} must be a loopback HTTP URL."
        ));
    }
    Ok(Some(MacroGameAttestationRequest {
        fixture_url,
        output_path,
    }))
}

fn local_storage_sync_attestation_request()
-> Result<Option<LocalStorageSyncAttestationRequest>, String> {
    let output = std::env::var_os(LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT_ENV);
    let fixture_url = std::env::var(LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL_ENV).ok();
    if output.is_none() && fixture_url.is_none() {
        return Ok(None);
    }
    let output_path = output
        .map(PathBuf::from)
        .ok_or_else(|| format!("{LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT_ENV} is required."))?;
    if !output_path.is_absolute() {
        return Err(format!(
            "{LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT_ENV} must be absolute."
        ));
    }
    let fixture_url = fixture_url
        .ok_or_else(|| format!("{LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL_ENV} is required."))?;
    let parsed = tauri::Url::parse(&fixture_url)
        .map_err(|_| format!("{LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL_ENV} is invalid."))?;
    if parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "::1" | "localhost"))
    {
        return Err(format!(
            "{LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL_ENV} must be a loopback HTTP URL."
        ));
    }
    Ok(Some(LocalStorageSyncAttestationRequest {
        fixture_url,
        output_path,
    }))
}

fn file_operations_attestation_output_path() -> Result<Option<PathBuf>, String> {
    let Some(path) = std::env::var_os(FILE_OPERATIONS_ATTESTATION_OUTPUT_ENV) else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(format!(
            "{FILE_OPERATIONS_ATTESTATION_OUTPUT_ENV} must be absolute."
        ));
    }
    Ok(Some(path))
}

fn validate_input_attestation_output_path(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "{INPUT_ATTESTATION_OUTPUT_ENV} must be an absolute path."
        ));
    }
    Ok(path)
}

fn runtime_restore_attestation_request() -> Result<Option<RuntimeRestoreAttestationRequest>, String>
{
    let stage = std::env::var(RESTORE_ATTESTATION_STAGE_ENV).ok();
    let output = std::env::var_os(RESTORE_ATTESTATION_OUTPUT_ENV);
    let fixture_url = std::env::var(RESTORE_ATTESTATION_FIXTURE_URL_ENV).ok();
    if stage.is_none() && output.is_none() && fixture_url.is_none() {
        return Ok(None);
    }
    let stage = stage.ok_or_else(|| format!("{RESTORE_ATTESTATION_STAGE_ENV} is required."))?;
    if !matches!(stage.as_str(), "seed" | "restore" | "clean-check") {
        return Err(format!(
            "{RESTORE_ATTESTATION_STAGE_ENV} must be seed, restore, or clean-check."
        ));
    }
    let output_path = output
        .map(PathBuf::from)
        .ok_or_else(|| format!("{RESTORE_ATTESTATION_OUTPUT_ENV} is required."))?;
    if !output_path.is_absolute() {
        return Err(format!(
            "{RESTORE_ATTESTATION_OUTPUT_ENV} must be absolute."
        ));
    }
    let fixture_url =
        fixture_url.ok_or_else(|| format!("{RESTORE_ATTESTATION_FIXTURE_URL_ENV} is required."))?;
    let parsed = tauri::Url::parse(&fixture_url)
        .map_err(|_| format!("{RESTORE_ATTESTATION_FIXTURE_URL_ENV} is invalid."))?;
    if parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "::1" | "localhost"))
    {
        return Err(format!(
            "{RESTORE_ATTESTATION_FIXTURE_URL_ENV} must be a loopback HTTP URL."
        ));
    }
    Ok(Some(RuntimeRestoreAttestationRequest {
        fixture_url,
        output_path,
        stage,
    }))
}

fn session_import_attestation_request() -> Result<Option<SessionImportAttestationRequest>, String> {
    let stage = std::env::var(SESSION_IMPORT_ATTESTATION_STAGE_ENV).ok();
    let output = std::env::var_os(SESSION_IMPORT_ATTESTATION_OUTPUT_ENV);
    let source = std::env::var_os(SESSION_IMPORT_ATTESTATION_SOURCE_ENV);
    let fixture_url = std::env::var(SESSION_IMPORT_ATTESTATION_FIXTURE_URL_ENV).ok();
    if stage.is_none() && output.is_none() && source.is_none() && fixture_url.is_none() {
        return Ok(None);
    }
    let stage =
        stage.ok_or_else(|| format!("{SESSION_IMPORT_ATTESTATION_STAGE_ENV} is required."))?;
    if !matches!(stage.as_str(), "import" | "readback") {
        return Err(format!(
            "{SESSION_IMPORT_ATTESTATION_STAGE_ENV} must be import or readback."
        ));
    }
    let output_path = output
        .map(PathBuf::from)
        .ok_or_else(|| format!("{SESSION_IMPORT_ATTESTATION_OUTPUT_ENV} is required."))?;
    let source_path = source
        .map(PathBuf::from)
        .ok_or_else(|| format!("{SESSION_IMPORT_ATTESTATION_SOURCE_ENV} is required."))?;
    if !output_path.is_absolute() || !source_path.is_absolute() {
        return Err("Session-import attestation paths must be absolute.".to_owned());
    }
    let fixture_url = fixture_url
        .ok_or_else(|| format!("{SESSION_IMPORT_ATTESTATION_FIXTURE_URL_ENV} is required."))?;
    let parsed = tauri::Url::parse(&fixture_url)
        .map_err(|_| format!("{SESSION_IMPORT_ATTESTATION_FIXTURE_URL_ENV} is invalid."))?;
    let loopback_host = parsed.host_str().is_some_and(|host| {
        matches!(host, "127.0.0.1" | "::1" | "localhost") || host.ends_with(".localhost")
    });
    if parsed.scheme() != "http" || !loopback_host {
        return Err(format!(
            "{SESSION_IMPORT_ATTESTATION_FIXTURE_URL_ENV} must be a loopback HTTP URL."
        ));
    }
    Ok(Some(SessionImportAttestationRequest {
        fixture_url,
        output_path,
        source_path,
        stage,
    }))
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

fn core_command_refreshes_runtime_projection(command: &CoreCommand) -> bool {
    matches!(command, CoreCommand::RuntimeWindowPreferencesReplace { .. })
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
    let runtime_window_preferences_changed = core_command_refreshes_runtime_projection(&command);
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
    if result.is_ok() && runtime_window_preferences_changed {
        state.runtime.publish_projection();
        if let Ok(language) = state.menu_language.lock().map(|value| value.clone()) {
            let _ = application_menu::install(&app, &state.core, &language);
        }
    }
    result
}

#[tauri::command]
async fn rion_overlay_request(
    webview: Webview,
    state: State<'_, CoreState>,
    payload: Value,
) -> Result<Value, CoreErrorPayload> {
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
    let role_id = state
        .runtime
        .role_id_for_webview(webview.label())
        .map_err(|message| shell_error("OVERLAY_ROLE_UNAVAILABLE", message))?;
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
    entries: Vec<(String, Option<String>)>,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .local_storage_sync_changed(webview.label(), &token, entries)
        .map_err(|message| shell_error("TAURI_LOCAL_STORAGE_SYNC_REJECTED", message))
}

#[tauri::command]
async fn rion_divider_pointer(
    webview: Webview,
    state: State<'_, CoreState>,
    payload: system_runtime::DividerPointerPayload,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .handle_divider_pointer(webview.label(), payload)
        .map_err(|message| shell_error("TAURI_DIVIDER_FAILED", message))
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
    runtime_tab_menu::handle_scoped_action(&app, &state, window_id, action)
        .await
        .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message))
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
                if let Ok(game_windows) =
                    state
                        .core
                        .invoke(CoreCommand::GameWindowsList)
                        .and_then(|value| {
                            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                                .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
                        })
                {
                    for game_window in game_windows.iter().filter(|game_window| {
                        !available_ids.contains(&game_window.target_display.id)
                    }) {
                        if let Ok(target) = launch_target_for_game_window(&app, &game_window.id) {
                            let _ = state.runtime.relocate_game_window(target);
                        }
                    }
                }
                let _ = state.runtime.persist_restore_session(false);
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
    let compatibility_statuses = state
        .core
        .invoke(CoreCommand::CompatibilityStatuses)
        .map_err(error_payload)?;
    Ok(json!({
        "embeddedRuntimeState": embedded_runtime_state(state)?,
        "games": snapshot["games"].clone(),
        "gameCompatibilityReports": snapshot["compatibilityReports"].clone(),
        "gameCompatibilityStatuses": compatibility_statuses,
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
    state: State<'_, CoreState>,
    startup: State<'_, StartupWindowState>,
    operation: String,
    args: Vec<Value>,
) -> Result<Value, CoreErrorPayload> {
    match operation.as_str() {
        "rendererReady" => {
            startup.mark_renderer_ready();
            window
                .show()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "rendererStartupFailed" => {
            let message = string_argument(&args, 0, "Renderer startup failure")?;
            show_startup_failure_message(&app, message);
            Ok(Value::Null)
        }
        "appSnapshot" => app_snapshot(&state, &window),
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
        "requestCurrentWindowClose" => {
            window
                .close()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
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
            if let Some(runtime_window) = state.runtime.window_for_id(&window_id) {
                runtime_window
                    .set_title(crate::system_runtime::native_runtime_window_title(
                        &updated.name,
                    ))
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
                if should_relocate {
                    let target = launch_target_for_game_window(&app, &window_id)?;
                    state
                        .runtime
                        .relocate_game_window(target)
                        .map_err(|error| shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", error))?;
                }
            }
            serde_json::to_value(updated)
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
            stop_runtime_display(&state, &window_id).await
        }
        "deleteGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            stop_runtime_display(&state, &window_id).await?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedWindowDelete {
                    window_id: window_id.clone(),
                })
                .await
                .map_err(error_payload)?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::GameWindowDelete { id: window_id })
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
            stop_runtime_display(&state, &window_id).await
        }
        "embeddedRuntimeState" => embedded_runtime_state(&state),
        "runGameCompatibilityCheck" => {
            let game_id = string_argument(&args, 0, "Game ID")?;
            let versions = runtime_versions(&app, &state)?;
            invoke_core_async(
                &state,
                json!({
                    "type": "compatibilityRun",
                    "gameId": game_id,
                    "versions": versions
                }),
            )
            .await
        }
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
    invoke_core_sync(
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
                "gpuFeatureStatusRawJson": "{}"
            }
        }),
    )
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

async fn stop_runtime_display(
    state: &CoreState,
    window_id: &str,
) -> Result<Value, CoreErrorPayload> {
    let snapshot = invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
    let tabs = snapshot["tabs"].as_array().cloned().unwrap_or_default();
    for tab in tabs {
        if tab["windowId"].as_str() != Some(window_id) {
            continue;
        }
        let source_id = tab["sourceId"].as_str().unwrap_or_default();
        let command = if tab["tabType"].as_str() == Some("workspace") {
            json!({ "type": "browserWorkspaceStop", "workspaceId": source_id })
        } else {
            json!({ "type": "browserRoleStop", "roleId": source_id })
        };
        invoke_core_async(state, command).await?;
    }
    Ok(Value::Null)
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
        for tab in &saved.tabs {
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
            if let Err(error) = launch_result {
                failures.push(json!({
                    "windowId": saved.id,
                    "tabId": tab.id,
                    "sourceId": tab.source_id,
                    "code": error.code,
                    "message": error.message
                }));
                window_failed = true;
            }

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
            let snapshot = invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
            let restored_tab_id = snapshot["tabs"]
                .as_array()
                .and_then(|tabs| {
                    tabs.iter()
                        .find(|candidate| candidate["sourceId"].as_str() == Some(&tab.source_id))
                })
                .and_then(|candidate| candidate["id"].as_str())
                .map(str::to_owned);
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
                && saved.active_tab_id.as_deref() != Some(tab.id.as_str())
                && let Some(tab_id) = restored_tab_id.as_deref()
                && let Err(error) =
                    invoke_core_async(state, json!({ "type": "embeddedTabHide", "tabId": tab_id }))
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
        if let Some(active_tab_id) = saved.active_tab_id.as_deref()
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
    replace_restore_progress(state, Vec::new())?;
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

fn game_window_restore_record(
    window: &StateGameWindowRecord,
) -> rion_core::RuntimeRestoreWindowRecord {
    let active_source_id = window.active_tab_id.as_ref().and_then(|active_tab_id| {
        window
            .tabs
            .iter()
            .find(|tab| &tab.id == active_tab_id)
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

#[cfg(any(windows, target_os = "macos"))]
fn start_runtime_restore_attestation(
    app: AppHandle,
    request: RuntimeRestoreAttestationRequest,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    thread::Builder::new()
        .name("rion-runtime-restore-attestation".to_owned())
        .spawn(move || {
            let stage = request.stage.clone();
            let outcome = wait_for_tauri_main_loop(&app).and_then(|()| {
                tauri::async_runtime::block_on(run_runtime_restore_attestation(&app, &request))
            });
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": true,
                        "stage": stage,
                        "report": report
                    }),
                    0,
                ),
                Err(message) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": false,
                        "stage": stage,
                        "error": {
                            "code": "SYSTEM_RUNTIME_RESTORE_ATTESTATION_FAILED",
                            "message": message
                        }
                    }),
                    7,
                ),
            };
            let write_result = write_runtime_restore_attestation(&request.output_path, &document);
            if request.stage == "seed" {
                if let Err(error) = write_result {
                    eprintln!("Runtime restore attestation output failed: {error}");
                    std::process::exit(8);
                }
                // Deliberately bypass Tauri's ExitRequested handler so the next
                // process observes a genuinely unclean persisted runtime session.
                std::process::exit(exit_code);
            }
            if let Err(error) = write_result {
                eprintln!("Runtime restore attestation output failed: {error}");
                app.exit(8);
            } else {
                app.exit(exit_code);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_tauri_main_loop(app: &AppHandle) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "The Tauri main loop did not become ready for runtime restore.".to_owned())
}

#[cfg(any(windows, target_os = "macos"))]
async fn run_runtime_restore_attestation(
    app: &AppHandle,
    request: &RuntimeRestoreAttestationRequest,
) -> Result<Value, String> {
    let state = app.state::<CoreState>();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The Tauri main window is unavailable.".to_owned())?;
    match request.stage.as_str() {
        "seed" => {
            let games = invoke_core_sync(&state, json!({ "type": "gamesList" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let game_id = games
                .as_array()
                .and_then(|games| games.first())
                .and_then(|game| game["id"].as_str())
                .ok_or_else(|| "The restore attestation found no game fixture.".to_owned())?;
            let role = invoke_core_sync(
                &state,
                json!({
                    "type": "roleCreate",
                    "input": {
                        "gameId": game_id,
                        "name": "System runtime restore attestation",
                        "launchUrl": request.fixture_url
                    }
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let role_id = role["id"]
                .as_str()
                .ok_or_else(|| "The restore attestation role has no ID.".to_owned())?
                .to_owned();
            let target = default_display_launch_target(&window, None)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let available_display_id = target.display_id;
            let synthetic_display_id = if available_display_id == -9_999 {
                -9_998
            } else {
                -9_999
            };
            let created_window = invoke_core_sync(
                &state,
                json!({
                    "type": "gameWindowCreate",
                    "input": {
                        "name": "Runtime restore attestation window",
                        "targetDisplay": { "id": synthetic_display_id },
                        "placement": {
                            "normalBounds": target.bounds,
                            "savedWorkArea": target.work_area,
                            "presentation": "normal"
                        }
                    }
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let game_window_id = created_window["id"]
                .as_str()
                .ok_or_else(|| "The restore attestation Game Window has no ID.".to_owned())?
                .to_owned();
            let synthetic_target = EmbeddedLaunchTargetRecord {
                window_id: game_window_id.clone(),
                display_id: synthetic_display_id,
                work_area: target.work_area.clone(),
                bounds: target.bounds.clone(),
                presentation: "normal".to_owned(),
            };
            invoke_core_async(
                &state,
                json!({
                    "type": "browserRoleLaunch",
                    "roleId": role_id,
                    "target": synthetic_target
                }),
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let fallback = EmbeddedLaunchTargetRecord {
                window_id: game_window_id.clone(),
                ..target.clone()
            };
            state.runtime.relocate_game_window(fallback.clone())?;
            invoke_core_sync(
                &state,
                json!({
                    "type": "gameWindowUpdate",
                    "id": game_window_id,
                    "input": {
                        "targetDisplay": { "id": available_display_id },
                        "placement": {
                            "normalBounds": fallback.bounds,
                            "savedWorkArea": fallback.work_area,
                            "presentation": "normal"
                        }
                    }
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let hotplug_projection = embedded_runtime_state(&state)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            if hotplug_projection["windows"]
                .as_array()
                .and_then(|windows| {
                    windows
                        .iter()
                        .find(|window| window["windowId"].as_str() == Some(game_window_id.as_str()))
                })
                .and_then(|window| window["displayId"].as_i64())
                != Some(available_display_id)
            {
                return Err(format!(
                    "The synthetic display removal did not move the live Game Window to the fallback display: {hotplug_projection}."
                ));
            }
            let stored = state.runtime.evaluate_role_for_attestation(
                &role_id,
                "localStorage.setItem('rion-runtime-restore-attestation', 'seeded'); JSON.stringify({ value: localStorage.getItem('rion-runtime-restore-attestation') })",
            )?;
            if stored["value"] != json!("seeded") {
                return Err(format!(
                    "The restore attestation could not seed the role store: {stored}."
                ));
            }
            state.runtime.persist_restore_session(false)?;
            // -1 is a reserved "no display" sentinel in the shared domain.
            let unavailable_display_id = if available_display_id == -2 { -3 } else { -2 };
            invoke_core_sync(
                &state,
                json!({
                    "type": "gameWindowUpdate",
                    "id": game_window_id,
                    "input": { "targetDisplay": { "id": unavailable_display_id } }
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let session = invoke_core_sync(&state, json!({ "type": "runtimeRestoreSessionGet" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let game_windows = invoke_core_sync(&state, json!({ "type": "gameWindowsList" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let runtime = state.runtime.restore_state_for_attestation()?;
            let saved_window_count = game_windows
                .as_array()
                .map(|windows| {
                    windows
                        .iter()
                        .filter(|window| {
                            window["tabs"]
                                .as_array()
                                .is_some_and(|tabs| !tabs.is_empty())
                        })
                        .count()
                })
                .unwrap_or(0);
            if session["cleanExit"].as_bool() != Some(false)
                || saved_window_count == 0
                || runtime["liveTabCount"].as_u64() != Some(1)
            {
                return Err(format!(
                    "The unclean restore seed was incomplete: session={session}, runtime={runtime}."
                ));
            }
            Ok(json!({
                "cleanExit": false,
                "availableDisplayId": available_display_id,
                "hotplugDisplayRemovalApplied": true,
                "liveTabCount": 1,
                "roleId": role_id,
                "roleStoreSeeded": true,
                "savedTargetDisplayId": unavailable_display_id,
                "savedTargetDisplayUnavailable": true,
                "savedWindowCount": saved_window_count
            }))
        }
        "restore" => {
            let session_before =
                invoke_core_sync(&state, json!({ "type": "runtimeRestoreSessionGet" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let game_windows_before =
                invoke_core_sync(&state, json!({ "type": "gameWindowsList" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let saved_window = game_windows_before
                .as_array()
                .and_then(|windows| windows.first())
                .ok_or_else(|| "The unclean restore has no persistent Game Window.".to_owned())?;
            let game_window_id = saved_window["id"]
                .as_str()
                .ok_or_else(|| "The unclean restore Game Window has no ID.".to_owned())?
                .to_owned();
            let role_id = saved_window["tabs"]
                .as_array()
                .and_then(|tabs| tabs.first())
                .and_then(|tab| tab["roleIds"].as_array())
                .and_then(|roles| roles.first())
                .and_then(Value::as_str)
                .ok_or_else(|| "The unclean restore session has no role ID.".to_owned())?
                .to_owned();
            let saved_target_display_id = saved_window["targetDisplay"]["id"]
                .as_i64()
                .ok_or_else(|| "The unclean restore session has no display ID.".to_owned())?;
            let current_display_id = default_display_launch_target(&window, None)
                .map_err(|error| format!("{}: {}", error.code, error.message))?
                .display_id;
            if saved_target_display_id == current_display_id {
                return Err(
                    "The restore attestation did not simulate a removed display target.".to_owned(),
                );
            }
            let runtime_before = state.runtime.restore_state_for_attestation()?;
            if session_before["cleanExit"].as_bool() != Some(false)
                || runtime_before["recoveryRequired"].as_bool() != Some(true)
                || runtime_before["dormantWindowCount"].as_u64() == Some(0)
            {
                return Err(format!(
                    "The second process did not classify the saved session as unclean: {runtime_before}."
                ));
            }
            let restore_result =
                restore_saved_game_windows(&state, &window, &[json!({ "scope": "all" })])
                    .await
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            if restore_result["failures"]
                .as_array()
                .is_some_and(|failures| !failures.is_empty())
            {
                return Err(format!(
                    "The restore attestation could not launch every saved tab: {restore_result}."
                ));
            }
            let stored = state.runtime.evaluate_role_for_attestation(
                &role_id,
                "JSON.stringify({ value: localStorage.getItem('rion-runtime-restore-attestation') })",
            )?;
            let session_after =
                invoke_core_sync(&state, json!({ "type": "runtimeRestoreSessionGet" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let runtime_after = state.runtime.restore_state_for_attestation()?;
            let restored_projection = embedded_runtime_state(&state)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let restored_display_id = restored_projection["windows"]
                .as_array()
                .and_then(|windows| {
                    windows
                        .iter()
                        .find(|window| window["windowId"].as_str() == Some(game_window_id.as_str()))
                })
                .and_then(|window| window["displayId"].as_i64())
                .ok_or_else(|| "The restored Game Window has no display target.".to_owned())?;
            let persisted_windows = invoke_core_sync(&state, json!({ "type": "gameWindowsList" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let persisted_window_count = persisted_windows
                .as_array()
                .map(|windows| {
                    windows
                        .iter()
                        .filter(|window| {
                            window["tabs"]
                                .as_array()
                                .is_some_and(|tabs| !tabs.is_empty())
                        })
                        .count()
                })
                .unwrap_or(0);
            if stored["value"] != json!("seeded")
                || persisted_window_count != 1
                || runtime_after["dormantWindowCount"].as_u64() != Some(0)
                || runtime_after["liveTabCount"].as_u64() != Some(1)
                || runtime_after["recoveryRequired"].as_bool() != Some(false)
                || restored_display_id != current_display_id
            {
                return Err(format!(
                    "The saved System WebView session was not restored exactly: store={stored}, session={session_after}, runtime={runtime_after}."
                ));
            }
            Ok(json!({
                "recoveryDetected": true,
                "recoveryCleared": true,
                "dormantWindowCountAfter": 0,
                "displayFallbackApplied": true,
                "persistedWindowCountAfter": persisted_window_count,
                "restoredDisplayId": restored_display_id,
                "restoredTabCount": 1,
                "roleStorePreserved": true
            }))
        }
        "clean-check" => {
            let runtime = state.runtime.restore_state_for_attestation()?;
            let auto_restore_eligible = state.runtime.begin_auto_restore();
            if runtime["recoveryRequired"].as_bool() != Some(false)
                || runtime["dormantWindowCount"].as_u64() == Some(0)
                || !auto_restore_eligible
            {
                return Err(format!(
                    "The clean session was not eligible for automatic restore: runtime={runtime}, eligible={auto_restore_eligible}."
                ));
            }
            Ok(json!({
                "autoRestoreEligible": true,
                "dormantWindowCount": runtime["dormantWindowCount"],
                "recoveryRequired": false
            }))
        }
        _ => Err("Unknown runtime restore attestation stage.".to_owned()),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn write_runtime_restore_attestation(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Runtime restore attestation output has no parent directory.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("restore-attestation.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn start_local_storage_sync_attestation(
    app: AppHandle,
    request: LocalStorageSyncAttestationRequest,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    thread::Builder::new()
        .name("rion-local-storage-sync-attestation".to_owned())
        .spawn(move || {
            let outcome =
                tauri::async_runtime::block_on(run_local_storage_sync_attestation(&app, &request));
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({ "schemaVersion": 1, "ok": true, "report": report }),
                    0,
                ),
                Err(message) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": false,
                        "error": {
                            "code": "SYSTEM_LOCAL_STORAGE_SYNC_ATTESTATION_FAILED",
                            "message": message
                        }
                    }),
                    15,
                ),
            };
            if let Err(error) = write_runtime_restore_attestation(&request.output_path, &document) {
                eprintln!("localStorage sync attestation output failed: {error}");
                app.exit(16);
            } else {
                app.exit(exit_code);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
async fn run_local_storage_sync_attestation(
    app: &AppHandle,
    request: &LocalStorageSyncAttestationRequest,
) -> Result<Value, String> {
    wait_for_tauri_main_loop(app)?;
    let state = app.state::<CoreState>();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The Tauri main window is unavailable.".to_owned())?;
    let target = default_display_launch_target(&window, None)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let game = invoke_core_sync(
        &state,
        json!({
            "type": "gameCreate",
            "input": {
                "name": "localStorage sync attestation",
                "defaultLaunchUrl": request.fixture_url,
                "localStorageSyncKeys": ["game_client_settings"]
            }
        }),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let game_id = game["id"]
        .as_str()
        .ok_or_else(|| "The localStorage sync fixture has no game ID.".to_owned())?
        .to_owned();
    let source = invoke_core_async(
        &state,
        json!({
            "type": "roleCreate",
            "input": {
                "gameId": game_id,
                "name": "localStorage source",
                "launchUrl": request.fixture_url
            }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let source_role_id = source["id"]
        .as_str()
        .ok_or_else(|| "The localStorage source role has no ID.".to_owned())?
        .to_owned();
    invoke_core_async(
        &state,
        json!({ "type": "browserRoleLaunch", "roleId": source_role_id, "target": target }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    state.runtime.evaluate_role_for_attestation(
        &source_role_id,
        "localStorage.setItem('game_client_settings', 'first-alignment'); JSON.stringify({ value: localStorage.getItem('game_client_settings') })",
    )?;

    let follower = invoke_core_async(
        &state,
        json!({
            "type": "roleCreate",
            "input": {
                "gameId": game_id,
                "name": "localStorage follower",
                "launchUrl": request.fixture_url,
                "localStorageSourceRoleId": source_role_id
            }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let follower_role_id = follower["id"]
        .as_str()
        .ok_or_else(|| "The localStorage follower role has no ID.".to_owned())?
        .to_owned();
    refresh_local_storage_sync_attestation_metadata(&state)?;
    invoke_core_async(
        &state,
        json!({ "type": "browserRoleLaunch", "roleId": follower_role_id, "target": target }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    wait_for_local_storage_sync_value(
        &state,
        &follower_role_id,
        Some("first-alignment"),
        Some("first-alignment"),
    )?;

    state.runtime.evaluate_role_for_attestation(
        &source_role_id,
        "localStorage.setItem('game_client_settings', 'live-update'); JSON.stringify({ value: localStorage.getItem('game_client_settings') })",
    )?;
    if let Err(error) =
        wait_for_local_storage_sync_value(&state, &follower_role_id, Some("live-update"), None)
    {
        let observer = state.runtime.evaluate_role_for_attestation(
            &source_role_id,
            "JSON.stringify(globalThis.__rionLocalStorageSyncObserver?.snapshot?.() ?? null)",
        )?;
        return Err(format!("{error} Source observer: {observer}."));
    }
    state.runtime.evaluate_role_for_attestation(
        &source_role_id,
        "localStorage.removeItem('game_client_settings'); JSON.stringify({ value: localStorage.getItem('game_client_settings') })",
    )?;
    if let Err(error) = wait_for_local_storage_sync_value(&state, &follower_role_id, None, None) {
        let observer = state.runtime.evaluate_role_for_attestation(
            &source_role_id,
            "JSON.stringify({ observer: globalThis.__rionLocalStorageSyncObserver?.snapshot?.() ?? null, value: localStorage.getItem('game_client_settings') })",
        )?;
        return Err(format!("{error} Source state: {observer}."));
    }

    state.runtime.evaluate_role_for_attestation(
        &source_role_id,
        "localStorage.setItem('game_client_settings', 'stopped-source'); JSON.stringify({ value: localStorage.getItem('game_client_settings') })",
    )?;
    wait_for_local_storage_sync_value(&state, &follower_role_id, Some("stopped-source"), None)?;
    for role_id in [&follower_role_id, &source_role_id] {
        invoke_core_async(
            &state,
            json!({ "type": "browserRoleStop", "roleId": role_id }),
        )
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    }
    invoke_core_async(
        &state,
        json!({ "type": "browserRoleLaunch", "roleId": follower_role_id, "target": target }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    wait_for_local_storage_sync_value(
        &state,
        &follower_role_id,
        Some("stopped-source"),
        Some("stopped-source"),
    )?;

    let mut isolated_url = tauri::Url::parse(&request.fixture_url)
        .map_err(|error| format!("The fixture URL is invalid: {error}."))?;
    let isolated_host = if isolated_url.host_str() == Some("localhost") {
        "127.0.0.1"
    } else {
        "localhost"
    };
    isolated_url
        .set_host(Some(isolated_host))
        .map_err(|_| "The isolated fixture origin could not be built.".to_owned())?;
    let isolated = invoke_core_async(
        &state,
        json!({
            "type": "roleCreate",
            "input": {
                "gameId": game_id,
                "name": "localStorage isolated role",
                "launchUrl": isolated_url.as_str()
            }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let isolated_role_id = isolated["id"]
        .as_str()
        .ok_or_else(|| "The isolated role has no ID.".to_owned())?
        .to_owned();
    let isolated_target = default_display_launch_target(&window, None)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    invoke_core_async(
        &state,
        json!({
            "type": "browserRoleLaunch",
            "roleId": isolated_role_id,
            "target": isolated_target
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    state.runtime.evaluate_role_for_attestation(
        &isolated_role_id,
        "localStorage.setItem('game_client_settings', 'isolated'); JSON.stringify({ value: localStorage.getItem('game_client_settings') })",
    )?;
    let rejected = invoke_core_async(
        &state,
        json!({
            "type": "roleUpdate",
            "id": isolated_role_id,
            "input": {
                "setLocalStorageSourceRoleId": true,
                "localStorageSourceRoleId": source_role_id
            }
        }),
    )
    .await
    .is_err();
    let isolated_value = state.runtime.evaluate_role_for_attestation(
        &isolated_role_id,
        "JSON.stringify({ value: localStorage.getItem('game_client_settings') })",
    )?;
    if !rejected || isolated_value["value"] != json!("isolated") {
        return Err(format!(
            "Cross-origin binding was not rejected without mutating the isolated store: rejected={rejected}, value={isolated_value}."
        ));
    }

    Ok(json!({
        "crossOriginRejected": true,
        "deletionMirrored": true,
        "documentStartAligned": true,
        "isolatedStorePreserved": true,
        "liveUpdateMirrored": true,
        "stoppedSourceBootstrap": true
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn refresh_local_storage_sync_attestation_metadata(state: &CoreState) -> Result<(), String> {
    let roles = invoke_core_sync(state, json!({ "type": "rolesList" }))
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let roles: Vec<StateRoleRecord> =
        serde_json::from_value(roles).map_err(|error| error.to_string())?;
    let games = invoke_core_sync(state, json!({ "type": "gamesList" }))
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let games: Vec<StateGameRecord> =
        serde_json::from_value(games).map_err(|error| error.to_string())?;
    state
        .runtime
        .refresh_local_storage_sync_metadata(&roles, &games)
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_local_storage_sync_value(
    state: &CoreState,
    role_id: &str,
    expected: Option<&str>,
    expected_initial: Option<&str>,
) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let value = state.runtime.evaluate_role_for_attestation(
            role_id,
            "JSON.stringify({ initial: globalThis.__rionLocalStorageInitial ?? null, value: localStorage.getItem('game_client_settings') })",
        )?;
        let current_matches =
            value["value"].as_str() == expected || (expected.is_none() && value["value"].is_null());
        let initial_matches =
            expected_initial.is_none_or(|expected| value["initial"].as_str() == Some(expected));
        if current_matches && initial_matches {
            return Ok(value);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "Timed out waiting for localStorage synchronization: role={role_id}, expected={expected:?}, expectedInitial={expected_initial:?}, actual={value}."
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn start_macro_game_attestation(
    app: AppHandle,
    request: MacroGameAttestationRequest,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    thread::Builder::new()
        .name("rion-macro-game-attestation".to_owned())
        .spawn(move || {
            let outcome =
                tauri::async_runtime::block_on(run_macro_game_attestation(&app, &request));
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({ "schemaVersion": 1, "ok": true, "report": report }),
                    0,
                ),
                Err(message) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": false,
                        "error": {
                            "code": "SYSTEM_MACRO_GAME_ATTESTATION_FAILED",
                            "message": message
                        }
                    }),
                    13,
                ),
            };
            if let Err(error) = write_runtime_restore_attestation(&request.output_path, &document) {
                eprintln!("Macro-game attestation output failed: {error}");
                app.exit(14);
            } else {
                app.exit(exit_code);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
async fn run_macro_game_attestation(
    app: &AppHandle,
    request: &MacroGameAttestationRequest,
) -> Result<Value, String> {
    wait_for_tauri_main_loop(app)?;
    let state = app.state::<CoreState>();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The Tauri main window is unavailable.".to_owned())?;
    let target = default_display_launch_target(&window, None)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let game = invoke_core_sync(
        &state,
        json!({
            "type": "gameCreate",
            "input": {
                "name": "Macro game attestation",
                "defaultLaunchUrl": request.fixture_url
            }
        }),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let game_id = game["id"]
        .as_str()
        .ok_or_else(|| "The macro-game fixture has no game ID.".to_owned())?;
    let mut role_ids = Vec::new();
    for name in ["Macro game role A", "Macro game role B"] {
        let role = invoke_core_sync(
            &state,
            json!({
                "type": "roleCreate",
                "input": {
                    "gameId": game_id,
                    "name": name,
                    "launchUrl": request.fixture_url
                }
            }),
        )
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let role_id = role["id"]
            .as_str()
            .ok_or_else(|| "The macro-game role has no ID.".to_owned())?
            .to_owned();
        invoke_core_async(
            &state,
            json!({ "type": "browserRoleLaunch", "roleId": role_id, "target": target }),
        )
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
        role_ids.push(role_id);
    }
    for role_id in &role_ids {
        let ready = state.runtime.evaluate_role_for_attestation(
            role_id,
            "JSON.stringify(globalThis.__rionMacroGame?.snapshot?.() ?? null)",
        )?;
        if ready["ready"] != json!(true) {
            return Err(format!(
                "The macro-game fixture did not initialize for {role_id}."
            ));
        }
    }

    let once = invoke_core_async(
        &state,
        json!({
            "type": "macroCreate",
            "input": {
                "enabled": true,
                "activationMode": "toggle",
                "name": "[測試] native ordered multi-role",
                "roleIds": role_ids,
                "repeat": { "type": "once" },
                "steps": [
                    { "type": "key", "code": "ArrowLeft", "modifiers": [], "action": "tap" },
                    { "type": "delay", "ms": 40 },
                    { "type": "key", "code": "ArrowRight", "modifiers": [], "action": "tap" },
                    { "type": "click", "unit": "percent", "xPercent": 50, "yPercent": 50 }
                ]
            }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let once_id = once["id"]
        .as_str()
        .ok_or_else(|| "The once macro has no ID.".to_owned())?;
    invoke_core_async(
        &state,
        json!({
            "type": "macroStart",
            "request": { "macroId": once_id, "sourceRoleId": null }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let ordered = wait_for_macro_game_snapshots(&state, &role_ids, |snapshots| {
        snapshots.iter().all(|snapshot| {
            snapshot["events"]
                .as_array()
                .is_some_and(|events| events.len() >= 4)
                && snapshot["clicks"].as_u64().unwrap_or(0) >= 1
        })
    })?;
    let expected = json!([
        "down:ArrowLeft",
        "up:ArrowLeft",
        "down:ArrowRight",
        "up:ArrowRight"
    ]);
    for snapshot in &ordered {
        if snapshot["events"] != expected
            || snapshot["heldCount"] != json!(0)
            || snapshot["untrusted"] != json!(0)
        {
            return Err(format!("Ordered multi-role macro diverged: {snapshot}."));
        }
    }

    let loop_macro = invoke_core_async(
        &state,
        json!({
            "type": "macroCreate",
            "input": {
                "enabled": true,
                "activationMode": "toggle",
                "name": "[測試] native loop cancel",
                "roleIds": role_ids,
                "repeat": { "type": "loop", "intervalMs": 50 },
                "steps": [
                    { "type": "key", "code": "KeyH", "modifiers": [], "action": "tap" },
                    { "type": "delay", "ms": 40 }
                ]
            }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let loop_id = loop_macro["id"]
        .as_str()
        .ok_or_else(|| "The loop macro has no ID.".to_owned())?;
    invoke_core_async(
        &state,
        json!({
            "type": "macroStart",
            "request": { "macroId": loop_id, "sourceRoleId": null }
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    wait_for_macro_game_snapshots(&state, &role_ids, |snapshots| {
        snapshots
            .iter()
            .all(|snapshot| snapshot["keyHDown"].as_u64().unwrap_or(0) >= 2)
    })?;
    invoke_core_async(&state, json!({ "type": "macroStop", "macroId": loop_id }))
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    thread::sleep(Duration::from_millis(100));
    let stopped = macro_game_snapshots(&state, &role_ids)?;
    thread::sleep(Duration::from_millis(300));
    let after_cancel = macro_game_snapshots(&state, &role_ids)?;
    for (stopped, after) in stopped.iter().zip(&after_cancel) {
        if stopped["keyHDown"] != after["keyHDown"] || after["heldCount"] != json!(0) {
            return Err(format!(
                "Loop cancellation left activity or a held key: {after}."
            ));
        }
    }
    let statuses = invoke_core_sync(&state, json!({ "type": "macroStatuses" }))
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    if statuses
        .as_array()
        .is_some_and(|statuses| !statuses.is_empty())
    {
        return Err(format!(
            "Macro statuses remained active after cancellation: {statuses}."
        ));
    }
    for role_id in &role_ids {
        let _ = invoke_core_async(
            &state,
            json!({ "type": "macroReleaseRole", "roleId": role_id }),
        )
        .await;
        invoke_core_async(
            &state,
            json!({ "type": "browserRoleStop", "roleId": role_id }),
        )
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    }
    Ok(json!({
        "cancelStoppedDispatch": true,
        "clickDelivered": true,
        "heldKeysReleased": true,
        "multiRoleSequenceMatched": true,
        "productionMacroStart": true,
        "roleCount": 2,
        "trustedEventsOnly": true
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn macro_game_snapshots(state: &CoreState, role_ids: &[String]) -> Result<Vec<Value>, String> {
    role_ids
        .iter()
        .map(|role_id| {
            state.runtime.evaluate_role_for_attestation(
                role_id,
                "JSON.stringify(globalThis.__rionMacroGame?.snapshot?.() ?? null)",
            )
        })
        .collect()
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_macro_game_snapshots(
    state: &CoreState,
    role_ids: &[String],
    complete: impl Fn(&[Value]) -> bool,
) -> Result<Vec<Value>, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let snapshots = macro_game_snapshots(state, role_ids)?;
        if complete(&snapshots) {
            return Ok(snapshots);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "The production macro chain timed out: {snapshots:?}."
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn start_session_import_attestation(
    app: AppHandle,
    request: SessionImportAttestationRequest,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    thread::Builder::new()
        .name("rion-session-import-attestation".to_owned())
        .spawn(move || {
            let outcome =
                tauri::async_runtime::block_on(run_session_import_attestation(&app, &request));
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": true,
                        "stage": request.stage,
                        "report": report
                    }),
                    0,
                ),
                Err(message) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": false,
                        "stage": request.stage,
                        "error": {
                            "code": "SYSTEM_SESSION_IMPORT_ATTESTATION_FAILED",
                            "message": message
                        }
                    }),
                    11,
                ),
            };
            if let Err(error) = write_runtime_restore_attestation(&request.output_path, &document) {
                eprintln!("Session-import attestation output failed: {error}");
                app.exit(12);
            } else {
                app.exit(exit_code);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
async fn run_session_import_attestation(
    app: &AppHandle,
    request: &SessionImportAttestationRequest,
) -> Result<Value, String> {
    wait_for_tauri_main_loop(app)?;
    let state = app.state::<CoreState>();
    match request.stage.as_str() {
        "import" => {
            create_session_import_chrome_fixture(&request.source_path, &request.fixture_url)?;
            let source_fingerprint =
                rion_platform::chrome_profile_source_fingerprint(&request.source_path, "Default")
                    .map_err(|error| error.to_string())?;
            let game = invoke_core_sync(
                &state,
                json!({
                    "type": "gameCreate",
                    "input": {
                        "name": "Session import attestation game",
                        "defaultLaunchUrl": request.fixture_url
                    }
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let game_id = game["id"]
                .as_str()
                .ok_or_else(|| "The session-import game has no ID.".to_owned())?;
            let preview = invoke_core_sync(
                &state,
                json!({
                    "type": "chromeProfilePreview",
                    "sourceUserDataDir": request.source_path
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let import_id = preview["importId"]
                .as_str()
                .ok_or_else(|| "The Chrome preview has no import ID.".to_owned())?;
            let profile_id = preview["profiles"]
                .as_array()
                .filter(|profiles| profiles.len() == 1)
                .and_then(|profiles| profiles.first())
                .and_then(|profile| profile["id"].as_str())
                .ok_or_else(|| {
                    "The Chrome preview did not resolve exactly one profile.".to_owned()
                })?;
            let result = invoke_core_async(
                &state,
                json!({
                    "type": "chromeProfileApply",
                    "importId": import_id,
                    "gameId": game_id,
                    "consentAccepted": true,
                    "resolutions": [{ "action": "create", "profileId": profile_id }]
                }),
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let item = result["items"]
                .as_array()
                .and_then(|items| items.first())
                .ok_or_else(|| "The Chrome import returned no item.".to_owned())?;
            if item["status"] != json!("imported")
                || item["cookieCount"] != json!(1)
                || item["localStorageCount"] != json!(1)
            {
                return Err(format!("The Chrome import result is incomplete: {item}."));
            }
            let role_id = item["roleId"]
                .as_str()
                .ok_or_else(|| "The imported item has no role ID.".to_owned())?;
            let transfer_root = state.core.user_data_dir().join(".session-transfers");
            let raw_staging_absent = !state
                .core
                .user_data_dir()
                .join(".chrome-profile-import-work")
                .exists();
            let encrypted_staging_cleaned = !transfer_root.exists()
                || fs::read_dir(&transfer_root)
                    .map_err(|error| error.to_string())?
                    .next()
                    .is_none();
            if !raw_staging_absent || !encrypted_staging_cleaned {
                return Err("Session-import staging was not cleaned after commit.".to_owned());
            }
            Ok(json!({
                "cookieCount": 1,
                "createdRole": true,
                "encryptedStagingCleaned": true,
                "localStorageCount": 1,
                "publicCommandApplied": true,
                "rawStagingAbsent": true,
                "roleIdPresent": !role_id.is_empty(),
                "sourceFingerprintStable": rion_platform::chrome_profile_source_fingerprint(
                    &request.source_path,
                    "Default"
                ).map_err(|error| error.to_string())? == source_fingerprint
            }))
        }
        "readback" => {
            let games = invoke_core_sync(&state, json!({ "type": "gamesList" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let game_id = unique_named_id(&games, "Session import attestation game")?;
            let roles = invoke_core_sync(&state, json!({ "type": "rolesList" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let role_id = unique_named_id(&roles, "Session import attestation profile")?;
            let preview = invoke_core_sync(
                &state,
                json!({
                    "type": "chromeProfilePreview",
                    "sourceUserDataDir": request.source_path
                }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let import_id = preview["importId"]
                .as_str()
                .ok_or_else(|| "The restart Chrome preview has no import ID.".to_owned())?;
            let profile_id = preview["profiles"][0]["id"]
                .as_str()
                .ok_or_else(|| "The restart Chrome preview has no profile ID.".to_owned())?;
            let replace = invoke_core_async(
                &state,
                json!({
                    "type": "chromeProfileApply",
                    "importId": import_id,
                    "gameId": game_id,
                    "consentAccepted": true,
                    "resolutions": [{
                        "action": "replace",
                        "profileId": profile_id,
                        "targetRoleId": role_id
                    }]
                }),
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            if replace["items"][0]["status"] != json!("imported") {
                return Err(format!("The replacement import failed: {replace}."));
            }
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "The Tauri main window is unavailable.".to_owned())?;
            let target = default_display_launch_target(&window, None)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            invoke_core_async(
                &state,
                json!({ "type": "browserRoleLaunch", "roleId": role_id, "target": target }),
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let readback = state.runtime.evaluate_role_for_attestation(
                &role_id,
                "JSON.stringify({ cookie: document.cookie.includes('rion_session='), cookieNames: document.cookie.split(';').map((item) => item.split('=')[0].trim()).filter(Boolean), localStorage: localStorage.getItem('rion-session-import') === 'present' })",
            )?;
            let native_cookie = state.runtime.role_cookie_for_attestation(
                &role_id,
                &request.fixture_url,
                "rion_session",
            )?;
            invoke_core_async(
                &state,
                json!({ "type": "browserRoleStop", "roleId": role_id }),
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            if native_cookie.is_null()
                || readback["cookie"] != json!(true)
                || readback["localStorage"] != json!(true)
            {
                return Err(format!(
                    "The imported session did not survive process restart: page={readback}, nativeCookie={native_cookie}."
                ));
            }
            Ok(json!({
                "cookieReadback": true,
                "localStorageReadback": true,
                "replacementApplied": true,
                "roleResolvedExactlyOnce": true,
                "systemWebViewReadback": true
            }))
        }
        _ => Err("Unknown session-import attestation stage.".to_owned()),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn unique_named_id(records: &Value, name: &str) -> Result<String, String> {
    let matches = records
        .as_array()
        .into_iter()
        .flatten()
        .filter(|record| record["name"].as_str() == Some(name))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(format!("Expected exactly one record named {name}."));
    }
    matches[0]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Record {name} has no ID."))
}

#[cfg(any(windows, target_os = "macos"))]
fn create_session_import_chrome_fixture(
    source: &std::path::Path,
    fixture_url: &str,
) -> Result<(), String> {
    let parsed = url::Url::parse(fixture_url).map_err(|error| error.to_string())?;
    let origin = parsed.origin().ascii_serialization();
    let host = parsed
        .host_str()
        .ok_or_else(|| "The session-import fixture has no host.".to_owned())?;
    let profile = source.join("Default");
    let cookie_path = profile.join("Network/Cookies");
    let leveldb_path = profile.join("Local Storage/leveldb");
    fs::create_dir_all(cookie_path.parent().expect("cookie parent"))
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(leveldb_path.parent().expect("LevelDB parent"))
        .map_err(|error| error.to_string())?;
    fs::write(
        source.join("Local State"),
        br#"{"profile":{"info_cache":{"Default":{"name":"Session import attestation profile"}}}}"#,
    )
    .map_err(|error| error.to_string())?;
    let connection = rusqlite::Connection::open(&cookie_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);\
             INSERT INTO meta(key, value) VALUES ('version', '23');\
             CREATE TABLE cookies(\
               host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER,\
               is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,\
               encrypted_value BLOB, top_frame_site_key TEXT\
             );",
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO cookies VALUES (?1,'rion_session','present','/',?2,0,0,1,X'','')",
            rusqlite::params![
                host,
                (chrono::Utc::now().timestamp() + 86_400 + 11_644_473_600) * 1_000_000
            ],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    let options = Options {
        create_if_missing: true,
        ..Options::default()
    };
    let mut database = DB::open(&leveldb_path, options).map_err(|error| error.to_string())?;
    let key = [
        b"_".as_slice(),
        origin.as_bytes(),
        &[0, 1],
        b"rion-session-import".as_slice(),
    ]
    .concat();
    database
        .put(&key, b"\x01present")
        .map_err(|error| error.to_string())?;
    database.flush().map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn start_file_operations_attestation(app: AppHandle, output_path: PathBuf) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    thread::Builder::new()
        .name("rion-file-operations-attestation".to_owned())
        .spawn(move || {
            let outcome =
                tauri::async_runtime::block_on(run_file_operations_attestation(&app, &output_path));
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({ "schemaVersion": 1, "ok": true, "report": report }),
                    0,
                ),
                Err(message) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": false,
                        "error": {
                            "code": "SYSTEM_FILE_OPERATIONS_ATTESTATION_FAILED",
                            "message": message
                        }
                    }),
                    7,
                ),
            };
            let write_result = write_file_operations_attestation(&output_path, &document);
            if let Err(error) = write_result {
                eprintln!("File-operations attestation output failed: {error}");
                app.exit(8);
            } else {
                app.exit(exit_code);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
async fn run_file_operations_attestation(
    app: &AppHandle,
    output_path: &std::path::Path,
) -> Result<Value, String> {
    let state = app.state::<CoreState>();
    let directory = output_path
        .parent()
        .ok_or_else(|| "The file-operations output has no parent directory.".to_owned())?
        .join("file-operations");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let before = invoke_core_sync(&state, json!({ "type": "stateSnapshot" }))
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let before_collections = json!({
        "games": before["games"].clone(),
        "roles": before["roles"].clone(),
        "launchWorkspaces": before["launchWorkspaces"].clone(),
        "macros": before["macros"].clone()
    });
    let selection = json!({
        "games": true,
        "roles": true,
        "launchWorkspaces": true,
        "macros": true,
        "preferences": true
    });

    let portable_path = directory.join("rion-portable-attestation.json");
    let portable = invoke_core_sync(
        &state,
        json!({
            "type": "portableExportTo",
            "path": portable_path.to_string_lossy(),
            "selection": selection
        }),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let portable_document = serde_json::from_slice::<Value>(
        &fs::read(&portable_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if !portable_attestation_export_is_valid(&portable, &portable_document, &portable_path) {
        return Err(format!(
            "The packaged portable export was invalid: result={portable}, document={portable_document}."
        ));
    }
    let preview = invoke_core_sync(
        &state,
        json!({
            "type": "portablePreviewFile",
            "path": portable_path.to_string_lossy()
        }),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let import_id = preview["importId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The packaged portable preview returned no import ID.".to_owned())?;
    invoke_core_sync(
        &state,
        json!({ "type": "portableDiscard", "importId": import_id }),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;

    let invalid_import_path = directory.join("invalid-portable.json");
    fs::write(&invalid_import_path, b"{not-json").map_err(|error| error.to_string())?;
    if invoke_core_sync(
        &state,
        json!({
            "type": "portablePreviewFile",
            "path": invalid_import_path.to_string_lossy()
        }),
    )
    .is_ok()
    {
        return Err("The packaged portable preview accepted corrupt JSON.".to_owned());
    }

    let portable_failure_path = directory.join("portable-failure.json");
    fs::create_dir(&portable_failure_path).map_err(|error| error.to_string())?;
    if invoke_core_sync(
        &state,
        json!({
            "type": "portableExportTo",
            "path": portable_failure_path.to_string_lossy(),
            "selection": selection
        }),
    )
    .is_ok()
    {
        return Err("The packaged portable export replaced a directory.".to_owned());
    }

    let versions = runtime_versions(app, &state)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let diagnostics_snapshot = json!({
        "applicationName": app.package_info().name,
        "applicationVersion": app.package_info().version.to_string(),
        "packaged": !cfg!(debug_assertions),
        "engine": versions["engine"].clone(),
        "engineVersion": versions["engineVersion"].clone(),
        "shell": versions["shell"].clone(),
        "shellVersion": versions["shellVersion"].clone(),
        "locale": "system",
        "systemVersion": std::env::consts::OS,
        "displays": [],
        "gpuFeatureStatusRawJson": "{}"
    });
    let diagnostics_path = directory.join("rion-diagnostics-attestation.zip");
    let diagnostics = invoke_core_async(
        &state,
        json!({
            "type": "diagnosticsExport",
            "path": diagnostics_path.to_string_lossy(),
            "snapshot": diagnostics_snapshot
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let diagnostics_bytes = fs::read(&diagnostics_path).map_err(|error| error.to_string())?;
    if !diagnostics_bytes.starts_with(b"PK\x03\x04")
        || !diagnostics_bytes
            .windows(b"diagnostics.json".len())
            .any(|window| window == b"diagnostics.json")
        || diagnostics["logFileCount"].as_u64() != Some(1)
    {
        return Err(format!(
            "The packaged diagnostics export was invalid: {diagnostics}."
        ));
    }

    let diagnostics_failure_path = directory.join("diagnostics-failure.zip");
    fs::create_dir(&diagnostics_failure_path).map_err(|error| error.to_string())?;
    if invoke_core_async(
        &state,
        json!({
            "type": "diagnosticsExport",
            "path": diagnostics_failure_path.to_string_lossy(),
            "snapshot": diagnostics_snapshot
        }),
    )
    .await
    .is_ok()
    {
        return Err("The packaged diagnostics export replaced a directory.".to_owned());
    }

    let temporary_files = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp") || name.contains(".rion-diagnostics-"))
        .collect::<Vec<_>>();
    if !temporary_files.is_empty() {
        return Err(format!(
            "Failed packaged file operations left temporary files: {temporary_files:?}."
        ));
    }
    let after = invoke_core_sync(&state, json!({ "type": "stateSnapshot" }))
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let after_collections = json!({
        "games": after["games"].clone(),
        "roles": after["roles"].clone(),
        "launchWorkspaces": after["launchWorkspaces"].clone(),
        "macros": after["macros"].clone()
    });
    if before_collections != after_collections {
        return Err("File-operation failures mutated persisted domain state.".to_owned());
    }
    Ok(json!({
        "corruptImportRejected": true,
        "diagnosticsAtomicFailurePreserved": diagnostics_failure_path.is_dir(),
        "diagnosticsExportVerified": true,
        "domainStatePreserved": true,
        "portableAtomicFailurePreserved": portable_failure_path.is_dir(),
        "portableExportVerified": true,
        "portablePreviewVerified": true,
        "temporaryFilesReleased": true
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn portable_attestation_export_is_valid(
    result: &Value,
    document: &Value,
    path: &std::path::Path,
) -> bool {
    document["schemaVersion"].as_u64() == Some(PORTABLE_SCHEMA_VERSION)
        && result["filePath"].as_str() == Some(path.to_string_lossy().as_ref())
}

#[cfg(any(windows, target_os = "macos"))]
fn write_file_operations_attestation(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "File-operations attestation output has no parent directory.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("file-operations-attestation.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
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
    let record = state
        .core
        .invoke(CoreCommand::GameWindowGet {
            id: window_id.to_owned(),
        })
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<StateGameWindowRecord>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
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
    target.window_id = window_id.to_owned();
    target.presentation = record.placement.presentation.clone();
    if remapped {
        target.bounds = remap_window_bounds(
            &record.placement.normal_bounds,
            &record.placement.saved_work_area,
            &target.work_area,
        );
        state
            .core
            .invoke(CoreCommand::GameWindowUpdate {
                id: window_id.to_owned(),
                input: rion_core::GameWindowUpdateInputRecord {
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
                    ..rion_core::GameWindowUpdateInputRecord::default()
                },
            })
            .map_err(error_payload)?;
        let _ = app.emit(
            "rion://game-window-display-remapped",
            json!({ "windowId": window_id, "displayId": target.display_id }),
        );
    } else {
        target.bounds = clamp_window_bounds(&record.placement.normal_bounds, &target.work_area);
    }
    Ok(target)
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
            let tab_id = action["tabId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error("TAURI_TAB_DRAG_INVALID", "Runtime tab ID is required.")
                })?;
            let (screen_x, screen_y) = drag_screen_point(action)?;
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
                let _ = take_tab_drag_session(state, session_id);
                state
                    .runtime
                    .discard_provisional_game_window(&initial_target.window_id);
                return Err(shell_error("TAURI_TAB_DRAG_FAILED", message));
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
            state
                .runtime
                .position_provisional_game_window(&prepared.target)
                .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
            if prepared.detach_requested && !prepared.detached {
                state
                    .runtime
                    .provisionally_move_tab(&prepared.tab_id, &prepared.provisional_window_id)
                    .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
                if let Ok(mut current) = state.tab_drag.lock()
                    && let Some(session) =
                        current.as_mut().filter(|session| session.id == session_id)
                {
                    session.detached = true;
                }
            }
        }
        "tabDragMove" => {
            let (screen_x, screen_y) = drag_screen_point(action)?;
            let session = state
                .tab_drag
                .lock()
                .map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?
                .clone()
                .filter(|session| session.id == session_id)
                .ok_or_else(|| {
                    shell_error("TAURI_TAB_DRAG_STALE", "Runtime tab drag session is stale.")
                })?;
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
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            if target_window_id == session.provisional_window_id {
                if let Err(error) = commit_tab_drag_to_new_window(state, &session).await {
                    cancel_tab_drag_session(state, &session)?;
                    return Err(error);
                }
            } else if target_window_id == session.source_window_id {
                cancel_tab_drag_session(state, &session)?;
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
                let target = launch_target_for_game_window(app, target_window_id)?;
                let result = Arc::clone(&state.core)
                    .invoke_async(CoreCommand::EmbeddedTabMoveOrdered {
                        tab_id: session.tab_id.clone(),
                        target,
                        before_tab_id: action["beforeTabId"].as_str().map(str::to_owned),
                    })
                    .await;
                if let Err(error) = result {
                    cancel_tab_drag_session(state, &session)?;
                    return Err(error_payload(error));
                }
                state
                    .runtime
                    .discard_provisional_game_window(&session.provisional_window_id);
            }
        }
        "tabDragEnd" => {
            let cancelled = action["cancelled"].as_bool().unwrap_or(false);
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            if cancelled || !session.detached {
                cancel_tab_drag_session(state, &session)?;
            } else if let Err(error) = commit_tab_drag_to_new_window(state, &session).await {
                cancel_tab_drag_session(state, &session)?;
                return Err(error);
            }
        }
        "tabDragCancel" => {
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            cancel_tab_drag_session(state, &session)?;
        }
        _ => unreachable!(),
    }
    Ok(true)
}

fn drag_screen_point(action: &Value) -> Result<(f64, f64), CoreErrorPayload> {
    let screen_x = action["screenX"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen X is invalid."))?;
    let screen_y = action["screenY"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen Y is invalid."))?;
    Ok((screen_x, screen_y))
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
    let mut bounds = source.placement.normal_bounds.clone();
    bounds.x = (screen_x - f64::from(bounds.width) / 2.0).round() as i32;
    bounds.y = (screen_y - 28.0).round() as i32;
    bounds = clamp_window_bounds(&bounds, &work_area);
    Ok((
        EmbeddedLaunchTargetRecord {
            window_id: provisional_window_id.to_owned(),
            display_id: monitor_id(&monitor),
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
    let logical_rect = |monitor: &tauri::Monitor| {
        let scale = monitor.scale_factor();
        let position = monitor.position();
        let size = monitor.size();
        (
            position.x as f64 / scale,
            position.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        )
    };
    monitors
        .iter()
        .find(|monitor| {
            let (left, top, width, height) = logical_rect(monitor);
            x >= left && x < left + width && y >= top && y < top + height
        })
        .cloned()
        .or_else(|| {
            monitors
                .iter()
                .min_by(|left, right| {
                    let distance = |monitor: &tauri::Monitor| {
                        let (left, top, width, height) = logical_rect(monitor);
                        (x - (left + width / 2.0)).powi(2) + (y - (top + height / 2.0)).powi(2)
                    };
                    distance(left).total_cmp(&distance(right))
                })
                .cloned()
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
        if std::env::var_os(INPUT_ATTESTATION_OUTPUT_ENV).is_some() {
            eprintln!(
                "System WebView parity: observed Web Content process termination for {}.",
                webview.label()
            );
        }
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
            let input_attestation_output = input_attestation_output_path()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let macro_game_attestation = macro_game_attestation_request()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let file_operations_attestation_output = file_operations_attestation_output_path()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let restore_attestation = runtime_restore_attestation_request()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let session_import_attestation = session_import_attestation_request()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let local_storage_sync_attestation = local_storage_sync_attestation_request()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let attestation_mode_count = usize::from(input_attestation_output.is_some())
                + usize::from(macro_game_attestation.is_some())
                + usize::from(file_operations_attestation_output.is_some())
                + usize::from(restore_attestation.is_some())
                + usize::from(session_import_attestation.is_some())
                + usize::from(local_storage_sync_attestation.is_some());
            if attestation_mode_count > 1 {
                return Err("Only one System WebView attestation mode can run at a time.".into());
            }
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
            let attestation_runtime = Arc::clone(&runtime);
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
                                        let result_core = Arc::clone(&effect_core);
                                        let result_runtime = Arc::clone(&effect_runtime);
                                        let restore_attestation =
                                            std::env::var_os(RESTORE_ATTESTATION_OUTPUT_ENV)
                                                .is_some();
                                        let action_name = core_effect_action_name(&effect.action);
                                        let persist_runtime = matches!(
                                                &effect.action,
                                            rion_core::CoreEffectAction::EmbeddedApplyRuntime { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyRole { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyTab { .. }
                                        );
                                        let _ = thread::Builder::new()
                                            .name("rion-tauri-core-effect".to_owned())
                                            .spawn(move || {
                                                if restore_attestation {
                                                    eprintln!(
                                                        "Runtime restore attestation: executing {action_name}."
                                                    );
                                                }
                                                let result = result_runtime.execute(effect);
                                                let succeeded = result.ok;
                                                if restore_attestation {
                                                    eprintln!(
                                                        "Runtime restore attestation: {action_name} completed (ok={succeeded})."
                                                    );
                                                }
                                                if result_core
                                                    .dispatch_core_effect_results(vec![result])
                                                    .is_ok()
                                                    && succeeded
                                                    && persist_runtime
                                                {
                                                    let _ = result_runtime
                                                        .persist_restore_session(false);
                                                    result_runtime.publish_projection();
                                                }
                                            });
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
                main_window_zoom: Mutex::new(1.0),
                menu_language: Mutex::new("en".to_owned()),
                runtime,
                tab_drag: Mutex::new(None),
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
            if let Some(request) = restore_attestation {
                #[cfg(any(windows, target_os = "macos"))]
                start_runtime_restore_attestation(app.handle().clone(), request)?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err("Runtime restore attestation supports only macOS and Windows.".into());
            } else if let Some(request) = macro_game_attestation {
                #[cfg(any(windows, target_os = "macos"))]
                start_macro_game_attestation(app.handle().clone(), request)?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err("Macro-game attestation supports only macOS and Windows.".into());
            } else if let Some(request) = session_import_attestation {
                #[cfg(any(windows, target_os = "macos"))]
                start_session_import_attestation(app.handle().clone(), request)?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err("Session-import attestation supports only macOS and Windows.".into());
            } else if let Some(request) = local_storage_sync_attestation {
                #[cfg(any(windows, target_os = "macos"))]
                start_local_storage_sync_attestation(app.handle().clone(), request)?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err(
                    "localStorage sync attestation supports only macOS and Windows.".into(),
                );
            } else if let Some(output_path) = file_operations_attestation_output {
                #[cfg(any(windows, target_os = "macos"))]
                start_file_operations_attestation(app.handle().clone(), output_path)?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err(
                    "File-operations attestation supports only macOS and Windows.".into(),
                );
            } else if let Some(output_path) = input_attestation_output {
                #[cfg(any(windows, target_os = "macos"))]
                eprintln!(
                    "System WebView parity: starting trusted-input attestation at {}.",
                    output_path.display()
                );
                #[cfg(any(windows, target_os = "macos"))]
                system_runtime::start_trusted_input_attestation(
                    app.handle().clone(),
                    output_path,
                    attestation_runtime,
                )?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err("System input attestation supports only macOS and Windows.".into());
            } else {
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
            }
                Ok(())
            })();
            if let Err(error) = setup_result {
                show_startup_failure(app.handle(), error.as_ref());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rion_core_invoke,
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
                tauri::RunEvent::ExitRequested { .. } => {
                    let Some(state) = app_handle.try_state::<CoreState>() else {
                        return;
                    };
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
                            } else if state.runtime.handle_window_close_requested(&label) {
                                api.prevent_close();
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
    fn display_ids_always_round_trip_through_javascript_numbers() {
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

        for hash in [0, 1, u64::MAX / 2, u64::MAX] {
            let id = safe_display_id(hash);
            assert!((0..MAX_SAFE_INTEGER).contains(&id));
            assert_eq!(id as f64 as i64, id);
        }
    }

    #[test]
    fn input_attestation_output_requires_an_absolute_path() {
        assert!(
            validate_input_attestation_output_path(PathBuf::from("relative/result.json")).is_err()
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn portable_attestation_requires_the_current_schema_and_export_path() {
        let path = std::env::temp_dir().join("rion-portable-attestation.json");
        let result = json!({ "filePath": path });
        let current = json!({ "schemaVersion": PORTABLE_SCHEMA_VERSION });

        assert!(portable_attestation_export_is_valid(
            &result, &current, &path
        ));
        assert!(!portable_attestation_export_is_valid(
            &result,
            &json!({ "schemaVersion": PORTABLE_SCHEMA_VERSION - 1 }),
            &path
        ));
        assert!(!portable_attestation_export_is_valid(
            &json!({ "filePath": path.with_file_name("other.json") }),
            &current,
            &path
        ));
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
}
