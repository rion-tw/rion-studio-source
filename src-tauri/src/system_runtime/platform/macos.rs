// macos system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

#[cfg(target_os = "macos")]
fn dispatch_key_effect(
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
fn macos_key_dispatch_needs_settle(previous_role_label: Option<&str>, role_label: &str) -> bool {
    previous_role_label.is_some_and(|previous| previous != role_label)
}

#[cfg(target_os = "macos")]
fn mac_modifier_flags(active_codes: &[String]) -> u64 {
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
fn dispatch_mouse_effect(
    webview: &Webview,
    point: ClickPoint,
    button: &str,
    pressed: bool,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_dispatch_mouse(
            webview: *mut std::ffi::c_void,
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
fn prepare_platform_role_webview_builder(
    app: &AppHandle,
    builder: WebviewBuilder<tauri::Wry>,
    data_store_identifier: [u8; 16],
    enabled: bool,
) -> (WebviewBuilder<tauri::Wry>, HighRefreshRateDiagnosticStatus) {
    if !enabled {
        return (builder, HighRefreshRateDiagnosticStatus::Disabled);
    }

    unsafe extern "C" {
        fn rion_wk_create_role_configuration(
            data_store_identifier_bytes: *const u8,
            high_refresh_rate_status: *mut i32,
        ) -> *mut std::ffi::c_void;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let scheduling = app.run_on_main_thread(move || {
        let mut raw_status = 2_i32;
        let raw_configuration = unsafe {
            rion_wk_create_role_configuration(data_store_identifier.as_ptr(), &mut raw_status)
        };
        let raw_configuration = raw_configuration as usize;
        if sender.send((raw_configuration, raw_status)).is_err() && raw_configuration != 0 {
            let raw_configuration = raw_configuration as *mut WKWebViewConfiguration;
            drop(unsafe { Retained::from_raw(raw_configuration) });
        }
    });
    let (builder, outcome) = if scheduling.is_err() {
        (builder, HighRefreshRateDiagnosticStatus::ScheduleFailed)
    } else {
        match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok((raw_configuration, raw_status)) => {
                let status = decode_macos_high_refresh_rate_status(raw_status);
                if raw_configuration == 0 {
                    (builder, HighRefreshRateDiagnosticStatus::Failed)
                } else {
                    let raw_configuration = raw_configuration as *mut WKWebViewConfiguration;
                    let configuration = unsafe { Retained::from_raw(raw_configuration) }
                        .expect("native WKWebView configuration pointer was non-null");
                    (builder.with_webview_configuration(configuration), status)
                }
            }
            Err(_) => (builder, HighRefreshRateDiagnosticStatus::Timeout),
        }
    };
    eprintln!(
        "System WebView macOS high refresh rate: status={}.",
        high_refresh_rate_status_label(outcome)
    );
    (builder, outcome)
}

#[cfg(target_os = "macos")]
fn decode_macos_high_refresh_rate_status(value: i32) -> HighRefreshRateDiagnosticStatus {
    match value {
        0 => HighRefreshRateDiagnosticStatus::Applied,
        1 => HighRefreshRateDiagnosticStatus::Unavailable,
        _ => HighRefreshRateDiagnosticStatus::Failed,
    }
}

#[cfg(target_os = "macos")]
fn install_platform_security_policy(webview: &Webview) -> RuntimeResult<()> {
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
fn dispatch_role_zoom_shortcut(app: &AppHandle, webview_label: &str, action: &str) {
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
struct MacRoleZoomShortcutContext {
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
fn install_role_zoom_shortcut_handler(webview: &Webview, app: AppHandle) -> RuntimeResult<()> {
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
                "SYSTEM_ROLE_ZOOM_SHORTCUT_FAILED",
                "WKWebView could not install the role zoom shortcut responder.",
            ))
        }
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_ROLE_ZOOM_SHORTCUT_TIMEOUT",
            "WKWebView role zoom shortcut installation timed out.",
        )),
    }
}

#[cfg(target_os = "macos")]
fn platform_role_surface_setup_inner(
    webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    unsafe extern "C" {
        fn rion_wk_install_security_policy(webview: *mut std::ffi::c_void) -> bool;
        fn rion_wk_track_surface(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            isolated_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            released_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            context_destructor: unsafe extern "C" fn(*mut std::ffi::c_void),
        ) -> u64;
    }

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let context = Arc::into_raw(Arc::clone(&tracker)) as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = webview.with_webview(move |platform_webview| {
        let native = platform_webview.inner();
        let security_installed = unsafe { rion_wk_install_security_policy(native) };
        let token = if security_installed {
            unsafe {
                rion_wk_track_surface(
                    native,
                    context as *mut std::ffi::c_void,
                    macos_surface_isolated,
                    macos_surface_released,
                    drop_macos_surface_context,
                )
            }
        } else {
            0
        };
        let _ = sender.send((security_installed, token));
    }) {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::tauri(error));
    }
    let (security_installed, token) =
        receiver
            .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_ROLE_SETUP_TIMEOUT",
                    "WKWebView security and lifecycle setup timed out.",
                )
            })?;
    if !security_installed || token == 0 {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::new(
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
        ));
    }
    tracker.native_token.store(token, Ordering::Release);
    Ok(tracker)
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_surface_isolated(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let tracker = unsafe { &*(context.cast::<SurfaceLifecycleTracker>()) };
        tracker.mark_isolated();
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
unsafe extern "C" fn drop_macos_surface_context(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            drop(unsafe { Arc::from_raw(context.cast::<SurfaceLifecycleTracker>()) });
        }
    }));
}

#[cfg(target_os = "macos")]
fn platform_surface_lifecycle_tracker(
    webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    unsafe extern "C" {
        fn rion_wk_track_surface(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            isolated_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
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
                macos_surface_isolated,
                macos_surface_released,
                drop_macos_surface_context,
            )
        };
        let _ = sender.send(token);
    }) {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::tauri(error));
    }
    let token = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_TIMEOUT",
                "WKWebView surface lifecycle registration timed out.",
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
fn quiesce_platform_surface(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
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
fn set_audio_muted(webview: &Webview, muted: bool) -> RuntimeResult<()> {
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
