// macos system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

use super::super::*;

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn platform_webview_diagnostics(
    _webview: &Webview,
) -> PlatformWebViewDiagnostics {
    PlatformWebViewDiagnostics {
        browser_process_present: None,
        graphics_renderer: None,
        graphics_vendor: None,
        hardware_acceleration_enabled: None,
        runtime_version: macos_webkit_runtime_version(),
        renderer_process_present: Some(true),
        gpu_process_present: None,
    }
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn macos_webkit_runtime_version() -> Option<String> {
    use std::ffi::CStr;

    unsafe extern "C" {
        fn rion_wk_copy_runtime_version() -> *mut std::os::raw::c_char;
        fn rion_wk_free_c_string(value: *mut std::os::raw::c_char);
    }

    let raw = unsafe { rion_wk_copy_runtime_version() };
    if raw.is_null() {
        return None;
    }
    let value = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .trim()
        .to_owned();
    unsafe { rion_wk_free_c_string(raw) };
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn platform_page_zoom(webview: &Webview) -> RuntimeResult<f64> {
    unsafe extern "C" {
        fn rion_wk_page_zoom(webview: *mut std::ffi::c_void) -> f64;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let zoom_factor = unsafe { rion_wk_page_zoom(platform_webview.inner()) };
            let _ = sender.send(zoom_factor);
        })
        .map_err(RuntimeError::tauri)?;
    let zoom_factor = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "BROWSER_PAGE_ZOOM_TIMEOUT",
                "WKWebView page zoom acknowledgement timed out.",
            )
        })?;
    validate_applied_page_zoom(zoom_factor)
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_hide(
    window: &Window,
) -> RuntimeResult<()> {
    crate::runtime_tabs_macos::request_window_hide(window.clone());
    Ok(())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_show(
    window: &Window,
) -> RuntimeResult<()> {
    window.show().map_err(RuntimeError::tauri)
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_minimize(
    window: &Window,
) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_webview_window_minimize(
    window: &WebviewWindow,
) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_restore(
    window: &Window,
) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_set_fullscreen(
    window: &Window,
    fullscreen: bool,
) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_toggle_fullscreen(
    window: &Window,
) -> Result<(), String> {
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    request_platform_window_set_fullscreen(window, !fullscreen)
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_window_show_foreground(
    window: &Window,
) -> RuntimeResult<()> {
    crate::runtime_tabs_macos::set_appkit_window_interaction(window, false, true)
        .map_err(|message| RuntimeError::new("SYSTEM_WINDOW_FOREGROUND_SUBMISSION_FAILED", message))
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn platform_window_is_focused(
    window: &Window,
) -> RuntimeResult<bool> {
    window.is_focused().map_err(RuntimeError::tauri)
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_webview_window_show(
    window: &WebviewWindow,
) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_webview_window_set_fullscreen(
    window: &WebviewWindow,
    fullscreen: bool,
) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn request_platform_webview_window_show_foreground(
    window: &WebviewWindow,
) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn dispatch_key_effect(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    use std::{ffi::CString, os::raw::c_char};

    unsafe extern "C" {
        fn rion_wk_dispatch_key(
            webview: *mut std::ffi::c_void,
            code: *const c_char,
            key_down: bool,
            modifier_flags: u64,
            repeat: bool,
        ) -> bool;
    }

    let role_label = webview.label().to_owned();
    let needs_settle = MACOS_KEY_DISPATCH_STATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map(|previous| macos_key_dispatch_needs_settle(previous.as_deref(), &role_label))
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The macOS key dispatch lock was poisoned.",
            )
        })?;
    if needs_settle {
        // WKWebView forwards AppKit key events to the web-content process
        // asynchronously. Let the previous role consume its direct responder
        // dispatch before handing off to another role. Same-role sequences stay fast.
        std::thread::sleep(MACOS_KEY_DISPATCH_SETTLE_INTERVAL);
    }
    let code = CString::new(effect.code.as_str()).map_err(|_| {
        RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_INVALID",
            "The macOS key code contains an invalid character.",
        )
    })?;
    let key_down = effect.phase == "rawKeyDown";
    let modifier_flags = mac_modifier_flags(&effect.active_codes);
    let repeat = effect.auto_repeat;
    let submission = NativeInputSubmissionGuard::new(context);
    let callback_submission = submission.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            if !callback_submission.claim() {
                let _ = sender.send(None);
                return;
            }
            let succeeded = unsafe {
                rion_wk_dispatch_key(
                    platform_webview.inner(),
                    code.as_ptr(),
                    key_down,
                    modifier_flags,
                    repeat,
                )
            };
            let _ = sender.send(Some(succeeded));
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(context.remaining(PLATFORM_CALLBACK_TIMEOUT)) {
        Ok(Some(true)) => {
            *MACOS_KEY_DISPATCH_STATE
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_TRUSTED_INPUT_FAILED",
                        "The macOS key dispatch lock was poisoned.",
                    )
                })? = Some(role_label);
            Ok(())
        }
        Ok(Some(false)) => Err(RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
            format!("WKWebView rejected the native {} event.", effect.code),
        )),
        Ok(None) => context.ensure_current(),
        Err(_) => Err(submission.timeout_error()),
    }
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn dispatch_key_effect_with_physical_modifiers(
    _webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    physical_modifier_codes: &[String],
    _context: &InputDispatchContext,
    mut dispatch_projection: impl FnMut(&EmbeddedKeyEffectRecord) -> RuntimeResult<()>,
) -> RuntimeResult<()> {
    let confirmed_physical_modifier_codes = physical_modifier_codes
        .iter()
        .filter(|code| macos_physical_modifier_is_pressed(code))
        .cloned()
        .collect::<Vec<_>>();
    for projection in
        physical_modifier_projection_effects(effect, &confirmed_physical_modifier_codes, |_| true)
    {
        dispatch_projection(&projection)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_physical_modifier_is_pressed(code: &str) -> bool {
    use std::{ffi::CString, os::raw::c_char};

    unsafe extern "C" {
        fn rion_wk_physical_modifier_pressed(code: *const c_char) -> bool;
    }

    CString::new(code)
        .ok()
        .is_some_and(|code| unsafe { rion_wk_physical_modifier_pressed(code.as_ptr()) })
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn macos_key_dispatch_needs_settle(
    previous_role_label: Option<&str>,
    role_label: &str,
) -> bool {
    previous_role_label.is_some_and(|previous| previous != role_label)
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn mac_modifier_flags(active_codes: &[String]) -> u64 {
    const SHIFT: u64 = 1 << 17;
    const CONTROL: u64 = 1 << 18;
    const OPTION: u64 = 1 << 19;
    const COMMAND: u64 = 1 << 20;

    active_codes.iter().fold(0, |flags, code| {
        flags
            | match code.as_str() {
                "ShiftLeft" | "ShiftRight" => SHIFT,
                "ControlLeft" | "ControlRight" => CONTROL,
                "AltLeft" | "AltRight" => OPTION,
                "MetaLeft" | "MetaRight" => COMMAND,
                _ => 0,
            }
    })
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn dispatch_mouse_effect(
    webview: &Webview,
    viewport: ViewportSize,
    point: ClickPoint,
    button: &str,
    pressed: bool,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_dispatch_mouse(
            webview: *mut std::ffi::c_void,
            viewport_width: f64,
            viewport_height: f64,
            x: f64,
            y: f64,
            button: i32,
            pressed: bool,
        ) -> bool;
    }

    let button = match button {
        "left" => 0,
        "middle" => 1,
        "right" => 2,
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_CLICK_INVALID",
                "Mouse button is invalid.",
            ));
        }
    };
    let submission = NativeInputSubmissionGuard::new(context);
    let callback_submission = submission.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            if !callback_submission.claim() {
                let _ = sender.send(None);
                return;
            }
            let succeeded = unsafe {
                rion_wk_dispatch_mouse(
                    platform_webview.inner(),
                    viewport.width,
                    viewport.height,
                    point.x as f64,
                    point.y as f64,
                    button,
                    pressed,
                )
            };
            let _ = sender.send(Some(succeeded));
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(context.remaining(PLATFORM_CALLBACK_TIMEOUT)) {
        Ok(Some(true)) => Ok(()),
        Ok(Some(false)) => Err(RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
            "WKWebView rejected the native mouse event.",
        )),
        Ok(None) => context.ensure_current(),
        Err(_) => Err(submission.timeout_error()),
    }
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn dispatch_mouse_click_sequence(
    webview: &Webview,
    viewport: ViewportSize,
    point: ClickPoint,
    button: &str,
    context: &InputDispatchContext,
    cleanup_context: impl FnMut() -> InputDispatchContext,
) -> Result<MouseInputDispatchDiagnostics, Box<MouseInputSequenceError>> {
    dispatch_coordinated_mouse_input_sequence(
        MACOS_MOUSE_DISPATCH_STATE.get_or_init(|| Mutex::new(None)),
        webview.label(),
        MouseInputDispatchPolicy {
            handoff_interval: MACOS_MOUSE_DISPATCH_SETTLE_INTERVAL,
            press_interval: MACOS_MOUSE_PRESS_INTERVAL,
        },
        context,
        cleanup_context,
        std::thread::sleep,
        |pressed, context| {
            dispatch_mouse_effect(webview, viewport, point, button, pressed, context)
        },
    )
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn prepare_platform_role_webview_builder(
    app: &AppHandle,
    builder: WebviewBuilder<tauri::Wry>,
    data_store_identifier: [u8; 16],
    high_refresh_rate_enabled: bool,
    contained_fullscreen_enabled: bool,
) -> (
    WebviewBuilder<tauri::Wry>,
    HighRefreshRateDiagnosticStatus,
    RoleWebGlConfiguration,
) {
    unsafe extern "C" {
        fn rion_wk_create_role_configuration(
            data_store_identifier_bytes: *const u8,
            high_refresh_rate_enabled: bool,
            contained_fullscreen_enabled: bool,
            web_gl_preference: i32,
            dom_rendering_preference: i32,
            canvas_rendering_preference: i32,
            high_refresh_rate_status: *mut i32,
            maximum_web_gl_performance_status: *mut i32,
            dom_rendering_status: *mut i32,
            canvas_rendering_status: *mut i32,
        ) -> *mut std::ffi::c_void;
    }

    let runtime_version = macos_webkit_runtime_version();
    let experiment = active_mac_web_gl_experiment();
    let policy = mac_web_gl_policy(runtime_version.as_deref(), experiment);
    let web_gl_preference = policy.web_gl_preference;
    let dom_rendering_preference = policy.dom_rendering_preference;
    let canvas_rendering_preference = policy.canvas_rendering_preference;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let scheduling = app.run_on_main_thread(move || {
        let mut raw_status = 2_i32;
        let mut raw_maximum_status = 2_i32;
        let mut raw_dom_rendering_status = 2_i32;
        let mut raw_canvas_rendering_status = 2_i32;
        let raw_configuration = unsafe {
            rion_wk_create_role_configuration(
                data_store_identifier.as_ptr(),
                high_refresh_rate_enabled,
                contained_fullscreen_enabled,
                web_gl_preference.native_value(),
                dom_rendering_preference.native_value(),
                canvas_rendering_preference.native_value(),
                &mut raw_status,
                &mut raw_maximum_status,
                &mut raw_dom_rendering_status,
                &mut raw_canvas_rendering_status,
            )
        };
        let raw_configuration = raw_configuration as usize;
        if sender
            .send((
                raw_configuration,
                raw_status,
                raw_maximum_status,
                raw_dom_rendering_status,
                raw_canvas_rendering_status,
            ))
            .is_err()
            && raw_configuration != 0
        {
            let raw_configuration = raw_configuration as *mut WKWebViewConfiguration;
            drop(unsafe { Retained::from_raw(raw_configuration) });
        }
    });
    let outcome = if scheduling.is_err() {
        (
            builder,
            HighRefreshRateDiagnosticStatus::ScheduleFailed,
            failed_web_gl_configuration(policy.configuration),
        )
    } else {
        match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok((
                raw_configuration,
                raw_status,
                raw_maximum_status,
                raw_dom_rendering_status,
                raw_canvas_rendering_status,
            )) => {
                let status = decode_macos_high_refresh_rate_status(raw_status);
                let web_gl_configuration = applied_mac_web_gl_configuration(
                    policy,
                    raw_maximum_status,
                    raw_dom_rendering_status,
                    raw_canvas_rendering_status,
                );
                if experiment.is_some() {
                    eprintln!(
                        "Rion WKWebView experiment feature writes: UseGPUProcessForWebGLEnabled={}, UseGPUProcessForDOMRenderingEnabled={}, UseGPUProcessForCanvasRenderingEnabled={}.",
                        macos_webgl_feature_write_status_label(raw_maximum_status),
                        macos_webgl_feature_write_status_label(raw_dom_rendering_status),
                        macos_webgl_feature_write_status_label(raw_canvas_rendering_status),
                    );
                }
                if raw_configuration == 0 {
                    (
                        builder,
                        HighRefreshRateDiagnosticStatus::Failed,
                        failed_web_gl_configuration(policy.configuration),
                    )
                } else {
                    let raw_configuration = raw_configuration as *mut WKWebViewConfiguration;
                    let configuration = unsafe { Retained::from_raw(raw_configuration) }
                        .expect("native WKWebView configuration pointer was non-null");
                    (
                        builder.with_webview_configuration(configuration),
                        status,
                        web_gl_configuration,
                    )
                }
            }
            Err(_) => (
                builder,
                HighRefreshRateDiagnosticStatus::Timeout,
                failed_web_gl_configuration(policy.configuration),
            ),
        }
    };
    eprintln!(
        "System WebView macOS performance configuration: WebKit={}, high-refresh={}, path={:?}, batching={:?}, experiment={:?}.",
        runtime_version.as_deref().unwrap_or("unknown"),
        high_refresh_rate_status_label(outcome.1),
        outcome.2.execution_path,
        outcome.2.command_batching_status,
        experiment,
    );
    outcome
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn decode_macos_high_refresh_rate_status(
    value: i32,
) -> HighRefreshRateDiagnosticStatus {
    match value {
        0 => HighRefreshRateDiagnosticStatus::Applied,
        1 => HighRefreshRateDiagnosticStatus::Unavailable,
        3 => HighRefreshRateDiagnosticStatus::Disabled,
        _ => HighRefreshRateDiagnosticStatus::Failed,
    }
}

#[cfg(target_os = "macos")]
fn macos_webgl_feature_write_status_label(value: i32) -> &'static str {
    match value {
        0 => "applied",
        1 => "unavailable",
        3 => "disabled",
        4 => "engine-managed",
        _ => "failed",
    }
}

#[cfg(target_os = "macos")]
fn applied_mac_web_gl_configuration(
    policy: MacWebGlPolicy,
    raw_web_gl_status: i32,
    raw_dom_rendering_status: i32,
    raw_canvas_rendering_status: i32,
) -> RoleWebGlConfiguration {
    let mut configuration = policy.configuration;
    let explicit_write_failed = [
        (policy.web_gl_preference, raw_web_gl_status),
        (policy.dom_rendering_preference, raw_dom_rendering_status),
        (
            policy.canvas_rendering_preference,
            raw_canvas_rendering_status,
        ),
    ]
    .into_iter()
    .any(|(preference, raw_status)| {
        preference != WebKitFeaturePreference::KeepDefault && raw_status != 0
    });
    if explicit_write_failed {
        configuration.execution_path = WebGlExecutionPath::Unknown;
        configuration.performance_target_status = PerformanceTargetStatus::Indeterminate;
    }
    configuration
}

#[cfg(target_os = "macos")]
fn failed_web_gl_configuration(
    mut configuration: RoleWebGlConfiguration,
) -> RoleWebGlConfiguration {
    configuration.execution_path = WebGlExecutionPath::Unknown;
    configuration.performance_target_status = PerformanceTargetStatus::Indeterminate;
    configuration
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn install_platform_security_policy(
    webview: &Webview,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_install_security_policy(webview: *mut std::ffi::c_void) -> bool;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let installed = unsafe { rion_wk_install_security_policy(platform_webview.inner()) };
            let _ = sender.send(installed);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "SYSTEM_SECURITY_POLICY_FAILED",
            "WKWebView could not install the JavaScript dialog and deny-by-default permission policy.",
        )),
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_SECURITY_POLICY_TIMEOUT",
            "WKWebView security policy installation timed out.",
        )),
    }
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn install_platform_contained_fullscreen_policy(
    webview: &Webview,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_install_contained_fullscreen_policy(webview: *mut std::ffi::c_void) -> bool;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let installed =
                unsafe { rion_wk_install_contained_fullscreen_policy(platform_webview.inner()) };
            let _ = sender.send(installed);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "SYSTEM_CONTAINED_FULLSCREEN_POLICY_FAILED",
            "WKWebView could not disable native element fullscreen for this Workspace Web surface.",
        )),
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_CONTAINED_FULLSCREEN_POLICY_TIMEOUT",
            "WKWebView contained fullscreen policy installation timed out.",
        )),
    }
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn platform_contained_fullscreen_popup_configuration(
    data_store_identifier: [u8; 16],
) -> RuntimeResult<Retained<WKWebViewConfiguration>> {
    unsafe extern "C" {
        fn rion_wk_create_contained_fullscreen_configuration(
            data_store_identifier_bytes: *const u8,
        ) -> *mut std::ffi::c_void;
    }

    let raw_configuration = unsafe {
        rion_wk_create_contained_fullscreen_configuration(data_store_identifier.as_ptr())
    } as *mut WKWebViewConfiguration;
    unsafe { Retained::from_raw(raw_configuration) }.ok_or_else(|| {
        RuntimeError::new(
            "SYSTEM_CONTAINED_FULLSCREEN_POLICY_FAILED",
            "WKWebView could not prepare the contained-fullscreen popup configuration.",
        )
    })
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn dispatch_role_zoom_shortcut(
    app: &AppHandle,
    webview_label: &str,
    action: &str,
) {
    if action == "quickAccess" {
        if let Some(state) = app.try_state::<crate::CoreState>() {
            let _ = state
                .runtime
                .request_quick_access_from_webview(webview_label);
        }
        return;
    }
    let result = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "The Rion Studio runtime is unavailable.".to_owned())
        .and_then(|state| {
            Arc::clone(&state.runtime)
                .zoom_role_for_webview(webview_label, action)
                .map(|_| ())
        });
    if let Err(message) = result {
        let _ = app.emit(
            "rion://shell-error",
            json!({
                "code": "TAURI_RUNTIME_ROLE_ZOOM_FAILED",
                "message": message
            }),
        );
    }
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) struct MacRoleZoomShortcutContext {
    app: AppHandle,
    webview_label: String,
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_role_zoom_shortcut(
    context: *mut std::ffi::c_void,
    action: *const std::os::raw::c_char,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() || action.is_null() {
            return;
        }
        let context = unsafe { &*(context.cast::<MacRoleZoomShortcutContext>()) };
        let Ok(action) = unsafe { std::ffi::CStr::from_ptr(action) }.to_str() else {
            return;
        };
        dispatch_role_zoom_shortcut(&context.app, &context.webview_label, action);
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn drop_macos_role_zoom_shortcut_context(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            drop(unsafe { Box::from_raw(context.cast::<MacRoleZoomShortcutContext>()) });
        }
    }));
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn install_role_application_shortcut_handler(
    webview: &Webview,
    app: AppHandle,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_install_role_zoom_shortcut(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            handler: unsafe extern "C" fn(
                context: *mut std::ffi::c_void,
                action: *const std::os::raw::c_char,
            ),
            destructor: unsafe extern "C" fn(context: *mut std::ffi::c_void),
        ) -> bool;
    }

    let context = Box::new(MacRoleZoomShortcutContext {
        app,
        webview_label: webview.label().to_owned(),
    });
    let context_address = Box::into_raw(context) as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let scheduling = webview.with_webview(move |platform_webview| {
        let installed = unsafe {
            rion_wk_install_role_zoom_shortcut(
                platform_webview.inner(),
                context_address as *mut std::ffi::c_void,
                macos_role_zoom_shortcut,
                drop_macos_role_zoom_shortcut_context,
            )
        };
        let _ = sender.send(installed);
    });
    if let Err(error) = scheduling {
        unsafe { drop_macos_role_zoom_shortcut_context(context_address as *mut std::ffi::c_void) };
        return Err(RuntimeError::tauri(error));
    }
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => {
            unsafe {
                drop_macos_role_zoom_shortcut_context(context_address as *mut std::ffi::c_void)
            };
            Err(RuntimeError::new(
                "SYSTEM_ROLE_APPLICATION_SHORTCUT_FAILED",
                "WKWebView could not install the role application shortcut responder.",
            ))
        }
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_ROLE_APPLICATION_SHORTCUT_TIMEOUT",
            "WKWebView role application shortcut installation timed out.",
        )),
    }
}

#[cfg(target_os = "macos")]
struct MacosRoleSurfaceContext {
    app: AppHandle,
    role_id: String,
    tracker: Arc<SurfaceLifecycleTracker>,
    webview_label: String,
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn submit_platform_role_surface_setup_inner<F>(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
    completion: F,
) -> RuntimeResult<()>
where
    F: FnOnce(RuntimeResult<Arc<SurfaceLifecycleTracker>>) + Send + 'static,
{
    unsafe extern "C" {
        fn rion_wk_install_security_policy(webview: *mut std::ffi::c_void) -> bool;
        fn rion_wk_track_role_surface(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            event_callback: unsafe extern "C" fn(*mut std::ffi::c_void, i32),
            released_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            context_destructor: unsafe extern "C" fn(*mut std::ffi::c_void),
            navigation_callback: unsafe extern "C" fn(
                *mut std::ffi::c_void,
                *const std::ffi::c_char,
            ) -> bool,
        ) -> u64;
    }

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let role_id = match target {
        SurfaceFailureTarget::Role { role_id, .. }
        | SurfaceFailureTarget::Popup { role_id, .. } => role_id,
    };
    let context = Box::into_raw(Box::new(MacosRoleSurfaceContext {
        app,
        role_id,
        tracker: Arc::clone(&tracker),
        webview_label: webview.label().to_owned(),
    })) as usize;
    if let Err(error) = webview.with_webview(move |platform_webview| {
        let native = platform_webview.inner();
        let security_installed = unsafe { rion_wk_install_security_policy(native) };
        let token = if security_installed {
            unsafe {
                rion_wk_track_role_surface(
                    native,
                    context as *mut std::ffi::c_void,
                    macos_role_surface_event,
                    macos_role_surface_released,
                    drop_macos_role_surface_context,
                    macos_main_frame_navigation,
                )
            }
        } else {
            0
        };
        if security_installed && token != 0 {
            tracker.native_token.store(token, Ordering::Release);
            completion(Ok(tracker));
        } else {
            drop(unsafe { Box::from_raw(context as *mut MacosRoleSurfaceContext) });
            completion(Err(RuntimeError::new(
                if security_installed {
                    "SYSTEM_SURFACE_LIFECYCLE_FAILED"
                } else {
                    "SYSTEM_SECURITY_POLICY_FAILED"
                },
                if security_installed {
                    "WKWebView surface lifecycle registration failed."
                } else {
                    "WKWebView could not install the JavaScript dialog and deny-by-default permission policy."
                },
            )));
        }
    }) {
        drop(unsafe { Box::from_raw(context as *mut MacosRoleSurfaceContext) });
        return Err(RuntimeError::tauri(error));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn platform_role_surface_setup_inner(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    submit_platform_role_surface_setup_inner(webview, app, target, move |result| {
        let _ = sender.send(result);
    })?;
    receiver.recv().map_err(|_| {
        RuntimeError::new(
            "SYSTEM_ROLE_SETUP_FAILED",
            "WKWebView security and lifecycle setup was cancelled.",
        )
    })?
}

#[cfg(target_os = "macos")]
fn handle_macos_surface_event(tracker: &SurfaceLifecycleTracker, event: i32) {
    match event {
        1 => tracker.record_native_isolation_event(1),
        2 => {
            let _ = tracker.mark_isolated(2);
        }
        5 => {
            let _ = tracker.mark_process_terminated();
        }
        3 => tracker.fail_isolation(&RuntimeError::new(
            "SYSTEM_SURFACE_NAVIGATION_FAILED",
            "The exact blank navigation failed.",
        )),
        4 => tracker.fail_isolation(&RuntimeError::new(
            "SYSTEM_SURFACE_PROVISIONAL_NAVIGATION_FAILED",
            "The exact provisional blank navigation failed.",
        )),
        6 => tracker.fail_isolation(&RuntimeError::new(
            "SYSTEM_SURFACE_DATA_STORE_MISMATCH",
            "The exact surface data-store identity changed during isolation.",
        )),
        7 => tracker.fail_isolation(&RuntimeError::new(
            "SYSTEM_SURFACE_NAVIGATION_SUBMISSION_FAILED",
            "WKWebView rejected the exact blank navigation.",
        )),
        8 => tracker.fail_release(&RuntimeError::new(
            "SYSTEM_SURFACE_NATIVE_RELEASE_FAILED",
            "WKWebView rejected the exact native surface release.",
        )),
        9 => tracker.fail_isolation(&RuntimeError::new(
            "SYSTEM_SURFACE_LEASE_DESTROYED",
            "The exact WKWebView lifecycle lease was destroyed before isolation completed.",
        )),
        10 => tracker.record_stale_native_event(),
        _ => {}
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_surface_event(context: *mut std::ffi::c_void, event: i32) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let tracker = unsafe { &*(context.cast::<SurfaceLifecycleTracker>()) };
        handle_macos_surface_event(tracker, event);
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_role_surface_event(context: *mut std::ffi::c_void, event: i32) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let context = unsafe { &*(context.cast::<MacosRoleSurfaceContext>()) };
        handle_macos_surface_event(&context.tracker, event);
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_surface_released(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let tracker = unsafe { &*(context.cast::<SurfaceLifecycleTracker>()) };
        tracker.mark_native_surface_released();
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_role_surface_released(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            unsafe { &*(context.cast::<MacosRoleSurfaceContext>()) }
                .tracker
                .mark_native_surface_released();
        }
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_main_frame_navigation(
    context: *mut std::ffi::c_void,
    url: *const std::ffi::c_char,
) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() || url.is_null() {
            return false;
        }
        let context = unsafe { &*(context.cast::<MacosRoleSurfaceContext>()) };
        let Ok(url) = unsafe { std::ffi::CStr::from_ptr(url) }.to_str() else {
            return false;
        };
        let Ok(url) = Url::parse(url) else {
            return false;
        };
        context
            .app
            .try_state::<crate::CoreState>()
            .is_some_and(|state| {
                state.runtime.allow_main_frame_navigation_after_input_fence(
                    &context.webview_label,
                    &context.role_id,
                    &url,
                )
            })
    }))
    .unwrap_or(false)
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn drop_macos_surface_context(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            drop(unsafe { Arc::from_raw(context.cast::<SurfaceLifecycleTracker>()) });
        }
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn drop_macos_role_surface_context(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            drop(unsafe { Box::from_raw(context.cast::<MacosRoleSurfaceContext>()) });
        }
    }));
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn platform_surface_lifecycle_tracker(
    webview: &Webview,
    _process_exit_tracking: SurfaceProcessExitTracking,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    unsafe extern "C" {
        fn rion_wk_track_surface(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            event_callback: unsafe extern "C" fn(*mut std::ffi::c_void, i32),
            released_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            context_destructor: unsafe extern "C" fn(*mut std::ffi::c_void),
        ) -> u64;
    }

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let context = Arc::into_raw(Arc::clone(&tracker)) as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = webview.with_webview(move |platform_webview| {
        let token = unsafe {
            rion_wk_track_surface(
                platform_webview.inner(),
                context as *mut std::ffi::c_void,
                macos_surface_event,
                macos_surface_released,
                drop_macos_surface_context,
            )
        };
        let _ = sender.send(token);
    }) {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::tauri(error));
    }
    let token = receiver.recv().map_err(|_| {
        RuntimeError::new(
            "SYSTEM_SURFACE_LIFECYCLE_FAILED",
            "WKWebView surface lifecycle registration was cancelled.",
        )
    })?;
    if token == 0 {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::new(
            "SYSTEM_SURFACE_LIFECYCLE_FAILED",
            "WKWebView surface lifecycle registration failed.",
        ));
    }
    tracker.native_token.store(token, Ordering::Release);
    Ok(tracker)
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn perform_platform_surface_quiesce(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
    _defer_navigation_to_preflight: bool,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_quiesce_surface(token: u64) -> bool;
    }
    let token = lifecycle.native_token.load(Ordering::Acquire);
    if token == 0 || !unsafe { rion_wk_quiesce_surface(token) } {
        return Err(RuntimeError::new(
            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
            "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn release_platform_surface(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_release_surface(token: u64) -> bool;
    }
    let token = lifecycle.native_token.load(Ordering::Acquire);
    if token == 0 || !unsafe { rion_wk_release_surface(token) } {
        return Err(RuntimeError::new(
            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
            "WKWebView rejected the exact native surface release request.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(in crate::system_runtime) fn set_audio_muted(
    webview: &Webview,
    muted: bool,
) -> RuntimeResult<()> {
    use std::{ffi::c_void, os::raw::c_char};

    unsafe extern "C" {
        fn objc_msgSend();
        fn sel_registerName(name: *const c_char) -> *mut c_void;
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            // WKWebView has no public per-view audio mute API. WebKit's own
            // _setPageMuted: SPI uses bit zero for page audio and preserves
            // playback position, unlike setAllMediaPlaybackSuspended:.
            let mute_selector = b"_setPageMuted:\0";
            let mute_selector = sel_registerName(mute_selector.as_ptr().cast());
            let responds_selector = b"respondsToSelector:\0";
            let responds_selector = sel_registerName(responds_selector.as_ptr().cast());
            let responds: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool =
                std::mem::transmute(objc_msgSend as *const ());
            if !responds(platform_webview.inner(), responds_selector, mute_selector) {
                let _ = sender.send(false);
                return;
            }
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) =
                std::mem::transmute(objc_msgSend as *const ());
            send(
                platform_webview.inner(),
                mute_selector,
                if muted { 1 } else { 0 },
            );
            let _ = sender.send(true);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "TAURI_AUDIO_MUTE_UNAVAILABLE",
            "This WKWebView does not expose the required audio mute capability.",
        )),
        Err(_) => Err(RuntimeError::new(
            "TAURI_AUDIO_MUTE_FAILED",
            "Audio mute timed out.",
        )),
    }
}
