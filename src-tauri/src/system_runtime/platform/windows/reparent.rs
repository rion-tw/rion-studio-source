#[cfg(any(windows, test))]
const WINDOWS_REPARENT_SYNC_TIMEOUT: Duration = Duration::from_millis(250);

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsReparentSurfaceSyncResult {
    failure: Option<WindowsReparentSurfaceSyncFailure>,
    label: String,
    notified: bool,
    verified: bool,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsReparentSurfaceSyncFailure {
    message: String,
    stage: &'static str,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsReparentSyncOutcome {
    completed_surface_count: usize,
    elapsed_ms: u64,
    notified_surface_count: usize,
    surface_count: usize,
    verified_surface_count: usize,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsReparentSyncFailure {
    completed_surface_count: usize,
    elapsed_ms: u64,
    failed_surface_label: Option<String>,
    message: String,
    notified_surface_count: usize,
    stage: &'static str,
    surface_count: usize,
    timed_out: bool,
    verified_surface_count: usize,
}

#[cfg(any(windows, test))]
fn reparent_sync_elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

#[cfg(any(windows, test))]
fn collect_windows_reparent_sync_results(
    receiver: Receiver<WindowsReparentSurfaceSyncResult>,
    surface_count: usize,
    scheduled_surface_count: usize,
    started: Instant,
    deadline: Instant,
    scheduling_failure: Option<WindowsReparentSurfaceSyncFailure>,
    scheduling_failure_label: Option<String>,
) -> Result<WindowsReparentSyncOutcome, WindowsReparentSyncFailure> {
    let mut completed_surface_count = 0;
    let mut failed_surface_label = scheduling_failure_label;
    let mut first_failure = scheduling_failure;
    let mut notified_surface_count = 0;
    let mut verified_surface_count = 0;

    while completed_surface_count < scheduled_surface_count {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(result) => {
                completed_surface_count += 1;
                notified_surface_count += usize::from(result.notified);
                verified_surface_count += usize::from(result.verified);
                if first_failure.is_none()
                    && let Some(failure) = result.failure
                {
                    failed_surface_label = Some(result.label);
                    first_failure = Some(failure);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(WindowsReparentSyncFailure {
                    completed_surface_count,
                    elapsed_ms: reparent_sync_elapsed_ms(started),
                    failed_surface_label,
                    message: format!(
                        "WebView2 reparent synchronization timed out after {}ms.",
                        WINDOWS_REPARENT_SYNC_TIMEOUT.as_millis()
                    ),
                    notified_surface_count,
                    stage: "callback-timeout",
                    surface_count,
                    timed_out: true,
                    verified_surface_count,
                });
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WindowsReparentSyncFailure {
                    completed_surface_count,
                    elapsed_ms: reparent_sync_elapsed_ms(started),
                    failed_surface_label,
                    message: "WebView2 reparent synchronization callback disconnected."
                        .to_owned(),
                    notified_surface_count,
                    stage: "callback-disconnected",
                    surface_count,
                    timed_out: false,
                    verified_surface_count,
                });
            }
        }
    }

    if let Some(failure) = first_failure {
        return Err(WindowsReparentSyncFailure {
            completed_surface_count,
            elapsed_ms: reparent_sync_elapsed_ms(started),
            failed_surface_label,
            message: failure.message,
            notified_surface_count,
            stage: failure.stage,
            surface_count,
            timed_out: false,
            verified_surface_count,
        });
    }

    Ok(WindowsReparentSyncOutcome {
        completed_surface_count,
        elapsed_ms: reparent_sync_elapsed_ms(started),
        notified_surface_count,
        surface_count,
        verified_surface_count,
    })
}

#[cfg(windows)]
fn synchronize_windows_reparented_surfaces(
    surfaces: &[Webview],
    target_window: &Window,
) -> Result<WindowsReparentSyncOutcome, WindowsReparentSyncFailure> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GA_ROOT, GetAncestor},
    };

    let started = Instant::now();
    let deadline = started + WINDOWS_REPARENT_SYNC_TIMEOUT;
    let expected_root = match target_window.hwnd() {
        Ok(hwnd) => hwnd.0 as usize,
        Err(error) => {
            return Err(WindowsReparentSyncFailure {
                completed_surface_count: 0,
                elapsed_ms: reparent_sync_elapsed_ms(started),
                failed_surface_label: None,
                message: error.to_string(),
                notified_surface_count: 0,
                stage: "target-window-handle",
                surface_count: surfaces.len(),
                timed_out: false,
                verified_surface_count: 0,
            });
        }
    };
    let (sender, receiver) = mpsc::channel();
    let mut scheduled_surface_count = 0;
    let mut scheduling_failure = None;
    let mut scheduling_failure_label = None;

    for surface in surfaces {
        let callback_sender = sender.clone();
        let label = surface.label().to_owned();
        let callback_label = label.clone();
        match surface.with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut controller_parent = HWND::default();
            let mut result = WindowsReparentSurfaceSyncResult {
                failure: None,
                label: callback_label,
                notified: false,
                verified: false,
            };
            if let Err(error) = controller.ParentWindow(&mut controller_parent) {
                result.failure = Some(WindowsReparentSurfaceSyncFailure {
                    message: error.to_string(),
                    stage: "controller-parent-window",
                });
            } else {
                let actual_root = GetAncestor(controller_parent, GA_ROOT);
                let expected_root = HWND(expected_root as *mut std::ffi::c_void);
                if actual_root != expected_root {
                    result.failure = Some(WindowsReparentSurfaceSyncFailure {
                        message:
                            "The WebView2 container is not attached to the target Game Window."
                                .to_owned(),
                        stage: "ancestor-mismatch",
                    });
                } else {
                    result.verified = true;
                    match controller.NotifyParentWindowPositionChanged() {
                        Ok(()) => result.notified = true,
                        Err(error) => {
                            result.failure = Some(WindowsReparentSurfaceSyncFailure {
                                message: error.to_string(),
                                stage: "notify-parent-position",
                            });
                        }
                    }
                }
            }
            let _ = callback_sender.send(result);
        }) {
            Ok(()) => scheduled_surface_count += 1,
            Err(error) if scheduling_failure.is_none() => {
                scheduling_failure_label = Some(label.clone());
                scheduling_failure = Some(WindowsReparentSurfaceSyncFailure {
                    message: error.to_string(),
                    stage: "callback-scheduling",
                });
            }
            Err(_) => {}
        }
    }
    drop(sender);

    collect_windows_reparent_sync_results(
        receiver,
        surfaces.len(),
        scheduled_surface_count,
        started,
        deadline,
        scheduling_failure,
        scheduling_failure_label,
    )
}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    #[allow(clippy::too_many_arguments)]
    fn record_windows_reparent_sync_event(
        &self,
        event: &'static str,
        message: &'static str,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        trigger: &'static str,
        result: Result<&WindowsReparentSyncOutcome, &WindowsReparentSyncFailure>,
        rollback_error_count: Option<usize>,
    ) {
        let core = Arc::clone(&self.core);
        let (level, context, error) = match result {
            Ok(outcome) => (
                if rollback_error_count.unwrap_or_default() == 0 {
                    LogLevel::Debug
                } else {
                    LogLevel::Warn
                },
                json!({
                    "completedSurfaceCount": outcome.completed_surface_count,
                    "elapsedMs": outcome.elapsed_ms,
                    "notifiedSurfaceCount": outcome.notified_surface_count,
                    "platform": "windows",
                    "rollbackErrorCount": rollback_error_count,
                    "sourceWindowId": source_window_id,
                    "surfaceCount": outcome.surface_count,
                    "tabId": tab_id,
                    "targetWindowId": target_window_id,
                    "timedOut": false,
                    "trigger": trigger,
                    "verifiedSurfaceCount": outcome.verified_surface_count,
                }),
                None,
            ),
            Err(failure) => (
                LogLevel::Warn,
                json!({
                    "completedSurfaceCount": failure.completed_surface_count,
                    "elapsedMs": failure.elapsed_ms,
                    "failedSurfaceLabel": failure.failed_surface_label,
                    "failureStage": failure.stage,
                    "notifiedSurfaceCount": failure.notified_surface_count,
                    "platform": "windows",
                    "rollbackErrorCount": rollback_error_count,
                    "sourceWindowId": source_window_id,
                    "surfaceCount": failure.surface_count,
                    "tabId": tab_id,
                    "targetWindowId": target_window_id,
                    "timedOut": failure.timed_out,
                    "trigger": trigger,
                    "verifiedSurfaceCount": failure.verified_surface_count,
                }),
                Some(log_error_details(
                    "SYSTEM_WEBVIEW_REPARENT_SYNC_FAILED",
                    &failure.message,
                )),
            ),
        };
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
}
