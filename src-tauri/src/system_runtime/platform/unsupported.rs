// unsupported system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

#[cfg(not(any(windows, target_os = "macos")))]
fn dispatch_key_effect(_webview: &Webview, _effect: &EmbeddedKeyEffectRecord) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
        "Trusted System WebView input is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn dispatch_mouse_effect(
    _webview: &Webview,
    _point: ClickPoint,
    _button: &str,
    _pressed: bool,
) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
        "Trusted System WebView input is unavailable on this platform.",
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_platform_security_policy(_webview: &Webview) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_role_zoom_shortcut_handler(_webview: &Webview, _app: AppHandle) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_role_surface_setup_inner(
    webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let tracker = platform_surface_lifecycle_tracker(webview)?;
    install_platform_security_policy(webview)?;
    Ok(tracker)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_surface_lifecycle_tracker(
    _webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    tracker.mark_native_surface_released();
    Ok(tracker)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn quiesce_platform_surface(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    lifecycle.mark_native_surface_released();
    lifecycle.mark_isolated();
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn set_audio_muted(_webview: &Webview, _muted: bool) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "TAURI_AUDIO_MUTE_FAILED",
        "System WebView audio mute is unavailable on this platform.",
    ))
}
