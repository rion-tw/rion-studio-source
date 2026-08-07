#[cfg(windows)]
fn windows_role_setup_error(stage: &'static str, error: windows::core::Error) -> RuntimeError {
    RuntimeError::new(
        "SYSTEM_ROLE_SETUP_FAILED",
        format!("WebView2 role setup failed during {stage}: {error}"),
    )
    .with_setup_diagnostic(stage, Some(format!("0x{:08X}", error.code().0 as u32)))
}

#[cfg(windows)]
fn windows_role_lifecycle_setup_error(error: RuntimeError) -> RuntimeError {
    RuntimeError {
        code: if error.code == "SYSTEM_SURFACE_LIFECYCLE_TIMEOUT" {
            "SYSTEM_ROLE_SETUP_TIMEOUT"
        } else {
            "SYSTEM_ROLE_SETUP_FAILED"
        },
        diagnostic: error.diagnostic.or(Some(RuntimeErrorDiagnostic {
            native_code: None,
            setup_stage: "lifecycle",
        })),
        message: error.message,
        rollback_error_count: error.rollback_error_count,
    }
}

#[cfg(windows)]
fn request_platform_window_hide(window: &Window) -> RuntimeResult<()> {
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SW_HIDE, ShowWindowAsync};

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(RuntimeError::new(
            "SYSTEM_WINDOW_HIDE_SUBMISSION_FAILED",
            "The Win32 game window handle is no longer valid.",
        ));
    }
    // ShowWindowAsync returns the previous visibility state, not a success
    // flag. A zero result therefore also represents an already-hidden window.
    let _ = unsafe { ShowWindowAsync(hwnd, SW_HIDE) };
    Ok(())
}

#[cfg(windows)]
fn request_platform_window_show(window: &Window) -> RuntimeResult<()> {
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SW_SHOW, ShowWindowAsync};

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(RuntimeError::new(
            "SYSTEM_WINDOW_SHOW_SUBMISSION_FAILED",
            "The Win32 game window handle is no longer valid.",
        ));
    }
    // Use the same owning-thread queue as retirement hides. An unconditional
    // later show supersedes a hide that was already posted by the old empty
    // host generation, even if synchronous visibility readback is stale.
    let _ = unsafe { ShowWindowAsync(hwnd, SW_SHOW) };
    Ok(())
}

#[cfg(windows)]
fn platform_surface_lifecycle_tracker(
    webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    use webview2_com::{
        take_pwstr, BrowserProcessExitedEventHandler, NavigationCompletedEventHandler,
        NavigationStartingEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment5},
    };
    use windows::core::Interface;

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let callback_tracker = Arc::clone(&tracker);
    let starting_tracker = Arc::clone(&tracker);
    let completed_tracker = Arc::clone(&tracker);
    let live_resize_label = webview.label().to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> RuntimeResult<(u32, u64)> {
                let controller = platform_webview.controller();
                windows_live_resize_register_controller(
                    live_resize_label,
                    controller.clone(),
                );
                let core: ICoreWebView2 = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| windows_surface_lifecycle_error("lifecycle-core", error))?;
                let mut browser_process_id = 0;
                core.BrowserProcessId(&mut browser_process_id)
                    .map_err(|error| {
                        windows_surface_lifecycle_error("lifecycle-process-id", error)
                    })?;
                let environment: ICoreWebView2Environment5 =
                    platform_webview.environment().cast().map_err(|error| {
                        windows_surface_lifecycle_error("lifecycle-environment", error)
                    })?;
                let handler = BrowserProcessExitedEventHandler::create(Box::new(
                    move |_environment, _args| {
                        let _ = callback_tracker.mark_browser_process_exited();
                        Ok(())
                    },
                ));
                let mut token = 0;
                environment
                    .add_BrowserProcessExited(&handler, &mut token)
                    .map_err(|error| {
                        windows_surface_lifecycle_error("lifecycle-process-exit-handler", error)
                    })?;
                let starting = NavigationStartingEventHandler::create(Box::new(
                    move |_webview, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut uri = windows::core::PWSTR::null();
                        args.Uri(&mut uri)?;
                        if take_pwstr(uri) != "about:blank" {
                            return Ok(());
                        }
                        let mut navigation_id = 0;
                        args.NavigationId(&mut navigation_id)?;
                        starting_tracker.record_windows_navigation_started(navigation_id);
                        Ok(())
                    },
                ));
                let mut starting_token = 0;
                core.add_NavigationStarting(&starting, &mut starting_token)
                    .map_err(|error| {
                        windows_surface_lifecycle_error(
                            "lifecycle-navigation-starting-handler",
                            error,
                        )
                    })?;
                let completed = NavigationCompletedEventHandler::create(Box::new(
                    move |_webview, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut navigation_id = 0;
                        args.NavigationId(&mut navigation_id)?;
                        let mut succeeded = windows::core::BOOL::default();
                        args.IsSuccess(&mut succeeded)?;
                        match windows_surface_navigation_completion(
                            completed_tracker.navigation_id.load(Ordering::Acquire),
                            navigation_id,
                            succeeded.as_bool(),
                        ) {
                            WindowsSurfaceNavigationCompletion::Stale => {
                                completed_tracker.record_stale_native_event();
                                return Ok(());
                            }
                            WindowsSurfaceNavigationCompletion::Isolated => {
                                if !completed_tracker.mark_isolated(2) {
                                    completed_tracker.record_stale_native_event();
                                }
                            }
                            WindowsSurfaceNavigationCompletion::Failed => {
                                let mut status = Default::default();
                                let _ = args.WebErrorStatus(&mut status);
                                completed_tracker.fail_isolation(&RuntimeError::new(
                                    "SYSTEM_SURFACE_NAVIGATION_FAILED",
                                    format!(
                                        "The exact WebView2 blank navigation failed with status {}.",
                                        status.0
                                    ),
                                ));
                            }
                        }
                        Ok(())
                    },
                ));
                let mut completed_token = 0;
                core.add_NavigationCompleted(&completed, &mut completed_token)
                    .map_err(|error| {
                        windows_surface_lifecycle_error(
                            "lifecycle-navigation-completed-handler",
                            error,
                        )
                    })?;
                Ok((browser_process_id, controller.as_raw() as usize as u64))
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_FAILED",
                format!("WebView2 lifecycle callback could not run: {error}"),
            )
            .with_setup_diagnostic("lifecycle-with-webview", None)
        })?;
    let (browser_process_id, controller_identity) = receiver.recv().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_FAILED",
                "WebView2 surface lifecycle registration was cancelled.",
            )
            .with_setup_diagnostic("lifecycle-cancelled", None)
        })??;
    tracker
        .browser_process_id
        .store(u64::from(browser_process_id), Ordering::Release);
    tracker
        .controller_identity
        .store(controller_identity, Ordering::Release);
    Ok(tracker)
}

#[cfg(windows)]
fn windows_surface_lifecycle_error(
    stage: &'static str,
    error: windows::core::Error,
) -> RuntimeError {
    RuntimeError::new(
        "SYSTEM_SURFACE_LIFECYCLE_FAILED",
        format!("WebView2 surface lifecycle setup failed during {stage}: {error}"),
    )
    .with_setup_diagnostic(stage, Some(format!("0x{:08X}", error.code().0 as u32)))
}

#[cfg(windows)]
fn perform_platform_surface_quiesce(
    webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    use windows::core::Interface;

    let expected_process_id = lifecycle.browser_process_id.load(Ordering::Acquire) as u32;
    let expected_controller_identity = lifecycle.controller_identity.load(Ordering::Acquire);
    let callback_lifecycle = Arc::clone(lifecycle);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> RuntimeResult<()> {
                let controller = platform_webview.controller();
                let actual_controller_identity = controller.as_raw() as usize as u64;
                let core: ICoreWebView2 = controller.CoreWebView2().map_err(|error| {
                    windows_surface_lifecycle_error("isolation-resolve-core", error)
                })?;
                let mut process_id = 0;
                core.BrowserProcessId(&mut process_id).map_err(|error| {
                    windows_surface_lifecycle_error("isolation-process-id", error)
                })?;
                if !windows_surface_identity_matches(
                    expected_controller_identity,
                    actual_controller_identity,
                    expected_process_id,
                    process_id,
                ) {
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_IDENTITY_MISMATCH",
                        "The WebView2 controller or process identity changed before isolation.",
                    ));
                }
                core.Stop().map_err(|error| {
                    windows_surface_lifecycle_error("isolation-stop", error)
                })?;
                core.Navigate(&windows::core::HSTRING::from("about:blank"))
                    .map_err(|error| windows_surface_lifecycle_error("isolation-navigate", error))?;
                Ok(())
            })();
            if let Err(error) = result {
                callback_lifecycle.fail_isolation(&error);
            }
        })
        .map_err(RuntimeError::tauri)?;
    Ok(())
}

#[cfg(windows)]
fn release_platform_surface(
    webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    if lifecycle.native_surface_is_released() {
        return Ok(());
    }
    use windows::core::Interface;
    let expected_controller_identity = lifecycle.controller_identity.load(Ordering::Acquire);
    let callback_lifecycle = Arc::clone(lifecycle);
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let actual_controller_identity = controller.as_raw() as usize as u64;
            let result = if expected_controller_identity == 0
                || actual_controller_identity != expected_controller_identity
            {
                Err(RuntimeError::new(
                    "SYSTEM_SURFACE_IDENTITY_MISMATCH",
                    "The WebView2 controller identity changed before native release.",
                ))
            } else {
                controller.Close().map_err(|error| {
                    windows_surface_lifecycle_error("controller-close", error)
                })
            };
            match result {
                Ok(()) => callback_lifecycle.mark_native_surface_released(),
                Err(error) => callback_lifecycle.fail_release(&error),
            }
        })
        .map_err(RuntimeError::tauri)?;
    Ok(())
}

#[cfg(windows)]
fn install_process_failure_monitor(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
) -> RuntimeResult<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND,
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, ICoreWebView2,
        },
        ProcessFailedEventHandler,
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let registration_sender = sender.clone();
            let event_app = app.clone();
            let event_target = target.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_webview, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                let kind_available =
                    args.is_some_and(|args| args.ProcessFailedKind(&mut kind).is_ok());
                if kind_available
                    && matches!(
                        kind,
                        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                    )
                    && let Some(state) = event_app.try_state::<crate::CoreState>()
                {
                    state.runtime.handle_surface_process_failure(
                        event_target.clone(),
                        webview2_process_failure_reason(kind).to_owned(),
                        webview2_process_failure_scope(kind),
                    );
                }
                Ok(())
            }));
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    let mut token = 0;
                    core.add_ProcessFailed(&handler, &mut token)
                })
                .map_err(|error| error.to_string());
            let _ = registration_sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_PROCESS_MONITOR_TIMEOUT",
                "WebView2 process-failure monitor registration timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_PROCESS_MONITOR_FAILED", message))
}

#[cfg(windows)]
fn webview2_process_failure_reason(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "render-process-unresponsive"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render-process-exited",
        _ => "webview2-process-failed",
    }
}

#[cfg(windows)]
fn webview2_process_failure_scope(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> SurfaceFailureScope {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
        SurfaceFailureScope::Browser
    } else {
        SurfaceFailureScope::Renderer
    }
}

#[cfg(windows)]
fn call_system_devtools(webview: &Webview, method: &str, params: &Value) -> RuntimeResult<String> {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::HSTRING;

    let method = HSTRING::from(method);
    let params = HSTRING::from(serde_json::to_string(params).map_err(|error| {
        RuntimeError::new("BROWSER_DEBUGGER_PARAMS_INVALID", error.to_string())
    })?);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let request_sender = sender.clone();
    webview
        .with_webview(move |platform_webview| unsafe {
            let completion_sender = request_sender.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, value| {
                    let _ = completion_sender
                        .send(status.map(|()| value).map_err(|error| error.to_string()));
                    Ok(())
                },
            ));
            let result =
                platform_webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core: ICoreWebView2| {
                        core.CallDevToolsProtocolMethod(&method, &params, &handler)
                    });
            if let Err(error) = result {
                let _ = request_sender.send(Err(error.to_string()));
            }
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| {
            RuntimeError::new(
                "BROWSER_DEBUGGER_TIMEOUT",
                "WebView2 DevTools protocol call timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("BROWSER_DEBUGGER_FAILED", message))
}

#[cfg(windows)]
fn call_system_input_devtools(
    webview: &Webview,
    method: &str,
    params: &Value,
    context: &InputDispatchContext,
) -> RuntimeResult<String> {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::HSTRING;

    context.ensure_current()?;
    let method = HSTRING::from(method);
    let params = HSTRING::from(serde_json::to_string(params).map_err(|error| {
        RuntimeError::new("BROWSER_DEBUGGER_PARAMS_INVALID", error.to_string())
    })?);
    let submission = NativeInputSubmissionGuard::new(context);
    let callback_submission = submission.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let request_sender = sender.clone();
    webview
        .with_webview(move |platform_webview| unsafe {
            if !callback_submission.claim() {
                let _ = request_sender.send(None);
                return;
            }
            let completion_sender = request_sender.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, value| {
                    let _ = completion_sender.send(Some(
                        status.map(|()| value).map_err(|error| error.to_string()),
                    ));
                    Ok(())
                },
            ));
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    core.CallDevToolsProtocolMethod(&method, &params, &handler)
                });
            if let Err(error) = result {
                let _ = request_sender.send(Some(Err(error.to_string())));
            }
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(context.remaining(PLATFORM_CALLBACK_TIMEOUT)) {
        Ok(Some(result)) => {
            result.map_err(|message| RuntimeError::new("BROWSER_DEBUGGER_FAILED", message))
        }
        Ok(None) => {
            context.ensure_current()?;
            Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action was rejected before WebView2 input submission.",
            ))
        }
        Err(_) => Err(submission.timeout_error()),
    }
}

#[cfg(windows)]
fn set_audio_muted(webview: &Webview, muted: bool) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows::core::Interface;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_8>())
                .and_then(|core| core.SetIsMuted(muted))
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", "Audio mute timed out."))?
        .map_err(|message| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", message))
}

impl RuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            diagnostic: None,
            message: message.into(),
            rollback_error_count: None,
        }
    }

    fn with_rollback_error_count(mut self, count: usize) -> Self {
        self.rollback_error_count = Some(count.min(u32::MAX as usize) as u32);
        self
    }

    #[cfg(windows)]
    fn with_setup_diagnostic(
        mut self,
        setup_stage: &'static str,
        native_code: Option<String>,
    ) -> Self {
        self.diagnostic = Some(RuntimeErrorDiagnostic {
            native_code,
            setup_stage,
        });
        self
    }

    fn io(error: std::io::Error) -> Self {
        Self::new("TAURI_RUNTIME_IO_FAILED", error.to_string())
    }

    fn tauri(error: impl std::fmt::Display) -> Self {
        Self::new("TAURI_RUNTIME_FAILED", error.to_string())
    }

    fn core(error: impl std::fmt::Display) -> Self {
        Self::new("TAURI_CORE_COMMAND_FAILED", error.to_string())
    }
}
