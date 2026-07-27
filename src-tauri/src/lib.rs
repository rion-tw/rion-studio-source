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
    AppCore, AppCoreOptions, BrowserRuntimeSnapshot, CoreCommand, CoreEffectAction,
    CoreEffectResult, CoreErrorPayload, CoreEvent, EmbeddedLaunchTargetRecord, StateCollection,
    StatePixelBoundsRecord, WorkspaceDisplayInfoRecord, migrate_legacy_data_root,
};
#[cfg(any(windows, target_os = "macos"))]
use rusty_leveldb::{DB, Options};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewWindow};

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
const RENDERER_READY_TIMEOUT: Duration = Duration::from_secs(15);

fn core_effect_action_name(action: &CoreEffectAction) -> &'static str {
    match action {
        CoreEffectAction::RoleBrowserDataClearSession { .. } => "roleBrowserDataClearSession",
        CoreEffectAction::LegacySessionRestore { .. } => "legacySessionRestore",
        CoreEffectAction::ChromeProfileImportSnapshot { .. } => "chromeProfileImportSnapshot",
        CoreEffectAction::ChromeProfileImportApply { .. } => "chromeProfileImportApply",
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

struct CoreState {
    _activation: ActivationServer,
    _quick_menu: tauri::tray::TrayIcon,
    core: Arc<AppCore>,
    main_window_zoom: Mutex<f64>,
    menu_language: Mutex<String>,
    pending_workspace_launch_request: Mutex<Option<Value>>,
    renderer_ready: Arc<AtomicBool>,
    runtime: Arc<SystemRuntimeExecutor>,
    updates: Arc<update_manager::UpdateManager>,
}

#[derive(Default)]
struct StartupFailureState(Mutex<Option<String>>);

fn show_startup_failure(app: &tauri::App, error: &dyn std::fmt::Display) {
    let message = format!("Rion Studio could not finish starting.\n\n{error}");
    if let Some(state) = app.try_state::<StartupFailureState>()
        && let Ok(mut current) = state.0.lock()
    {
        *current = Some(message.clone());
    }
    if let Some(window) = app.get_webview_window("main") {
        let encoded = serde_json::to_string(&message)
            .unwrap_or_else(|_| "\"Rion Studio could not finish starting.\"".to_owned());
        let _ = window.eval(format!("window.__rionShowStartupFailure?.({encoded});"));
        let _ = window.show();
        let _ = window.set_focus();
    }
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
    let display_id = state
        .runtime
        .tab_strip_display_for_webview(webview.label())
        .ok_or_else(|| {
            shell_error(
                "TAURI_RUNTIME_CHROME_UNAUTHORIZED",
                "Runtime tab actions are restricted to the local tab-strip WebView.",
            )
        })?;
    runtime_tab_menu::handle_scoped_action(&app, &state, display_id, action)
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

fn workspace_displays(window: &WebviewWindow) -> Result<Value, CoreErrorPayload> {
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

fn removed_display_ids(runtime_ids: &[i64], available_ids: &HashSet<i64>) -> Vec<i64> {
    let mut removed = runtime_ids
        .iter()
        .copied()
        .filter(|id| !available_ids.contains(id))
        .collect::<Vec<_>>();
    removed.sort_unstable();
    removed.dedup();
    removed
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
                let Ok(displays) = workspace_displays(&window) else {
                    continue;
                };
                if previous.as_ref() == Some(&displays) {
                    continue;
                }
                let Some(state) = app.try_state::<CoreState>() else {
                    break;
                };
                let records = match serde_json::from_value::<Vec<WorkspaceDisplayInfoRecord>>(
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
                let snapshot = state
                    .core
                    .invoke(CoreCommand::BrowserRuntimeSnapshot)
                    .ok()
                    .and_then(|value| serde_json::from_value::<BrowserRuntimeSnapshot>(value).ok());
                if let (Some(snapshot), Ok(fallback)) =
                    (snapshot, workspace_launch_target(&window, None))
                {
                    let runtime_ids = snapshot
                        .displays
                        .iter()
                        .map(|display| display.display_id)
                        .collect::<Vec<_>>();
                    for display_id in removed_display_ids(&runtime_ids, &available_ids) {
                        if display_id == fallback.display_id {
                            continue;
                        }
                        if let Err(error) = state.core.invoke(CoreCommand::EmbeddedDisplayRemove {
                            display_id,
                            fallback: fallback.clone(),
                        }) {
                            let _ = app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code(),
                                    "message": error.to_string(),
                                    "displayId": display_id
                                }),
                            );
                        }
                    }
                }
                if let Err(error) = state
                    .core
                    .invoke(CoreCommand::WorkspaceReconcileDisplays { displays: records })
                {
                    let _ = app.emit(
                        "rion://shell-error",
                        json!({ "code": error.code(), "message": error.to_string() }),
                    );
                }
                let _ = state.runtime.persist_restore_session(false);
                state.runtime.publish_projection();
                let _ = app.emit("rion://workspace-displays", &displays);
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
        "roles": snapshot["roles"].clone(),
        "roleStatuses": role_statuses,
        "launchWorkspaces": snapshot["launchWorkspaces"].clone(),
        "workspaceDisplays": workspace_displays(window)?,
        "macros": snapshot["macros"].clone(),
        "macroStatuses": macro_statuses
    }))
}

#[tauri::command]
async fn rion_shell_invoke(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, CoreState>,
    operation: String,
    args: Vec<Value>,
) -> Result<Value, CoreErrorPayload> {
    match operation.as_str() {
        "rendererReady" => {
            state.renderer_ready.store(true, Ordering::Release);
            window
                .show()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
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
        "restartApplication" => {
            if state
                .core
                .invoke(CoreCommand::BrowserStatuses)
                .map_err(error_payload)?
                .as_array()
                .is_some_and(|statuses| !statuses.is_empty())
            {
                return Err(shell_error(
                    "SHELL_RESTART_BLOCKED",
                    "Stop all running roles before restarting Rion Studio.",
                ));
            }
            app.restart();
        }
        "workspaceDisplays" => workspace_displays(&window),
        "launchRole" => {
            let role_id = string_argument(&args, 0, "Role ID")?;
            let target = workspace_launch_target(&window, None)?;
            let statuses = Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserRoleLaunch {
                    role_id,
                    target,
                    zoom_factor: None,
                })
                .await
                .map_err(error_payload)?;
            Ok(statuses
                .as_array()
                .and_then(|statuses| statuses.first())
                .cloned()
                .unwrap_or(Value::Null))
        }
        "launchWorkspace" => {
            let workspace_id = string_argument(&args, 0, "Workspace ID")?;
            let workspace_name = state
                .core
                .invoke(CoreCommand::WorkspacesList)
                .ok()
                .and_then(|value| value.as_array().cloned())
                .and_then(|workspaces| {
                    workspaces.into_iter().find_map(|workspace| {
                        (workspace["id"].as_str() == Some(workspace_id.as_str()))
                            .then(|| workspace["name"].as_str().map(str::to_owned))
                            .flatten()
                    })
                })
                .unwrap_or_else(|| workspace_id.clone());
            let requested_display_id = args
                .get(1)
                .and_then(|value| value.get("displayId"))
                .and_then(Value::as_i64);
            let target = match workspace_launch_target(&window, requested_display_id) {
                Ok(target) => target,
                Err(_) => {
                    let result = json!({
                        "kind": "display_selection_required",
                        "reason": "target_unavailable",
                        "displays": workspace_displays(&window)?
                    });
                    if let Ok(mut pending) = state.pending_workspace_launch_request.lock() {
                        *pending = Some(json!({
                            "workspaceId": workspace_id,
                            "workspaceName": workspace_name,
                            "result": result
                        }));
                    }
                    return Ok(result);
                }
            };
            let display_id = target.display_id;
            let statuses = Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWorkspaceLaunch {
                    workspace_id,
                    target,
                })
                .await
                .map_err(error_payload)?;
            Ok(json!({
                "kind": "launched",
                "displayId": display_id,
                "statuses": statuses
            }))
        }
        "showEmbeddedRuntimeWindows" => {
            let display_id = args.first().and_then(Value::as_i64);
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedWindowsShow { display_id })
                .await
                .map_err(error_payload)
        }
        "showEmbeddedRuntimeTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabActivate { tab_id })
                .await
                .map_err(error_payload)
        }
        "moveEmbeddedRuntimeTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let display_id = args.get(1).and_then(Value::as_i64).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Display ID is required.")
            })?;
            let target = workspace_launch_target(&window, Some(display_id))?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabMove { tab_id, target })
                .await
                .map_err(error_payload)
        }
        "restoreSavedGameWindows" => restore_saved_game_windows(&state, &window, &args).await,
        "autoRestoreSavedGameWindows" => {
            if !state.runtime.begin_auto_restore() {
                return Ok(Value::Null);
            }
            restore_saved_game_windows(&state, &window, &[json!({ "scope": "last-visible" })]).await
        }
        "discardSavedGameWindows" => discard_saved_game_windows(&state, &args),
        "stopEmbeddedRuntimeWindow" => {
            let display_id = args.first().and_then(Value::as_i64).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Display ID is required.")
            })?;
            stop_runtime_display(&state, display_id).await
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
        "previewChromeProfileImport" => preview_chrome_profile_import(&state).await,
        "getGraphicsDiagnostics" => graphics_diagnostics(&app, &state).await,
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
        "consumePendingWorkspaceLaunchRequest" => Ok(state
            .pending_workspace_launch_request
            .lock()
            .ok()
            .and_then(|mut pending| pending.take())
            .unwrap_or(Value::Null)),
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

async fn graphics_diagnostics(
    app: &tauri::AppHandle,
    state: &CoreState,
) -> Result<Value, CoreErrorPayload> {
    let settings = invoke_core_sync(state, json!({ "type": "gameBrowserSettingsGet" }))?;
    let versions = runtime_versions(app, state)?;
    invoke_core_async(
        state,
        json!({
            "type": "graphicsDiagnosticsAssemble",
            "appliedSettings": settings["graphics"].clone(),
            "embeddedRawJson": "null",
            "embeddedError": "Tauri does not expose a synchronous GPU probe for the launcher WebView.",
            "featureStatusRawJson": "{}",
            "gpuInfoReady": false,
            "hardwareAccelerationEnabled": null,
            "platform": platform_name()
                .map_err(|error| shell_error("SHELL_PLATFORM_UNSUPPORTED", error))?,
            "versions": versions
        }),
    )
    .await
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
    let displays = workspace_displays(window)?
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
    display_id: i64,
) -> Result<Value, CoreErrorPayload> {
    let snapshot = invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
    let tabs = snapshot["tabs"].as_array().cloned().unwrap_or_default();
    for tab in tabs {
        if tab["displayId"].as_i64() != Some(display_id) {
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
    let mut session = invoke_core_sync(state, json!({ "type": "runtimeRestoreSessionGet" }))?;
    let windows = session["windows"].as_array().cloned().unwrap_or_default();
    let selected = windows
        .iter()
        .filter(|saved| match scope {
            "window" => saved["id"].as_str() == input["windowId"].as_str(),
            "last-visible" => saved["wasVisible"].as_bool() == Some(true),
            _ => true,
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut restored_ids = Vec::new();
    for saved in selected {
        let requested_display = saved["targetDisplay"]["id"].as_i64();
        let target = workspace_launch_target(window, requested_display)
            .or_else(|_| workspace_launch_target(window, None))?;
        let window_was_visible = saved["wasVisible"].as_bool() == Some(true);
        for tab in saved["tabs"].as_array().cloned().unwrap_or_default() {
            let source_id = tab["sourceId"].as_str().ok_or_else(|| {
                shell_error(
                    "TAURI_RESTORE_INVALID",
                    "A saved Game Window tab is invalid.",
                )
            })?;
            if tab["tabType"].as_str() == Some("workspace") {
                invoke_core_async(
                    state,
                    json!({
                        "type": "browserWorkspaceLaunch",
                        "workspaceId": source_id,
                        "target": target
                    }),
                )
                .await?;
            } else {
                invoke_core_async(
                    state,
                    json!({
                        "type": "browserRoleLaunch",
                        "roleId": source_id,
                        "target": target
                    }),
                )
                .await?;
            }
            let snapshot = invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
            let restored_tab_id = snapshot["tabs"]
                .as_array()
                .and_then(|tabs| {
                    tabs.iter()
                        .find(|candidate| candidate["sourceId"].as_str() == Some(source_id))
                })
                .and_then(|candidate| candidate["id"].as_str())
                .map(str::to_owned);
            if tab["audioMuted"].as_bool() == Some(true) {
                state
                    .runtime
                    .restore_tab_audio_muted(source_id, true)
                    .map_err(|error| shell_error("TAURI_RESTORE_AUDIO_FAILED", error))?;
            }
            if (tab["hidden"].as_bool() == Some(true) || !window_was_visible)
                && let Some(tab_id) = restored_tab_id.as_deref()
            {
                invoke_core_async(state, json!({ "type": "embeddedTabHide", "tabId": tab_id }))
                    .await?;
            }
        }
        if window_was_visible && let Some(active_source_id) = saved["activeSourceId"].as_str() {
            let snapshot = invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
            if let Some(tab_id) = snapshot["tabs"]
                .as_array()
                .and_then(|tabs| {
                    tabs.iter()
                        .find(|candidate| candidate["sourceId"].as_str() == Some(active_source_id))
                })
                .and_then(|candidate| candidate["id"].as_str())
            {
                invoke_core_async(
                    state,
                    json!({ "type": "embeddedTabActivate", "tabId": tab_id }),
                )
                .await?;
            }
        }
        if let Some(id) = saved["id"].as_str() {
            restored_ids.push(id.to_owned());
        }
    }
    if let Some(stored_windows) = session["windows"].as_array_mut() {
        stored_windows.retain(|saved| {
            saved["id"]
                .as_str()
                .is_none_or(|id| !restored_ids.iter().any(|restored| restored == id))
        });
    }
    session["updatedAt"] = Value::String(chrono::Utc::now().to_rfc3339());
    session["cleanExit"] = Value::Bool(false);
    let dormant_windows = serde_json::from_value::<Vec<rion_core::RuntimeRestoreWindowRecord>>(
        session["windows"].clone(),
    )
    .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))?;
    invoke_core_sync(
        state,
        json!({ "type": "runtimeRestoreSessionReplace", "session": session }),
    )?;
    state
        .runtime
        .replace_dormant_windows(dormant_windows, false);
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    Ok(Value::Null)
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
    let mut session = invoke_core_sync(state, json!({ "type": "runtimeRestoreSessionGet" }))?;
    if scope == "all" {
        session["windows"] = Value::Array(Vec::new());
    } else {
        let window_id = input["windowId"].as_str().ok_or_else(|| {
            shell_error(
                "TAURI_SHELL_INPUT_INVALID",
                "Saved Game Window ID is required.",
            )
        })?;
        if let Some(windows) = session["windows"].as_array_mut() {
            windows.retain(|saved| saved["id"].as_str() != Some(window_id));
        }
    }
    session["updatedAt"] = Value::String(chrono::Utc::now().to_rfc3339());
    session["cleanExit"] = Value::Bool(false);
    let dormant_windows = serde_json::from_value::<Vec<rion_core::RuntimeRestoreWindowRecord>>(
        session["windows"].clone(),
    )
    .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))?;
    invoke_core_sync(
        state,
        json!({ "type": "runtimeRestoreSessionReplace", "session": session }),
    )?;
    state
        .runtime
        .replace_dormant_windows(dormant_windows, false);
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    Ok(Value::Null)
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
    if matches!(request.stage.as_str(), "seed" | "restore") {
        let displays = workspace_displays(&window)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let records = serde_json::from_value::<Vec<WorkspaceDisplayInfoRecord>>(displays)
            .map_err(|error| error.to_string())?;
        state
            .core
            .invoke(CoreCommand::WorkspaceReconcileDisplays { displays: records })
            .map_err(|error| format!("{}: {}", error.code(), error))?;
    }
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
            let target = workspace_launch_target(&window, None)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let available_display_id = target.display_id;
            let synthetic_display_id = if available_display_id == -9_999 {
                -9_998
            } else {
                -9_999
            };
            let synthetic_target = EmbeddedLaunchTargetRecord {
                display_id: synthetic_display_id,
                work_area: target.work_area.clone(),
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
            invoke_core_async(
                &state,
                json!({
                    "type": "embeddedDisplayRemove",
                    "displayId": synthetic_display_id,
                    "fallback": target
                }),
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let hotplug_snapshot =
                invoke_core_sync(&state, json!({ "type": "browserRuntimeSnapshot" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            if hotplug_snapshot["tabs"]
                .as_array()
                .and_then(|tabs| tabs.first())
                .and_then(|tab| tab["displayId"].as_i64())
                != Some(available_display_id)
            {
                return Err(format!(
                    "The synthetic display removal did not move the live System WebView to the fallback display: {hotplug_snapshot}."
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
            let mut session =
                invoke_core_sync(&state, json!({ "type": "runtimeRestoreSessionGet" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            // -1 is a reserved "no display" sentinel in the shared domain.
            let unavailable_display_id = if available_display_id == -2 { -3 } else { -2 };
            let saved_target = session["windows"]
                .as_array_mut()
                .and_then(|windows| windows.first_mut())
                .and_then(|window| window["targetDisplay"].as_object_mut())
                .ok_or_else(|| {
                    "The restore attestation could not locate its saved display target.".to_owned()
                })?;
            saved_target.insert("id".to_owned(), json!(unavailable_display_id));
            invoke_core_sync(
                &state,
                json!({ "type": "runtimeRestoreSessionReplace", "session": session }),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let session = invoke_core_sync(&state, json!({ "type": "runtimeRestoreSessionGet" }))
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let runtime = state.runtime.restore_state_for_attestation()?;
            let saved_window_count = session["windows"].as_array().map(Vec::len).unwrap_or(0);
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
            let role_id = session_before["windows"]
                .as_array()
                .and_then(|windows| windows.first())
                .and_then(|window| window["tabs"].as_array())
                .and_then(|tabs| tabs.first())
                .and_then(|tab| tab["roleIds"].as_array())
                .and_then(|roles| roles.first())
                .and_then(Value::as_str)
                .ok_or_else(|| "The unclean restore session has no role ID.".to_owned())?
                .to_owned();
            let saved_target_display_id = session_before["windows"]
                .as_array()
                .and_then(|windows| windows.first())
                .and_then(|window| window["targetDisplay"]["id"].as_i64())
                .ok_or_else(|| "The unclean restore session has no display ID.".to_owned())?;
            let current_display_id = workspace_launch_target(&window, None)
                .map_err(|error| format!("{}: {}", error.code, error.message))?
                .display_id;
            if saved_target_display_id == current_display_id {
                return Err(
                    "The restore attestation did not simulate a removed display target.".to_owned(),
                );
            }
            let runtime_before = state.runtime.restore_state_for_attestation()?;
            if runtime_before["recoveryRequired"].as_bool() != Some(true)
                || runtime_before["dormantWindowCount"].as_u64() == Some(0)
            {
                return Err(format!(
                    "The second process did not classify the saved session as unclean: {runtime_before}."
                ));
            }
            restore_saved_game_windows(&state, &window, &[json!({ "scope": "all" })])
                .await
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let stored = state.runtime.evaluate_role_for_attestation(
                &role_id,
                "JSON.stringify({ value: localStorage.getItem('rion-runtime-restore-attestation') })",
            )?;
            let session_after =
                invoke_core_sync(&state, json!({ "type": "runtimeRestoreSessionGet" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?;
            let runtime_after = state.runtime.restore_state_for_attestation()?;
            let restored_display_id =
                invoke_core_sync(&state, json!({ "type": "browserRuntimeSnapshot" }))
                    .map_err(|error| format!("{}: {}", error.code, error.message))?["tabs"]
                    .as_array()
                    .and_then(|tabs| tabs.first())
                    .and_then(|tab| tab["displayId"].as_i64())
                    .ok_or_else(|| "The restored runtime has no display target.".to_owned())?;
            let persisted_window_count = session_after["windows"]
                .as_array()
                .map(Vec::len)
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
    let target = workspace_launch_target(&window, None)
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
            let target = workspace_launch_target(&window, None)
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
    if portable_document["schemaVersion"].as_u64() != Some(7)
        || portable["filePath"].as_str() != Some(portable_path.to_string_lossy().as_ref())
    {
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

fn workspace_launch_target(
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
        display_id: monitor_id(&monitor),
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
    })
}

pub(crate) fn launch_target_for_app_display(
    app: &AppHandle,
    display_id: i64,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let monitor = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?
        .into_iter()
        .find(|monitor| monitor_id(monitor) == display_id)
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    Ok(EmbeddedLaunchTargetRecord {
        display_id: monitor_id(&monitor),
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
    })
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(StartupFailureState::default())
        .on_page_load(|webview, _| {
            if webview.label() != "main" {
                return;
            }
            let app = webview.app_handle();
            let message = app
                .try_state::<StartupFailureState>()
                .and_then(|state| state.0.lock().ok().and_then(|value| value.clone()));
            if let Some(message) = message {
                let encoded = serde_json::to_string(&message)
                    .unwrap_or_else(|_| "\"Rion Studio could not finish starting.\"".to_owned());
                let _ = webview.eval(format!("window.__rionShowStartupFailure?.({encoded});"));
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
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
            let attestation_mode_count = usize::from(input_attestation_output.is_some())
                + usize::from(macro_game_attestation.is_some())
                + usize::from(file_operations_attestation_output.is_some())
                + usize::from(restore_attestation.is_some())
                + usize::from(session_import_attestation.is_some());
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
            let renderer_ready = Arc::new(AtomicBool::new(false));
            let recovery_core = Arc::clone(&core);
            app.manage(CoreState {
                _activation: activation,
                _quick_menu: quick_menu,
                core,
                main_window_zoom: Mutex::new(1.0),
                menu_language: Mutex::new("en".to_owned()),
                pending_workspace_launch_request: Mutex::new(None),
                renderer_ready: Arc::clone(&renderer_ready),
                runtime,
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
                        if renderer_ready.load(Ordering::Acquire) {
                            return;
                        }
                        let dispatch_app = ready_app.clone();
                        let _ = ready_app.run_on_main_thread(move || {
                            if let Some(window) = dispatch_app.get_webview_window("main") {
                                let message = serde_json::to_string(
                                    "The desktop renderer did not become ready within 15 seconds. Check the diagnostics log and restart Rion Studio.",
                                )
                                .unwrap_or_else(|_| "\"Renderer startup timed out.\"".to_owned());
                                let _ = window.eval(format!(
                                    "window.__rionShowStartupFailure?.({message});"
                                ));
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        });
                    })?;
            }
                Ok(())
            })();
            if let Err(error) = setup_result {
                show_startup_failure(app, error.as_ref());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rion_core_invoke,
            rion_divider_pointer,
            rion_overlay_request,
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
                        tauri::WindowEvent::CloseRequested { api, .. }
                            if state.runtime.handle_window_close_requested(&label) =>
                        {
                            api.prevent_close();
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
                                if let Ok(displays) = workspace_displays(&window) {
                                    let _ = app_handle.emit("rion://workspace-displays", displays);
                                }
                                if let Ok(fullscreen) = window.is_fullscreen() {
                                    let _ = app_handle.emit(
                                        "rion://window-state",
                                        json!({ "fullscreen": fullscreen }),
                                    );
                                }
                            }
                        }
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                            if label == "main" =>
                        {
                            if let Some(window) = app_handle.get_webview_window("main")
                                && let Ok(displays) = workspace_displays(&window)
                            {
                                let _ = app_handle.emit("rion://workspace-displays", displays);
                            }
                        }
                        tauri::WindowEvent::Focused(true) if label != "main" => {
                            let runtime = Arc::clone(&state.runtime);
                            let _ = thread::Builder::new()
                                .name("rion-runtime-focus-persist".to_owned())
                                .spawn(move || {
                                    let _ = runtime.persist_restore_session(false);
                                });
                        }
                        tauri::WindowEvent::Destroyed => {
                            state.runtime.forget_popup(&label);
                        }
                        _ => {}
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
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
    fn display_reconciliation_reports_each_missing_runtime_display_once() {
        let available = HashSet::from([2_i64, 3_i64]);
        assert_eq!(removed_display_ids(&[4, 1, 4, 2], &available), vec![1, 4]);
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
}
