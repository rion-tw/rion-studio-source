use std::{collections::HashSet, path::PathBuf, sync::Arc, thread};

#[cfg(any(windows, target_os = "macos"))]
use std::fs;

use rion_core::{
    AppCore, AppCoreOptions, BrowserRuntimeSnapshot, CoreCommand, CoreEffectResult,
    CoreErrorPayload, CoreEvent, EmbeddedLaunchTargetRecord, StateCollection,
    StatePixelBoundsRecord, WorkspaceDisplayInfoRecord,
};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewWindow};

mod activation;
mod native_shell;
mod quick_menu;
mod system_runtime;
mod update_manager;

use activation::ActivationServer;
use system_runtime::SystemRuntimeExecutor;

const CORE_EVENTS_EVENT: &str = "rion://core-events";
const OVERLAY_REQUEST_MAX_BYTES: usize = 64 * 1024;
const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio";
const INPUT_ATTESTATION_OUTPUT_ENV: &str = "RION_STUDIO_INPUT_ATTESTATION_OUTPUT";
const FILE_OPERATIONS_ATTESTATION_OUTPUT_ENV: &str =
    "RION_STUDIO_FILE_OPERATIONS_ATTESTATION_OUTPUT";
const RESTORE_ATTESTATION_FIXTURE_URL_ENV: &str =
    "RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_FIXTURE_URL";
const RESTORE_ATTESTATION_OUTPUT_ENV: &str = "RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_OUTPUT";
const RESTORE_ATTESTATION_STAGE_ENV: &str = "RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_STAGE";

struct RuntimeRestoreAttestationRequest {
    fixture_url: String,
    output_path: PathBuf,
    stage: String,
}

struct CoreState {
    _activation: ActivationServer,
    _quick_menu: tauri::tray::TrayIcon,
    core: Arc<AppCore>,
    runtime: Arc<SystemRuntimeExecutor>,
    updates: Arc<update_manager::UpdateManager>,
}

fn platform_name() -> Result<&'static str, String> {
    if cfg!(target_os = "macos") {
        Ok("darwin")
    } else if cfg!(target_os = "windows") {
        Ok("win32")
    } else {
        Err("Rion Studio Tauri Preview supports only macOS and Windows.".to_owned())
    }
}

fn shared_user_data_dir<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("RION_STUDIO_USER_DATA_DIR") {
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

fn input_attestation_output_path() -> Result<Option<PathBuf>, String> {
    let Some(path) = std::env::var_os(INPUT_ATTESTATION_OUTPUT_ENV) else {
        return Ok(None);
    };
    validate_input_attestation_output_path(PathBuf::from(path)).map(Some)
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
    state: State<'_, CoreState>,
    command: Value,
) -> Result<Value, CoreErrorPayload> {
    let command =
        serde_json::from_value::<CoreCommand>(command).map_err(|error| CoreErrorPayload {
            code: "CORE_INPUT_INVALID".to_owned(),
            message: error.to_string(),
        })?;
    if command.requires_async_dispatch() {
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
    }
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
            window
                .show()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "appSnapshot" => app_snapshot(&state, &window),
        "currentWindowState" => Ok(json!({ "fullscreen": window.is_fullscreen()
            .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))? })),
        "refreshQuickMenu" => quick_menu::refresh(&app, &state.core)
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
            let requested_display_id = args
                .get(1)
                .and_then(|value| value.get("displayId"))
                .and_then(Value::as_i64);
            let target = match workspace_launch_target(&window, requested_display_id) {
                Ok(target) => target,
                Err(_) => {
                    return Ok(json!({
                        "kind": "display_selection_required",
                        "reason": "target_unavailable",
                        "displays": workspace_displays(&window)?
                    }));
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
        "getGraphicsDiagnostics" => graphics_diagnostics(&app, &state).await,
        "revealLogs" => reveal_logs(&state).await,
        "exportDiagnostics" => export_diagnostics(&app, &window, &state).await,
        "appVersion" => Ok(Value::String(app.package_info().version.to_string())),
        "updateStatus" => Ok(state.updates.status()),
        "checkForUpdates" => {
            let updates = Arc::clone(&state.updates);
            Ok(updates.check().await)
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
        "consumePendingWorkspaceLaunchRequest" => Ok(Value::Null),
        "consumePendingMacroPageRequest" => Ok(state
            .runtime
            .take_macro_page_request()
            .unwrap_or(Value::Null)),
        _ => Err(shell_error(
            "TAURI_SHELL_OPERATION_UNAVAILABLE",
            format!(
                "Tauri Preview shell operation {operation} is not available ({} argument(s)).",
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
            let outcome =
                tauri::async_runtime::block_on(run_runtime_restore_attestation(&app, &request));
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

pub fn run() {
    let builder = tauri::Builder::default();
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
    builder
        .setup(|app| {
            let input_attestation_output = input_attestation_output_path()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let file_operations_attestation_output = file_operations_attestation_output_path()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let restore_attestation = runtime_restore_attestation_request()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let attestation_mode_count = usize::from(input_attestation_output.is_some())
                + usize::from(file_operations_attestation_output.is_some())
                + usize::from(restore_attestation.is_some());
            if attestation_mode_count > 1 {
                return Err("Only one System WebView attestation mode can run at a time.".into());
            }
            let user_data_dir = shared_user_data_dir(app)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let app_version = app.package_info().version.to_string();
            let core = match AppCore::create_with_startup_backup(
                AppCoreOptions {
                    app_version: app_version.clone(),
                    platform: platform_name()
                        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?
                        .to_owned(),
                    user_data_dir: user_data_dir.to_string_lossy().into_owned(),
                    performance_telemetry_path: None,
                },
                "tauri-preview",
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
            let quick_menu = quick_menu::create(&app.handle().clone(), Arc::clone(&core))?;
            let updates = Arc::new(update_manager::UpdateManager::new(
                app.handle().clone(),
                app.package_info().version.to_string(),
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
                                        let persist_runtime = matches!(
                                                &effect.action,
                                            rion_core::CoreEffectAction::EmbeddedApplyRuntime { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyRole { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyTab { .. }
                                        );
                                        let _ = thread::Builder::new()
                                            .name("rion-tauri-core-effect".to_owned())
                                            .spawn(move || {
                                                let result = result_runtime.execute(effect);
                                                let succeeded = result.ok;
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
                                        let _ = app_handle.run_on_main_thread(move || {
                                            let _ = quick_menu::refresh(&menu_app, &menu_core);
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
            app.manage(CoreState {
                _activation: activation,
                _quick_menu: quick_menu,
                core,
                runtime,
                updates,
            });
            if let Some(request) = restore_attestation {
                #[cfg(any(windows, target_os = "macos"))]
                start_runtime_restore_attestation(app.handle().clone(), request)?;
                #[cfg(not(any(windows, target_os = "macos")))]
                return Err("Runtime restore attestation supports only macOS and Windows.".into());
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
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rion_core_invoke,
            rion_overlay_request,
            rion_dispatch_core_effect_results,
            rion_shared_user_data_dir,
            rion_shell_invoke
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Rion Studio Tauri Preview")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    let state = app_handle.state::<CoreState>();
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
                    let state = app_handle.state::<CoreState>();
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
                            state.runtime.resize_window(&label, size.width, size.height);
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
                            let _ = state.runtime.persist_restore_session(false);
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
                    let state = app_handle.state::<CoreState>();
                    state.runtime.close_all();
                    state.core.shutdown();
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
