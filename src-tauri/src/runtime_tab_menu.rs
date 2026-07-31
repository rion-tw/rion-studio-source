use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};

use rion_core::{
    AppCore, BrowserRuntimeSnapshot, CoreCommand, EmbeddedLaunchTargetRecord, LogCaptureRecord,
    LogErrorDetails, LogLevel, LogSource, StateGameWindowRecord,
};
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
const SAVE_WINDOW_PREFIX: &str = "runtime-window-save:";
const STOP_PREFIX: &str = "runtime-tab-stop:";
const LAUNCH_INTENT_CAPACITY: usize = 64;
const MAX_CONCURRENT_LAUNCH_INTENTS: usize = 4;
const TAB_MENU_INTENT_CAPACITY: usize = 16;
const MAX_CONCURRENT_TAB_MENU_MODELS: usize = 2;

struct LaunchIntent {
    action_started: Instant,
    native_action_at: String,
    preview_committed_at: String,
    preview_committed_ms: u64,
    preview_key: String,
    source_id: String,
    target: EmbeddedLaunchTargetRecord,
    workspace: bool,
}

struct TabMenuIntent {
    language: String,
    muted: bool,
    tab_id: String,
    window: Window,
}

#[derive(Clone)]
pub(crate) struct LaunchIntentDispatcher {
    sender: tokio::sync::mpsc::Sender<LaunchIntent>,
    tab_menu_sender: tokio::sync::mpsc::Sender<TabMenuIntent>,
}

impl LaunchIntentDispatcher {
    pub(crate) fn start(
        app: AppHandle,
        core: Arc<AppCore>,
        runtime: Arc<crate::system_runtime::SystemRuntimeExecutor>,
    ) -> Self {
        let (sender, mut receiver) =
            tokio::sync::mpsc::channel::<LaunchIntent>(LAUNCH_INTENT_CAPACITY);
        let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_LAUNCH_INTENTS));
        let launch_app = app.clone();
        let launch_core = Arc::clone(&core);
        tauri::async_runtime::spawn(async move {
            while let Some(intent) = receiver.recv().await {
                let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
                    break;
                };
                let app = launch_app.clone();
                let core = Arc::clone(&launch_core);
                let runtime = Arc::clone(&runtime);
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let core_queue_ms = intent
                        .action_started
                        .elapsed()
                        .as_millis()
                        .min(u64::MAX as u128) as u64;
                    let core_started = Instant::now();
                    let command = if intent.workspace {
                        CoreCommand::BrowserWorkspaceLaunch {
                            workspace_id: intent.source_id.clone(),
                            target: intent.target.clone(),
                        }
                    } else {
                        CoreCommand::BrowserRoleLaunch {
                            role_id: intent.source_id.clone(),
                            target: intent.target.clone(),
                            zoom_factor: None,
                        }
                    };
                    let result = core.invoke_async(command).await;
                    let error = result.as_ref().err().map(|error| error.payload());
                    capture_launch_intent_event(
                        Arc::clone(&core),
                        &intent,
                        result.is_ok(),
                        core_queue_ms,
                        core_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                        error.as_ref(),
                    );
                    if let Err(error) = result {
                        runtime.fail_tab_launch_preview(&intent.preview_key);
                        crate::reveal_shell_error(&app, error.payload());
                    }
                });
            }
        });

        let (tab_menu_sender, mut tab_menu_receiver) =
            tokio::sync::mpsc::channel::<TabMenuIntent>(TAB_MENU_INTENT_CAPACITY);
        let tab_menu_permits =
            Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_TAB_MENU_MODELS));
        tauri::async_runtime::spawn(async move {
            while let Some(intent) = tab_menu_receiver.recv().await {
                let Ok(permit) = Arc::clone(&tab_menu_permits).acquire_owned().await else {
                    break;
                };
                let app = app.clone();
                let core = Arc::clone(&core);
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let model = tauri::async_runtime::spawn_blocking(move || {
                        let snapshot = snapshot(&core)?;
                        let game_windows = core
                            .invoke(CoreCommand::GameWindowsList)
                            .map_err(|error| error.to_string())?;
                        Ok::<_, String>((snapshot, game_windows))
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result);
                    match model {
                        Ok((snapshot, game_windows)) => {
                            let menu_app = app.clone();
                            let error_app = app.clone();
                            if let Err(error) = app.run_on_main_thread(move || {
                                if let Err(message) = open_tab_from_model(
                                    &menu_app,
                                    &intent.tab_id,
                                    &intent.language,
                                    intent.muted,
                                    &snapshot,
                                    &game_windows,
                                    intent.window,
                                ) {
                                    reveal_menu_error(&menu_app, message);
                                }
                            }) {
                                reveal_menu_error(
                                    &error_app,
                                    format!("runtime tab menu could not be queued: {error}"),
                                );
                            }
                        }
                        Err(message) => reveal_menu_error(&app, message),
                    }
                });
            }
        });
        Self {
            sender,
            tab_menu_sender,
        }
    }

    fn try_launch(&self, intent: LaunchIntent) -> Result<(), String> {
        self.sender.try_send(intent).map_err(|error| match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => {
                "The background launch queue is full. Close or wait for an existing launch before retrying."
                    .to_owned()
            }
            tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                "The background launch queue is unavailable.".to_owned()
            }
        })
    }

    fn try_open_tab_menu(&self, intent: TabMenuIntent) -> Result<(), String> {
        self.tab_menu_sender
            .try_send(intent)
            .map_err(|error| match error {
                tokio::sync::mpsc::error::TrySendError::Full(_) => {
                    "The background tab menu queue is full.".to_owned()
                }
                tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                    "The background tab menu queue is unavailable.".to_owned()
                }
            })
    }
}

fn capture_launch_intent_event(
    core: Arc<AppCore>,
    intent: &LaunchIntent,
    accepted: bool,
    core_queue_ms: u64,
    core_invoke_ms: u64,
    error: Option<&rion_core::CoreErrorPayload>,
) {
    let context = serde_json::json!({
        "coreInvokeMs": core_invoke_ms,
        "coreQueueMs": core_queue_ms,
        "launchAcceptedMs": intent.action_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        "nativeActionAt": intent.native_action_at,
        "nativeActionMs": intent.preview_committed_ms,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "previewCommittedAt": intent.preview_committed_at,
        "previewCommittedMs": intent.preview_committed_ms,
        "sourceId": intent.source_id,
        "sourceType": if intent.workspace { "workspace" } else { "role" },
        "windowId": intent.target.window_id,
    });
    let error = error.map(|error| LogErrorDetails {
        name: error.code.clone(),
        message: error.message.clone(),
        stack: None,
        cause: None,
    });
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level: if accepted {
                        LogLevel::Info
                    } else {
                        LogLevel::Error
                    },
                    source: LogSource::Browser,
                    event: if accepted {
                        "tab.launch-accepted"
                    } else {
                        "tab.launch-rejected"
                    }
                    .to_owned(),
                    message: if accepted {
                        "The provisional tab launch was accepted for background settlement."
                    } else {
                        "The provisional tab launch was rejected before background settlement."
                    }
                    .to_owned(),
                    context_raw_json: serde_json::to_string(&context).ok(),
                    error,
                }],
            })
            .await;
    });
}

#[derive(Clone, Default)]
pub(crate) struct RefreshCoordinator {
    state: Arc<Mutex<RefreshState>>,
}

#[derive(Default)]
struct RefreshState {
    catalog: Option<LauncherCatalog>,
    catalog_applied_revision: u64,
    catalog_requested_revision: u64,
    catalog_worker_running: bool,
    language: String,
    loading_menu: Option<Menu<tauri::Wry>>,
    menus: HashMap<String, Menu<tauri::Wry>>,
    presence: crate::system_runtime::RuntimeLauncherPresence,
    presence_revision: u64,
    registered_window_ids: HashSet<String>,
    saving_window_ids: HashSet<String>,
}

#[derive(Clone)]
struct LauncherCatalog {
    game_windows: serde_json::Value,
    language: String,
    roles: serde_json::Value,
    workspaces: serde_json::Value,
}

#[derive(Clone)]
struct LauncherMenuModel {
    catalog: LauncherCatalog,
    presence: crate::system_runtime::RuntimeLauncherPresence,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LauncherMenuRevision {
    catalog: u64,
    presence: u64,
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
            state.catalog_requested_revision =
                state.catalog_requested_revision.wrapping_add(1).max(1);
            state.language = language;
            if state.catalog_worker_running {
                false
            } else {
                state.catalog_worker_running = true;
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
                state.catalog_worker_running = false;
            }
            return Err(error.to_string());
        }
        Ok(())
    }

    fn run(&self, app: AppHandle, core: Arc<AppCore>) {
        loop {
            let (revision, language) = match self.state.lock() {
                Ok(state) => (state.catalog_requested_revision, state.language.clone()),
                Err(_) => return,
            };
            match LauncherCatalog::load(&core, language) {
                Ok(catalog) => {
                    let coordinator = self.clone();
                    let menu_app = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        coordinator.apply_catalog(&menu_app, revision, catalog);
                    }) {
                        eprintln!("Runtime launcher native refresh could not be queued: {error}");
                    }
                }
                Err(error) => eprintln!("Runtime launcher model refresh failed: {error}"),
            }
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.catalog_requested_revision != revision {
                continue;
            }
            state.catalog_worker_running = false;
            return;
        }
    }

    fn apply_catalog(&self, app: &AppHandle, revision: u64, catalog: LauncherCatalog) {
        let desired = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.catalog_requested_revision != revision {
                return;
            }
            state.loading_menu = launcher_loading_menu(app, &catalog.language).ok();
            state.catalog_applied_revision = revision;
            state.catalog = Some(catalog);
            desired_launcher_model(&state)
        };
        if let Some((revision, model)) = desired {
            self.rebuild(app, revision, model);
        }
    }

    pub(crate) fn update_presence(
        &self,
        app: &AppHandle,
        presence: crate::system_runtime::RuntimeLauncherPresence,
    ) -> Result<(), String> {
        let desired = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
            if state.presence == presence {
                return Ok(());
            }
            state.presence = presence;
            state.presence_revision = state.presence_revision.wrapping_add(1).max(1);
            desired_launcher_model(&state)
        };
        let Some((revision, model)) = desired else {
            return Ok(());
        };
        let coordinator = self.clone();
        let menu_app = app.clone();
        app.run_on_main_thread(move || coordinator.rebuild(&menu_app, revision, model))
            .map_err(|error| error.to_string())
    }

    pub(crate) fn request_presence(
        &self,
        app: AppHandle,
        runtime: Arc<crate::system_runtime::SystemRuntimeExecutor>,
    ) {
        let coordinator = self.clone();
        tauri::async_runtime::spawn(async move {
            let presence =
                tauri::async_runtime::spawn_blocking(move || runtime.launcher_presence_snapshot())
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result);
            match presence {
                Ok(presence) => {
                    if let Err(error) = coordinator.update_presence(&app, presence) {
                        eprintln!("Runtime launcher presence repair could not be queued: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("Runtime launcher presence repair failed: {error}");
                }
            }
        });
    }

    fn rebuild(&self, app: &AppHandle, revision: LauncherMenuRevision, model: LauncherMenuModel) {
        let window_ids = match self.state.lock() {
            Ok(state) if desired_launcher_revision(&state) == Some(revision) => state
                .registered_window_ids
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            _ => return,
        };
        let menus = window_ids
            .iter()
            .filter_map(|window_id| match launcher_menu(app, &model, window_id) {
                Ok(menu) => Some((window_id.clone(), menu)),
                Err(error) => {
                    eprintln!(
                        "Runtime launcher menu refresh failed for window {window_id}: {error}"
                    );
                    None
                }
            })
            .collect::<HashMap<_, _>>();
        let prepared_window_ids = window_ids.iter().cloned().collect::<HashSet<_>>();
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if desired_launcher_revision(&state) != Some(revision) {
            return;
        }
        for window_id in &window_ids {
            if !state.registered_window_ids.contains(window_id) {
                state.menus.remove(window_id);
            } else if let Some(menu) = menus.get(window_id) {
                state.menus.insert(window_id.clone(), menu.clone());
            } else {
                state.menus.remove(window_id);
            }
        }
        let late_window_ids = state
            .registered_window_ids
            .difference(&prepared_window_ids)
            .cloned()
            .collect::<Vec<_>>();
        drop(state);
        for window_id in late_window_ids {
            self.install_window_menu(app, revision, model.clone(), window_id);
        }
    }

    pub(crate) fn register_window(&self, app: &AppHandle, window_id: &str) -> Result<(), String> {
        let desired = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
            if !state.registered_window_ids.insert(window_id.to_owned()) {
                return Ok(());
            }
            desired_launcher_model(&state)
        };
        let Some((revision, model)) = desired else {
            return Ok(());
        };
        let coordinator = self.clone();
        let menu_app = app.clone();
        let window_id = window_id.to_owned();
        app.run_on_main_thread(move || {
            coordinator.install_window_menu(&menu_app, revision, model, window_id);
        })
        .map_err(|error| error.to_string())
    }

    pub(crate) fn unregister_window(&self, window_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.registered_window_ids.remove(window_id);
            state.menus.remove(window_id);
        }
    }

    fn begin_save(&self, window_id: &str) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
        Ok(state.saving_window_ids.insert(window_id.to_owned()))
    }

    fn finish_save(&self, window_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.saving_window_ids.remove(window_id);
        }
    }

    fn install_window_menu(
        &self,
        app: &AppHandle,
        revision: LauncherMenuRevision,
        model: LauncherMenuModel,
        window_id: String,
    ) {
        let menu = match launcher_menu(app, &model, &window_id) {
            Ok(menu) => menu,
            Err(error) => {
                eprintln!(
                    "Runtime launcher menu could not be prepared for window {window_id}: {error}"
                );
                return;
            }
        };
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if desired_launcher_revision(&state) == Some(revision)
            && state.registered_window_ids.contains(&window_id)
        {
            state.menus.insert(window_id, menu);
        }
    }

    fn popup(&self, window_id: &str, window: Window) -> Result<(), String> {
        let (cached_menu, loading_menu) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "runtime launcher refresh coordinator lock poisoned".to_owned())?;
            (
                state.menus.get(window_id).cloned(),
                state.loading_menu.clone(),
            )
        };
        let menu = if let Some(menu) = cached_menu {
            menu
        } else {
            // The first click can race startup projection collection. The loading menu was
            // prebuilt during app setup, so this event still performs no Core/SQLite read,
            // runtime-state wait, or native menu construction.
            loading_menu.ok_or_else(|| {
                "The runtime launcher projection has not been initialized yet.".to_owned()
            })?
        };
        menu.popup(window).map_err(|error| error.to_string())
    }
}

fn desired_launcher_revision(state: &RefreshState) -> Option<LauncherMenuRevision> {
    state.catalog.as_ref()?;
    Some(LauncherMenuRevision {
        catalog: state.catalog_applied_revision,
        presence: state.presence_revision,
    })
}

fn desired_launcher_model(
    state: &RefreshState,
) -> Option<(LauncherMenuRevision, LauncherMenuModel)> {
    let revision = desired_launcher_revision(state)?;
    Some((
        revision,
        LauncherMenuModel {
            catalog: state.catalog.clone()?,
            presence: state.presence.clone(),
        },
    ))
}

impl LauncherCatalog {
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
        Ok(Self {
            game_windows,
            language,
            roles,
            workspaces,
        })
    }
}

pub fn open_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "runtime state is unavailable".to_owned())?;
    let (window, muted) = state.runtime.native_menu_context_for_tab(tab_id)?;
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    state.launch_intents.try_open_tab_menu(TabMenuIntent {
        language,
        muted,
        tab_id: tab_id.to_owned(),
        window,
    })
}

#[allow(clippy::too_many_arguments)]
fn open_tab_from_model(
    app: &AppHandle,
    tab_id: &str,
    language: &str,
    muted: bool,
    snapshot: &BrowserRuntimeSnapshot,
    game_windows: &serde_json::Value,
    window: Window,
) -> Result<(), String> {
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| "runtime tab was not found".to_owned())?;
    let text = labels(language);
    let mut displays = SubmenuBuilder::new(app, text.move_to_window);
    for game_window in game_windows.as_array().cloned().unwrap_or_default() {
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
    let (window, _) = state.runtime.launcher_context_for_window_id(window_id)?;
    state
        .runtime_launcher_refresh
        .request_presence(app.clone(), Arc::clone(&state.runtime));
    state.runtime_launcher_refresh.popup(window_id, window)
}

fn launcher_menu(
    app: &AppHandle,
    model: &LauncherMenuModel,
    window_id: &str,
) -> Result<Menu<tauri::Wry>, String> {
    let text = labels(&model.catalog.language);
    let mut roles_menu = SubmenuBuilder::new(app, text.roles);
    let role_values = model.catalog.roles.as_array().cloned().unwrap_or_default();
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
            roles_menu = roles_menu.text(
                launcher_menu_item_id(LAUNCH_ROLE_PREFIX, window_id, id),
                launcher_item_label(
                    name,
                    launcher_presence_tab(&model.presence, id, false).is_some(),
                ),
            );
        }
    }
    let mut workspaces_menu = SubmenuBuilder::new(app, text.workspaces);
    let workspace_values = model
        .catalog
        .workspaces
        .as_array()
        .cloned()
        .unwrap_or_default();
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
            workspaces_menu = workspaces_menu.text(
                launcher_menu_item_id(LAUNCH_WORKSPACE_PREFIX, window_id, id),
                launcher_item_label(
                    name,
                    launcher_presence_tab(&model.presence, id, true).is_some(),
                ),
            );
        }
    }
    let saved = model
        .catalog
        .game_windows
        .as_array()
        .is_some_and(|windows| windows.iter().any(|window| window["id"] == window_id));
    let mut menu = MenuBuilder::new(app);
    if !saved {
        menu = menu
            .text(format!("{SAVE_WINDOW_PREFIX}{window_id}"), text.save_window)
            .separator();
    }
    menu.item(&roles_menu.build().map_err(|error| error.to_string())?)
        .item(&workspaces_menu.build().map_err(|error| error.to_string())?)
        .build()
        .map_err(|error| error.to_string())
}

fn launcher_presence_tab<'a>(
    presence: &'a crate::system_runtime::RuntimeLauncherPresence,
    source_id: &str,
    workspace: bool,
) -> Option<&'a crate::system_runtime::RuntimeLauncherPresenceTab> {
    presence.tabs.iter().find(|tab| {
        if workspace {
            tab.tab_type == "workspace" && tab.source_id == source_id
        } else {
            tab.role_ids.iter().any(|role_id| role_id == source_id)
                || (tab.tab_type == "role" && tab.source_id == source_id)
        }
    })
}

fn launcher_item_label(name: &str, launched: bool) -> String {
    if launched {
        format!("✓ {name}")
    } else {
        name.to_owned()
    }
}

fn launcher_menu_item_id(prefix: &str, window_id: &str, source_id: &str) -> String {
    format!("{prefix}{window_id}:{source_id}")
}

fn parse_launcher_menu_target(value: &str) -> Result<(&str, &str), String> {
    let (window_id, source_id) = value
        .split_once(':')
        .ok_or_else(|| "runtime launcher menu target is invalid".to_owned())?;
    if window_id.is_empty() || source_id.is_empty() {
        return Err("runtime launcher menu target is invalid".to_owned());
    }
    Ok((window_id, source_id))
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
        match current_tab_muted(&state, tab_id) {
            Ok(muted) => {
                let app = app.clone();
                let runtime = Arc::clone(&state.runtime);
                let tab_id = tab_id.to_owned();
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        runtime.set_tab_audio_muted(&tab_id, !muted)
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result);
                    if let Err(message) = result {
                        reveal_menu_error(&app, message);
                    }
                });
            }
            Err(message) => reveal_menu_error(app, message),
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
        match state.runtime.launcher_context_for_window_id(window_id) {
            Ok((_, target)) => spawn_command(
                app,
                &state.core,
                CoreCommand::EmbeddedTabMove {
                    tab_id: tab_id.to_owned(),
                    target,
                },
            ),
            Err(message) => reveal_menu_error(app, message),
        }
    } else if let Some(value) = id.strip_prefix(LAUNCH_ROLE_PREFIX) {
        launch_from_scoped_menu(app, &state, value, false);
    } else if let Some(value) = id.strip_prefix(LAUNCH_WORKSPACE_PREFIX) {
        launch_from_scoped_menu(app, &state, value, true);
    } else if let Some(window_id) = id.strip_prefix(SAVE_WINDOW_PREFIX) {
        save_runtime_game_window(app, &state, window_id);
    }
    true
}

fn launch_from_scoped_menu(
    app: &AppHandle,
    state: &crate::CoreState,
    value: &str,
    workspace: bool,
) {
    let result = parse_launcher_menu_target(value).and_then(|(window_id, source_id)| {
        state
            .runtime
            .launcher_context_for_window_id(window_id)
            .map(|(_, target)| (target, source_id))
    });
    match result {
        Ok((target, source_id)) => launch_from_menu(app, state, target, source_id, workspace),
        Err(message) => reveal_menu_error(app, message),
    }
}

fn save_runtime_game_window(app: &AppHandle, state: &crate::CoreState, window_id: &str) {
    match state.runtime_launcher_refresh.begin_save(window_id) {
        Ok(true) => {}
        Ok(false) => return,
        Err(message) => {
            reveal_menu_error(app, message);
            return;
        }
    }
    let app = app.clone();
    let core = Arc::clone(&state.core);
    let runtime = Arc::clone(&state.runtime);
    let coordinator = state.runtime_launcher_refresh.clone();
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    let window_id = window_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let preparation_core = Arc::clone(&core);
        let preparation_runtime = Arc::clone(&runtime);
        let preparation_window_id = window_id.clone();
        let preparation_language = language.clone();
        let preparation = tauri::async_runtime::spawn_blocking(move || {
            let windows = saved_game_windows(&preparation_core)?;
            if windows
                .iter()
                .any(|window| window.id == preparation_window_id)
            {
                return Ok((None, windows));
            }
            let name = crate::next_game_window_name(&windows, &preparation_language);
            let input = preparation_runtime
                .runtime_game_window_save_input(&preparation_window_id, name)
                .map_err(|message| crate::shell_error("TAURI_GAME_WINDOW_SAVE_FAILED", message))?;
            Ok((Some(input), windows))
        })
        .await
        .map_err(|error| crate::shell_error("CORE_INTERNAL_FAILED", error.to_string()))
        .and_then(|result| result);

        let result = async {
            let (input, existing_windows) = preparation?;
            let Some(input) = input else {
                runtime
                    .refresh_saved_game_windows(&existing_windows)
                    .map_err(|message| crate::shell_error("SHELL_WINDOW_FAILED", message))?;
                return Ok::<(), rion_core::CoreErrorPayload>(());
            };
            let saved = core
                .invoke_async(CoreCommand::GameWindowSaveRuntime { input })
                .await
                .map_err(crate::error_payload)
                .and_then(|value| {
                    serde_json::from_value::<StateGameWindowRecord>(value).map_err(|error| {
                        crate::shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let windows = saved_game_windows(&core)?;
            if let Err(message) = runtime.refresh_saved_game_windows(&windows) {
                let compensation = core
                    .invoke_async(CoreCommand::GameWindowDeleteIfUnchanged {
                        id: saved.id.clone(),
                        updated_at: saved.updated_at.clone(),
                    })
                    .await;
                let authoritative = saved_game_windows(&core);
                if let Ok(authoritative) = &authoritative {
                    let _ = runtime.refresh_saved_game_windows(authoritative);
                }
                if let Err(error) = compensation {
                    return Err(crate::shell_error(
                        "TAURI_GAME_WINDOW_SAVE_ROLLBACK_FAILED",
                        format!(
                            "Native title update failed ({message}); saved-window rollback also failed: {error}"
                        ),
                    ));
                }
                return Err(crate::shell_error("SHELL_WINDOW_FAILED", message));
            }
            Ok(())
        }
        .await;

        coordinator.finish_save(&window_id);
        let _ = coordinator.request(app.clone(), Arc::clone(&core), language);
        if let Err(error) = result {
            crate::reveal_shell_error(&app, error);
        }
    });
}

fn saved_game_windows(
    core: &AppCore,
) -> Result<Vec<StateGameWindowRecord>, rion_core::CoreErrorPayload> {
    core.invoke(CoreCommand::GameWindowsList)
        .map_err(crate::error_payload)
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|error| crate::shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })
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
        SAVE_WINDOW_PREFIX,
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
        "tabDragStart" => &[
            "type",
            "sessionId",
            "tabId",
            "screenX",
            "screenY",
            "grabRatioX",
            "grabRatioY",
            "tabWidth",
            "tabHeight",
        ][..],
        "tabDragMove" => &["type", "sessionId", "screenX", "screenY"][..],
        "tabDragHover" => &[
            "type",
            "sessionId",
            "windowId",
            "beforeTabId",
            "screenX",
            "screenY",
            "tabWidth",
            "tabHeight",
        ][..],
        "tabDragDrop" => &[
            "type",
            "sessionId",
            "windowId",
            "beforeTabId",
            "screenX",
            "screenY",
        ][..],
        "tabDragEnd" => &["type", "sessionId", "cancelled", "screenX", "screenY"][..],
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
            let target = state
                .runtime
                .launcher_context_for_window_id(target_window_id)?
                .1;
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

fn launch_from_menu(
    app: &AppHandle,
    state: &crate::CoreState,
    target: EmbeddedLaunchTargetRecord,
    source_id: &str,
    workspace: bool,
) {
    let action_started = Instant::now();
    let native_action_at = chrono::Utc::now().to_rfc3339();
    let tab_type = if workspace { "workspace" } else { "role" };
    capture_launcher_action_event(
        Arc::clone(&state.core),
        "tab.launch-menu-selected",
        "A runtime launcher menu selection was received.",
        LogLevel::Debug,
        &target,
        source_id,
        workspace,
        None,
    );
    let preview = if let Some(tab_id) = state
        .runtime
        .presented_tab_for_launcher_source(source_id, tab_type)
    {
        if let Err(message) = crate::preview_and_commit_native_tab_selection(app, state, &tab_id) {
            reveal_menu_error(app, message);
            return;
        }
        state.runtime.retry_failed_tab_launch(source_id, tab_type)
    } else {
        // The launcher menu belongs to an already-live game window. Commit its
        // provisional presentation before returning from the native menu action so
        // Tokio scheduling, Core work and controller creation cannot delay the tab.
        match state
            .runtime
            .preview_tab_launch(&target, source_id, tab_type)
        {
            Ok(preview_key) => Some(preview_key),
            Err(error) => {
                let payload = rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                };
                capture_launcher_action_event(
                    Arc::clone(&state.core),
                    "tab.launch-preview-rejected",
                    "The runtime launcher could not reserve its provisional tab.",
                    LogLevel::Error,
                    &target,
                    source_id,
                    workspace,
                    Some(&payload),
                );
                crate::reveal_shell_error(app, payload);
                return;
            }
        }
    };
    let Some(preview_key) = preview else {
        if state
            .runtime
            .presented_tab_for_launcher_source(source_id, tab_type)
            .is_some()
        {
            return;
        }
        reveal_menu_error(app, "The provisional runtime tab could not be reserved.");
        return;
    };
    let preview_committed_ms = action_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let preview_committed_at = chrono::Utc::now().to_rfc3339();
    if let Err(message) = state.launch_intents.try_launch(LaunchIntent {
        action_started,
        native_action_at,
        preview_committed_at,
        preview_committed_ms,
        preview_key: preview_key.clone(),
        source_id: source_id.to_owned(),
        target: target.clone(),
        workspace,
    }) {
        state.runtime.fail_tab_launch_preview(&preview_key);
        let payload = rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_LAUNCH_QUEUE_FAILED".to_owned(),
            message,
        };
        capture_launcher_action_event(
            Arc::clone(&state.core),
            "tab.launch-queue-rejected",
            "The provisional tab could not enter the background launch queue.",
            LogLevel::Error,
            &target,
            source_id,
            workspace,
            Some(&payload),
        );
        crate::reveal_shell_error(app, payload);
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_launcher_action_event(
    core: Arc<AppCore>,
    event: &'static str,
    message: &'static str,
    level: LogLevel,
    target: &EmbeddedLaunchTargetRecord,
    source_id: &str,
    workspace: bool,
    error: Option<&rion_core::CoreErrorPayload>,
) {
    let context = serde_json::json!({
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "sourceId": source_id,
        "sourceType": if workspace { "workspace" } else { "role" },
        "windowId": target.window_id,
    });
    let error = error.map(|error| LogErrorDetails {
        name: error.code.clone(),
        message: error.message.clone(),
        stack: None,
        cause: None,
    });
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level,
                    source: LogSource::Browser,
                    event: event.to_owned(),
                    message: message.to_owned(),
                    context_raw_json: serde_json::to_string(&context).ok(),
                    error,
                }],
            })
            .await;
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
    state.runtime.tab_audio_muted(tab_id)
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
    save_window: &'static str,
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
            save_window: "儲存為新遊戲視窗",
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
            save_window: "保存为新游戏窗口",
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
            save_window: "新しいゲームウインドウとして保存",
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
            save_window: "Save as New Game Window",
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
    fn save_window_label_is_localized_for_every_supported_language() {
        for (language, expected) in [
            ("en", "Save as New Game Window"),
            ("zh-TW", "儲存為新遊戲視窗"),
            ("zh-CN", "保存为新游戏窗口"),
            ("ja", "新しいゲームウインドウとして保存"),
        ] {
            assert_eq!(labels(language).save_window, expected, "{language}");
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
            "runtime-window-save:window-1",
            "runtime-tab-stop:tab-1",
        ] {
            assert!(is_runtime_menu_event(id), "{id}");
        }
        assert!(!is_runtime_menu_event("open-app"));
    }

    #[test]
    fn launcher_menu_item_ids_preserve_their_source_window() {
        let first = launcher_menu_item_id(LAUNCH_ROLE_PREFIX, "window-1", "role-1");
        let second = launcher_menu_item_id(LAUNCH_ROLE_PREFIX, "window-2", "role-1");
        let workspace =
            launcher_menu_item_id(LAUNCH_WORKSPACE_PREFIX, "window-1", "workspace:daily");

        assert_eq!(first, "runtime-tab-launch-role:window-1:role-1".to_owned());
        assert_ne!(first, second);
        assert_eq!(
            parse_launcher_menu_target(first.strip_prefix(LAUNCH_ROLE_PREFIX).unwrap()),
            Ok(("window-1", "role-1"))
        );
        assert_eq!(
            parse_launcher_menu_target(workspace.strip_prefix(LAUNCH_WORKSPACE_PREFIX).unwrap()),
            Ok(("window-1", "workspace:daily"))
        );
    }

    #[test]
    fn launcher_menu_targets_reject_missing_window_or_source_ids() {
        for value in ["window-only", ":role-1", "window-1:"] {
            assert_eq!(
                parse_launcher_menu_target(value),
                Err("runtime launcher menu target is invalid".to_owned()),
                "{value}"
            );
        }
    }

    #[test]
    fn launcher_presence_marks_workspaces_and_their_actual_roles() {
        let presence = crate::system_runtime::RuntimeLauncherPresence {
            tabs: vec![crate::system_runtime::RuntimeLauncherPresenceTab {
                role_ids: vec!["role-a".to_owned(), "role-b".to_owned()],
                source_id: "workspace-a".to_owned(),
                tab_id: "tab-a".to_owned(),
                tab_type: "workspace".to_owned(),
            }],
        };

        assert_eq!(
            launcher_presence_tab(&presence, "workspace-a", true).map(|tab| tab.tab_id.as_str()),
            Some("tab-a")
        );
        assert_eq!(
            launcher_presence_tab(&presence, "role-b", false).map(|tab| tab.tab_id.as_str()),
            Some("tab-a")
        );
        assert!(launcher_presence_tab(&presence, "role-c", false).is_none());
        assert_eq!(launcher_item_label("Role B", true), "✓ Role B");
        assert_eq!(launcher_item_label("Role C", false), "Role C");
    }

    #[test]
    fn launcher_catalog_and_presence_revisions_advance_independently() {
        let mut state = RefreshState {
            catalog: Some(LauncherCatalog {
                game_windows: serde_json::json!([]),
                language: "en".to_owned(),
                roles: serde_json::json!([]),
                workspaces: serde_json::json!([]),
            }),
            catalog_applied_revision: 7,
            presence_revision: 2,
            ..RefreshState::default()
        };

        assert_eq!(
            desired_launcher_revision(&state),
            Some(LauncherMenuRevision {
                catalog: 7,
                presence: 2,
            })
        );
        state.presence_revision = 3;
        assert_eq!(
            desired_launcher_revision(&state),
            Some(LauncherMenuRevision {
                catalog: 7,
                presence: 3,
            })
        );
        state.catalog_applied_revision = 8;
        assert_eq!(
            desired_launcher_revision(&state),
            Some(LauncherMenuRevision {
                catalog: 8,
                presence: 3,
            })
        );
    }
}
