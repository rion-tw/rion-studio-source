use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}},
    thread,
    time::Instant,
};

use rion_core::{
    AppCore, CoreCommand, EmbeddedLaunchTargetRecord, RuntimeLaunchIntentReceiptRecord,
    RuntimeLaunchDestinationRequest, RuntimeLaunchIntentRecord, StateGameWindowRecord,
    LogCaptureRecord,
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
const TAB_MENU_INTENT_CAPACITY: usize = 16;
const MAX_CONCURRENT_TAB_MENU_MODELS: usize = 2;

struct LaunchIntent {
    enqueued_at: Instant,
    origin: &'static str,
    record: RuntimeLaunchIntentRecord,
    reply: Option<tokio::sync::oneshot::Sender<Result<RuntimeLaunchOutcome, rion_core::CoreErrorPayload>>>,
    target_policy: RuntimeLaunchTargetPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeLaunchTargetPolicy {
    Automatic,
    NewWindow,
    RequestedGameWindow(String),
    AuthenticatedLiveWindow(String),
}

impl From<RuntimeLaunchDestinationRequest> for RuntimeLaunchTargetPolicy {
    fn from(request: RuntimeLaunchDestinationRequest) -> Self {
        match request {
            RuntimeLaunchDestinationRequest::Automatic => Self::Automatic,
            RuntimeLaunchDestinationRequest::NewWindow => Self::NewWindow,
            RuntimeLaunchDestinationRequest::GameWindow { window_id } => {
                Self::RequestedGameWindow(window_id)
            }
        }
    }
}

pub(crate) struct LaunchAdmissionSignal(
    Option<tokio::sync::oneshot::Sender<()>>,
);

impl LaunchAdmissionSignal {
    fn channel() -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (Self(Some(sender)), receiver)
    }

    pub(crate) fn complete(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

pub(crate) struct RuntimeLaunchOutcome {
    pub(crate) receipt: RuntimeLaunchIntentReceiptRecord,
    pub(crate) statuses: serde_json::Value,
}

struct TabMenuIntent {
    language: String,
    muted: bool,
    tab_id: String,
    window_id: String,
    window: Window,
}

#[derive(Clone)]
pub(crate) struct LaunchIntentDispatcher {
    launch_log_sender: tokio::sync::mpsc::UnboundedSender<Vec<LogCaptureRecord>>,
    next_sequence: Arc<AtomicU64>,
    sender: tokio::sync::mpsc::Sender<LaunchIntent>,
    tab_menu_sender: tokio::sync::mpsc::Sender<TabMenuIntent>,
}

impl LaunchIntentDispatcher {
    pub(crate) fn start(
        app: AppHandle,
        core: Arc<AppCore>,
        _runtime: Arc<crate::system_runtime::SystemRuntimeExecutor>,
    ) -> Self {
        let (sender, mut receiver) =
            tokio::sync::mpsc::channel::<LaunchIntent>(LAUNCH_INTENT_CAPACITY);
        let (launch_log_sender, mut launch_log_receiver) =
            tokio::sync::mpsc::unbounded_channel::<Vec<rion_core::LogCaptureRecord>>();
        let launch_log_core = Arc::clone(&core);
        tauri::async_runtime::spawn(async move {
            while let Some(entries) = launch_log_receiver.recv().await {
                let _ = launch_log_core
                    .invoke_async(CoreCommand::LogsCapture { entries })
                    .await;
            }
        });
        let launch_app = app.clone();
        let actor_launch_log_sender = launch_log_sender.clone();
        tauri::async_runtime::spawn(async move {
            let (job_completed_sender, mut job_completed_receiver) =
                tokio::sync::mpsc::unbounded_channel::<String>();
            let mut execution_jobs = HashMap::new();
            loop {
                let intent = tokio::select! {
                    completed_intent_id = job_completed_receiver.recv() => {
                        if let Some(completed_intent_id) = completed_intent_id {
                            execution_jobs.remove(&completed_intent_id);
                        }
                        continue;
                    }
                    intent = receiver.recv() => {
                        let Some(intent) = intent else {
                            break;
                        };
                        intent
                    }
                };
                let queue_wait_ms = intent
                    .enqueued_at
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64;
                let (mut admission_signal, admission_completed) =
                    LaunchAdmissionSignal::channel();
                let job_app = launch_app.clone();
                let job_launch_log_sender = actor_launch_log_sender.clone();
                let job_completed_sender = job_completed_sender.clone();
                let tracked_intent_id = intent.record.intent_id.clone();
                let job = tauri::async_runtime::spawn(async move {
                    let terminal_intent = intent.record.clone();
                    let result = crate::execute_runtime_launch_intent(
                        &job_app,
                        intent.record,
                        crate::RuntimeLaunchExecutionContext::new(
                            intent.target_policy,
                            intent.origin,
                            &job_launch_log_sender,
                            intent.enqueued_at,
                            queue_wait_ms,
                            &mut admission_signal,
                        ),
                    )
                    .await;
                    if let Err(error) = result.as_ref() {
                        let mut events = crate::RuntimeLaunchEventBatch::with_timing(
                            job_launch_log_sender,
                            intent.enqueued_at,
                            queue_wait_ms,
                        );
                        events.record(
                            "launch.intent-terminal",
                            &terminal_intent,
                            None,
                            Some(&error.code),
                        );
                    }
                    if let Some(reply) = intent.reply {
                        let _ = reply.send(result);
                    } else if let Err(error) = result {
                        crate::reveal_shell_error(&job_app, error);
                    }
                    let _ = job_completed_sender.send(terminal_intent.intent_id);
                });
                execution_jobs.insert(tracked_intent_id, job);
                // A dropped signal means the job failed before committing an admission. Either
                // outcome releases the next mailbox item without waiting for native execution.
                let _ = admission_completed.await;
            }
            for (_, job) in execution_jobs {
                job.abort();
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
                        let game_windows = core
                            .invoke(CoreCommand::GameWindowsList)
                            .map_err(|error| error.to_string())?;
                        Ok::<_, String>(game_windows)
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result);
                    match model {
                        Ok(game_windows) => {
                            let menu_app = app.clone();
                            let error_app = app.clone();
                            if let Err(error) = app.run_on_main_thread(move || {
                                if let Err(message) = open_tab_from_model(
                                    &menu_app,
                                    &intent.tab_id,
                                    &intent.language,
                                    intent.muted,
                                    &intent.window_id,
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
            launch_log_sender,
            next_sequence: Arc::new(AtomicU64::new(0)),
            sender,
            tab_menu_sender,
        }
    }

    fn intent_record(&self, source_id: &str, workspace: bool) -> RuntimeLaunchIntentRecord {
        RuntimeLaunchIntentRecord {
            intent_id: uuid::Uuid::new_v4().to_string(),
            adapter_sequence: self
                .next_sequence
                .fetch_add(1, Ordering::AcqRel)
                .saturating_add(1),
            source_id: source_id.to_owned(),
            source_type: if workspace { "workspace" } else { "role" }.to_owned(),
        }
    }

    fn enqueue(&self, intent: LaunchIntent) -> Result<(), String> {
        let mut queued_event = crate::RuntimeLaunchEventBatch::with_timing(
            self.launch_log_sender.clone(),
            intent.enqueued_at,
            0,
        );
        queued_event.record("launch.intent-enqueued", &intent.record, None, Some(intent.origin));
        self.sender.try_send(intent).map_err(|error| match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => {
                "The background launch queue is full. Close or wait for an existing launch before retrying."
                    .to_owned()
            }
            tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                "The background launch queue is unavailable.".to_owned()
            }
        })?;
        queued_event.submit();
        Ok(())
    }

    pub(crate) fn try_launch_source(
        &self,
        source_id: &str,
        workspace: bool,
        target_policy: RuntimeLaunchTargetPolicy,
        origin: &'static str,
    ) -> Result<(), String> {
        self.enqueue(LaunchIntent {
            enqueued_at: Instant::now(),
            origin,
            record: self.intent_record(source_id, workspace),
            reply: None,
            target_policy,
        })
    }

    pub(crate) async fn submit(
        &self,
        source_id: &str,
        workspace: bool,
        destination: RuntimeLaunchDestinationRequest,
        origin: &'static str,
    ) -> Result<RuntimeLaunchOutcome, rion_core::CoreErrorPayload> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.enqueue(LaunchIntent {
            enqueued_at: Instant::now(),
            origin,
            record: self.intent_record(source_id, workspace),
            reply: Some(reply),
            target_policy: destination.into(),
        })
        .map_err(|message| rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_LAUNCH_QUEUE_FAILED".to_owned(),
            message,
        })?;
        receiver.await.map_err(|_| rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_LAUNCH_ACTOR_STOPPED".to_owned(),
            message: "The runtime launch actor stopped before the intent completed.".to_owned(),
        })?
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
    let window_id = state
        .runtime
        .live_tab_window_id(tab_id)
        .ok_or_else(|| "runtime tab is no longer in the live topology".to_owned())?;
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    state.launch_intents.try_open_tab_menu(TabMenuIntent {
        language,
        muted,
        tab_id: tab_id.to_owned(),
        window_id,
        window,
    })
}
