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
    }
}

#[cfg(windows)]
fn platform_surface_lifecycle_tracker(
    webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    use webview2_com::{
        BrowserProcessExitedEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment5},
    };
    use windows::core::Interface;

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let callback_tracker = Arc::clone(&tracker);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> RuntimeResult<(u32, u64)> {
                let controller = platform_webview.controller();
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
                        callback_tracker.mark_browser_process_exited();
                        Ok(())
                    },
                ));
                let mut token = 0;
                environment
                    .add_BrowserProcessExited(&handler, &mut token)
                    .map_err(|error| {
                        windows_surface_lifecycle_error("lifecycle-process-exit-handler", error)
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
    let (browser_process_id, controller_identity) = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_TIMEOUT",
                "WebView2 surface lifecycle registration timed out.",
            )
            .with_setup_diagnostic("lifecycle-timeout", None)
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
fn quiesce_platform_surface(
    webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    use windows::core::Interface;

    let expected_process_id = lifecycle.browser_process_id.load(Ordering::Acquire) as u32;
    let expected_controller_identity = lifecycle.controller_identity.load(Ordering::Acquire);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let result = (|| -> windows::core::Result<()> {
                let actual_controller_identity = controller.as_raw() as usize as u64;
                let core: ICoreWebView2 = controller.CoreWebView2()?;
                let mut process_id = 0;
                core.BrowserProcessId(&mut process_id)?;
                if !windows_surface_identity_matches(
                    expected_controller_identity,
                    actual_controller_identity,
                    expected_process_id,
                    process_id,
                ) {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80004005_u32 as i32,
                    )));
                }
                core.Stop()?;
                core.Navigate(&windows::core::HSTRING::from("about:blank"))?;
                controller.Close()
            })()
            .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(SURFACE_ISOLATION_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "WebView2 surface identity verification timed out.",
            )
        })?
        .map_err(|message| {
            RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                format!("WebView2 surface identity verification failed: {message}"),
            )
        })?;
    lifecycle.mark_native_surface_released();
    lifecycle.mark_isolated();
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
        }
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
