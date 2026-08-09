use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

#[cfg(target_os = "macos")]
use std::sync::OnceLock;

use rion_core::{
    AppCore, AppCoreOptions, BrowserRuntimeSnapshot, CoreCommand, CoreEffectAction,
    CoreEffectResult, CoreErrorPayload, CoreEvent, DisplayFingerprintRecord, DisplayTargetRecord,
    EmbeddedLaunchTargetRecord, GameWindowCreateInputRecord, GameWindowDisplayRemapRecord,
    GameWindowPlacementRecord, GameWindowTabRecord,
    GameWindowUpdateInputRecord, LogCaptureRecord, LogErrorDetails, LogLevel, LogSource,
    MacroRunStatus,
    RuntimeLaunchIntentReceiptRecord, RuntimeLaunchIntentRecord,
    RuntimeWindowStopRequestRecord,
    StateCollection, StateGameWindowRecord,
    StatePixelBoundsRecord, StateResolutionRecord, SystemRuntimeOperationStatus,
    SystemRuntimeOperationSummaryRecord,
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

fn record_application_shutdown_outcome(
    core: &AppCore,
    receipt: &SystemRuntimeOperationSummaryRecord,
    clean_exit_persisted: bool,
    persistence_error: Option<&str>,
) {
    let context = json!({
        "cleanExitPersisted": clean_exit_persisted,
        "completionScope": receipt.completion_scope.as_str(),
        "elapsedMs": receipt.elapsed_ms,
        "failureCode": receipt.failure_code,
        "operationId": receipt.operation_id,
        "phase": receipt.stage,
        "platform": receipt.platform,
        "status": receipt.status.as_str(),
    });
    let _ = core.invoke(CoreCommand::LogsCapture {
        entries: vec![LogCaptureRecord {
            level: if clean_exit_persisted {
                LogLevel::Info
            } else {
                LogLevel::Warn
            },
            source: LogSource::Browser,
            event: "application.shutdown-outcome".to_owned(),
            message: if clean_exit_persisted {
                "Application shutdown reached a terminal native outcome and persisted its clean-exit marker."
            } else {
                "Application shutdown did not persist a clean-exit marker."
            }
            .to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: persistence_error.map(|message| LogErrorDetails {
                name: "TAURI_RESTORE_PERSIST_FAILED".to_owned(),
                message: message.to_owned(),
                stack: None,
                cause: None,
            }),
        }],
    });
}

fn start_application_shutdown(app_handle: &AppHandle, state: &CoreState) {
    state.runtime.flush_all_live_window_states();
    let _ = state.runtime.persist_all_game_window_placements();
    if let Err(error) = state.runtime.persist_restore_session(false) {
        let _ = app_handle.emit(
            "rion://shell-error",
            json!({
                "code": "TAURI_RESTORE_PERSIST_FAILED",
                "message": error
            }),
        );
    }
    let runtime = Arc::clone(&state.runtime);
    let core = Arc::clone(&state.core);
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let receipt = runtime.close_all();
        let persistence_result =
            if system_runtime::shutdown_receipt_allows_clean_exit(&receipt.status) {
                runtime.persist_restore_session(true)
            } else {
                Err(receipt
                    .failure_code
                    .clone()
                    .unwrap_or_else(|| "SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE".to_owned()))
            };
        if let Err(error) = &persistence_result {
            let _ = app.emit(
                "rion://shell-error",
                json!({
                    "code": "TAURI_RESTORE_PERSIST_FAILED",
                    "message": error
                }),
            );
        }
        record_application_shutdown_outcome(
            &core,
            &receipt,
            persistence_result.is_ok(),
            persistence_result.as_ref().err().map(String::as_str),
        );
        runtime.wait_for_final_window_state_flush(std::time::Duration::from_secs(2));
        core.shutdown();
        if let Some(state) = app.try_state::<CoreState>() {
            state.application_shutdown.mark_ready_to_exit();
        }
        app.exit(0);
    });
}

fn confirm_application_shutdown(app: &AppHandle, state: &CoreState) {
    state.application_exit_guard.permit();
    match state.application_shutdown.request_exit() {
        ApplicationExitRequest::StartShutdown => start_application_shutdown(app, state),
        ApplicationExitRequest::WaitForShutdown => {}
        ApplicationExitRequest::Exit => app.exit(0),
    }
}

fn request_application_shutdown(app: &AppHandle, state: &CoreState) {
    if state.application_exit_guard.should_prevent() {
        let _ = state
            .runtime
            .request_main_window_show(true, "application-menu-quit");
        let _ = app.emit("rion://application-quit-requested", ());
        return;
    }
    confirm_application_shutdown(app, state);
}

struct CoreState {
    _activation: ActivationServer,
    _power_monitor: power_lifecycle::PowerMonitor,
    _quick_menu: quick_menu::QuickMenu,
    core: Arc<AppCore>,
    display_topology: DisplayTopologyCoordinator,
    application_exit_guard: ApplicationExitGuard,
    application_shutdown: ApplicationShutdownCoordinator,
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

#[derive(Debug, Eq, PartialEq)]
enum ApplicationExitRequest {
    StartShutdown,
    WaitForShutdown,
    Exit,
}

#[derive(Default)]
struct ApplicationShutdownCoordinator {
    started: AtomicBool,
    ready_to_exit: AtomicBool,
}

impl ApplicationShutdownCoordinator {
    fn mark_started(&self) {
        self.started.store(true, Ordering::Release);
    }

    fn request_exit(&self) -> ApplicationExitRequest {
        if self.ready_to_exit.load(Ordering::Acquire) {
            return ApplicationExitRequest::Exit;
        }
        if self.started.swap(true, Ordering::AcqRel) {
            ApplicationExitRequest::WaitForShutdown
        } else {
            ApplicationExitRequest::StartShutdown
        }
    }

    fn mark_ready_to_exit(&self) {
        self.ready_to_exit.store(true, Ordering::Release);
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
