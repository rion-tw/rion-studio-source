use rion_core::{BrowserRuntimeSnapshot, CoreCommand};
use tauri::{
    AppHandle, Manager,
    menu::{CheckMenuItemBuilder, ContextMenu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
};

const ACTIVATE_PREFIX: &str = "runtime-tab-activate:";
const HIDE_PREFIX: &str = "runtime-tab-hide:";
const LAUNCH_ROLE_PREFIX: &str = "runtime-tab-launch-role:";
const LAUNCH_WORKSPACE_PREFIX: &str = "runtime-tab-launch-workspace:";
const MOVE_PREFIX: &str = "runtime-tab-move:";
const MUTE_PREFIX: &str = "runtime-tab-mute:";
const STOP_PREFIX: &str = "runtime-tab-stop:";

pub fn open_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "runtime state is unavailable".to_owned())?;
    let snapshot = snapshot(&state.core)?;
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| "runtime tab was not found".to_owned())?;
    let window = state
        .runtime
        .window_for_tab(tab_id)
        .ok_or_else(|| "runtime tab window was not found".to_owned())?;
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    let text = labels(&language);
    let projection = state.runtime.projection(&snapshot);
    let muted = projection["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|candidate| candidate["id"] == tab_id))
        .and_then(|tab| tab["audioMuted"].as_bool())
        .unwrap_or(false);
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let mut displays = SubmenuBuilder::new(app, text.move_to_display);
    for display in crate::workspace_displays(&main)
        .map_err(|error| error.message)?
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let Some(display_id) = display["id"].as_i64() else {
            continue;
        };
        let label = display["label"]
            .as_str()
            .filter(|label| !label.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{} {display_id}", text.display));
        let item = MenuItemBuilder::with_id(format!("{MOVE_PREFIX}{tab_id}:{display_id}"), label)
            .enabled(display_id != tab.display_id)
            .build(app)
            .map_err(|error| error.to_string())?;
        displays = displays.item(&item);
    }
    let displays = displays.build().map_err(|error| error.to_string())?;
    let mute = CheckMenuItemBuilder::with_id(
        format!("{MUTE_PREFIX}{tab_id}"),
        if muted { text.unmute } else { text.mute },
    )
    .checked(muted)
    .build(app)
    .map_err(|error| error.to_string())?;
    let menu = MenuBuilder::new(app)
        .item(&displays)
        .item(&mute)
        .separator()
        .text(format!("{HIDE_PREFIX}{tab_id}"), text.hide)
        .separator()
        .text(format!("{STOP_PREFIX}{tab_id}"), text.stop)
        .build()
        .map_err(|error| error.to_string())?;
    menu.popup(window).map_err(|error| error.to_string())
}

pub fn open_launcher(app: &AppHandle, display_id: i64) -> Result<(), String> {
    let state = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "runtime state is unavailable".to_owned())?;
    let snapshot = snapshot(&state.core)?;
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    let text = labels(&language);
    let roles = state
        .core
        .invoke(CoreCommand::RolesList)
        .map_err(|error| error.to_string())?;
    let workspaces = state
        .core
        .invoke(CoreCommand::WorkspacesList)
        .map_err(|error| error.to_string())?;
    let mut roles_menu = SubmenuBuilder::new(app, text.roles);
    let role_values = roles.as_array().cloned().unwrap_or_default();
    if role_values.is_empty() {
        let item = MenuItemBuilder::new(text.no_roles)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        roles_menu = roles_menu.item(&item);
    } else {
        for role in role_values {
            let (Some(id), Some(name)) = (role["id"].as_str(), role["name"].as_str()) else {
                continue;
            };
            if let Some(tab) = snapshot
                .tabs
                .iter()
                .find(|tab| tab.role_ids.iter().any(|value| value == id))
            {
                roles_menu =
                    roles_menu.text(format!("{ACTIVATE_PREFIX}{}", tab.id), format!("✓ {name}"));
            } else {
                roles_menu =
                    roles_menu.text(format!("{LAUNCH_ROLE_PREFIX}{display_id}:{id}"), name);
            }
        }
    }
    let mut workspaces_menu = SubmenuBuilder::new(app, text.workspaces);
    let workspace_values = workspaces.as_array().cloned().unwrap_or_default();
    if workspace_values.is_empty() {
        let item = MenuItemBuilder::new(text.no_workspaces)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        workspaces_menu = workspaces_menu.item(&item);
    } else {
        for workspace in workspace_values {
            let (Some(id), Some(name)) = (workspace["id"].as_str(), workspace["name"].as_str())
            else {
                continue;
            };
            if let Some(tab) = snapshot
                .tabs
                .iter()
                .find(|tab| tab.tab_type == "workspace" && tab.source_id == id)
            {
                workspaces_menu = workspaces_menu
                    .text(format!("{ACTIVATE_PREFIX}{}", tab.id), format!("✓ {name}"));
            } else {
                workspaces_menu = workspaces_menu
                    .text(format!("{LAUNCH_WORKSPACE_PREFIX}{display_id}:{id}"), name);
            }
        }
    }
    let menu = MenuBuilder::new(app)
        .item(&roles_menu.build().map_err(|error| error.to_string())?)
        .item(&workspaces_menu.build().map_err(|error| error.to_string())?)
        .build()
        .map_err(|error| error.to_string())?;
    let window = snapshot
        .displays
        .iter()
        .find(|display| display.display_id == display_id)
        .and_then(|display| display.active_tab_id.as_deref())
        .and_then(|tab_id| state.runtime.window_for_tab(tab_id))
        .ok_or_else(|| "active runtime window was not found".to_owned())?;
    menu.popup(window).map_err(|error| error.to_string())
}

pub fn handle_event(app: &AppHandle, id: &str) -> bool {
    let Some(state) = app.try_state::<crate::CoreState>() else {
        return false;
    };
    if let Some(tab_id) = id.strip_prefix(ACTIVATE_PREFIX) {
        spawn_command(
            &state.core,
            CoreCommand::EmbeddedTabActivate {
                tab_id: tab_id.to_owned(),
            },
        );
    } else if let Some(tab_id) = id.strip_prefix(HIDE_PREFIX) {
        spawn_command(
            &state.core,
            CoreCommand::EmbeddedTabHide {
                tab_id: tab_id.to_owned(),
            },
        );
    } else if let Some(tab_id) = id.strip_prefix(STOP_PREFIX) {
        if let Some(command) = stop_command(&state.core, tab_id) {
            spawn_command(&state.core, command);
        }
    } else if let Some(tab_id) = id.strip_prefix(MUTE_PREFIX) {
        let projection = snapshot(&state.core).map(|snapshot| state.runtime.projection(&snapshot));
        let muted = projection
            .ok()
            .and_then(|projection| {
                projection["tabs"].as_array().and_then(|tabs| {
                    tabs.iter()
                        .find(|tab| tab["id"] == tab_id)
                        .and_then(|tab| tab["audioMuted"].as_bool())
                })
            })
            .unwrap_or(false);
        let _ = state.runtime.set_tab_audio_muted(tab_id, !muted);
    } else if let Some(value) = id.strip_prefix(MOVE_PREFIX) {
        let Some((tab_id, display_id)) = value.rsplit_once(':') else {
            return true;
        };
        if let Ok(display_id) = display_id.parse::<i64>()
            && let Ok(target) = crate::launch_target_for_app_display(app, display_id)
        {
            spawn_command(
                &state.core,
                CoreCommand::EmbeddedTabMove {
                    tab_id: tab_id.to_owned(),
                    target,
                },
            );
        }
    } else if let Some(value) = id.strip_prefix(LAUNCH_ROLE_PREFIX) {
        launch_from_menu(app, &state, value, false);
    } else if let Some(value) = id.strip_prefix(LAUNCH_WORKSPACE_PREFIX) {
        launch_from_menu(app, &state, value, true);
    } else {
        return false;
    }
    true
}

pub async fn handle_scoped_action(
    app: &AppHandle,
    state: &crate::CoreState,
    display_id: i64,
    action: serde_json::Value,
) -> Result<(), String> {
    let action_type = action["type"]
        .as_str()
        .ok_or_else(|| "runtime tab action type is required".to_owned())?;
    let allowed_keys = match action_type {
        "activate" | "hide" | "stop" | "openTabMenu" => &["type", "tabId"][..],
        "move" => &["type", "tabId", "displayId"][..],
        "reorder" => &["type", "tabId", "beforeTabId"][..],
        "openLauncher" | "fullscreenToolbarEnter" | "fullscreenToolbarLeave" => &["type"][..],
        "activateAdjacent" => &["type", "direction"][..],
        "windowControl" => &["type", "control"][..],
        _ => return Err("runtime tab action type is not supported".to_owned()),
    };
    if action.as_object().is_none_or(|value| {
        value
            .keys()
            .any(|key| !allowed_keys.contains(&key.as_str()))
    }) {
        return Err("runtime tab action contains unexpected fields".to_owned());
    }
    if action_type == "openLauncher" {
        return open_launcher(app, display_id);
    }
    if matches!(
        action_type,
        "fullscreenToolbarEnter" | "fullscreenToolbarLeave"
    ) {
        return state
            .runtime
            .set_windows_toolbar_revealed(display_id, action_type == "fullscreenToolbarEnter");
    }
    if action_type == "activateAdjacent" {
        let direction = action["direction"]
            .as_str()
            .filter(|value| matches!(*value, "next" | "previous"))
            .ok_or_else(|| "runtime tab direction is invalid".to_owned())?;
        return state
            .core
            .invoke_async(CoreCommand::EmbeddedTabActivateAdjacent {
                display_id,
                direction: direction.to_owned(),
            })
            .await
            .map(|_| ())
            .map_err(|error| error.to_string());
    }
    if action_type == "windowControl" {
        let control = action["control"]
            .as_str()
            .ok_or_else(|| "runtime window control is required".to_owned())?;
        let window = state
            .runtime
            .window_for_display(display_id)
            .ok_or_else(|| "runtime window was not found".to_owned())?;
        return match control {
            "close" => window.close().map_err(|error| error.to_string()),
            "minimize" => window.minimize().map_err(|error| error.to_string()),
            "toggleFullscreen" => {
                let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
                window
                    .set_fullscreen(!fullscreen)
                    .map_err(|error| error.to_string())
            }
            "zoom" => {
                let maximized = window.is_maximized().map_err(|error| error.to_string())?;
                if maximized {
                    window.unmaximize().map_err(|error| error.to_string())
                } else {
                    window.maximize().map_err(|error| error.to_string())
                }
            }
            _ => Err("runtime window control is invalid".to_owned()),
        };
    }
    let tab_id = action["tabId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "runtime tab ID is required".to_owned())?;
    let snapshot = snapshot(&state.core)?;
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id && tab.display_id == display_id)
        .ok_or_else(|| "runtime tab is outside this chrome WebView's display".to_owned())?;
    if action_type == "openTabMenu" {
        return open_tab(app, tab_id);
    }
    let command = match action_type {
        "activate" => CoreCommand::EmbeddedTabActivate {
            tab_id: tab_id.to_owned(),
        },
        "hide" => CoreCommand::EmbeddedTabHide {
            tab_id: tab_id.to_owned(),
        },
        "stop" => stop_command(&state.core, tab_id)
            .ok_or_else(|| "runtime tab was not found".to_owned())?,
        "move" => {
            let target_display_id = action["displayId"]
                .as_i64()
                .ok_or_else(|| "target display ID is required".to_owned())?;
            let target = crate::launch_target_for_app_display(app, target_display_id)
                .map_err(|error| error.message)?;
            CoreCommand::EmbeddedTabMove {
                tab_id: tab_id.to_owned(),
                target,
            }
        }
        "reorder" => {
            let before_tab_id = action
                .get("beforeTabId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if let Some(before) = before_tab_id.as_deref()
                && !snapshot
                    .tabs
                    .iter()
                    .any(|candidate| candidate.id == before && candidate.display_id == display_id)
            {
                return Err("reorder target is outside this chrome WebView's display".to_owned());
            }
            CoreCommand::EmbeddedTabReorder {
                tab_id: tab.id.clone(),
                before_tab_id,
            }
        }
        _ => return Err("runtime tab action is invalid".to_owned()),
    };
    state
        .core
        .invoke_async(command)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn launch_from_menu(app: &AppHandle, state: &crate::CoreState, value: &str, workspace: bool) {
    let Some((display_id, source_id)) = value.split_once(':') else {
        return;
    };
    let Ok(display_id) = display_id.parse::<i64>() else {
        return;
    };
    let workspace_record = if workspace {
        state
            .core
            .invoke(CoreCommand::WorkspacesList)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .and_then(|items| {
                items
                    .into_iter()
                    .find(|item| item["id"].as_str() == Some(source_id))
            })
    } else {
        None
    };
    let requested_display_id = workspace_menu_display_id(workspace_record.as_ref(), display_id);
    let Ok(target) = crate::launch_target_for_app_display(app, requested_display_id) else {
        if workspace {
            queue_workspace_display_request(
                app,
                state,
                source_id,
                workspace_record
                    .as_ref()
                    .and_then(|record| record["name"].as_str())
                    .unwrap_or(source_id),
            );
        }
        return;
    };
    let command = if workspace {
        CoreCommand::BrowserWorkspaceLaunch {
            workspace_id: source_id.to_owned(),
            target,
        }
    } else {
        CoreCommand::BrowserRoleLaunch {
            role_id: source_id.to_owned(),
            target,
            zoom_factor: None,
        }
    };
    spawn_command(&state.core, command);
}

fn workspace_menu_display_id(workspace: Option<&serde_json::Value>, source_display_id: i64) -> i64 {
    workspace
        .and_then(|record| record["targetDisplay"]["id"].as_i64())
        .unwrap_or(source_display_id)
}

fn queue_workspace_display_request(
    app: &AppHandle,
    state: &crate::CoreState,
    workspace_id: &str,
    workspace_name: &str,
) {
    let displays = app
        .get_webview_window("main")
        .and_then(|window| crate::workspace_displays(&window).ok())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    let request = serde_json::json!({
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "result": {
            "kind": "display_selection_required",
            "reason": "target_unavailable",
            "displays": displays
        }
    });
    if let Ok(mut pending) = state.pending_workspace_launch_request.lock() {
        *pending = Some(request.clone());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = tauri::Emitter::emit(app, "rion://workspace-launch-request", request);
}

fn spawn_command(core: &std::sync::Arc<rion_core::AppCore>, command: CoreCommand) {
    let core = std::sync::Arc::clone(core);
    tauri::async_runtime::spawn(async move {
        let _ = core.invoke_async(command).await;
    });
}

fn snapshot(core: &rion_core::AppCore) -> Result<BrowserRuntimeSnapshot, String> {
    core.invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}

fn stop_command(core: &rion_core::AppCore, tab_id: &str) -> Option<CoreCommand> {
    let tab = snapshot(core)
        .ok()?
        .tabs
        .into_iter()
        .find(|tab| tab.id == tab_id)?;
    Some(if tab.tab_type == "workspace" {
        CoreCommand::BrowserWorkspaceStop {
            workspace_id: tab.source_id,
        }
    } else {
        CoreCommand::BrowserRoleStop {
            role_id: tab.source_id,
        }
    })
}

struct Labels {
    display: &'static str,
    hide: &'static str,
    move_to_display: &'static str,
    mute: &'static str,
    no_roles: &'static str,
    no_workspaces: &'static str,
    roles: &'static str,
    stop: &'static str,
    unmute: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            display: "顯示器",
            hide: "隱藏分頁（保持運行）",
            move_to_display: "移至顯示器",
            mute: "將分頁靜音",
            no_roles: "沒有角色",
            no_workspaces: "沒有工作區",
            roles: "角色",
            stop: "停止並關閉",
            unmute: "取消分頁靜音",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            display: "显示器",
            hide: "隐藏标签页（保持运行）",
            move_to_display: "移至显示器",
            mute: "将标签页静音",
            no_roles: "没有角色",
            no_workspaces: "没有工作区",
            roles: "角色",
            stop: "停止并关闭",
            unmute: "取消标签页静音",
            workspaces: "工作区",
        },
        "ja" => Labels {
            display: "ディスプレイ",
            hide: "タブを非表示（実行を継続）",
            move_to_display: "ディスプレイへ移動",
            mute: "タブをミュート",
            no_roles: "ロールなし",
            no_workspaces: "ワークスペースなし",
            roles: "ロール",
            stop: "停止して閉じる",
            unmute: "タブのミュートを解除",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            display: "Display",
            hide: "Hide tab (keeps running)",
            move_to_display: "Move to Display",
            mute: "Mute Tab",
            no_roles: "No Roles",
            no_workspaces: "No Workspaces",
            roles: "Roles",
            stop: "Stop and Close",
            unmute: "Unmute Tab",
            workspaces: "Workspaces",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::workspace_menu_display_id;

    #[test]
    fn workspace_launcher_preserves_a_saved_display_target() {
        let workspace = serde_json::json!({ "targetDisplay": { "id": 42 } });
        assert_eq!(workspace_menu_display_id(Some(&workspace), 7), 42);
        assert_eq!(workspace_menu_display_id(None, 7), 7);
    }
}
