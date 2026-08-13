impl SystemRuntimeExecutor {
    fn apply_role_audio_muted(
        &self,
        role_id: &str,
        muted: bool,
        previous_muted: bool,
    ) -> RuntimeResult<()> {
        let (webviews, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.native_tab_id_for_role_surface(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            let tab = state.native_resources.tabs.get(&tab_id).ok_or_else(|| {
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
            (webviews, popup_labels)
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
        Ok(())
    }

    fn role_webview(&self, role_id: &str) -> RuntimeResult<Webview> {
        let state = self.state()?;
        let tab_id = state.native_tab_id_for_role_surface(role_id).ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role was not found.",
            )
        })?;
        state.native_resources.tabs[tab_id]
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
            .all(|role_id| state.has_native_role_surface(role_id))
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
        let pending_operation_ids = self
            .core
            .runtime_kernel()
            .snapshot()
            .map(|snapshot| {
                snapshot
                    .operations
                    .into_values()
                    .filter(|operation| operation.phase == RuntimeOperationPhase::Pending)
                    .map(|operation| operation.operation_id.into_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !pending_operation_ids.is_empty() {
            let _ = self.fail_runtime_event_stream(
                &uuid::Uuid::new_v4().to_string(),
                &pending_operation_ids,
                "NATIVE_EVENT_STREAM_STOPPED",
            );
        }
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

fn performance_diagnostic_operation_record(
    state: &PerformanceDiagnosticOperationState,
    diagnostics: Option<BrowserPerformanceDiagnosticsRecord>,
    error: Option<String>,
) -> BrowserPerformanceDiagnosticOperationRecord {
    BrowserPerformanceDiagnosticOperationRecord {
        operation_id: state.operation_id.clone(),
        revision: state.revision,
        phase: state.phase,
        diagnostics,
        error: error.and_then(bounded_diagnostic_text),
    }
}

fn transition_performance_diagnostic_phase(
    state: &mut PerformanceDiagnosticOperationState,
    expected: &[BrowserPerformanceDiagnosticOperationPhase],
    next: BrowserPerformanceDiagnosticOperationPhase,
) -> bool {
    if !expected.contains(&state.phase) {
        return false;
    }
    state.revision = state.revision.saturating_add(1);
    state.phase = next;
    true
}

fn empty_performance_diagnostics(
    captured_at: String,
    platform: String,
    status: BrowserPerformanceDiagnosticStatus,
    configuration: &RuntimeWebViewConfiguration,
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
        high_refresh_rate_requested: configuration.macos_high_refresh_rate,
        maximum_web_gl_performance_requested: configuration.maximum_web_gl_performance,
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
    let platform = platform_webview_diagnostics(&surface.webview);
    readback.graphics.renderer = platform
        .graphics_renderer
        .clone()
        .or(readback.graphics.renderer);
    readback.graphics.vendor = platform
        .graphics_vendor
        .clone()
        .or(readback.graphics.vendor);
    readback.graphics.error = readback.graphics.error.and_then(bounded_diagnostic_text);
    readback.graphics.renderer = readback.graphics.renderer.and_then(bounded_diagnostic_text);
    readback.graphics.vendor = readback.graphics.vendor.and_then(bounded_diagnostic_text);
    readback.graphics.webgl = diagnostic_availability(&readback.graphics.webgl);
    readback.graphics.webgl2 = diagnostic_availability(&readback.graphics.webgl2);
    readback.graphics.webgpu = diagnostic_availability(&readback.graphics.webgpu);
    let (slow_frame_count, missed_vsync_count) =
        frame_budget_diagnostics(&readback.frame_intervals_ms, display_refresh_rate_hz);
    let hardware_acceleration = platform
        .hardware_acceleration_enabled
        .or_else(|| hardware_acceleration_enabled(&readback.graphics));
    let gpu_process_present = platform.gpu_process_present.or(match surface
        .web_gl_configuration
        .execution_path
    {
        WebGlExecutionPath::WebContentDirect => Some(false),
        WebGlExecutionPath::GpuProcess | WebGlExecutionPath::EngineManaged => Some(true),
        WebGlExecutionPath::Unknown => None,
    });
    let maximum_mode_status = maximum_mode_status_with_evidence(
        cfg!(windows),
        surface.web_gl_configuration.maximum_mode_status,
        platform.browser_process_present,
        platform.renderer_process_present,
        gpu_process_present,
        hardware_acceleration,
    );
    let web_gl_execution_path = web_gl_execution_path_with_evidence(
        surface.web_gl_configuration.execution_path,
        maximum_mode_status,
    );
    let game_loop_fps = readback
        .game_loop_fps
        .and_then(finite_non_negative)
        .map(|value| value.min(1_000.0));
    let game_loop_p10_fps = readback
        .game_loop_p10_fps
        .and_then(finite_non_negative)
        .map(|value| value.min(1_000.0));
    let context_loss_count = readback.context_loss_count.map(|value| value.min(1_024));
    let performance_target_status = performance_target_status(
        surface.web_gl_configuration.performance_target_status,
        PerformanceTargetEvidence {
            context_loss_count,
            display_refresh_rate_hz,
            game_loop_fps,
            game_loop_p10_fps,
            hardware_acceleration_enabled: hardware_acceleration,
            missed_vsync_count,
            presentation_fps: readback.presentation_fps,
            presentation_sample_count: readback.frame_intervals_ms.len(),
        },
    );
    let web_kit_runtime_version = if cfg!(target_os = "macos") {
        platform.runtime_version.clone()
    } else {
        None
    };
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
        presentation_fps: readback
            .presentation_fps
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
        use_gpu_process_for_web_gl_status: surface
            .web_gl_configuration
            .web_gl_feature_status,
        use_gpu_process_for_dom_rendering_status: surface
            .web_gl_configuration
            .dom_rendering_feature_status,
        use_gpu_process_for_canvas_rendering_status: surface
            .web_gl_configuration
            .canvas_rendering_feature_status,
        web_gl_execution_path,
        maximum_mode_status,
        web_gl_command_batching_status: surface.web_gl_configuration.command_batching_status,
        performance_target_status,
        webview_runtime_version: platform.runtime_version.clone(),
        web_kit_runtime_version,
        browser_process_present: platform.browser_process_present,
        renderer_process_present: platform.renderer_process_present,
        gpu_process_present,
        hardware_acceleration_enabled: hardware_acceleration,
        primary_canvas: readback.primary_canvas,
        web_gl_context_attributes: readback.web_gl_context_attributes,
        game_loop_fps,
        game_loop_p10_fps,
        game_loop_timing_mode: readback.game_loop_timing_mode,
        game_loop_timing_value: readback.game_loop_timing_value.and_then(finite_non_negative),
        game_loop_timer_drift_p95_ms: readback
            .game_loop_timer_drift_p95_ms
            .and_then(finite_non_negative),
        context_loss_count,
        error: None,
    }
}

fn failed_performance_surface(
    surface: PerformanceDiagnosticSurface,
    error: String,
) -> BrowserPerformanceSurfaceDiagnosticRecord {
    let platform = platform_webview_diagnostics(&surface.webview);
    let maximum_mode_status = maximum_mode_status_with_evidence(
        cfg!(windows),
        surface.web_gl_configuration.maximum_mode_status,
        platform.browser_process_present,
        platform.renderer_process_present,
        platform.gpu_process_present,
        platform.hardware_acceleration_enabled,
    );
    let web_kit_runtime_version = if cfg!(target_os = "macos") {
        platform.runtime_version.clone()
    } else {
        None
    };
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
        presentation_fps: None,
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
        use_gpu_process_for_web_gl_status: surface
            .web_gl_configuration
            .web_gl_feature_status,
        use_gpu_process_for_dom_rendering_status: surface
            .web_gl_configuration
            .dom_rendering_feature_status,
        use_gpu_process_for_canvas_rendering_status: surface
            .web_gl_configuration
            .canvas_rendering_feature_status,
        web_gl_execution_path: web_gl_execution_path_with_evidence(
            surface.web_gl_configuration.execution_path,
            maximum_mode_status,
        ),
        maximum_mode_status,
        web_gl_command_batching_status: surface.web_gl_configuration.command_batching_status,
        performance_target_status: PerformanceTargetStatus::Indeterminate,
        webview_runtime_version: platform.runtime_version.clone(),
        web_kit_runtime_version,
        browser_process_present: platform.browser_process_present,
        renderer_process_present: platform.renderer_process_present,
        gpu_process_present: platform.gpu_process_present,
        hardware_acceleration_enabled: platform.hardware_acceleration_enabled,
        primary_canvas: None,
        web_gl_context_attributes: None,
        game_loop_fps: None,
        game_loop_p10_fps: None,
        game_loop_timing_mode: None,
        game_loop_timing_value: None,
        game_loop_timer_drift_p95_ms: None,
        context_loss_count: None,
        error: bounded_diagnostic_text(error),
    }
}

fn maximum_mode_status_with_evidence(
    windows_engine: bool,
    configured: MaximumWebGlPerformanceDiagnosticStatus,
    browser_process_present: Option<bool>,
    renderer_process_present: Option<bool>,
    gpu_process_present: Option<bool>,
    hardware_acceleration_enabled: Option<bool>,
) -> MaximumWebGlPerformanceDiagnosticStatus {
    if !windows_engine || configured != MaximumWebGlPerformanceDiagnosticStatus::EngineManaged {
        return configured;
    }
    let evidence = [
        browser_process_present,
        renderer_process_present,
        gpu_process_present,
        hardware_acceleration_enabled,
    ];
    if evidence.contains(&Some(false)) {
        MaximumWebGlPerformanceDiagnosticStatus::Failed
    } else if evidence.contains(&None) {
        MaximumWebGlPerformanceDiagnosticStatus::Unavailable
    } else {
        configured
    }
}

fn web_gl_execution_path_with_evidence(
    configured: WebGlExecutionPath,
    status: MaximumWebGlPerformanceDiagnosticStatus,
) -> WebGlExecutionPath {
    match status {
        MaximumWebGlPerformanceDiagnosticStatus::Unavailable
        | MaximumWebGlPerformanceDiagnosticStatus::Failed
        | MaximumWebGlPerformanceDiagnosticStatus::NotApplicable => WebGlExecutionPath::Unknown,
        _ => configured,
    }
}

#[derive(Clone, Copy)]
struct PerformanceTargetEvidence {
    context_loss_count: Option<u32>,
    display_refresh_rate_hz: Option<f64>,
    game_loop_fps: Option<f64>,
    game_loop_p10_fps: Option<f64>,
    hardware_acceleration_enabled: Option<bool>,
    missed_vsync_count: Option<u32>,
    presentation_fps: Option<f64>,
    presentation_sample_count: usize,
}

fn performance_target_status(
    configured: PerformanceTargetStatus,
    evidence: PerformanceTargetEvidence,
) -> PerformanceTargetStatus {
    if evidence.game_loop_fps.is_none() && evidence.game_loop_p10_fps.is_none() {
        return configured;
    }
    let Some((game_loop_fps, game_loop_p10_fps, presentation_fps, refresh_rate)) = evidence
        .game_loop_fps
        .zip(evidence.game_loop_p10_fps)
        .zip(evidence.presentation_fps)
        .zip(evidence.display_refresh_rate_hz)
        .map(|(((game_loop_fps, game_loop_p10_fps), presentation_fps), refresh_rate)| {
            (game_loop_fps, game_loop_p10_fps, presentation_fps, refresh_rate)
        })
    else {
        return PerformanceTargetStatus::Indeterminate;
    };
    let missed_ratio = evidence
        .missed_vsync_count
        .map(|count| count as f64 / evidence.presentation_sample_count.max(1) as f64)
        .unwrap_or(f64::INFINITY);
    if game_loop_fps >= 110.0
        && game_loop_p10_fps >= 100.0
        && presentation_fps >= refresh_rate * 0.95
        && missed_ratio <= 0.01
        && evidence.context_loss_count == Some(0)
        && evidence.hardware_acceleration_enabled == Some(true)
    {
        PerformanceTargetStatus::Passed
    } else {
        PerformanceTargetStatus::Failed
    }
}

fn hardware_acceleration_enabled(graphics: &StateWebGraphicsRecord) -> Option<bool> {
    match graphics.webgl.as_str() {
        "available" => {
            let renderer = graphics
                .renderer
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase();
            Some(!["software", "swiftshader", "llvmpipe"]
                .iter()
                .any(|marker| renderer.contains(marker)))
        }
        "unavailable" => Some(false),
        _ => None,
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
fn set_windows_runtime_window_cloaked(window: &Window, cloaked: bool) -> RuntimeResult<()> {
    use windows::{
        Win32::Graphics::Dwm::{DWMWA_CLOAK, DwmSetWindowAttribute},
        core::BOOL,
    };

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    let value = BOOL::from(cloaked);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
    }
    .map_err(RuntimeError::tauri)
}

#[cfg(windows)]
fn register_windows_runtime_window_with_taskbar(window: &Window) -> RuntimeResult<()> {
    use windows::Win32::{
        System::Com::{CLSCTX_SERVER, CoCreateInstance},
        UI::Shell::{ITaskbarList, TaskbarList},
    };

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    let taskbar: ITaskbarList = unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_SERVER) }
        .map_err(RuntimeError::tauri)?;
    unsafe { taskbar.AddTab(hwnd) }.map_err(RuntimeError::tauri)
}

#[cfg(windows)]
fn set_windows_surface_host_initialization_visibility(
    window: &Window,
    visible: bool,
) -> RuntimeResult<()> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let callback_window = window.clone();
    window
        .run_on_main_thread(move || {
            use windows::Win32::UI::WindowsAndMessaging::{
                SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow,
            };
            let result = callback_window
                .hwnd()
                .map_err(|error| error.to_string())
                .map(|hwnd| {
                    let command = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
                    let _ = unsafe { ShowWindow(hwnd, command) };
                });
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    let result = receiver
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
        })?;
    result.map_err(|error| {
        let action = if visible { "show" } else { "hide" };
        RuntimeError::new(
            "TAURI_RUNTIME_VISIBILITY_FAILED",
            format!("The Windows WebView2 parent window could not {action}: {error}"),
        )
    })
}

struct SessionPaths {
    webkit_identifier: [u8; 16],
    webview2: PathBuf,
}
