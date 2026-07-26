use std::sync::Arc;

use rion_core::{AppCore, CoreCommand, EmbeddedLaunchTargetRecord, StatePixelBoundsRecord};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "rion-quick-menu";
const ROLE_PREFIX: &str = "launch-role:";
const WORKSPACE_PREFIX: &str = "launch-workspace:";
const STOP_ROLE_PREFIX: &str = "stop-role:";
const STOP_WORKSPACE_PREFIX: &str = "stop-workspace:";

pub fn create(app: &AppHandle, core: Arc<AppCore>) -> Result<TrayIcon, String> {
    let menu = menu(app, &core)?;
    let event_core = Arc::clone(&core);
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Rion Studio")
        .on_menu_event(move |app, event| {
            handle_menu_event(app, &event_core, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app).map_err(|error| error.to_string())
}

pub fn refresh(app: &AppHandle, core: &AppCore) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "Rion Studio Quick Menu is unavailable.".to_owned())?;
    tray.set_menu(Some(menu(app, core)?))
        .map_err(|error| error.to_string())
}

fn menu(app: &AppHandle, core: &AppCore) -> Result<Menu<tauri::Wry>, String> {
    let roles = core
        .invoke(CoreCommand::RolesList)
        .map_err(|error| error.to_string())?;
    let workspaces = core
        .invoke(CoreCommand::WorkspacesList)
        .map_err(|error| error.to_string())?;
    let role_statuses = core
        .invoke(CoreCommand::BrowserStatuses)
        .map_err(|error| error.to_string())?;
    let workspace_statuses = core
        .invoke(CoreCommand::BrowserWorkspaceStatuses)
        .map_err(|error| error.to_string())?;
    let legal_accepted = legal_is_accepted(core);
    let saved_window_count = saved_window_count(core);
    let role_state = |id: &str| status_state(&role_statuses, "roleId", id);
    let workspace_state = |id: &str| status_state(&workspace_statuses, "workspaceId", id);
    let mut role_menu = SubmenuBuilder::new(app, "Roles");
    let role_values = roles.as_array().cloned().unwrap_or_default();
    if role_values.is_empty() {
        role_menu = role_menu.text("no-roles", "No Roles");
    } else {
        for role in role_values {
            if let (Some(id), Some(name)) = (role["id"].as_str(), role["name"].as_str()) {
                let state = role_state(id);
                let (prefix, marker) = if state == Some("running") {
                    (STOP_ROLE_PREFIX, "✓ ")
                } else if state.is_some() {
                    (ROLE_PREFIX, "… ")
                } else {
                    (ROLE_PREFIX, "")
                };
                role_menu = role_menu.text(format!("{prefix}{id}"), format!("{marker}{name}"));
            }
        }
    }
    let mut workspace_menu = SubmenuBuilder::new(app, "Workspaces");
    let workspace_values = workspaces.as_array().cloned().unwrap_or_default();
    if workspace_values.is_empty() {
        workspace_menu = workspace_menu.text("no-workspaces", "No Workspaces");
    } else {
        for workspace in workspace_values {
            if let (Some(id), Some(name)) = (workspace["id"].as_str(), workspace["name"].as_str()) {
                let state = workspace_state(id);
                let (prefix, marker) = if state == Some("running") {
                    (STOP_WORKSPACE_PREFIX, "✓ ")
                } else if state.is_some() {
                    (WORKSPACE_PREFIX, "… ")
                } else {
                    (WORKSPACE_PREFIX, "")
                };
                workspace_menu =
                    workspace_menu.text(format!("{prefix}{id}"), format!("{marker}{name}"));
            }
        }
    }
    let role_menu = role_menu.build().map_err(|error| error.to_string())?;
    let workspace_menu = workspace_menu.build().map_err(|error| error.to_string())?;
    let mut menu = MenuBuilder::new(app).text("open-app", "Open Rion Studio");
    if !legal_accepted {
        menu = menu.text("review-terms", "Review terms before launching");
    }
    if saved_window_count > 0 {
        menu = menu.text(
            "restore-windows",
            format!("Restore Saved Game Windows ({saved_window_count})"),
        );
    }
    menu = menu
        .text("show-games", "Show Game Windows")
        .separator()
        .item(&role_menu)
        .item(&workspace_menu);
    if role_statuses
        .as_array()
        .is_some_and(|items| !items.is_empty())
    {
        menu = menu.separator().text("stop-all", "Stop All Running Roles");
    }
    menu.separator()
        .text("quit-app", "Quit Rion Studio")
        .build()
        .map_err(|error| error.to_string())
}

fn handle_menu_event(app: &AppHandle, core: &Arc<AppCore>, id: &str) {
    match id {
        "open-app" | "review-terms" => show_main_window(app),
        "restore-windows" => {
            show_main_window(app);
            let _ = app.emit("rion://quick-menu-restore", ());
        }
        "show-games" => {
            let core = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                let _ = core
                    .invoke_async(CoreCommand::EmbeddedWindowsShow { display_id: None })
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
        _ if id.starts_with(STOP_ROLE_PREFIX) => {
            stop_role(core, id.trim_start_matches(STOP_ROLE_PREFIX));
        }
        _ if id.starts_with(STOP_WORKSPACE_PREFIX) => {
            stop_workspace(core, id.trim_start_matches(STOP_WORKSPACE_PREFIX));
        }
        _ if id.starts_with(ROLE_PREFIX) || id.starts_with(WORKSPACE_PREFIX) => {
            if !legal_is_accepted(core) {
                show_main_window(app);
                return;
            }
            let Some(target) = launch_target(app) else {
                return;
            };
            let source_id = id
                .strip_prefix(ROLE_PREFIX)
                .or_else(|| id.strip_prefix(WORKSPACE_PREFIX))
                .unwrap_or_default()
                .to_owned();
            if source_id.is_empty() {
                return;
            }
            let workspace = id.starts_with(WORKSPACE_PREFIX);
            let core = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                let command = if workspace {
                    CoreCommand::BrowserWorkspaceLaunch {
                        workspace_id: source_id,
                        target,
                    }
                } else {
                    CoreCommand::BrowserRoleLaunch {
                        role_id: source_id,
                        target,
                        zoom_factor: None,
                    }
                };
                let _ = core.invoke_async(command).await;
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

fn saved_window_count(core: &AppCore) -> usize {
    core.invoke(CoreCommand::RuntimeRestoreSessionGet)
        .ok()
        .and_then(|value| value["windows"].as_array().map(Vec::len))
        .unwrap_or(0)
}

fn status_state<'a>(statuses: &'a serde_json::Value, key: &str, id: &str) -> Option<&'a str> {
    statuses.as_array()?.iter().find_map(|status| {
        (status[key].as_str() == Some(id))
            .then(|| status["state"].as_str())
            .flatten()
    })
}

fn stop_role(core: &Arc<AppCore>, role_id: &str) {
    if role_id.is_empty() {
        return;
    }
    let core = Arc::clone(core);
    let role_id = role_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::BrowserRoleStop { role_id })
            .await;
    });
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn launch_target(app: &AppHandle) -> Option<EmbeddedLaunchTargetRecord> {
    let window = app.get_webview_window("main")?;
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    Some(EmbeddedLaunchTargetRecord {
        display_id: super::monitor_id(&monitor),
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale).round() as i32,
            y: (work_area.position.y as f64 / scale).round() as i32,
            width: (work_area.size.width as f64 / scale).round() as i32,
            height: (work_area.size.height as f64 / scale).round() as i32,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_menu_ids_keep_domain_ids_as_opaque_suffixes() {
        let role_id = "0f15d171-2380-4bd8-aa0c-b17fe07746ad";
        let encoded = format!("{ROLE_PREFIX}{role_id}");
        assert_eq!(encoded.strip_prefix(ROLE_PREFIX), Some(role_id));
        assert!(!encoded.starts_with(WORKSPACE_PREFIX));
    }

    #[test]
    fn status_state_distinguishes_running_busy_and_missing_items() {
        let statuses = serde_json::json!([
            {"roleId":"role-running","state":"running"},
            {"roleId":"role-loading","state":"launching"}
        ]);
        assert_eq!(
            status_state(&statuses, "roleId", "role-running"),
            Some("running")
        );
        assert_eq!(
            status_state(&statuses, "roleId", "role-loading"),
            Some("launching")
        );
        assert_eq!(status_state(&statuses, "roleId", "role-missing"), None);
    }
}
