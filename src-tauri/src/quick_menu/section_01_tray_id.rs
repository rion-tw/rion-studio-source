use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use rion_core::{AppCore, CoreCommand};
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
    let menu = windows_menu(app, &starter_spec("en", QuickMenuPlatform::Windows))?;
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
    crate::quick_menu_macos::install(&starter_spec("en", QuickMenuPlatform::Macos))?;
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
    transient_windows: Vec<(String, String)>,
    open_workspace_ids: Vec<String>,
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
            let result = MenuModel::load(&core, &runtime, language);
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
    fn load(
        core: &AppCore,
        runtime: &crate::SystemRuntimeExecutor,
        language: String,
    ) -> Result<Self, String> {
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
        let presence = runtime.launcher_presence_snapshot()?;
        let mut open_workspace_ids = presence
            .tabs
            .iter()
            .filter(|tab| tab.tab_type == "workspace")
            .map(|tab| tab.source_id.clone())
            .collect::<Vec<_>>();
        open_workspace_ids.sort();
        open_workspace_ids.dedup();
        let mut running_window_ids = presence
            .windows
            .iter()
            .map(|window| window.window_id.clone())
            .collect::<Vec<_>>();
        running_window_ids.sort();
        let mut transient_windows = presence
            .windows
            .into_iter()
            .filter(|window| !window.persisted)
            .map(|window| (window.window_id, window.title))
            .collect::<Vec<_>>();
        transient_windows.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(Self {
            game_windows,
            language,
            legal_accepted,
            role_statuses,
            roles,
            running_window_ids,
            transient_windows,
            open_workspace_ids,
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
            "transientWindows": self.transient_windows,
            "openWorkspaceIds": self.open_workspace_ids,
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

fn starter_spec(language: &str, platform: QuickMenuPlatform) -> Vec<MenuEntry> {
    let labels = labels(language);
    let mut entries = vec![item("open-app", labels.open, true)];
    if platform.is_windows() {
        entries.push(MenuEntry::Separator);
        entries.push(item("quit-app", labels.quit, true));
    }
    entries
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
    let open_workspace_ids = model
        .open_workspace_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
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
                // Opening/stopping presentation is owned by the live tab store.
                // A delayed Core workspace status may describe role lifecycle,
                // but it must never turn a visible tab into an "open" or "closed"
                // menu action.
                let running = open_workspace_ids.contains(id);
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
    for (window_id, title) in &model.transient_windows {
        window_items.push(item(
            format!("{SHOW_DISPLAY_PREFIX}{window_id}"),
            format!("✓ {title} · {}", labels.temporary_window),
            true,
        ));
    }
    if window_items.is_empty() {
        window_items.push(item("no-windows", labels.no_windows, false));
    }

    let mut entries = vec![item("open-app", labels.open, true)];
    if !legal_accepted {
        entries.push(item("review-terms", labels.review_terms, true));
    }
    entries.push(MenuEntry::Separator);
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
