use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use rion_core::{
    AppCore, AppCoreOptions, BrowserRuntimeSnapshot, CoreCommand, CoreEffectAction,
    CoreEffectResult, CoreErrorPayload, CoreEvent, DisplayFingerprintRecord, DisplayTargetRecord,
    EmbeddedLaunchTargetRecord, GameWindowCreateInputRecord, GameWindowDisplayRemapRecord,
    GameWindowPlacementRecord, GameWindowTabRecord,
    GameWindowUpdateInputRecord, LogCaptureRecord, LogLevel, LogSource, MacroRunStatus,
    StateCollection, StateGameWindowRecord,
    StatePixelBoundsRecord, StateResolutionRecord, SystemRuntimeOperationSummaryRecord,
    RuntimeTabDragSessionRecord, RuntimeTabMoveResultRecord,
};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, Manager, State, Webview, WebviewWindow, Window, webview::PageLoadEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use activation::ActivationServer;
use system_runtime::{
    RuntimeTabDragTerminalStatus, RuntimeTabMutationAcceptance,
    RuntimeTabMutationProjectionOutcome, RuntimeTabMutationTerminalStatus, SystemRuntimeExecutor,
};

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
        CoreEffectAction::EmbeddedClaimRoleSlot { .. } => "embeddedClaimRoleSlot",
        CoreEffectAction::EmbeddedDestroyTab { .. } => "embeddedDestroyTab",
        CoreEffectAction::EmbeddedFollowRoleOwnership { .. } => {
            "embeddedFollowRoleOwnership"
        }
        CoreEffectAction::OverlayOpenMacroPage { .. } => "overlayOpenMacroPage",
        CoreEffectAction::OverlayCopyCoordinate { .. } => "overlayCopyCoordinate",
        CoreEffectAction::BrowserAction { .. } => "browserAction",
    }
}

struct CoreState {
    _activation: ActivationServer,
    _power_monitor: power_lifecycle::PowerMonitor,
    _quick_menu: quick_menu::QuickMenu,
    core: Arc<AppCore>,
    display_topology: DisplayTopologyCoordinator,
    application_exit_guard: ApplicationExitGuard,
    application_shutdown_started: AtomicBool,
    main_window_zoom: Mutex<f64>,
    menu_language: Mutex<String>,
    quick_menu_refresh: quick_menu::RefreshCoordinator,
    runtime_launcher_refresh: runtime_tab_menu::RefreshCoordinator,
    launch_intents: runtime_tab_menu::LaunchIntentDispatcher,
    runtime: Arc<SystemRuntimeExecutor>,
    tab_drag: Mutex<Option<GameWindowTabDragSession>>,
    tab_drag_finished: Mutex<VecDeque<CompletedGameWindowTabDrag>>,
    tab_drag_lane: tokio::sync::Mutex<()>,
    #[cfg(target_os = "macos")]
    macos_tab_drag_actions:
        OnceLock<tokio::sync::mpsc::UnboundedSender<runtime_tabs_macos::QueuedNativeTabAction>>,
    updates: Arc<update_manager::UpdateManager>,
}

pub(crate) fn preview_and_commit_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<SystemRuntimeOperationSummaryRecord, String> {
    preview_and_commit_tab_selection_inner(app, state, tab_id, false)
}

pub(crate) fn stale_live_tab_action_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("runtime tab") || message.contains("tab presentation"))
        && (message.contains("not found")
            || message.contains("no longer")
            || message.contains("closing"))
}

pub(crate) fn preview_and_commit_adjacent_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    window_id: &str,
    direction: &str,
) -> Result<SystemRuntimeOperationSummaryRecord, String> {
    let (target_tab_id, provisional, operation_id) = state
        .runtime
        .preview_adjacent_tab_activation_background(window_id, direction)?;
    if !provisional
        && let Err(message) = commit_previewed_tab_selection(
            app,
            state,
            window_id,
            &target_tab_id,
        )
    {
        eprintln!("Adjacent tab selection commit could not be scheduled: {message}");
    }
    state
        .runtime
        .complete_background_presentation_summary(&operation_id)
}

fn preview_and_commit_tab_selection_inner(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
    native_style_applied: bool,
) -> Result<SystemRuntimeOperationSummaryRecord, String> {
    let (window_id, provisional, resolved_tab_id, operation_id) =
        match state
            .runtime
            .preview_tab_activation_background(tab_id, native_style_applied)
        {
            Err(message) if stale_live_tab_action_error(&message) => {
                return Ok(state.runtime.superseded_tab_activation_summary(tab_id));
            }
            result => result?,
        };
    if !provisional
        && let Err(message) =
            commit_previewed_tab_selection(
                app,
                state,
                &window_id,
                &resolved_tab_id,
            )
    {
        eprintln!("Runtime tab selection commit could not be scheduled: {message}");
    }
    state
        .runtime
        .complete_background_presentation_summary(&operation_id)
}

pub(crate) fn preview_and_schedule_native_tab_selection(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<(), String> {
    let (window_id, provisional, resolved_tab_id, operation_id) = match state
        .runtime
        .preview_tab_activation_background(tab_id, true)
    {
        Err(message) if stale_live_tab_action_error(&message) => return Ok(()),
        result => result?,
    };
    if !provisional {
        commit_previewed_tab_selection(app, state, &window_id, &resolved_tab_id)?;
    }
    monitor_background_tab_presentation(Arc::clone(&state.runtime), operation_id);
    Ok(())
}

fn monitor_background_tab_presentation(runtime: Arc<SystemRuntimeExecutor>, operation_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let receipt = runtime.wait_native_operation_summary(&operation_id);
        if let Ok(receipt) = receipt
            && !matches!(receipt.status.as_str(), "applied" | "superseded")
        {
            eprintln!(
                "Background tab presentation did not fully apply: operation={} status={} code={}",
                receipt.operation_id,
                receipt.status.as_str(),
                receipt.failure_code.as_deref().unwrap_or("none")
            );
        }
    });
}

pub(crate) fn commit_previewed_tab_selection(
    _app: &AppHandle,
    state: &CoreState,
    window_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    state
        .runtime
        .tab_selection_revision(window_id, tab_id)
        .ok_or_else(|| "The previewed tab selection is no longer current.".to_owned())?;
    state
        .runtime
        .schedule_live_window_state_persistence(window_id);
    Ok(())
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
    Attached,
    Floating,
    Finishing,
    Cancelled,
}

#[derive(Clone)]
struct GameWindowTabDragSession {
    accepted_at: String,
    current_window_id: String,
    drop_before_tab_id: Option<String>,
    drop_ordered_tab_ids: Option<Vec<String>>,
    drop_window_id: Option<String>,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
    hover_window_id: Option<String>,
    id: String,
    intent_generation: u64,
    last_event_sequence: u64,
    latest_move_revision: u64,
    latest_screen_x: f64,
    latest_screen_y: f64,
    operation_id: String,
    original_target: EmbeddedLaunchTargetRecord,
    phase: GameWindowTabDragPhase,
    processed_move_revision: u64,
    provisional_window_id: String,
    single_tab: bool,
    source_window_id: String,
    source_cancelled: bool,
    source_drop_accepted: bool,
    source_end_received: bool,
    tab_height: f64,
    tab_id: String,
    tab_width: f64,
    target: EmbeddedLaunchTargetRecord,
    title: String,
    lifecycle_epoch: u64,
    window_anchor: Option<(f64, f64)>,
    window_was_moved: bool,
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
