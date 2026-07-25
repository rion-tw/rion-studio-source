use std::{path::PathBuf, sync::Arc, thread};

use rion_core::{
    AppCore, AppCoreOptions, CoreCommand, CoreEffectResult, CoreErrorPayload, CoreEvent,
    EmbeddedLaunchTargetRecord, StateCollection, StatePixelBoundsRecord,
};
use serde_json::{Value, json};
use tauri::{Emitter, Manager, State, WebviewWindow};

mod activation;
mod electron_helper;
mod native_shell;
mod quick_menu;
mod system_runtime;
mod update_manager;

use activation::ActivationServer;
use electron_helper::ElectronHelperClient;
use system_runtime::SystemRuntimeExecutor;

const CORE_EVENTS_EVENT: &str = "rion://core-events";
const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio";

struct CoreState {
    _activation: ActivationServer,
    _quick_menu: tauri::tray::TrayIcon,
    core: Arc<AppCore>,
    helper: Option<Arc<ElectronHelperClient>>,
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
    (hasher.finish() & i64::MAX as u64) as i64
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

fn embedded_runtime_state(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    if let Some(runtime_state) = state.helper.as_ref().and_then(|helper| helper.runtime_state()) {
        return Ok(runtime_state);
    }
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
            let versions = state.helper.as_ref().map(|helper| helper.versions());
            invoke_core_async(
                &state,
                json!({
                    "type": "compatibilityRun",
                    "gameId": game_id,
                    "versions": {
                        "chrome": versions.as_ref().map(|value| value.chromium.as_str())
                            .unwrap_or("system-webview"),
                        "electron": versions.as_ref().map(|value| value.electron.as_str())
                            .unwrap_or("unavailable")
                    }
                }),
            )
            .await
        }
        "captureExternalRoleDiagnostics" => {
            let role_id = string_argument(&args, 0, "Role ID")?;
            invoke_core_async(
                &state,
                json!({ "type": "externalDiagnosticsCapture", "roleId": role_id }),
            )
            .await
            .map(|_| Value::Null)
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
        "applyChromeProfileImport" => apply_chrome_profile_import(&state, &args).await,
        "getGraphicsDiagnostics" => graphics_diagnostics(&state).await,
        "revealLogs" => reveal_logs(&state).await,
        "exportDiagnostics" => export_diagnostics(&app, &window, &state).await,
        "appVersion" => Ok(Value::String(app.package_info().version.to_string())),
        "updateStatus" => Ok(state.updates.status()),
        "checkForUpdates" => {
            let updates = Arc::clone(&state.updates);
            tauri::async_runtime::spawn_blocking(move || updates.check())
                .await
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error.to_string()))
        }
        "openUpdateDownload" | "installDownloadedUpdate" => state
            .updates
            .open_download()
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error)),
        "consumePendingWorkspaceLaunchRequest" => Ok(state
            .helper
            .as_ref()
            .and_then(|helper| helper.take_workspace_launch_request())
            .unwrap_or(Value::Null)),
        "consumePendingMacroPageRequest" => Ok(state
            .helper
            .as_ref()
            .and_then(|helper| helper.take_macro_page_request())
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

async fn invoke_core_async(
    state: &CoreState,
    command: Value,
) -> Result<Value, CoreErrorPayload> {
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

async fn preview_chrome_profile_import(
    state: &CoreState,
) -> Result<Value, CoreErrorPayload> {
    let default_path = invoke_core_sync(state, json!({ "type": "chromeProfileDefaultPath" }))?
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let path = tauri::async_runtime::spawn_blocking(move || {
        native_shell::pick_directory(
            "Choose Chrome User Data folder",
            default_path.as_deref(),
        )
    })
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error.to_string()))?
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
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

async fn apply_chrome_profile_import(
    state: &CoreState,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let input = args.first().cloned().ok_or_else(|| {
        shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Chrome profile import input is required.",
        )
    })?;
    let mut command = input;
    let object = command.as_object_mut().ok_or_else(|| {
        shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Chrome profile import input is invalid.",
        )
    })?;
    object.insert("type".to_owned(), Value::String("chromeProfileApply".to_owned()));
    invoke_core_async(state, command).await
}

async fn graphics_diagnostics(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let settings = invoke_core_sync(state, json!({ "type": "gameBrowserSettingsGet" }))?;
    let versions = state.helper.as_ref().map(|helper| helper.versions());
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
            "versions": {
                "chromium": versions.as_ref().map(|value| value.chromium.as_str())
                    .unwrap_or("system-webview"),
                "electron": versions.as_ref().map(|value| value.electron.as_str())
                    .unwrap_or("unavailable"),
                "node": versions.as_ref().map(|value| value.node.as_str())
                    .unwrap_or("unavailable")
            }
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
    tauri::async_runtime::spawn_blocking(move || {
        native_shell::reveal_in_file_manager(&directory)
    })
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
    let versions = state.helper.as_ref().map(|helper| helper.versions());
    invoke_core_sync(
        state,
        json!({
            "type": "diagnosticsExport",
            "path": path.to_string_lossy(),
            "snapshot": {
                "applicationName": app.package_info().name,
                "applicationVersion": app.package_info().version.to_string(),
                "packaged": !cfg!(debug_assertions),
                "electronVersion": versions.as_ref().map(|value| value.electron.as_str())
                    .unwrap_or("unavailable"),
                "chromiumVersion": versions.as_ref().map(|value| value.chromium.as_str())
                    .unwrap_or("system-webview"),
                "nodeVersion": versions.as_ref().map(|value| value.node.as_str())
                    .unwrap_or("unavailable"),
                "locale": "system",
                "systemVersion": std::env::consts::OS,
                "displays": displays,
                "gpuFeatureStatusRawJson": "{}"
            }
        }),
    )
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
    let input = args.first().cloned().unwrap_or_else(|| json!({ "scope": "all" }));
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
            if tab["hidden"].as_bool() == Some(true) {
                let snapshot =
                    invoke_core_sync(state, json!({ "type": "browserRuntimeSnapshot" }))?;
                if let Some(tab_id) = snapshot["tabs"]
                    .as_array()
                    .and_then(|tabs| {
                        tabs.iter()
                            .find(|candidate| candidate["sourceId"].as_str() == Some(source_id))
                    })
                    .and_then(|candidate| candidate["id"].as_str())
                {
                    invoke_core_async(
                        state,
                        json!({ "type": "embeddedTabHide", "tabId": tab_id }),
                    )
                    .await?;
                }
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
    invoke_core_sync(
        state,
        json!({ "type": "runtimeRestoreSessionReplace", "session": session }),
    )?;
    Ok(Value::Null)
}

fn discard_saved_game_windows(
    state: &CoreState,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let input = args.first().cloned().unwrap_or_else(|| json!({ "scope": "all" }));
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
    invoke_core_sync(
        state,
        json!({ "type": "runtimeRestoreSessionReplace", "session": session }),
    )?;
    Ok(Value::Null)
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
    tauri::Builder::default()
        .setup(|app| {
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
            ));
            let helper = match ElectronHelperClient::start(
                app.handle().clone(),
                Arc::clone(&core),
                &user_data_dir,
            ) {
                Ok(helper) => Some(Arc::new(helper)),
                Err(error) => {
                    #[cfg(not(debug_assertions))]
                    return Err(error.into());
                    #[cfg(debug_assertions)]
                    {
                        eprintln!(
                            "Electron runtime helper is unavailable; using the limited direct Tauri runtime: {error}"
                        );
                        None
                    }
                }
            };
            core.invoke(CoreCommand::SystemWebViewRuntimeRegister {
                registration: helper
                    .as_ref()
                    .map(|helper| helper.registration())
                    .unwrap_or_else(|| runtime.registration()),
            })?;
            let receiver = core.subscribe()?;
            let quick_menu = quick_menu::create(&app.handle().clone(), Arc::clone(&core))?;
            let updates = Arc::new(update_manager::UpdateManager::new(
                app.handle().clone(),
                app.package_info().version.to_string(),
            ));
            let app_handle = app.handle().clone();
            let effect_core = Arc::clone(&core);
            let effect_runtime = Arc::clone(&runtime);
            let effect_helper = helper.as_ref().map(Arc::clone);
            thread::Builder::new()
                .name("rion-tauri-core-events".to_owned())
                .spawn(move || {
                    while let Ok(events) = receiver.recv() {
                        let mut renderer_events = Vec::new();
                        let mut shutdown = false;
                        effect_helper
                            .as_ref()
                            .map(|helper| helper.forward_events(&events));
                        for event in events {
                            match event {
                                CoreEvent::CoreEffects { effects } => {
                                    for effect in effects {
                                        let result_core = Arc::clone(&effect_core);
                                        let result_runtime = Arc::clone(&effect_runtime);
                                        let result_helper =
                                            effect_helper.as_ref().map(Arc::clone);
                                        let _ = thread::Builder::new()
                                            .name("rion-tauri-core-effect".to_owned())
                                            .spawn(move || {
                                                let result = result_helper
                                                    .as_ref()
                                                    .map(|helper| helper.execute(effect.clone()))
                                                    .unwrap_or_else(|| {
                                                        result_runtime.execute(effect)
                                                    });
                                                let _ = result_core
                                                    .dispatch_core_effect_results(vec![result]);
                                            });
                                    }
                                }
                                CoreEvent::Shutdown => {
                                    shutdown = true;
                                    renderer_events.push(CoreEvent::Shutdown);
                                }
                                event => {
                                    if matches!(
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
                                    ) {
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
                helper,
                runtime,
                updates,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rion_core_invoke,
            rion_dispatch_core_effect_results,
            rion_shared_user_data_dir,
            rion_shell_invoke
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Rion Studio Tauri Preview")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app_handle.state::<CoreState>();
                if let Some(helper) = &state.helper {
                    helper.close();
                }
                state.runtime.close_all();
                state.core.shutdown();
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
}
