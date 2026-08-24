// unsupported system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

use super::super::*;

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn ensure_platform_automation_surface_ready(
    _webview: &Webview,
    context: &InputDispatchContext,
) -> AutomationSurfaceReadinessOutcome {
    AutomationSurfaceReadinessOutcome {
        observation: AutomationSurfaceReadinessObservation {
            controller_visible: None,
            policy_mode: "unsupported",
            resume_attempted: false,
            suspended_after: None,
            suspended_before: None,
        },
        result: context.ensure_current(),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn platform_webview_diagnostics(
    _webview: &Webview,
) -> PlatformWebViewDiagnostics {
    PlatformWebViewDiagnostics::default()
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn platform_page_zoom(_webview: &Webview) -> RuntimeResult<f64> {
    Err(RuntimeError::new(
        "BROWSER_PAGE_ZOOM_UNAVAILABLE",
        "Applied System WebView page zoom is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn platform_workspace_web_history_state(
    _webview: &Webview,
) -> RuntimeResult<(bool, bool)> {
    Err(RuntimeError::new(
        "WORKSPACE_WEB_HISTORY_UNAVAILABLE",
        "Native Workspace Web navigation history is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_workspace_web_navigation(
    _webview: &Webview,
    _action: WorkspaceWebNativeNavigationAction,
) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "WORKSPACE_WEB_NAVIGATION_UNAVAILABLE",
        "Native Workspace Web navigation is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_hide(
    window: &Window,
) -> RuntimeResult<()> {
    window.hide().map_err(RuntimeError::tauri)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_show(
    window: &Window,
) -> RuntimeResult<()> {
    window.show().map_err(RuntimeError::tauri)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_minimize(
    window: &Window,
) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_webview_window_minimize(
    window: &WebviewWindow,
) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_restore(
    window: &Window,
) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_set_maximized(
    window: &Window,
    maximized: bool,
) -> Result<(), String> {
    if maximized {
        window.maximize()
    } else {
        window.unmaximize()
    }
    .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_set_fullscreen(
    window: &Window,
    fullscreen: bool,
) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_toggle_fullscreen(
    window: &Window,
) -> Result<(), String> {
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    request_platform_window_set_fullscreen(window, !fullscreen)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_toggle_maximized(
    window: &Window,
) -> Result<(), String> {
    window
        .is_maximized()
        .map_err(|error| error.to_string())
        .and_then(|maximized| {
            if maximized {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|error| error.to_string())
        })
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_window_show_foreground(
    window: &Window,
) -> RuntimeResult<()> {
    window.show().map_err(RuntimeError::tauri)?;
    window.set_focus().map_err(RuntimeError::tauri)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn platform_window_is_focused(
    window: &Window,
) -> RuntimeResult<bool> {
    window.is_focused().map_err(RuntimeError::tauri)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_webview_window_show(
    window: &WebviewWindow,
) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_webview_window_toggle_maximized(
    window: &WebviewWindow,
) -> Result<bool, String> {
    window
        .is_maximized()
        .map_err(|error| error.to_string())
        .and_then(|maximized| {
            if maximized {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|error| error.to_string())?;
            Ok(!maximized)
        })
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_webview_window_set_fullscreen(
    window: &WebviewWindow,
    fullscreen: bool,
) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn request_platform_webview_window_show_foreground(
    window: &WebviewWindow,
) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn dispatch_key_effect(
    _webview: &Webview,
    _effect: &EmbeddedKeyEffectRecord,
    _context: &InputDispatchContext,
) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
        "Trusted System WebView input is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn dispatch_key_effect_with_physical_modifiers(
    _webview: &Webview,
    _effect: &EmbeddedKeyEffectRecord,
    _physical_modifier_codes: &[String],
    _context: &InputDispatchContext,
    _dispatch_projection: impl FnMut(&EmbeddedKeyEffectRecord) -> RuntimeResult<()>,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn dispatch_mouse_effect(
    _webview: &Webview,
    _viewport: ViewportSize,
    _point: ClickPoint,
    _button: &str,
    _pressed: bool,
    _context: &InputDispatchContext,
) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
        "Trusted System WebView input is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn dispatch_mouse_click_sequence(
    webview: &Webview,
    viewport: ViewportSize,
    point: ClickPoint,
    button: &str,
    context: &InputDispatchContext,
    cleanup_context: impl FnMut() -> InputDispatchContext,
) -> Result<MouseInputDispatchDiagnostics, Box<MouseInputSequenceError>> {
    dispatch_mouse_input_sequence(
        context,
        cleanup_context,
        MouseInputDispatchDiagnostics::default(),
        || {},
        |pressed, context| {
            dispatch_mouse_effect(webview, viewport, point, button, pressed, context)
        },
    )
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn install_platform_security_policy(
    _webview: &Webview,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn install_platform_contained_fullscreen_policy(
    _webview: &Webview,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn preflight_platform_contained_fullscreen_policy(
    _webview: &Webview,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn install_role_application_shortcut_handler(
    _webview: &Webview,
    _app: AppHandle,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn platform_role_surface_setup_inner(
    webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let tracker = platform_surface_lifecycle_tracker(webview, SurfaceProcessExitTracking::Enabled)?;
    install_platform_security_policy(webview)?;
    Ok(tracker)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn platform_surface_lifecycle_tracker(
    _webview: &Webview,
    _process_exit_tracking: SurfaceProcessExitTracking,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    tracker.mark_native_surface_released();
    Ok(tracker)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn perform_platform_surface_quiesce(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
    _defer_navigation_to_preflight: bool,
) -> RuntimeResult<()> {
    lifecycle.mark_native_surface_released();
    let _ = lifecycle.mark_isolated(2);
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn release_platform_surface(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    lifecycle.mark_native_surface_released();
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(in crate::system_runtime) fn set_audio_muted(
    _webview: &Webview,
    _muted: bool,
) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "TAURI_AUDIO_MUTE_FAILED",
        "System WebView audio mute is unavailable on this platform.",
    ))
}
