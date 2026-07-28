use std::{collections::HashSet, sync::Arc};

use rion_core::{AppCore, BrowserRuntimeSnapshot, CoreCommand};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "rion-quick-menu";
const ROLE_PREFIX: &str = "launch-role:";
const WORKSPACE_PREFIX: &str = "launch-workspace:";
const STOP_WORKSPACE_PREFIX: &str = "stop-workspace:";
const SHOW_DISPLAY_PREFIX: &str = "show-display:";
const RESTORE_WINDOW_PREFIX: &str = "restore-window:";

pub fn create(
    app: &AppHandle,
    core: Arc<AppCore>,
    runtime: Arc<crate::SystemRuntimeExecutor>,
) -> Result<TrayIcon, String> {
    let menu = menu(app, &core, &runtime, "en")?;
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

pub fn refresh(
    app: &AppHandle,
    core: &AppCore,
    runtime: &crate::SystemRuntimeExecutor,
    language: &str,
) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "Rion Studio Quick Menu is unavailable.".to_owned())?;
    tray.set_menu(Some(menu(app, core, runtime, language)?))
        .map_err(|error| error.to_string())
}

fn menu(
    app: &AppHandle,
    core: &AppCore,
    runtime: &crate::SystemRuntimeExecutor,
    language: &str,
) -> Result<Menu<tauri::Wry>, String> {
    let labels = labels(language);
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
    let runtime_projection = core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .ok()
        .and_then(|value| serde_json::from_value::<BrowserRuntimeSnapshot>(value).ok())
        .map(|snapshot| runtime.projection(&snapshot))
        .unwrap_or_else(|| serde_json::json!({ "windows": [], "savedWindows": [] }));
    let role_state = |id: &str| status_state(&role_statuses, "roleId", id);
    let workspace_state = |id: &str| status_state(&workspace_statuses, "workspaceId", id);
    let mut role_menu = SubmenuBuilder::new(app, labels.roles);
    let role_values = roles.as_array().cloned().unwrap_or_default();
    let role_ids = role_values
        .iter()
        .filter_map(|role| role["id"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    if role_values.is_empty() {
        role_menu = role_menu.text("no-roles", labels.no_roles);
    } else {
        for role in role_values {
            if let (Some(id), Some(name)) = (role["id"].as_str(), role["name"].as_str()) {
                let state = role_state(id);
                let busy = matches!(state, Some("launching" | "stopping"));
                let marker = if state == Some("running") {
                    "✓ "
                } else if busy {
                    "… "
                } else {
                    ""
                };
                let item = MenuItemBuilder::with_id(
                    format!("{ROLE_PREFIX}{id}"),
                    format!("{marker}{name}"),
                )
                .enabled(legal_accepted && !busy)
                .build(app)
                .map_err(|error| error.to_string())?;
                role_menu = role_menu.item(&item);
            }
        }
    }
    let mut workspace_menu = SubmenuBuilder::new(app, labels.workspaces);
    let workspace_values = workspaces.as_array().cloned().unwrap_or_default();
    if workspace_values.is_empty() {
        workspace_menu = workspace_menu.text("no-workspaces", labels.no_workspaces);
    } else {
        for workspace in workspace_values {
            if let (Some(id), Some(name)) = (workspace["id"].as_str(), workspace["name"].as_str()) {
                let state = workspace_state(id);
                let assigned_role_ids = workspace["slots"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|slot| slot["roleId"].as_str())
                    .collect::<Vec<_>>();
                let missing_role = assigned_role_ids
                    .iter()
                    .any(|role_id| !role_ids.contains(*role_id));
                let busy = matches!(state, Some("launching" | "stopping"));
                let running = state == Some("running");
                let (prefix, marker) = if running {
                    (STOP_WORKSPACE_PREFIX, "✓ ")
                } else if busy {
                    (WORKSPACE_PREFIX, "… ")
                } else {
                    (WORKSPACE_PREFIX, "")
                };
                let item =
                    MenuItemBuilder::with_id(format!("{prefix}{id}"), format!("{marker}{name}"))
                        .enabled(
                            legal_accepted
                                && (running
                                    || (!busy && !assigned_role_ids.is_empty() && !missing_role)),
                        )
                        .build(app)
                        .map_err(|error| error.to_string())?;
                workspace_menu = workspace_menu.item(&item);
            }
        }
    }
    let role_menu = role_menu.build().map_err(|error| error.to_string())?;
    let workspace_menu = workspace_menu.build().map_err(|error| error.to_string())?;
    let mut menu = MenuBuilder::new(app).text("open-app", labels.open);
    if !legal_accepted {
        menu = menu.text("review-terms", labels.review_terms);
    }
    let windows = runtime_projection["windows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let saved_windows = runtime_projection["savedWindows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let has_game_windows = !windows.is_empty() || !saved_windows.is_empty();
    if has_game_windows {
        let header = MenuItemBuilder::new(labels.game_windows)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        menu = menu.item(&header);
        for window in windows {
            let (Some(window_id), Some(display_id)) =
                (window["windowId"].as_str(), window["displayId"].as_i64())
            else {
                continue;
            };
            let count = window["tabCount"].as_u64().unwrap_or(0);
            let visibility = if window["visible"].as_bool().unwrap_or(false) {
                labels.visible
            } else {
                labels.hidden
            };
            menu = menu.text(
                format!("{SHOW_DISPLAY_PREFIX}{window_id}"),
                format!(
                    "{} · {count} {} · {visibility}",
                    display_label(app, display_id),
                    labels.tabs
                ),
            );
        }
        for window in saved_windows {
            let (Some(id), Some(display_label)) =
                (window["id"].as_str(), window["displayLabel"].as_str())
            else {
                continue;
            };
            let count = window["tabCount"].as_u64().unwrap_or(0);
            let item = MenuItemBuilder::with_id(
                format!("{RESTORE_WINDOW_PREFIX}{id}"),
                format!(
                    "{display_label} · {count} {} · {}",
                    labels.tabs, labels.saved
                ),
            )
            .enabled(legal_accepted && window["state"].as_str() != Some("restoring"))
            .build(app)
            .map_err(|error| error.to_string())?;
            menu = menu.item(&item);
        }
        menu = menu.separator();
    }
    menu = menu.item(&role_menu).item(&workspace_menu);
    if has_game_windows {
        menu = menu.separator().text("show-games", labels.show_all);
    }
    if role_statuses
        .as_array()
        .is_some_and(|items| !items.is_empty())
    {
        menu = menu.separator().text("stop-all", labels.stop_all);
    }
    menu.separator()
        .text("quit-app", labels.quit)
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
        _ if id.starts_with(SHOW_DISPLAY_PREFIX) => {
            let window_id = id.trim_start_matches(SHOW_DISPLAY_PREFIX).to_owned();
            let core = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                let _ = core
                    .invoke_async(CoreCommand::EmbeddedWindowsShow {
                        window_id: Some(window_id),
                    })
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
        "show-games" => {
            let core = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                let _ = core
                    .invoke_async(CoreCommand::EmbeddedWindowsShow { window_id: None })
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
            let core = Arc::clone(core);
            let app = app.clone();
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
                if let Err(error) = core.invoke_async(command).await {
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn display_label(app: &AppHandle, display_id: i64) -> String {
    app.available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find_map(|monitor| {
                (super::monitor_id(&monitor) == display_id)
                    .then(|| monitor.name().cloned())
                    .flatten()
            })
        })
        .unwrap_or_else(|| format!("Display {display_id}"))
}

#[derive(Clone, Copy)]
struct Labels {
    game_windows: &'static str,
    hidden: &'static str,
    no_roles: &'static str,
    no_workspaces: &'static str,
    open: &'static str,
    quit: &'static str,
    review_terms: &'static str,
    roles: &'static str,
    saved: &'static str,
    show_all: &'static str,
    stop_all: &'static str,
    tabs: &'static str,
    visible: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            game_windows: "遊戲視窗",
            hidden: "已隱藏",
            no_roles: "沒有角色",
            no_workspaces: "沒有工作區",
            open: "開啟 Rion Studio",
            quit: "結束 Rion Studio",
            review_terms: "啟動前請先檢閱條款",
            roles: "角色",
            saved: "已儲存",
            show_all: "顯示所有遊戲視窗",
            stop_all: "停止所有執行中的角色",
            tabs: "個分頁",
            visible: "顯示中",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            game_windows: "游戏窗口",
            hidden: "已隐藏",
            no_roles: "没有角色",
            no_workspaces: "没有工作区",
            open: "打开 Rion Studio",
            quit: "退出 Rion Studio",
            review_terms: "启动前请先查看条款",
            roles: "角色",
            saved: "已保存",
            show_all: "显示所有游戏窗口",
            stop_all: "停止所有运行中的角色",
            tabs: "个标签页",
            visible: "显示中",
            workspaces: "工作区",
        },
        "ja" => Labels {
            game_windows: "ゲームウインドウ",
            hidden: "非表示",
            no_roles: "ロールなし",
            no_workspaces: "ワークスペースなし",
            open: "Rion Studio を開く",
            quit: "Rion Studio を終了",
            review_terms: "起動前に利用規約を確認",
            roles: "ロール",
            saved: "保存済み",
            show_all: "すべてのゲームウインドウを表示",
            stop_all: "実行中のロールをすべて停止",
            tabs: "タブ",
            visible: "表示中",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            game_windows: "Game Windows",
            hidden: "Hidden",
            no_roles: "No Roles",
            no_workspaces: "No Workspaces",
            open: "Open Rion Studio",
            quit: "Quit Rion Studio",
            review_terms: "Review terms before launching",
            roles: "Roles",
            saved: "Saved",
            show_all: "Show All Game Windows",
            stop_all: "Stop All Running Roles",
            tabs: "tabs",
            visible: "Visible",
            workspaces: "Workspaces",
        },
    }
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
