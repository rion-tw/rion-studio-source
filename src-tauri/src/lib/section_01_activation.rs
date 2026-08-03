use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

use rion_core::{
    AppCore, AppCoreOptions, BrowserRuntimeSnapshot, CoreCommand, CoreEffectAction,
    CoreEffectResult, CoreErrorPayload, CoreEvent, DisplayFingerprintRecord, DisplayTargetRecord,
    EmbeddedLaunchTargetRecord, GameWindowCreateInputRecord, GameWindowPlacementRecord,
    GameWindowRoleViewRecord, GameWindowTabRecord, GameWindowUpdateInputRecord, LogCaptureRecord,
    LogLevel, LogSource, MacroRunStatus, StateCollection, StateGameWindowRecord,
    StatePixelBoundsRecord, StateResolutionRecord, SystemRuntimeOperationSummaryRecord,
};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, Manager, State, Webview, WebviewWindow, Window, webview::PageLoadEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use activation::ActivationServer;
use system_runtime::{RuntimeTabDragWindowSnapshot, SystemRuntimeExecutor};

const CORE_EVENTS_EVENT: &str = "rion://core-events";
const OVERLAY_REQUEST_MAX_BYTES: usize = 64 * 1024;
const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio";
const RENDERER_READY_TIMEOUT: Duration = Duration::from_secs(15);

fn core_effect_action_name(action: &CoreEffectAction) -> &'static str {
    match action {
        CoreEffectAction::RoleBrowserDataClearSession { .. } => "roleBrowserDataClearSession",
        CoreEffectAction::ChromeProfileImportSnapshot { .. } => "chromeProfileImportSnapshot",
        CoreEffectAction::ChromeProfileImportApply { .. } => "chromeProfileImportApply",
        CoreEffectAction::ChromeProfileImportVerify { .. } => "chromeProfileImportVerify",
        CoreEffectAction::ChromeProfileImportRollback { .. } => "chromeProfileImportRollback",
        CoreEffectAction::ChromeProfileImportCommit { .. } => "chromeProfileImportCommit",
        CoreEffectAction::EmbeddedCreateTab { .. } => "embeddedCreateTab",
        CoreEffectAction::EmbeddedConfigureRoleSessions { .. } => "embeddedConfigureRoleSessions",
        CoreEffectAction::EmbeddedLoadRoles { .. } => "embeddedLoadRoles",
        CoreEffectAction::EmbeddedInstallOverlays { .. } => "embeddedInstallOverlays",
        CoreEffectAction::EmbeddedFocusRole { .. } => "embeddedFocusRole",
        CoreEffectAction::EmbeddedDestroyRole { .. } => "embeddedDestroyRole",
        CoreEffectAction::EmbeddedDestroyTab { .. } => "embeddedDestroyTab",
        CoreEffectAction::EmbeddedApplyRuntime { .. } => "embeddedApplyRuntime",
        CoreEffectAction::OverlayOpenMacroPage { .. } => "overlayOpenMacroPage",
        CoreEffectAction::OverlayCopyCoordinate { .. } => "overlayCopyCoordinate",
        CoreEffectAction::BrowserAction { .. } => "browserAction",
    }
}

struct CoreState {
    _activation: ActivationServer,
    _quick_menu: quick_menu::QuickMenu,
    core: Arc<AppCore>,
    display_topology: native_projection::RevisionedJsonProjection,
    application_exit_guard: ApplicationExitGuard,
    application_shutdown_started: AtomicBool,
    main_window_zoom: Mutex<f64>,
    menu_language: Mutex<String>,
    quick_menu_refresh: quick_menu::RefreshCoordinator,
    runtime_launcher_refresh: runtime_tab_menu::RefreshCoordinator,
    launch_intents: runtime_tab_menu::LaunchIntentDispatcher,
    runtime: Arc<SystemRuntimeExecutor>,
    tab_selection_commit: TabSelectionCommitCoordinator,
    tab_drag: Mutex<Option<GameWindowTabDragSession>>,
    tab_drag_finished: Mutex<VecDeque<String>>,
    tab_drag_lane: tokio::sync::Mutex<()>,
    updates: Arc<update_manager::UpdateManager>,
}

const TAB_SELECTION_COMMIT_DEBOUNCE: Duration = Duration::from_millis(150);
const TAB_SELECTION_COMMIT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const TAB_SELECTION_COMMIT_RETRY_DELAY: Duration = Duration::from_millis(300);

#[derive(Clone, Default)]
struct TabSelectionCommitCoordinator {
    next_generation: Arc<AtomicU64>,
    workers: Arc<Mutex<HashMap<String, TabSelectionCommitWorker>>>,
}

struct TabSelectionCommitWorker {
    generation: u64,
    sender: tokio::sync::watch::Sender<TabSelectionCommitRequest>,
}

#[derive(Clone)]
struct TabSelectionCommitRequest {
    app: AppHandle,
    core: Arc<AppCore>,
    runtime: Arc<SystemRuntimeExecutor>,
    tab_id: String,
    window_id: String,
    selection_revision: u64,
}

impl TabSelectionCommitCoordinator {
    fn request(
        &self,
        app: AppHandle,
        core: Arc<AppCore>,
        runtime: Arc<SystemRuntimeExecutor>,
        window_id: String,
        tab_id: String,
        selection_revision: u64,
    ) -> Result<(), String> {
        let request = TabSelectionCommitRequest {
            app,
            core,
            runtime,
            tab_id,
            window_id: window_id.clone(),
            selection_revision,
        };
        let mut workers = self
            .workers
            .lock()
            .map_err(|_| "tab selection commit coordinator lock poisoned".to_owned())?;
        if let Some(worker) = workers.get(&window_id)
            && worker.sender.send(request.clone()).is_ok()
        {
            return Ok(());
        }
        let (sender, receiver) = tokio::sync::watch::channel(request);
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        workers.insert(
            window_id.clone(),
            TabSelectionCommitWorker { generation, sender },
        );
        tauri::async_runtime::spawn(run_tab_selection_commit_worker(
            receiver,
            Arc::downgrade(&self.workers),
            window_id,
            generation,
        ));
        Ok(())
    }
}

async fn run_tab_selection_commit_worker(
    mut receiver: tokio::sync::watch::Receiver<TabSelectionCommitRequest>,
    workers: std::sync::Weak<Mutex<HashMap<String, TabSelectionCommitWorker>>>,
    window_id: String,
    generation: u64,
) {
    loop {
        let request = receiver.borrow_and_update().clone();
        tokio::time::sleep(TAB_SELECTION_COMMIT_DEBOUNCE).await;
        match receiver.has_changed() {
            Ok(true) => continue,
            Ok(false) => {}
            Err(_) => {
                if retire_tab_selection_commit_worker(
                    &workers,
                    &window_id,
                    generation,
                    &receiver,
                ) {
                    return;
                }
                continue;
            }
        }
        if !request
            .runtime
            .tab_selection_is_desired(
                &request.window_id,
                &request.tab_id,
                request.selection_revision,
            )
        {
            if !wait_for_tab_selection_commit_request(&mut receiver).await {
                if retire_tab_selection_commit_worker(
                    &workers,
                    &window_id,
                    generation,
                    &receiver,
                ) {
                    return;
                }
                continue;
            }
            continue;
        }
        let command = || CoreCommand::EmbeddedTabActivateConditional {
            tab_id: request.tab_id.clone(),
            window_id: request.window_id.clone(),
            selection_revision: request.selection_revision,
        };
        let mut result = Arc::clone(&request.core).invoke_async(command()).await;
        if result.is_err() && !receiver.has_changed().unwrap_or(false) {
            tokio::time::sleep(TAB_SELECTION_COMMIT_RETRY_DELAY).await;
            if !receiver.has_changed().unwrap_or(false)
                && request
                    .runtime
                    .tab_selection_is_desired(
                        &request.window_id,
                        &request.tab_id,
                        request.selection_revision,
                    )
            {
                result = Arc::clone(&request.core).invoke_async(command()).await;
            }
        }
        if let Err(error) = result
            && !receiver.has_changed().unwrap_or(false)
            && request
                .runtime
                .tab_selection_is_desired(
                    &request.window_id,
                    &request.tab_id,
                    request.selection_revision,
                )
        {
            request.runtime.reconcile_tab_activation(&request.window_id);
            reveal_shell_error(&request.app, error.payload());
        }
        if !wait_for_tab_selection_commit_request(&mut receiver).await
            && retire_tab_selection_commit_worker(
                &workers,
                &window_id,
                generation,
                &receiver,
            )
        {
            return;
        }
    }
}

async fn wait_for_tab_selection_commit_request(
    receiver: &mut tokio::sync::watch::Receiver<TabSelectionCommitRequest>,
) -> bool {
    matches!(
        tokio::time::timeout(TAB_SELECTION_COMMIT_IDLE_TIMEOUT, receiver.changed()).await,
        Ok(Ok(()))
    )
}

fn retire_tab_selection_commit_worker(
    workers: &std::sync::Weak<Mutex<HashMap<String, TabSelectionCommitWorker>>>,
    window_id: &str,
    generation: u64,
    receiver: &tokio::sync::watch::Receiver<TabSelectionCommitRequest>,
) -> bool {
    let Some(workers) = workers.upgrade() else {
        return true;
    };
    let Ok(mut workers) = workers.lock() else {
        return true;
    };
    if !workers
        .get(window_id)
        .is_some_and(|worker| worker.generation == generation)
    {
        return true;
    }
    // request() holds this same map lock while publishing. Recheck the receiver only after
    // acquiring it so an activation arriving on the idle-timeout boundary is either consumed by
    // this worker or observes the removed entry and creates a replacement worker.
    if receiver.has_changed().unwrap_or(false) {
        return false;
    }
    workers.remove(window_id);
    true
}

pub(crate) fn preview_and_commit_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<SystemRuntimeOperationSummaryRecord, String> {
    preview_and_commit_tab_selection_inner(app, state, tab_id, false)
}

fn preview_and_commit_tab_selection_inner(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
    native_style_applied: bool,
) -> Result<SystemRuntimeOperationSummaryRecord, String> {
    let (window_id, provisional, resolved_tab_id, operation_id) = state
        .runtime
        .preview_tab_activation(tab_id, native_style_applied)?;
    if !provisional
        && let Err(message) =
            commit_previewed_tab_selection(app, state, &window_id, &resolved_tab_id)
    {
        eprintln!("Runtime tab selection commit could not be scheduled: {message}");
        return state.runtime.fail_native_operation_summary(
            &operation_id,
            "tabSelectionCommitFailed",
            "SYSTEM_TAB_SELECTION_COMMIT_FAILED",
        );
    }
    state.runtime.wait_native_operation_summary(&operation_id)
}

pub(crate) fn preview_and_commit_native_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<(), String> {
    match preview_and_commit_tab_selection_inner(app, state, tab_id, true) {
        Err(message)
            if matches!(
                message.as_str(),
                "Runtime tab was not found." | "The runtime tab is closing."
            ) =>
        {
            // Native pointer/key actions can arrive after an optimistic close or provisional-ID
            // replacement. They are stale presentation intents, not user-visible failures.
            Ok(())
        }
        result => result.and_then(runtime_operation_receipt_result),
    }
}

pub(crate) fn commit_previewed_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    window_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    let selection_revision = state
        .runtime
        .tab_selection_revision(window_id, tab_id)
        .ok_or_else(|| "The previewed tab selection is no longer current.".to_owned())?;
    state.tab_selection_commit.request(
        app.clone(),
        Arc::clone(&state.core),
        Arc::clone(&state.runtime),
        window_id.to_owned(),
        tab_id.to_owned(),
        selection_revision,
    )
}

#[derive(Default)]
struct ApplicationExitGuard {
    permitted: AtomicBool,
}

impl ApplicationExitGuard {
    fn permit(&self) {
        self.permitted.store(true, Ordering::Release);
    }

    fn should_prevent(&self) -> bool {
        !self.permitted.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
enum GameWindowTabDragPhase {
    Previewing,
    AwaitingDropIntent,
    Attached,
    Floating,
    Finishing,
    Cancelled,
}

#[derive(Clone)]
struct GameWindowTabDragSession {
    current_window_id: String,
    drop_before_tab_id: Option<String>,
    drop_window_id: Option<String>,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
    id: String,
    latest_move_revision: u64,
    latest_screen_x: f64,
    latest_screen_y: f64,
    native_changes_applied: bool,
    original_target: EmbeddedLaunchTargetRecord,
    phase: GameWindowTabDragPhase,
    processed_move_revision: u64,
    provisional_window_id: String,
    single_tab: bool,
    snapshots: HashMap<String, RuntimeTabDragWindowSnapshot>,
    source_window_id: String,
    source_cancelled: bool,
    source_drop_accepted: bool,
    source_end_received: bool,
    tab_height: f64,
    tab_id: String,
    tab_width: f64,
    target: EmbeddedLaunchTargetRecord,
    title: String,
    window_anchor: Option<(f64, f64)>,
    window_was_moved: bool,
}

#[derive(Clone)]
struct WorkspaceConflictRollbackPlan {
    active: bool,
    audio_muted: bool,
    before_tab_id: Option<String>,
    hidden: bool,
    role_zoom_factor: Option<f64>,
    role_views: Vec<GameWindowRoleViewRecord>,
    source_id: String,
    tab_id: String,
    tab_type: String,
    target: EmbeddedLaunchTargetRecord,
    window_index: usize,
}

struct SavedWindowTakeover {
    original_target_tab_ids: HashSet<String>,
    plans: Vec<WorkspaceConflictRollbackPlan>,
    recovery_records: Vec<StateGameWindowRecord>,
    target_window_id: String,
}

fn sort_workspace_conflict_rollback_plans(plans: &mut [WorkspaceConflictRollbackPlan]) {
    plans.sort_by(|left, right| {
        left.target
            .window_id
            .cmp(&right.target.window_id)
            .then(left.window_index.cmp(&right.window_index))
    });
}

async fn stop_workspace_conflict(
    state: &CoreState,
    plan: &WorkspaceConflictRollbackPlan,
) -> Result<(), CoreErrorPayload> {
    let command = if plan.tab_type == "workspace" {
        CoreCommand::BrowserWorkspaceStop {
            workspace_id: plan.source_id.clone(),
        }
    } else {
        CoreCommand::BrowserRoleStop {
            role_id: plan.source_id.clone(),
        }
    };
    Arc::clone(&state.core)
        .invoke_async(command)
        .await
        .map(|_| ())
        .map_err(error_payload)
}

async fn rollback_workspace_conflicts(
    state: &CoreState,
    plans: &[WorkspaceConflictRollbackPlan],
) -> Vec<String> {
    let mut errors = Vec::new();
    let mut restored_tab_ids = HashMap::new();
    for plan in plans.iter().rev() {
        let launch = if plan.tab_type == "workspace" {
            CoreCommand::BrowserWorkspaceLaunch {
                workspace_id: plan.source_id.clone(),
                target: plan.target.clone(),
            }
        } else {
            CoreCommand::BrowserRoleLaunch {
                role_id: plan.source_id.clone(),
                target: plan.target.clone(),
                zoom_factor: plan.role_zoom_factor,
            }
        };
        if let Err(error) = Arc::clone(&state.core).invoke_async(launch).await {
            errors.push(format!("launch {}: {error}", plan.source_id));
            continue;
        }
        let restored_tab_id = browser_runtime_snapshot(state)
            .ok()
            .and_then(|snapshot| {
                snapshot
                    .tabs
                    .into_iter()
                    .find(|tab| {
                        tab.window_id == plan.target.window_id
                            && tab.tab_type == plan.tab_type
                            && tab.source_id == plan.source_id
                    })
                    .map(|tab| tab.id)
            })
            .unwrap_or_else(|| plan.tab_id.clone());
        restored_tab_ids.insert(plan.tab_id.clone(), restored_tab_id.clone());
        let before_tab_id = plan.before_tab_id.as_ref().map(|before_tab_id| {
            restored_tab_ids
                .get(before_tab_id)
                .cloned()
                .unwrap_or_else(|| before_tab_id.clone())
        });
        if let Err(error) = Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedTabReorder {
                tab_id: restored_tab_id.clone(),
                before_tab_id,
            })
            .await
        {
            errors.push(format!("reorder {}: {error}", plan.tab_id));
        }
        if plan.hidden
            && let Err(error) = Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabHide {
                    tab_id: restored_tab_id.clone(),
                })
                .await
        {
            errors.push(format!("hide {}: {error}", plan.tab_id));
        }
        if plan.audio_muted
            && let Err(error) = state.runtime.set_tab_audio_muted(&restored_tab_id, true)
        {
            errors.push(format!("mute {}: {error}", plan.tab_id));
        }
        if let Err(error) = state
            .runtime
            .restore_tab_role_views(&restored_tab_id, &plan.role_views)
        {
            errors.push(format!("layout {}: {error}", plan.tab_id));
        }
    }
    for plan in plans.iter().filter(|plan| plan.active && !plan.hidden) {
        let tab_id = restored_tab_ids
            .get(&plan.tab_id)
            .cloned()
            .unwrap_or_else(|| plan.tab_id.clone());
        if let Err(error) = Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedTabActivate { tab_id })
            .await
        {
            errors.push(format!("activate {}: {error}", plan.tab_id));
        }
    }
    errors
}

fn restore_workspace_conflict_metadata(
    state: &CoreState,
    records: &[StateGameWindowRecord],
) -> Vec<String> {
    records
        .iter()
        .filter_map(|record| {
            state
                .core
                .invoke(CoreCommand::GameWindowUpdate {
                    id: record.id.clone(),
                    input: GameWindowUpdateInputRecord {
                        name: Some(record.name.clone()),
                        target_display: Some(record.target_display.clone()),
                        placement: Some(record.placement.clone()),
                        tabs: Some(record.tabs.clone()),
                        active_tab_id: Some(record.active_tab_id.clone()),
                    },
                })
                .err()
                .map(|error| format!("persist {}: {error}", record.id))
        })
        .collect()
}

fn workspace_conflict_transaction_error(
    state: &CoreState,
    original: CoreErrorPayload,
    mut rollback_errors: Vec<String>,
    recovery_records: &[StateGameWindowRecord],
) -> CoreErrorPayload {
    if rollback_errors.is_empty() {
        return original;
    }
    rollback_errors.extend(restore_workspace_conflict_metadata(state, recovery_records));
    state.runtime.mark_unhealthy_after_failed_compensation();
    shell_error(
        "TAURI_WORKSPACE_CONFLICT_ROLLBACK_FAILED",
        format!(
            "{} ({}) Conflict restoration also failed: {}. Restart Rion Studio to recover safely.",
            original.message,
            original.code,
            rollback_errors.join("; ")
        ),
    )
}

async fn begin_saved_window_takeover(
    state: &CoreState,
    saved: &StateGameWindowRecord,
    game_windows: &[StateGameWindowRecord],
) -> Result<SavedWindowTakeover, CoreErrorPayload> {
    let snapshot = browser_runtime_snapshot(state)?;
    let desired_roles = saved
        .tabs
        .iter()
        .flat_map(|tab| tab.role_ids.iter().cloned())
        .collect::<HashSet<_>>();
    let desired_sources = saved
        .tabs
        .iter()
        .map(|tab| format!("{}:{}", tab.tab_type, tab.source_id))
        .collect::<HashSet<_>>();
    let original_target_tab_ids = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.window_id == saved.id)
        .map(|tab| tab.id.clone())
        .collect::<HashSet<_>>();
    let conflicting_tabs = snapshot
        .tabs
        .iter()
        .filter(|tab| {
            tab.window_id != saved.id
                && (desired_sources.contains(&format!("{}:{}", tab.tab_type, tab.source_id))
                    || tab
                        .role_ids
                        .iter()
                        .any(|role_id| desired_roles.contains(role_id)))
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut affected_window_ids = HashSet::from([saved.id.clone()]);
    let mut plans = Vec::with_capacity(conflicting_tabs.len());
    for tab in conflicting_tabs {
        let runtime_window = snapshot
            .windows
            .iter()
            .find(|window| window.window_id == tab.window_id)
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_SNAPSHOT_INVALID",
                    "A conflicting runtime tab has no runtime window.",
                )
            })?;
        let window_index = runtime_window
            .tab_ids
            .iter()
            .position(|tab_id| tab_id == &tab.id)
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_SNAPSHOT_INVALID",
                    "A conflicting runtime tab is missing from its window order.",
                )
            })?;
        let role_views = state
            .runtime
            .runtime_tab_role_views(&tab.id)
            .map_err(|error| shell_error("TAURI_RUNTIME_ROLE_NOT_FOUND", error))?;
        affected_window_ids.insert(tab.window_id.clone());
        plans.push(WorkspaceConflictRollbackPlan {
            active: runtime_window.active_tab_id.as_deref() == Some(tab.id.as_str()),
            audio_muted: state
                .runtime
                .tab_audio_muted(&tab.id)
                .map_err(|error| shell_error("TAURI_RUNTIME_AUDIO_FAILED", error))?,
            before_tab_id: runtime_window.tab_ids.get(window_index + 1).cloned(),
            hidden: tab.hidden,
            role_zoom_factor: (tab.tab_type == "role")
                .then(|| {
                    role_views
                        .first()
                        .map(|view| view.browser_zoom_percent / 100.0)
                })
                .flatten(),
            role_views,
            source_id: tab.source_id,
            tab_id: tab.id,
            tab_type: tab.tab_type,
            target: state
                .runtime
                .launch_target_for_window_id(&tab.window_id)
                .map_err(|error| shell_error("TAURI_RUNTIME_DISPLAY_NOT_FOUND", error))?,
            window_index,
        });
    }
    sort_workspace_conflict_rollback_plans(&mut plans);
    let recovery_records = game_windows
        .iter()
        .filter(|window| affected_window_ids.contains(&window.id))
        .cloned()
        .collect::<Vec<_>>();

    for index in 0..plans.len() {
        if let Err(error) = stop_workspace_conflict(state, &plans[index]).await {
            let mut rollback_errors = restore_workspace_conflict_metadata(state, &recovery_records);
            rollback_errors.extend(rollback_workspace_conflicts(state, &plans[..index]).await);
            return Err(workspace_conflict_transaction_error(
                state,
                error,
                rollback_errors,
                &recovery_records,
            ));
        }
    }
    let persistence_errors = restore_workspace_conflict_metadata(state, &recovery_records);
    if !persistence_errors.is_empty() {
        let mut rollback_errors = persistence_errors;
        rollback_errors.extend(rollback_workspace_conflicts(state, &plans).await);
        return Err(workspace_conflict_transaction_error(
            state,
            shell_error(
                "TAURI_GAME_WINDOW_TAKEOVER_PERSIST_FAILED",
                "Saved Game Window configurations could not be preserved during takeover.",
            ),
            rollback_errors,
            &recovery_records,
        ));
    }
    Ok(SavedWindowTakeover {
        original_target_tab_ids,
        plans,
        recovery_records,
        target_window_id: saved.id.clone(),
    })
}

async fn rollback_saved_window_takeover(
    state: &CoreState,
    takeover: &SavedWindowTakeover,
) -> Vec<String> {
    let mut errors = Vec::new();
    if let Ok(snapshot) = browser_runtime_snapshot(state) {
        let launched_target_tabs = snapshot
            .tabs
            .iter()
            .filter(|tab| {
                tab.window_id == takeover.target_window_id
                    && !takeover.original_target_tab_ids.contains(&tab.id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for tab in launched_target_tabs.into_iter().rev() {
            let command = if tab.tab_type == "workspace" {
                CoreCommand::BrowserWorkspaceStop {
                    workspace_id: tab.source_id.clone(),
                }
            } else {
                CoreCommand::BrowserRoleStop {
                    role_id: tab.source_id.clone(),
                }
            };
            if let Err(error) = Arc::clone(&state.core).invoke_async(command).await {
                errors.push(format!("stop takeover tab {}: {error}", tab.id));
            }
        }
    }
    errors.extend(restore_workspace_conflict_metadata(
        state,
        &takeover.recovery_records,
    ));
    errors.extend(rollback_workspace_conflicts(state, &takeover.plans).await);
    errors.extend(restore_workspace_conflict_metadata(
        state,
        &takeover.recovery_records,
    ));
    errors
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimeRestoreTabMatch {
    Missing,
    InTarget { hidden: bool, id: String },
    Conflict { window_id: String },
}

struct RestoreProgressGuard<'a> {
    active: bool,
    state: &'a CoreState,
}

impl<'a> RestoreProgressGuard<'a> {
    fn new(state: &'a CoreState) -> Self {
        Self {
            active: true,
            state,
        }
    }

    fn finish(mut self) -> Result<(), CoreErrorPayload> {
        replace_restore_progress(self.state, Vec::new())?;
        self.active = false;
        Ok(())
    }
}
