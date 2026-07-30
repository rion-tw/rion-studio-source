use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    thread,
};

use rion_core::{AppCore, BrowserRuntimeSnapshot, CoreCommand};
use tauri::{
    AppHandle, Manager, Window,
    menu::{CheckMenuItemBuilder, ContextMenu, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
};

const ACTIVATE_PREFIX: &str = "runtime-tab-activate:";
const HIDE_PREFIX: &str = "runtime-tab-hide:";
const LAUNCH_ROLE_PREFIX: &str = "runtime-tab-launch-role:";
const LAUNCH_WORKSPACE_PREFIX: &str = "runtime-tab-launch-workspace:";
const MOVE_PREFIX: &str = "runtime-tab-move:";
const MOVE_NEW_PREFIX: &str = "runtime-tab-move-new:";
const MUTE_PREFIX: &str = "runtime-tab-mute:";
const RELOAD_PREFIX: &str = "runtime-tab-reload:";
const STOP_PREFIX: &str = "runtime-tab-stop:";

#[derive(Clone, Default)]
pub(crate) struct RefreshCoordinator {
    state: Arc<Mutex<RefreshState>>,
}

#[derive(Default)]
struct RefreshState {
    language: String,
    loading_menu: Option<Menu<tauri::Wry>>,
    menus: HashMap<String, Menu<tauri::Wry>>,
    model: Option<Arc<LauncherMenuModel>>,
    revision: u64,
    worker_running: bool,
}

#[derive(Clone)]
struct LauncherMenuModel {
    language: String,
    roles: serde_json::Value,
    runtime: BrowserRuntimeSnapshot,
    window_ids: Vec<String>,
    workspaces: serde_json::Value,
}

impl RefreshCoordinator {
    pub(crate) fn prime(&self, app: &AppHandle, language: &str) -> Result<(), String> {
        let menu = launcher_loading_menu(app, language)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
        state.language = language.to_owned();
        state.loading_menu = Some(menu);
        Ok(())
    }

    /// Coalesces Core and SQLite reads on a dedicated worker so the native plus button never
    /// performs database work or waits for an in-flight game launch.
    pub(crate) fn request(
        &self,
        app: AppHandle,
        core: Arc<AppCore>,
        language: String,
    ) -> Result<(), String> {
        let should_spawn = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
            state.revision = state.revision.wrapping_add(1).max(1);
            state.language = language;
            if state.worker_running {
                false
            } else {
                state.worker_running = true;
                true
            }
        };
        if !should_spawn {
            return Ok(());
        }
        let coordinator = self.clone();
        let spawn = thread::Builder::new()
            .name("rion-runtime-launcher-model".to_owned())
            .spawn(move || coordinator.run(app, core));
        if let Err(error) = spawn {
            if let Ok(mut state) = self.state.lock() {
                state.worker_running = false;
            }
            return Err(error.to_string());
        }
        Ok(())
    }

    fn run(&self, app: AppHandle, core: Arc<AppCore>) {
        loop {
            let (revision, language) = match self.state.lock() {
                Ok(state) => (state.revision, state.language.clone()),
                Err(_) => return,
            };
            match LauncherMenuModel::load(&core, language) {
                Ok(model) => {
                    let coordinator = self.clone();
                    let menu_app = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        coordinator.apply(&menu_app, revision, model);
                    }) {
                        eprintln!("Runtime launcher native refresh could not be queued: {error}");
                    }
                }
                Err(error) => eprintln!("Runtime launcher model refresh failed: {error}"),
            }
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.revision != revision {
                continue;
            }
            state.worker_running = false;
            return;
        }
    }

    fn apply(&self, app: &AppHandle, revision: u64, model: LauncherMenuModel) {
        if self
            .state
            .lock()
            .ok()
            .is_none_or(|state| state.revision != revision)
        {
            return;
        }
        let mut menus = HashMap::new();
        for window_id in &model.window_ids {
            match launcher_menu(app, &model, window_id) {
                Ok(menu) => {
                    menus.insert(window_id.clone(), menu);
                }
                Err(error) => {
                    eprintln!("Runtime launcher menu refresh failed for {window_id}: {error}");
                }
            }
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.revision != revision {
            return;
        }
        state.loading_menu = launcher_loading_menu(app, &model.language).ok();
        state.menus = menus;
        state.model = Some(Arc::new(model));
    }

    fn popup(
        &self,
        app: &AppHandle,
        core: Arc<AppCore>,
        language: String,
        window_id: &str,
        window: Window,
    ) -> Result<(), String> {
        let (cached_menu, loading_menu) = self
            .state
            .lock()
            .map(|state| {
                (
                    state.menus.get(window_id).cloned(),
                    state.loading_menu.clone(),
                )
            })
            .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
        let menu = if let Some(menu) = cached_menu {
            menu
        } else {
            // The first click can race startup projection collection. The loading menu was
            // prebuilt during app setup, so this event still performs no Core/SQLite read and
            // no native menu construction.
            let _ = self.request(app.clone(), core, language.clone());
            loading_menu.ok_or_else(|| {
                "The runtime launcher projection has not been initialized yet.".to_owned()
            })?
        };
        menu.popup(window).map_err(|error| error.to_string())
    }
}

impl LauncherMenuModel {
    fn load(core: &AppCore, language: String) -> Result<Self, String> {
        let runtime = snapshot(core)?;
        let roles = core
            .invoke(CoreCommand::RolesList)
            .map_err(|error| error.to_string())?;
        let workspaces = core
            .invoke(CoreCommand::WorkspacesList)
            .map_err(|error| error.to_string())?;
        let mut window_ids = runtime
            .windows
            .iter()
            .map(|window| window.window_id.clone())
            .chain(runtime.tabs.iter().map(|tab| tab.window_id.clone()))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        window_ids.sort();
        Ok(Self {
            language,
            roles,
            runtime,
            window_ids,
            workspaces,
        })
    }
}

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
    let mut displays = SubmenuBuilder::new(app, text.move_to_window);
    for game_window in state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(|error| error.to_string())?
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let (Some(window_id), Some(label)) =
            (game_window["id"].as_str(), game_window["name"].as_str())
        else {
            continue;
        };
        let item = MenuItemBuilder::with_id(format!("{MOVE_PREFIX}{tab_id}:{window_id}"), label)
            .enabled(window_id != tab.window_id)
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
        .text(format!("{RELOAD_PREFIX}{tab_id}"), text.reload)
        .separator()
        .item(&displays)
        .text(
            format!("{MOVE_NEW_PREFIX}{tab_id}"),
            text.move_to_new_window,
        )
        .item(&mute)
        .separator()
        .text(format!("{HIDE_PREFIX}{tab_id}"), text.hide)
        .separator()
        .text(format!("{STOP_PREFIX}{tab_id}"), text.stop)
        .build()
        .map_err(|error| error.to_string())?;
    menu.popup(window).map_err(|error| error.to_string())
}

pub fn open_launcher(app: &AppHandle, window_id: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "runtime state is unavailable".to_owned())?;
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    let window = state
        .runtime
        .window_for_id(window_id)
        .ok_or_else(|| "runtime window was not found".to_owned())?;
    state
        .runtime_launcher_refresh
        .popup(app, Arc::clone(&state.core), language, window_id, window)
}

fn launcher_menu(
    app: &AppHandle,
    model: &LauncherMenuModel,
    window_id: &str,
) -> Result<Menu<tauri::Wry>, String> {
    let text = labels(&model.language);
    let mut roles_menu = SubmenuBuilder::new(app, text.roles);
    let role_values = model.roles.as_array().cloned().unwrap_or_default();
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
            if let Some(tab) = model
                .runtime
                .tabs
                .iter()
                .find(|tab| tab.role_ids.iter().any(|value| value == id))
            {
                roles_menu =
                    roles_menu.text(format!("{ACTIVATE_PREFIX}{}", tab.id), format!("✓ {name}"));
            } else {
                roles_menu = roles_menu.text(format!("{LAUNCH_ROLE_PREFIX}{window_id}:{id}"), name);
            }
        }
    }
    let mut workspaces_menu = SubmenuBuilder::new(app, text.workspaces);
    let workspace_values = model.workspaces.as_array().cloned().unwrap_or_default();
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
            if let Some(tab) = model
                .runtime
                .tabs
                .iter()
                .find(|tab| tab.tab_type == "workspace" && tab.source_id == id)
            {
                workspaces_menu = workspaces_menu
                    .text(format!("{ACTIVATE_PREFIX}{}", tab.id), format!("✓ {name}"));
            } else {
                workspaces_menu = workspaces_menu
                    .text(format!("{LAUNCH_WORKSPACE_PREFIX}{window_id}:{id}"), name);
            }
        }
    }
    MenuBuilder::new(app)
        .item(&roles_menu.build().map_err(|error| error.to_string())?)
        .item(&workspaces_menu.build().map_err(|error| error.to_string())?)
        .build()
        .map_err(|error| error.to_string())
}

fn launcher_loading_menu(app: &AppHandle, language: &str) -> Result<Menu<tauri::Wry>, String> {
    let item = MenuItemBuilder::new(labels(language).loading)
        .enabled(false)
        .build(app)
        .map_err(|error| error.to_string())?;
    MenuBuilder::new(app)
        .item(&item)
        .build()
        .map_err(|error| error.to_string())
}

pub fn handle_event(app: &AppHandle, id: &str) -> bool {
    if !is_runtime_menu_event(id) {
        return false;
    }
    let Some(state) = app.try_state::<crate::CoreState>() else {
        reveal_menu_error(app, "runtime state is unavailable");
        return true;
    };
    if let Some(tab_id) = id.strip_prefix(ACTIVATE_PREFIX) {
        if let Err(message) = crate::preview_and_commit_native_tab_selection(app, &state, tab_id) {
            reveal_menu_error(app, message);
        }
    } else if let Some(tab_id) = id.strip_prefix(HIDE_PREFIX) {
        spawn_command(
            app,
            &state.core,
            CoreCommand::EmbeddedTabHide {
                tab_id: tab_id.to_owned(),
            },
        );
    } else if let Some(tab_id) = id.strip_prefix(RELOAD_PREFIX) {
        if let Err(message) = state.runtime.reload_tab(tab_id) {
            reveal_menu_error(app, message);
        }
    } else if let Some(tab_id) = id.strip_prefix(STOP_PREFIX) {
        match state.runtime.preview_tab_close(tab_id) {
            Ok(intent) => {
                let app = app.clone();
                let core = std::sync::Arc::clone(&state.core);
                let runtime = std::sync::Arc::clone(&state.runtime);
                let tab_id = tab_id.to_owned();
                tauri::async_runtime::spawn(async move {
                    let result = core.invoke_async(intent.into_core_command()).await;
                    runtime.resolve_tab_close_preview(&tab_id, result.is_ok());
                    if let Err(error) = result {
                        crate::reveal_shell_error(&app, error.payload());
                    }
                });
            }
            Err(message) => reveal_menu_error(app, message),
        }
    } else if let Some(tab_id) = id.strip_prefix(MUTE_PREFIX) {
        let result = current_tab_muted(&state, tab_id)
            .and_then(|muted| state.runtime.set_tab_audio_muted(tab_id, !muted));
        if let Err(message) = result {
            reveal_menu_error(app, message);
        }
    } else if let Some(tab_id) = id.strip_prefix(MOVE_NEW_PREFIX) {
        let app = app.clone();
        let tab_id = tab_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let Some(state) = app.try_state::<crate::CoreState>() else {
                reveal_menu_error(&app, "runtime state is unavailable");
                return;
            };
            if let Err(error) =
                crate::move_game_window_tab_to_new_window(&app, &state, &tab_id, None).await
            {
                crate::reveal_shell_error(&app, error);
            }
        });
    } else if let Some(value) = id.strip_prefix(MOVE_PREFIX) {
        let Some((tab_id, window_id)) = value.rsplit_once(':') else {
            reveal_menu_error(app, "runtime move menu target is invalid");
            return true;
        };
        match crate::launch_target_for_game_window(app, window_id) {
            Ok(target) => spawn_command(
                app,
                &state.core,
                CoreCommand::EmbeddedTabMove {
                    tab_id: tab_id.to_owned(),
                    target,
                },
            ),
            Err(error) => crate::reveal_shell_error(app, error),
        }
    } else if let Some(value) = id.strip_prefix(LAUNCH_ROLE_PREFIX) {
        launch_from_menu(app, &state, value, false);
    } else if let Some(value) = id.strip_prefix(LAUNCH_WORKSPACE_PREFIX) {
        launch_from_menu(app, &state, value, true);
    }
    true
}

fn is_runtime_menu_event(id: &str) -> bool {
    [
        ACTIVATE_PREFIX,
        HIDE_PREFIX,
        LAUNCH_ROLE_PREFIX,
        LAUNCH_WORKSPACE_PREFIX,
        MOVE_PREFIX,
        MOVE_NEW_PREFIX,
        MUTE_PREFIX,
        RELOAD_PREFIX,
        STOP_PREFIX,
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
}

pub async fn handle_scoped_action(
    app: &AppHandle,
    state: &crate::CoreState,
    window_id: String,
    action: serde_json::Value,
) -> Result<(), String> {
    let action_type = action["type"]
        .as_str()
        .ok_or_else(|| "runtime tab action type is required".to_owned())?;
    let allowed_keys = match action_type {
        "activate" | "hide" | "stop" | "openTabMenu" => &["type", "tabId"][..],
        "move" => &["type", "tabId", "windowId"][..],
        "tabDragStart" => &["type", "sessionId", "tabId", "screenX", "screenY"][..],
        "tabDragMove" => &["type", "sessionId", "screenX", "screenY"][..],
        "tabDragDrop" => &["type", "sessionId", "windowId", "beforeTabId"][..],
        "tabDragEnd" => &["type", "sessionId", "cancelled"][..],
        "tabDragCancel" => &["type", "sessionId"][..],
        "reorder" => &["type", "tabId", "beforeTabId"][..],
        "openLauncher" | "fullscreenToolbarEnter" | "fullscreenToolbarLeave" => &["type"][..],
        "activateAdjacent" => &["type", "direction"][..],
        "applicationShortcut" => &["type", "command"][..],
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
    if crate::handle_game_window_tab_drag(app, state, &window_id, &action)
        .await
        .map_err(|error| error.message)?
    {
        return Ok(());
    }
    if action_type == "openLauncher" {
        return open_launcher(app, &window_id);
    }
    if action_type == "applicationShortcut" {
        let command = action["command"]
            .as_str()
            .and_then(crate::application_menu::ApplicationShortcutCommand::parse)
            .ok_or_else(|| "application shortcut command is invalid".to_owned())?;
        return crate::application_menu::execute_shortcut(
            app,
            state,
            command,
            crate::application_menu::ApplicationShortcutTarget::RuntimeWindow(&window_id),
        );
    }
    if matches!(
        action_type,
        "fullscreenToolbarEnter" | "fullscreenToolbarLeave"
    ) {
        return state
            .runtime
            .set_windows_toolbar_revealed(&window_id, action_type == "fullscreenToolbarEnter");
    }
    if action_type == "activateAdjacent" {
        let direction = action["direction"]
            .as_str()
            .filter(|value| matches!(*value, "next" | "previous"))
            .ok_or_else(|| "runtime tab direction is invalid".to_owned())?;
        let (target_tab_id, provisional) = state
            .runtime
            .preview_adjacent_tab_activation(&window_id, direction)?;
        if provisional {
            return Ok(());
        }
        return crate::commit_previewed_tab_selection(app, state, &window_id, &target_tab_id);
    }
    if action_type == "windowControl" {
        let control = action["control"]
            .as_str()
            .ok_or_else(|| "runtime window control is required".to_owned())?;
        let window = state
            .runtime
            .window_for_id(&window_id)
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
    if action_type == "stop" && state.runtime.cancel_provisional_tab_launch(tab_id) {
        return Ok(());
    }
    if action_type == "activate" {
        return crate::preview_and_commit_native_tab_selection(app, state, tab_id);
    }
    if action_type == "stop" {
        let intent = state.runtime.preview_tab_close(tab_id)?;
        let result = state.core.invoke_async(intent.into_core_command()).await;
        state
            .runtime
            .resolve_tab_close_preview(tab_id, result.is_ok());
        return result.map(|_| ()).map_err(|error| error.to_string());
    }
    let snapshot = snapshot(&state.core)?;
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| "runtime tab is outside this tab-strip WebView's window".to_owned())?;
    if action_type != "move" && tab.window_id != window_id {
        return Err("runtime tab is outside this tab-strip WebView's window".to_owned());
    }
    if action_type == "openTabMenu" {
        return open_tab(app, tab_id);
    }
    let command = match action_type {
        "hide" => CoreCommand::EmbeddedTabHide {
            tab_id: tab_id.to_owned(),
        },
        "move" => {
            let target_window_id = action["windowId"]
                .as_str()
                .ok_or_else(|| "target window ID is required".to_owned())?;
            if target_window_id != window_id {
                return Err("target window is outside this tab-strip WebView".to_owned());
            }
            let target = crate::launch_target_for_game_window(app, target_window_id)
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
                    .any(|candidate| candidate.id == before && candidate.window_id == window_id)
            {
                return Err("reorder target is outside this tab-strip WebView's display".to_owned());
            }
            CoreCommand::EmbeddedTabReorder {
                tab_id: tab.id.clone(),
                before_tab_id,
            }
        }
        _ => return Err("runtime tab action is invalid".to_owned()),
    };
    let result = state.core.invoke_async(command).await;
    result.map(|_| ()).map_err(|error| error.to_string())
}

fn launch_from_menu(app: &AppHandle, state: &crate::CoreState, value: &str, workspace: bool) {
    let Some((window_id, source_id)) = value.split_once(':') else {
        reveal_menu_error(app, "runtime launch menu target is invalid");
        return;
    };
    let target = match crate::launch_target_for_game_window(app, window_id) {
        Ok(target) => target,
        Err(error) => {
            crate::reveal_shell_error(app, error);
            return;
        }
    };
    let tab_type = if workspace { "workspace" } else { "role" };
    let source_id = source_id.to_owned();
    // The launcher menu belongs to an already-live game window. Commit its
    // provisional presentation before returning from the native menu action so
    // Tokio scheduling, Core work and controller creation cannot delay the tab.
    let preview = state
        .runtime
        .preview_tab_launch(&target, &source_id, tab_type)
        .ok();
    let app = app.clone();
    let core = std::sync::Arc::clone(&state.core);
    let runtime = std::sync::Arc::clone(&state.runtime);
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
        let result = core.invoke_async(command).await;
        if let Some(key) = preview {
            runtime.cancel_tab_launch_preview(&key);
        }
        if let Err(error) = result {
            crate::reveal_shell_error(&app, error.payload());
        }
    });
}

fn spawn_command(app: &AppHandle, core: &std::sync::Arc<rion_core::AppCore>, command: CoreCommand) {
    let app = app.clone();
    let core = std::sync::Arc::clone(core);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = core.invoke_async(command).await {
            crate::reveal_shell_error(&app, error.payload());
        }
    });
}

fn reveal_menu_error(app: &AppHandle, message: impl Into<String>) {
    crate::reveal_shell_error(
        app,
        rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_MENU_FAILED".to_owned(),
            message: message.into(),
        },
    );
}

fn current_tab_muted(state: &crate::CoreState, tab_id: &str) -> Result<bool, String> {
    let projection = state.runtime.projection(&snapshot(&state.core)?);
    projection["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"] == tab_id))
        .and_then(|tab| tab["audioMuted"].as_bool())
        .ok_or_else(|| "runtime tab audio state was not found".to_owned())
}

fn snapshot(core: &rion_core::AppCore) -> Result<BrowserRuntimeSnapshot, String> {
    core.invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}

struct Labels {
    hide: &'static str,
    loading: &'static str,
    move_to_window: &'static str,
    move_to_new_window: &'static str,
    mute: &'static str,
    no_roles: &'static str,
    no_workspaces: &'static str,
    reload: &'static str,
    roles: &'static str,
    stop: &'static str,
    unmute: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            hide: "隱藏分頁（保持運行）",
            loading: "正在準備角色與工作區…",
            move_to_window: "移至遊戲視窗",
            move_to_new_window: "移至新遊戲視窗",
            mute: "將分頁靜音",
            no_roles: "沒有角色",
            no_workspaces: "沒有工作區",
            reload: "重新整理",
            roles: "角色",
            stop: "停止並關閉",
            unmute: "取消分頁靜音",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            hide: "隐藏标签页（保持运行）",
            loading: "正在准备角色与工作区…",
            move_to_window: "移至游戏窗口",
            move_to_new_window: "移至新游戏窗口",
            mute: "将标签页静音",
            no_roles: "没有角色",
            no_workspaces: "没有工作区",
            reload: "重新加载",
            roles: "角色",
            stop: "停止并关闭",
            unmute: "取消标签页静音",
            workspaces: "工作区",
        },
        "ja" => Labels {
            hide: "タブを非表示（実行を継続）",
            loading: "ロールとワークスペースを準備中…",
            move_to_window: "ゲームウィンドウへ移動",
            move_to_new_window: "新しいゲームウィンドウへ移動",
            mute: "タブをミュート",
            no_roles: "ロールなし",
            no_workspaces: "ワークスペースなし",
            reload: "再読み込み",
            roles: "ロール",
            stop: "停止して閉じる",
            unmute: "タブのミュートを解除",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            hide: "Hide tab (keeps running)",
            loading: "Preparing roles and workspaces…",
            move_to_window: "Move to Game Window",
            move_to_new_window: "Move to New Game Window",
            mute: "Mute Tab",
            no_roles: "No Roles",
            no_workspaces: "No Workspaces",
            reload: "Reload",
            roles: "Roles",
            stop: "Stop and Close",
            unmute: "Unmute Tab",
            workspaces: "Workspaces",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_label_is_localized_for_every_supported_language() {
        for (language, expected) in [
            ("en", "Reload"),
            ("zh-TW", "重新整理"),
            ("zh-CN", "重新加载"),
            ("ja", "再読み込み"),
        ] {
            assert_eq!(labels(language).reload, expected, "{language}");
        }
    }

    #[test]
    fn launcher_loading_label_is_localized_for_every_supported_language() {
        for language in ["en", "zh-TW", "zh-CN", "ja"] {
            assert!(!labels(language).loading.is_empty(), "{language}");
        }
    }

    #[test]
    fn runtime_menu_events_are_recognized_before_app_state_resolution() {
        for id in [
            "runtime-tab-activate:tab-1",
            "runtime-tab-hide:tab-1",
            "runtime-tab-launch-role:window-1:role-1",
            "runtime-tab-launch-workspace:window-1:workspace-1",
            "runtime-tab-move:tab-1:window-2",
            "runtime-tab-move-new:tab-1",
            "runtime-tab-mute:tab-1",
            "runtime-tab-reload:tab-1",
            "runtime-tab-stop:tab-1",
        ] {
            assert!(is_runtime_menu_event(id), "{id}");
        }
        assert!(!is_runtime_menu_event("open-app"));
    }
}
