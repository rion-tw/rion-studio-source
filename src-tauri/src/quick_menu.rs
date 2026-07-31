use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    thread,
};

use rion_core::{AppCore, BrowserRuntimeSnapshot, CoreCommand};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(target_os = "windows")]
use tauri::{
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

#[cfg(target_os = "windows")]
const TRAY_ID: &str = "rion-quick-menu";
const ROLE_PREFIX: &str = "launch-role:";
const WORKSPACE_PREFIX: &str = "launch-workspace:";
const STOP_WORKSPACE_PREFIX: &str = "stop-workspace:";
const SHOW_DISPLAY_PREFIX: &str = "show-display:";
const RESTORE_WINDOW_PREFIX: &str = "restore-window:";

pub struct QuickMenu {
    #[cfg(target_os = "windows")]
    _tray: TrayIcon,
}

#[cfg(target_os = "windows")]
pub fn create(app: &AppHandle) -> Result<QuickMenu, String> {
    let menu = windows_menu(app, &starter_spec("en"))?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Rion Studio")
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
    builder
        .build(app)
        .map(|tray| QuickMenu { _tray: tray })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn create(_app: &AppHandle) -> Result<QuickMenu, String> {
    crate::quick_menu_macos::install(&[])?;
    Ok(QuickMenu {})
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn create(_app: &AppHandle) -> Result<QuickMenu, String> {
    Ok(QuickMenu {})
}

#[derive(Clone, Default)]
pub struct RefreshCoordinator {
    state: Arc<Mutex<RefreshState>>,
}

#[derive(Default)]
struct RefreshState {
    language: String,
    last_fingerprint: Option<String>,
    revision: u64,
    worker_running: bool,
}

struct MenuModel {
    game_windows: serde_json::Value,
    language: String,
    legal_accepted: bool,
    role_statuses: serde_json::Value,
    roles: serde_json::Value,
    running_window_ids: Vec<String>,
    workspace_statuses: serde_json::Value,
    workspaces: serde_json::Value,
}

impl RefreshCoordinator {
    /// Requests a coalesced refresh without ever reading Core state on AppKit's main thread.
    ///
    /// Core and SQLite snapshots are collected on one bounded worker. Only the already-built
    /// model is handed to the native event loop, so a busy runtime can delay the quick menu but
    /// can never stall a game-window tab selection.
    pub fn request(
        &self,
        app: AppHandle,
        core: Arc<AppCore>,
        runtime: Arc<crate::SystemRuntimeExecutor>,
        language: String,
    ) -> Result<(), String> {
        let should_spawn = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "quick-menu refresh coordinator lock poisoned".to_owned())?;
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
            .name("rion-quick-menu-model".to_owned())
            .spawn(move || coordinator.run_worker(app, core, runtime));
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    state.worker_running = false;
                }
                Err(error.to_string())
            }
        }
    }

    fn run_worker(
        &self,
        app: AppHandle,
        core: Arc<AppCore>,
        runtime: Arc<crate::SystemRuntimeExecutor>,
    ) {
        loop {
            // Quick-menu refresh is never launch-critical. Wait until presentation,
            // attach and close traffic has yielded before reading snapshots or
            // rebuilding an AppKit/Win32 native menu.
            runtime.wait_for_shell_idle();
            let (revision, language) = match self.state.lock() {
                Ok(state) => (state.revision, state.language.clone()),
                Err(_) => return,
            };
            let result = MenuModel::load(&core, language);
            let Ok(model) = result else {
                eprintln!(
                    "Rion Studio Quick Menu model refresh failed: {}",
                    result.err().unwrap_or_default()
                );
                if self.finish_or_retry(revision, None) {
                    return;
                }
                continue;
            };
            let fingerprint = model.fingerprint();
            let should_apply = match self.state.lock() {
                Ok(state) => {
                    state.revision == revision
                        && state.last_fingerprint.as_deref() != Some(fingerprint.as_str())
                }
                Err(_) => return,
            };
            if should_apply {
                let menu_app = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let result = apply_menu(&menu_app, &model);
                    if let Err(error) = result {
                        eprintln!("Rion Studio Quick Menu native refresh failed: {error}");
                    }
                });
            }
            if self.finish_or_retry(revision, should_apply.then_some(fingerprint)) {
                return;
            }
        }
    }

    fn finish_or_retry(&self, revision: u64, fingerprint: Option<String>) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return true;
        };
        if state.revision != revision {
            return false;
        }
        if let Some(fingerprint) = fingerprint {
            state.last_fingerprint = Some(fingerprint);
        }
        state.worker_running = false;
        true
    }
}

impl MenuModel {
    fn load(core: &AppCore, language: String) -> Result<Self, String> {
        let game_windows = core
            .invoke(CoreCommand::GameWindowsList)
            .map_err(|error| error.to_string())?;
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
        let mut running_window_ids = core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .ok()
            .and_then(|value| serde_json::from_value::<BrowserRuntimeSnapshot>(value).ok())
            .map(|snapshot| {
                snapshot
                    .windows
                    .into_iter()
                    .map(|window| window.window_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        running_window_ids.sort();
        Ok(Self {
            game_windows,
            language,
            legal_accepted,
            role_statuses,
            roles,
            running_window_ids,
            workspace_statuses,
            workspaces,
        })
    }

    fn fingerprint(&self) -> String {
        serde_json::to_string(&serde_json::json!({
            "gameWindows": self.game_windows,
            "language": self.language,
            "legalAccepted": self.legal_accepted,
            "roleStatuses": self.role_statuses,
            "roles": self.roles,
            "runningWindowIds": self.running_window_ids,
            "workspaceStatuses": self.workspace_statuses,
            "workspaces": self.workspaces,
        }))
        .unwrap_or_default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuickMenuPlatform {
    #[cfg(any(target_os = "macos", test))]
    Macos,
    #[cfg(any(target_os = "windows", test))]
    Windows,
}

impl QuickMenuPlatform {
    #[cfg(any(target_os = "windows", test))]
    fn is_windows(self) -> bool {
        matches!(self, Self::Windows)
    }

    #[cfg(not(any(target_os = "windows", test)))]
    fn is_windows(self) -> bool {
        false
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MenuEntry {
    Item {
        id: String,
        text: String,
        enabled: bool,
    },
    Submenu {
        text: String,
        items: Vec<MenuEntry>,
    },
    Separator,
}

#[cfg(target_os = "windows")]
fn starter_spec(language: &str) -> Vec<MenuEntry> {
    let labels = labels(language);
    vec![
        item("open-app", labels.open, true),
        MenuEntry::Separator,
        item("quit-app", labels.quit, true),
    ]
}

fn menu_spec(model: &MenuModel, platform: QuickMenuPlatform) -> Vec<MenuEntry> {
    let labels = labels(&model.language);
    let roles = &model.roles;
    let workspaces = &model.workspaces;
    let role_statuses = &model.role_statuses;
    let workspace_statuses = &model.workspace_statuses;
    let legal_accepted = model.legal_accepted;
    let role_state = |id: &str| status_state(role_statuses, "roleId", id);
    let workspace_state = |id: &str| status_state(workspace_statuses, "workspaceId", id);
    let mut role_items = Vec::new();
    let role_values = roles.as_array().cloned().unwrap_or_default();
    let role_ids = role_values
        .iter()
        .filter_map(|role| role["id"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    if role_values.is_empty() {
        role_items.push(item("no-roles", labels.no_roles, false));
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
                role_items.push(item(
                    format!("{ROLE_PREFIX}{id}"),
                    format!("{marker}{name}"),
                    legal_accepted && !busy,
                ));
            }
        }
    }
    let mut workspace_items = Vec::new();
    let workspace_values = workspaces.as_array().cloned().unwrap_or_default();
    if workspace_values.is_empty() {
        workspace_items.push(item("no-workspaces", labels.no_workspaces, false));
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
                workspace_items.push(item(
                    format!("{prefix}{id}"),
                    format!("{marker}{name}"),
                    legal_accepted
                        && (running || (!busy && !assigned_role_ids.is_empty() && !missing_role)),
                ));
            }
        }
    }
    let running_window_ids = model
        .running_window_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut window_items = Vec::new();
    for window in model.game_windows.as_array().cloned().unwrap_or_default() {
        let (Some(id), Some(name)) = (window["id"].as_str(), window["name"].as_str()) else {
            continue;
        };
        let running = running_window_ids.contains(id);
        window_items.push(item(
            format!(
                "{}{id}",
                if running {
                    SHOW_DISPLAY_PREFIX
                } else {
                    RESTORE_WINDOW_PREFIX
                }
            ),
            format!("{}{name}", if running { "✓ " } else { "" }),
            running || legal_accepted,
        ));
    }
    if window_items.is_empty() {
        window_items.push(item("no-windows", labels.no_windows, false));
    }

    let mut entries = Vec::new();
    if platform.is_windows() {
        entries.push(item("open-app", labels.open, true));
    }
    if !legal_accepted {
        entries.push(item("review-terms", labels.review_terms, true));
    }
    entries.push(MenuEntry::Submenu {
        text: labels.roles.to_owned(),
        items: role_items,
    });
    entries.push(MenuEntry::Submenu {
        text: labels.workspaces.to_owned(),
        items: workspace_items,
    });
    entries.push(MenuEntry::Submenu {
        text: labels.windows.to_owned(),
        items: window_items,
    });
    if role_statuses
        .as_array()
        .is_some_and(|items| !items.is_empty())
    {
        entries.push(MenuEntry::Separator);
        entries.push(item("stop-all", labels.stop_all, true));
    }
    if platform.is_windows() {
        entries.push(MenuEntry::Separator);
        entries.push(item("quit-app", labels.quit, true));
    }
    entries
}

fn item(id: impl Into<String>, text: impl Into<String>, enabled: bool) -> MenuEntry {
    MenuEntry::Item {
        id: id.into(),
        text: text.into(),
        enabled,
    }
}

#[cfg(target_os = "windows")]
fn windows_menu(app: &AppHandle, entries: &[MenuEntry]) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for entry in entries {
        append_windows_root_entry(app, &menu, entry)?;
    }
    Ok(menu)
}

#[cfg(target_os = "windows")]
fn append_windows_root_entry(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    entry: &MenuEntry,
) -> Result<(), String> {
    match entry {
        MenuEntry::Item { id, text, enabled } => {
            let item = MenuItemBuilder::with_id(id, text)
                .enabled(*enabled)
                .build(app)
                .map_err(|error| error.to_string())?;
            menu.append(&item).map_err(|error| error.to_string())
        }
        MenuEntry::Submenu { text, items } => {
            let submenu = windows_submenu(app, text, items)?;
            menu.append(&submenu).map_err(|error| error.to_string())
        }
        MenuEntry::Separator => {
            let separator =
                PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
            menu.append(&separator).map_err(|error| error.to_string())
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_submenu(
    app: &AppHandle,
    text: &str,
    entries: &[MenuEntry],
) -> Result<Submenu<tauri::Wry>, String> {
    let menu = Submenu::new(app, text, true).map_err(|error| error.to_string())?;
    for entry in entries {
        match entry {
            MenuEntry::Item { id, text, enabled } => {
                let item = MenuItemBuilder::with_id(id, text)
                    .enabled(*enabled)
                    .build(app)
                    .map_err(|error| error.to_string())?;
                menu.append(&item).map_err(|error| error.to_string())?;
            }
            MenuEntry::Submenu { text, items } => {
                let submenu = windows_submenu(app, text, items)?;
                menu.append(&submenu).map_err(|error| error.to_string())?;
            }
            MenuEntry::Separator => {
                let separator =
                    PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
                menu.append(&separator).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(menu)
}

fn apply_menu(app: &AppHandle, model: &MenuModel) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let entries = menu_spec(model, QuickMenuPlatform::Windows);
        let menu = windows_menu(app, &entries)?;
        let tray = app
            .tray_by_id(TRAY_ID)
            .ok_or_else(|| "Rion Studio Quick Menu is unavailable.".to_owned())?;
        tray.set_menu(Some(menu)).map_err(|error| error.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let entries = menu_spec(model, QuickMenuPlatform::Macos);
        crate::quick_menu_macos::install(&entries)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, model);
        Ok(())
    }
}

pub fn handle_event(app: &AppHandle, id: &str) -> bool {
    if !is_quick_menu_action(id) {
        return false;
    }
    match id {
        "open-app" | "review-terms" => {
            show_main_window(app);
            return true;
        }
        "quit-app" => {
            app.exit(0);
            return true;
        }
        _ => {}
    }
    if let Some(state) = app.try_state::<crate::CoreState>() {
        handle_menu_event(app, &state.core, id);
    }
    true
}

fn is_quick_menu_action(id: &str) -> bool {
    matches!(
        id,
        "open-app" | "review-terms" | "restore-windows" | "quit-app" | "stop-all"
    ) || [
        SHOW_DISPLAY_PREFIX,
        RESTORE_WINDOW_PREFIX,
        STOP_WORKSPACE_PREFIX,
        ROLE_PREFIX,
        WORKSPACE_PREFIX,
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
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
            let runtime = Arc::clone(&state.runtime);
            let core = Arc::clone(core);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Native menu events run on the main thread. Never wait there for the
                // native creation lane or a host-window callback.
                let preview_runtime = Arc::clone(&runtime);
                let preview_target = target.clone();
                let preview_source_id = source_id.clone();
                let preview = tauri::async_runtime::spawn_blocking(move || {
                    preview_runtime.preview_tab_launch(
                        &preview_target,
                        &preview_source_id,
                        if workspace { "workspace" } else { "role" },
                    )
                })
                .await
                .ok()
                .and_then(Result::ok);
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

#[derive(Clone, Copy)]
struct Labels {
    no_roles: &'static str,
    no_windows: &'static str,
    no_workspaces: &'static str,
    open: &'static str,
    quit: &'static str,
    review_terms: &'static str,
    roles: &'static str,
    stop_all: &'static str,
    windows: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            no_roles: "沒有角色",
            no_windows: "沒有視窗",
            no_workspaces: "沒有工作區",
            open: "開啟 Rion Studio",
            quit: "結束 Rion Studio",
            review_terms: "啟動前請先檢閱條款",
            roles: "角色",
            stop_all: "停止所有執行中的角色",
            windows: "視窗",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            no_roles: "没有角色",
            no_windows: "没有窗口",
            no_workspaces: "没有工作区",
            open: "打开 Rion Studio",
            quit: "退出 Rion Studio",
            review_terms: "启动前请先查看条款",
            roles: "角色",
            stop_all: "停止所有运行中的角色",
            windows: "窗口",
            workspaces: "工作区",
        },
        "ja" => Labels {
            no_roles: "ロールなし",
            no_windows: "ウインドウなし",
            no_workspaces: "ワークスペースなし",
            open: "Rion Studio を開く",
            quit: "Rion Studio を終了",
            review_terms: "起動前に利用規約を確認",
            roles: "ロール",
            stop_all: "実行中のロールをすべて停止",
            windows: "ウインドウ",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            no_roles: "No Roles",
            no_windows: "No Windows",
            no_workspaces: "No Workspaces",
            open: "Open Rion Studio",
            quit: "Quit Rion Studio",
            review_terms: "Review terms before launching",
            roles: "Roles",
            stop_all: "Stop All Running Roles",
            windows: "Windows",
            workspaces: "Workspaces",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn populated_model(language: &str, legal_accepted: bool) -> MenuModel {
        MenuModel {
            game_windows: serde_json::json!([{
                "id": "active-window",
                "name": "Running Saved Window",
            }, {
                "id": "saved-window",
                "name": "Dormant Saved Window",
            }]),
            language: language.to_owned(),
            legal_accepted,
            role_statuses: serde_json::json!([
                {"roleId":"role-running","state":"running"},
                {"roleId":"role-busy","state":"launching"}
            ]),
            roles: serde_json::json!([
                {"id":"role-running","name":"Running Role"},
                {"id":"role-busy","name":"Busy Role"}
            ]),
            running_window_ids: vec!["active-window".to_owned(), "unsaved-window".to_owned()],
            workspace_statuses: serde_json::json!([
                {"workspaceId":"workspace-running","state":"running"},
                {"workspaceId":"workspace-busy","state":"launching"}
            ]),
            workspaces: serde_json::json!([
                {
                    "id":"workspace-running",
                    "name":"Running Workspace",
                    "slots":[{"roleId":"role-running"}]
                }, {
                    "id":"workspace-ready",
                    "name":"Ready Workspace",
                    "slots":[{"roleId":"role-running"}]
                }, {
                    "id":"workspace-busy",
                    "name":"Busy Workspace",
                    "slots":[{"roleId":"role-running"}]
                }, {
                    "id":"workspace-missing",
                    "name":"Missing Workspace",
                    "slots":[{"roleId":"missing-role"}]
                }
            ]),
        }
    }

    fn root_item<'a>(entries: &'a [MenuEntry], id: &str) -> Option<&'a MenuEntry> {
        entries
            .iter()
            .find(|entry| matches!(entry, MenuEntry::Item { id: entry_id, .. } if entry_id == id))
    }

    fn submenu<'a>(entries: &'a [MenuEntry], text: &str) -> &'a [MenuEntry] {
        entries
            .iter()
            .find_map(|entry| match entry {
                MenuEntry::Submenu {
                    text: entry_text,
                    items,
                } if entry_text == text => Some(items.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing submenu {text}"))
    }

    fn assert_item(entry: &MenuEntry, expected_text: &str, expected_enabled: bool) {
        let MenuEntry::Item { text, enabled, .. } = entry else {
            panic!("expected menu item, got {entry:?}");
        };
        assert_eq!(text, expected_text);
        assert_eq!(*enabled, expected_enabled);
    }

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

    #[test]
    fn quick_menu_fingerprint_tracks_menu_inputs() {
        let ready = populated_model("en", true);
        let mut busy = populated_model("en", true);
        busy.role_statuses = serde_json::json!([{"roleId":"role-running","state":"launching"}]);

        assert_ne!(ready.fingerprint(), busy.fingerprint());
    }

    #[test]
    fn platform_specs_keep_open_and_quit_windows_only() {
        let model = populated_model("en", true);
        let windows = menu_spec(&model, QuickMenuPlatform::Windows);
        let macos = menu_spec(&model, QuickMenuPlatform::Macos);

        assert!(root_item(&windows, "open-app").is_some());
        assert!(root_item(&windows, "quit-app").is_some());
        assert!(root_item(&macos, "open-app").is_none());
        assert!(root_item(&macos, "quit-app").is_none());
    }

    #[test]
    fn platform_specs_list_only_saved_windows_and_check_running_ones() {
        let model = populated_model("en", true);
        for platform in [QuickMenuPlatform::Macos, QuickMenuPlatform::Windows] {
            let entries = menu_spec(&model, platform);
            let windows = submenu(&entries, "Windows");
            for id in ["show-display:active-window", "restore-window:saved-window"] {
                assert!(
                    root_item(&entries, id).is_none(),
                    "window action must not remain at the menu root: {id}"
                );
            }
            assert_item(
                root_item(windows, "show-display:active-window").unwrap(),
                "✓ Running Saved Window",
                true,
            );
            assert_item(
                root_item(windows, "restore-window:saved-window").unwrap(),
                "Dormant Saved Window",
                true,
            );
            assert!(root_item(windows, "show-display:unsaved-window").is_none());
            assert!(root_item(windows, "show-games").is_none());
            assert_eq!(windows.len(), 2);
            assert_eq!(submenu(&entries, "Roles").len(), 2);
            assert_eq!(submenu(&entries, "Workspaces").len(), 4);
        }
    }

    #[test]
    fn role_and_workspace_submenus_preserve_busy_missing_and_stop_rules() {
        let entries = menu_spec(&populated_model("en", true), QuickMenuPlatform::Windows);
        let roles = submenu(&entries, "Roles");
        let workspaces = submenu(&entries, "Workspaces");

        assert_item(
            root_item(roles, "launch-role:role-running").unwrap(),
            "✓ Running Role",
            true,
        );
        assert_item(
            root_item(roles, "launch-role:role-busy").unwrap(),
            "… Busy Role",
            false,
        );
        assert_item(
            root_item(workspaces, "stop-workspace:workspace-running").unwrap(),
            "✓ Running Workspace",
            true,
        );
        assert_item(
            root_item(workspaces, "launch-workspace:workspace-ready").unwrap(),
            "Ready Workspace",
            true,
        );
        assert_item(
            root_item(workspaces, "launch-workspace:workspace-busy").unwrap(),
            "… Busy Workspace",
            false,
        );
        assert_item(
            root_item(workspaces, "launch-workspace:workspace-missing").unwrap(),
            "Missing Workspace",
            false,
        );
    }

    #[test]
    fn legal_gate_disables_launch_and_restore_actions_but_keeps_running_saved_windows_visible() {
        let entries = menu_spec(&populated_model("en", false), QuickMenuPlatform::Macos);

        assert!(root_item(&entries, "review-terms").is_some());
        assert_item(
            root_item(submenu(&entries, "Roles"), "launch-role:role-running").unwrap(),
            "✓ Running Role",
            false,
        );
        assert_item(
            root_item(
                submenu(&entries, "Workspaces"),
                "stop-workspace:workspace-running",
            )
            .unwrap(),
            "✓ Running Workspace",
            false,
        );
        assert!(matches!(
            root_item(submenu(&entries, "Windows"), "show-display:active-window"),
            Some(MenuEntry::Item { enabled: true, .. })
        ));
        assert!(matches!(
            root_item(submenu(&entries, "Windows"), "restore-window:saved-window"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
    }

    #[test]
    fn empty_role_workspace_and_window_states_are_disabled() {
        let model = MenuModel {
            game_windows: serde_json::json!([]),
            language: "en".to_owned(),
            legal_accepted: true,
            role_statuses: serde_json::json!([]),
            roles: serde_json::json!([]),
            running_window_ids: vec![],
            workspace_statuses: serde_json::json!([]),
            workspaces: serde_json::json!([]),
        };
        let entries = menu_spec(&model, QuickMenuPlatform::Windows);

        assert!(matches!(
            root_item(submenu(&entries, "Roles"), "no-roles"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
        assert!(matches!(
            root_item(submenu(&entries, "Workspaces"), "no-workspaces"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
        assert!(matches!(
            root_item(submenu(&entries, "Windows"), "no-windows"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
    }

    #[test]
    fn four_supported_languages_keep_submenu_labels() {
        let cases = [
            ("en", "Roles", "Workspaces", "Windows"),
            ("zh-TW", "角色", "工作區", "視窗"),
            ("zh-CN", "角色", "工作区", "窗口"),
            ("ja", "ロール", "ワークスペース", "ウインドウ"),
        ];

        for (language, roles, workspaces, windows) in cases {
            let labels = labels(language);
            assert_eq!(labels.roles, roles);
            assert_eq!(labels.workspaces, workspaces);
            assert_eq!(labels.windows, windows);
        }
    }

    #[test]
    fn quick_menu_routing_claims_only_its_own_global_menu_events() {
        for id in [
            "open-app",
            "quit-app",
            "launch-role:role:with:colons",
            "launch-workspace:workspace/opaque",
            "stop-workspace:workspace/opaque",
            "show-display:window/opaque",
            "restore-window:window/opaque",
        ] {
            assert!(is_quick_menu_action(id), "quick-menu event {id}");
        }
        for id in [
            "show-games",
            "rion-new-game-window",
            "rion-browser-zoom-in",
            "rion-show-game-window:window/opaque",
            "unknown-menu-item",
        ] {
            assert!(!is_quick_menu_action(id), "application menu event {id}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_dock_adapter_passes_its_selector_self_test() {
        assert!(crate::quick_menu_macos::native_adapter_self_test());
    }
}
