impl SystemRuntimeExecutor {
    fn set_role_audio_muted(&self, role_id: &str, muted: bool) -> RuntimeResult<()> {
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Audio,
            "setRoleAudioMuted",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_role(role_id);
        if let Ok(state) = self.state()
            && let Some(tab_id) = state.role_tabs.get(role_id)
            && let Some(tab) = state.tabs.get(tab_id)
        {
            operation.tab_id = Some(tab_id.clone());
            operation.window_id = Some(tab.window_id.clone());
            operation.surface_generation = tab.roles.get(role_id).map(|role| role.generation);
        }
        let result = self.apply_role_audio_muted(role_id, muted);
        let receipt = match result.as_ref() {
            Ok(()) => NativeOperationReceipt::applied(operation, "audioMuteApplied"),
            Err(error) if error.code == "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED" => {
                let receipt = NativeOperationReceipt::with_status(
                    operation,
                    "audioMuteRollbackFailed",
                    NativeOperationStatus::Indeterminate,
                    Some(error.code),
                );
                if let Some(count) = error.rollback_error_count {
                    receipt.with_rollback_error_count(count as usize)
                } else {
                    receipt
                }
            }
            Err(error) => NativeOperationReceipt::with_status(
                operation,
                "audioMuteFailed",
                NativeOperationStatus::Failed,
                Some(error.code),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn apply_role_audio_muted(&self, role_id: &str, muted: bool) -> RuntimeResult<()> {
        let (tab_id, previous_muted, webviews, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let tab_role_ids = tab.roles.keys().cloned().collect::<HashSet<_>>();
            let webviews = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| tab_role_ids.contains(*popup_role_id))
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (tab_id, tab.audio_muted, webviews, popup_labels)
        };
        let mut all_webviews = webviews;
        for label in popup_labels {
            let webview = self.app.get_webview(&label).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_POPUP_HANDLE_MISSING",
                    format!("Runtime popup {label} has no live native handle."),
                )
            })?;
            all_webviews.push(webview);
        }
        if let Err(failure) = apply_reversible_fanout(
            &all_webviews,
            |index, webview| {
                set_audio_muted(webview, muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            },
            |index, webview| {
                set_audio_muted(webview, previous_muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_AUDIO_MUTE_FAILED",
                "Updating runtime tab audio mute",
                &failure,
            ));
        }
        let commit = (|| -> RuntimeResult<()> {
            let mut state = self.state()?;
            let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_AUDIO_STALE",
                    "The runtime tab stopped while updating audio mute.",
                )
            })?;
            if tab.audio_muted != previous_muted {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_AUDIO_STALE",
                    "The runtime tab audio state changed concurrently.",
                ));
            }
            tab.audio_muted = muted;
            Ok(())
        })();
        if let Err(error) = commit {
            let rollback_errors = rollback_reversible_fanout(&all_webviews, |index, webview| {
                set_audio_muted(webview, previous_muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            });
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
                return Err(RuntimeError::new(
                    "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED",
                    format!(
                        "{} Compensation also failed: {}. Restart Rion Studio to recover safely.",
                        error.message,
                        rollback_errors.join("; ")
                    ),
                )
                .with_rollback_error_count(rollback_errors.len()));
            }
            return Err(error);
        }
        Ok(())
    }

    fn role_webview(&self, role_id: &str) -> RuntimeResult<Webview> {
        let state = self.state()?;
        let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role was not found.",
            )
        })?;
        state.tabs[tab_id]
            .roles
            .get(role_id)
            .map(|role| role.webview.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })
    }

    fn require_roles(&self, role_ids: &[String]) -> RuntimeResult<()> {
        let state = self.state()?;
        if role_ids
            .iter()
            .all(|role_id| state.role_tabs.contains_key(role_id))
        {
            Ok(())
        } else {
            Err(RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "A runtime role was not found.",
            ))
        }
    }

    fn state(&self) -> RuntimeResult<std::sync::MutexGuard<'_, RuntimeState>> {
        self.state.lock().map_err(|_| {
            RuntimeError::new(
                "TAURI_RUNTIME_STATE_FAILED",
                "System runtime state lock poisoned.",
            )
        })
    }

}
impl Drop for SystemRuntimeExecutor {
    fn drop(&mut self) {
        let _ = self.close_all();
    }
}

fn handle_browser_download(
    app: &AppHandle,
    role_id: Option<&str>,
    event: DownloadEvent<'_>,
) -> bool {
    let (payload, allowed) = match event {
        DownloadEvent::Requested { url, .. } => (
            json!({
                "state": "blocked",
                "roleId": role_id,
                "url": url
            }),
            false,
        ),
        DownloadEvent::Finished { url, path, success } => (
            json!({
                "state": if success { "completed" } else { "failed" },
                "roleId": role_id,
                "url": url,
                "path": path.map(|path| path.to_string_lossy().into_owned())
            }),
            true,
        ),
        _ => return false,
    };
    let _ = app.emit("rion://browser-download", payload);
    allowed
}

fn evaluate_system_webview(webview: &Webview, source: &str) -> RuntimeResult<String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .eval_with_callback(source, move |value| {
            let _ = sender.send(value);
        })
        .map_err(RuntimeError::tauri)?;
    receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| {
        RuntimeError::new(
            "TAURI_EVALUATION_TIMEOUT",
            "System WebView JavaScript evaluation timed out.",
        )
    })
}

fn empty_performance_diagnostics(
    captured_at: String,
    platform: String,
    status: BrowserPerformanceDiagnosticStatus,
    high_refresh_rate_requested: bool,
    sample_duration: Duration,
    system_low_power_mode_enabled: Option<bool>,
    system_thermal_state: Option<String>,
) -> BrowserPerformanceDiagnosticsRecord {
    BrowserPerformanceDiagnosticsRecord {
        captured_at,
        platform,
        status,
        window_id: None,
        window_focused: false,
        display_refresh_rate_hz: None,
        system_low_power_mode_enabled,
        system_thermal_state,
        high_refresh_rate_requested,
        sample_duration_ms: sample_duration.as_millis().min(u32::MAX as u128) as u32,
        surfaces: Vec::new(),
    }
}

fn decode_performance_diagnostic_readback(
    raw: &str,
) -> RuntimeResult<PerformanceDiagnosticReadback> {
    let value = serde_json::from_str::<Value>(raw).map_err(|error| {
        RuntimeError::new(
            "PERFORMANCE_DIAGNOSTIC_INVALID",
            format!("System WebView returned invalid diagnostic JSON: {error}"),
        )
    })?;
    let value = if let Some(nested) = value.as_str() {
        serde_json::from_str::<Value>(nested).map_err(|error| {
            RuntimeError::new(
                "PERFORMANCE_DIAGNOSTIC_INVALID",
                format!("System WebView returned invalid nested diagnostic JSON: {error}"),
            )
        })?
    } else {
        value
    };
    serde_json::from_value(value).map_err(|error| {
        RuntimeError::new(
            "PERFORMANCE_DIAGNOSTIC_INVALID",
            format!("System WebView returned an invalid diagnostic result: {error}"),
        )
    })
}

fn completed_performance_surface(
    surface: PerformanceDiagnosticSurface,
    mut readback: PerformanceDiagnosticReadback,
    display_refresh_rate_hz: Option<f64>,
) -> BrowserPerformanceSurfaceDiagnosticRecord {
    readback.graphics.error = readback.graphics.error.and_then(bounded_diagnostic_text);
    readback.graphics.renderer = readback.graphics.renderer.and_then(bounded_diagnostic_text);
    readback.graphics.vendor = readback.graphics.vendor.and_then(bounded_diagnostic_text);
    readback.graphics.webgl = diagnostic_availability(&readback.graphics.webgl);
    readback.graphics.webgl2 = diagnostic_availability(&readback.graphics.webgl2);
    readback.graphics.webgpu = diagnostic_availability(&readback.graphics.webgpu);
    let (slow_frame_count, missed_vsync_count) =
        frame_budget_diagnostics(&readback.frame_intervals_ms, display_refresh_rate_hz);
    BrowserPerformanceSurfaceDiagnosticRecord {
        role_id: surface.role_id,
        origin: surface.origin,
        document_visibility_state: match readback.document_visibility_state.as_str() {
            "visible" | "hidden" | "prerender" => readback.document_visibility_state,
            _ => "unknown".to_owned(),
        },
        document_has_focus: readback.document_has_focus,
        viewport_width: finite_non_negative(readback.viewport_width).unwrap_or(0.0),
        viewport_height: finite_non_negative(readback.viewport_height).unwrap_or(0.0),
        device_pixel_ratio: finite_non_negative(readback.device_pixel_ratio).unwrap_or(1.0),
        hardware_concurrency: readback.hardware_concurrency.min(1_024),
        frame_count: readback.frame_count,
        observed_duration_ms: finite_non_negative(readback.observed_duration_ms).unwrap_or(0.0),
        average_fps: readback
            .average_fps
            .and_then(finite_non_negative)
            .map(|value| value.min(1_000.0)),
        p50_frame_interval_ms: readback.p50_frame_interval_ms.and_then(finite_non_negative),
        p95_frame_interval_ms: readback.p95_frame_interval_ms.and_then(finite_non_negative),
        p99_frame_interval_ms: readback.p99_frame_interval_ms.and_then(finite_non_negative),
        longest_frame_interval_ms: readback
            .longest_frame_interval_ms
            .and_then(finite_non_negative),
        slow_frame_count,
        missed_vsync_count,
        long_task_count: readback.long_task_count.map(|value| value.min(2_048)),
        long_task_total_duration_ms: readback
            .long_task_total_duration_ms
            .and_then(finite_non_negative),
        longest_task_ms: readback.longest_task_ms.and_then(finite_non_negative),
        graphics: readback.graphics,
        high_refresh_rate_status: surface.high_refresh_rate_status,
        error: None,
    }
}

fn failed_performance_surface(
    surface: PerformanceDiagnosticSurface,
    error: String,
) -> BrowserPerformanceSurfaceDiagnosticRecord {
    BrowserPerformanceSurfaceDiagnosticRecord {
        role_id: surface.role_id,
        origin: surface.origin,
        document_visibility_state: "unknown".to_owned(),
        document_has_focus: false,
        viewport_width: 0.0,
        viewport_height: 0.0,
        device_pixel_ratio: 1.0,
        hardware_concurrency: 0,
        frame_count: 0,
        observed_duration_ms: 0.0,
        average_fps: None,
        p50_frame_interval_ms: None,
        p95_frame_interval_ms: None,
        p99_frame_interval_ms: None,
        longest_frame_interval_ms: None,
        slow_frame_count: None,
        missed_vsync_count: None,
        long_task_count: None,
        long_task_total_duration_ms: None,
        longest_task_ms: None,
        graphics: StateWebGraphicsRecord {
            error: None,
            renderer: None,
            vendor: None,
            webgl: "unknown".to_owned(),
            webgl2: "unknown".to_owned(),
            webgpu: "unknown".to_owned(),
        },
        high_refresh_rate_status: surface.high_refresh_rate_status,
        error: bounded_diagnostic_text(error),
    }
}

fn frame_budget_diagnostics(
    frame_intervals_ms: &[f64],
    display_refresh_rate_hz: Option<f64>,
) -> (Option<u32>, Option<u32>) {
    let Some(refresh_rate) =
        display_refresh_rate_hz.filter(|value| value.is_finite() && *value > 1.0)
    else {
        return (None, None);
    };
    let frame_budget_ms = 1_000.0 / refresh_rate;
    let slow_threshold_ms = frame_budget_ms * 1.5;
    let mut slow_frames = 0_u64;
    let mut missed_vsyncs = 0_u64;
    for interval in frame_intervals_ms
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        if interval <= slow_threshold_ms {
            continue;
        }
        slow_frames = slow_frames.saturating_add(1);
        let elapsed_budgets = (interval / frame_budget_ms).ceil().max(1.0) as u64;
        missed_vsyncs = missed_vsyncs.saturating_add(elapsed_budgets.saturating_sub(1));
    }
    (
        Some(slow_frames.min(u32::MAX as u64) as u32),
        Some(missed_vsyncs.min(u32::MAX as u64) as u32),
    )
}

fn bounded_diagnostic_text(value: String) -> Option<String> {
    (!value.is_empty()).then(|| value.chars().take(512).collect())
}

fn diagnostic_availability(value: &str) -> String {
    if matches!(value, "available" | "unavailable" | "unknown") {
        value.to_owned()
    } else {
        "unknown".to_owned()
    }
}

fn finite_non_negative(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

#[cfg(target_os = "macos")]
fn platform_display_refresh_rate(window: &Window) -> Option<f64> {
    unsafe extern "C" {
        fn rion_ns_window_display_refresh_rate(window: *mut std::ffi::c_void) -> f64;
    }
    let raw_window = window.ns_window().ok()?;
    finite_non_negative(unsafe { rion_ns_window_display_refresh_rate(raw_window) })
        .filter(|value| *value > 1.0)
}

#[cfg(windows)]
fn platform_display_refresh_rate(window: &Window) -> Option<f64> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetDeviceCaps, ReleaseDC, VREFRESH};

    let hwnd = window.hwnd().ok()?;
    let device_context = unsafe { GetDC(Some(hwnd)) };
    if device_context.0.is_null() {
        return None;
    }
    let refresh_rate = unsafe { GetDeviceCaps(Some(device_context), VREFRESH) };
    unsafe {
        ReleaseDC(Some(hwnd), device_context);
    }
    (refresh_rate > 1).then_some(refresh_rate as f64)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_display_refresh_rate(_window: &Window) -> Option<f64> {
    None
}

#[cfg(target_os = "macos")]
fn platform_performance_environment() -> PlatformPerformanceEnvironment {
    unsafe extern "C" {
        fn rion_ns_low_power_mode_enabled() -> i32;
        fn rion_ns_thermal_state() -> i32;
    }

    PlatformPerformanceEnvironment {
        system_low_power_mode_enabled: match unsafe { rion_ns_low_power_mode_enabled() } {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
        system_thermal_state: decode_macos_thermal_state(unsafe { rion_ns_thermal_state() }),
    }
}

#[cfg(windows)]
fn platform_performance_environment() -> PlatformPerformanceEnvironment {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS::default();
    let system_low_power_mode_enabled = unsafe { GetSystemPowerStatus(&mut status) }
        .ok()
        .and_then(|()| windows_low_power_mode_from_system_status_flag(status.SystemStatusFlag));
    PlatformPerformanceEnvironment {
        system_low_power_mode_enabled,
        system_thermal_state: None,
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_performance_environment() -> PlatformPerformanceEnvironment {
    PlatformPerformanceEnvironment {
        system_low_power_mode_enabled: None,
        system_thermal_state: None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn decode_macos_thermal_state(value: i32) -> Option<String> {
    match value {
        0 => Some("nominal"),
        1 => Some("fair"),
        2 => Some("serious"),
        3 => Some("critical"),
        4 => Some("unknown"),
        _ => None,
    }
    .map(str::to_owned)
}

#[cfg(any(windows, test))]
fn windows_low_power_mode_from_system_status_flag(value: u8) -> Option<bool> {
    match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn surface_host_initialization_requires_visible_parent(platform: &str) -> bool {
    platform == "windows"
}

#[cfg(windows)]
fn set_windows_surface_host_initialization_visibility(
    window: &Window,
    visible: bool,
) -> RuntimeResult<()> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow},
    };

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?.0 as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let hwnd = HWND(hwnd as *mut std::ffi::c_void);
            let command = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
            unsafe {
                let _ = ShowWindow(hwnd, command);
            }
            let _ = sender.send(());
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|error| {
            let action = if visible { "show" } else { "hide" };
            RuntimeError::new(
                "SYSTEM_WEBVIEW_CREATION_STALLED",
                format!(
                    "The Windows WebView2 parent window did not {action} within {}ms ({error}). Restart Rion Studio before launching another browser role.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                ),
            )
        })
}

struct SessionPaths {
    webkit_identifier: [u8; 16],
    webview2: PathBuf,
}
