// windows system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

#[cfg(windows)]
fn dispatch_key_effect(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    let modifiers = cdp_modifier_mask(&effect.active_codes);
    let mut parameters = cdp_key_descriptor(&effect.code, modifiers);
    let object = parameters
        .as_object_mut()
        .expect("CDP key descriptor is always an object");
    object.insert("type".to_owned(), json!(effect.phase));
    if effect.auto_repeat {
        object.insert("autoRepeat".to_owned(), json!(true));
    }
    if modifiers > 0 {
        object.insert("modifiers".to_owned(), json!(modifiers));
    }
    call_system_input_devtools(webview, "Input.dispatchKeyEvent", &parameters, context).map(|_| ())
}

#[cfg(windows)]
fn dispatch_mouse_effect(
    webview: &Webview,
    point: ClickPoint,
    button: &str,
    pressed: bool,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    call_system_input_devtools(
        webview,
        "Input.dispatchMouseEvent",
        &json!({
            "type": if pressed { "mousePressed" } else { "mouseReleased" },
            "button": button,
            "clickCount": 1,
            "x": point.x,
            "y": point.y,
        }),
        context,
    )
    .map(|_| ())
}

#[cfg(windows)]
fn install_platform_security_policy(webview: &Webview) -> RuntimeResult<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_STATE_DENY,
            COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL, ICoreWebView2, ICoreWebView2_14,
        },
        PermissionRequestedEventHandler, ServerCertificateErrorDetectedEventHandler,
    };
    use windows::core::Interface;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let permission_handler =
                PermissionRequestedEventHandler::create(Box::new(move |_webview, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                }));
            let certificate_handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(
                move |_webview, args| {
                    if let Some(args) = args {
                        args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                    }
                    Ok(())
                },
            ));
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    let mut permission_token = 0;
                    core.add_PermissionRequested(&permission_handler, &mut permission_token)?;
                    let certificate_core = core.cast::<ICoreWebView2_14>()?;
                    let mut certificate_token = 0;
                    certificate_core.add_ServerCertificateErrorDetected(
                        &certificate_handler,
                        &mut certificate_token,
                    )
                })
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SECURITY_POLICY_TIMEOUT",
                "WebView2 security policy installation timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_SECURITY_POLICY_FAILED", message))
}

#[cfg(windows)]
fn install_document_navigation_macro_release_handler(
    webview: &Webview,
    app: AppHandle,
    role_id: &str,
) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    let webview_label = webview.label().to_owned();
    let role_id = role_id.to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    register_windows_document_navigation_handler(&core, app, role_id, webview_label)
                })
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_NAVIGATION_HANDLER_TIMEOUT",
                "WebView2 document navigation handler installation timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_NAVIGATION_HANDLER_FAILED", message))
}

#[cfg(windows)]
fn register_windows_document_navigation_handler(
    core_webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    callback_app: AppHandle,
    role_id: String,
    webview_label: String,
) -> windows::core::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        WebResourceRequestedEventHandler,
    };
    use windows::core::HSTRING;

    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_core, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let Some(state) = callback_app.try_state::<crate::CoreState>() else {
            return Ok(());
        };
        if !state
            .runtime
            .should_defer_windows_document_navigation(&webview_label)
        {
            return Ok(());
        }
        let input_epoch = match state
            .runtime
            .current_navigation_input_epoch(&webview_label, &role_id)
            .map(Ok)
            .unwrap_or_else(|| {
                state
                    .runtime
                    .begin_navigation_input_fence(&webview_label, &role_id, None)
            })
        {
            Ok(input_epoch) => input_epoch,
            Err(error) => {
                emit_windows_document_navigation_error(
                    &callback_app,
                    "SYSTEM_NAVIGATION_INPUT_FENCE_FAILED",
                    "The Windows document request could not establish an input fence and was allowed to continue.",
                    &role_id,
                    &webview_label,
                    &error.message,
                );
                return Ok(());
            }
        };
        // SAFETY: WebView2 supplied these event args to this callback, and the
        // callback is still executing on the owning UI thread.
        let deferral = match unsafe { args.GetDeferral() } {
            Ok(deferral) => deferral,
            Err(error) => {
                emit_windows_document_navigation_error(
                    &callback_app,
                    "SYSTEM_NAVIGATION_DEFERRAL_FAILED",
                    "The Windows document request could not be deferred and was allowed to continue.",
                    &role_id,
                    &webview_label,
                    &error.to_string(),
                );
                return Ok(());
            }
        };
        let completed = Arc::new(AtomicBool::new(false));
        let deferral_token = retain_windows_document_navigation_deferral(deferral);
        let core = Arc::clone(&state.core);
        let release_app = callback_app.clone();
        let release_role_id = role_id.clone();
        let release_webview_label = webview_label.clone();
        let release_runtime = Arc::clone(&state.runtime);
        tauri::async_runtime::spawn(async move {
            let release = core
                .invoke_async(CoreCommand::MacroInputDrain {
                    role_id: release_role_id.clone(),
                    input_epoch,
                })
                .await;
            match release {
                Ok(value) => {
                    let current = serde_json::from_value::<MacroInputEpochRecord>(value)
                        .is_ok_and(|record| record.current);
                    if current {
                        release_runtime.finish_navigation_input_drain(
                            &release_webview_label,
                            &release_role_id,
                            input_epoch,
                        );
                    }
                }
                Err(error) => emit_windows_document_navigation_error(
                    &release_app,
                    "SYSTEM_NAVIGATION_INPUT_DRAIN_FAILED",
                    "Macro input could not be drained before a Windows document request; automatic input remains fenced.",
                    &release_role_id,
                    &release_webview_label,
                    &error.to_string(),
                ),
            }
            let scheduled_completed = Arc::clone(&completed);
            let completion_app = release_app.clone();
            let completion_role_id = release_role_id.clone();
            let completion_webview_label = release_webview_label.clone();
            let scheduling = release_app.run_on_main_thread(move || {
                if let Err(error) = complete_windows_document_navigation_deferral(
                    deferral_token,
                    &scheduled_completed,
                ) {
                    emit_windows_document_navigation_error(
                        &completion_app,
                        "SYSTEM_NAVIGATION_DEFERRAL_COMPLETE_FAILED",
                        "The Windows document request deferral could not be completed.",
                        &completion_role_id,
                        &completion_webview_label,
                        &error,
                    );
                }
            });
            if let Err(error) = scheduling {
                emit_windows_document_navigation_error(
                    &release_app,
                    "SYSTEM_NAVIGATION_DEFERRAL_SCHEDULE_FAILED",
                    "The Windows document request could not be resumed because the app event loop was unavailable.",
                    &release_role_id,
                    &release_webview_label,
                    &error.to_string(),
                );
            }
        });
        Ok(())
    }));
    for pattern in ["http://*", "https://*"] {
        // SAFETY: `core_webview` remains owned by the WebView2 UI thread for
        // the duration of handler registration.
        unsafe {
            core_webview.AddWebResourceRequestedFilter(
                &HSTRING::from(pattern),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
            )?;
        }
    }
    let mut token = 0;
    // SAFETY: The handler and event token are valid for this registration call,
    // which runs on the WebView2 UI thread.
    unsafe { core_webview.add_WebResourceRequested(&handler, &mut token) }
}

#[cfg(windows)]
fn retain_windows_document_navigation_deferral(
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
) -> u64 {
    let token = WINDOWS_DOCUMENT_NAVIGATION_DEFERRAL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS.with(|deferrals| {
        let previous = deferrals.borrow_mut().insert(token, deferral);
        debug_assert!(
            previous.is_none(),
            "document navigation deferral token reused"
        );
    });
    token
}

#[cfg(windows)]
fn complete_windows_document_navigation_deferral(
    token: u64,
    completed: &AtomicBool,
) -> Result<bool, String> {
    complete_navigation_deferral_once(completed, || {
        let deferral = WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS
            .with(|deferrals| deferrals.borrow_mut().remove(&token))
            .ok_or_else(|| "The Windows document request deferral was not found.".to_owned())?;
        unsafe { deferral.Complete() }.map_err(|error| error.to_string())
    })
}

#[cfg(windows)]
fn emit_windows_document_navigation_error(
    app: &AppHandle,
    code: &str,
    message: &str,
    role_id: &str,
    webview_label: &str,
    reason: &str,
) {
    let _ = app.emit(
        "rion://shell-error",
        json!({
            "code": code,
            "message": message,
            "reason": reason,
            "roleId": role_id,
            "webviewLabel": webview_label
        }),
    );
}

#[cfg(windows)]
fn dispatch_runtime_tab_shortcut(
    app: &AppHandle,
    webview_label: &str,
    direction: &str,
    modifier_codes: Vec<String>,
) {
    let Some(state) = app.try_state::<crate::CoreState>() else {
        return;
    };
    let Some(window_id) = state.runtime.window_id_for_webview(webview_label) else {
        return;
    };
    let target = state
        .runtime
        .preview_adjacent_tab_activation(&window_id, direction)
        .ok();
    let Some((tab_id, provisional)) = target else {
        return;
    };
    let Ok(Some(handoff_window_id)) = state.runtime.begin_windows_shortcut_modifier_handoff(
        webview_label,
        modifier_codes,
        &tab_id,
    ) else {
        return;
    };
    if !provisional {
        let _ = crate::commit_previewed_tab_selection(app, &state, &window_id, &tab_id);
    }
    let runtime = Arc::clone(&state.runtime);
    let scheduled_runtime = Arc::clone(&runtime);
    let scheduled_window_id = handoff_window_id.clone();
    let scheduling = app.run_on_main_thread(move || {
        tauri::async_runtime::spawn_blocking(move || {
            scheduled_runtime.finish_windows_shortcut_modifier_handoff(&scheduled_window_id);
        });
    });
    if scheduling.is_err() {
        tauri::async_runtime::spawn_blocking(move || {
            runtime.finish_windows_shortcut_modifier_handoff(&handoff_window_id);
        });
    }
}

#[cfg(windows)]
fn install_role_zoom_shortcut_handler(webview: &Webview, app: AppHandle) -> RuntimeResult<()> {
    use webview2_com::{
        AcceleratorKeyPressedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
            COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
        },
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_LCONTROL, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RSHIFT,
        VK_RWIN, VK_SHIFT,
    };

    let webview_label = webview.label().to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let shortcut_app = app.clone();
            let shortcut_label = webview_label.clone();
            let handler =
                AcceleratorKeyPressedEventHandler::create(Box::new(move |_controller, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                    args.KeyEventKind(&mut kind)?;
                    if !matches!(
                        kind,
                        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                    ) {
                        return Ok(());
                    }
                    let mut virtual_key = 0;
                    args.VirtualKey(&mut virtual_key)?;
                    let mut physical_status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    args.PhysicalKeyStatus(&mut physical_status)?;
                    let pressed = |key: u16| GetKeyState(i32::from(key)) < 0;
                    let control = pressed(VK_CONTROL.0);
                    let alt = pressed(VK_MENU.0);
                    let meta = pressed(VK_LWIN.0) || pressed(VK_RWIN.0);
                    let shift = pressed(VK_SHIFT.0);
                    if virtual_key == 0x09 && control && !alt && !meta {
                        args.SetHandled(true)?;
                        let modifier_codes = windows_shortcut_modifier_codes(
                            pressed(VK_LCONTROL.0),
                            pressed(VK_RCONTROL.0),
                            shift,
                            pressed(VK_LSHIFT.0),
                            pressed(VK_RSHIFT.0),
                        );
                        dispatch_runtime_tab_shortcut(
                            &shortcut_app,
                            &shortcut_label,
                            if shift { "previous" } else { "next" },
                            modifier_codes,
                        );
                        return Ok(());
                    }
                    let command = windows_application_shortcut_command(
                        virtual_key,
                        control,
                        alt,
                        meta,
                        shift,
                        physical_status.WasKeyDown.as_bool(),
                    );
                    let Some(command) = command else {
                        return Ok(());
                    };
                    args.SetHandled(true)?;
                    let result = shortcut_app
                        .try_state::<crate::CoreState>()
                        .ok_or_else(|| "The Rion Studio runtime is unavailable.".to_owned())
                        .and_then(|state| {
                            crate::application_menu::execute_shortcut(
                                &shortcut_app,
                                &state,
                                command,
                                crate::application_menu::ApplicationShortcutTarget::RoleWebview(
                                    &shortcut_label,
                                ),
                            )
                        });
                    if let Err(message) = result {
                        let _ = shortcut_app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "TAURI_APPLICATION_SHORTCUT_FAILED",
                                "message": message
                            }),
                        );
                    }
                    Ok(())
                }));
            let mut token = 0;
            let result = platform_webview
                .controller()
                .add_AcceleratorKeyPressed(&handler, &mut token)
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_ROLE_ZOOM_SHORTCUT_TIMEOUT",
                "WebView2 role zoom shortcut installation timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_ROLE_ZOOM_SHORTCUT_FAILED", message))
}

#[cfg(windows)]
fn platform_role_surface_setup(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
) -> Result<Arc<SurfaceLifecycleTracker>, RoleSurfaceSetupFailure> {
    let lifecycle =
        platform_surface_lifecycle_tracker(webview).map_err(|error| RoleSurfaceSetupFailure {
            error: windows_role_lifecycle_setup_error(error),
            lifecycle: None,
        })?;
    install_windows_role_surface_handlers(webview, app, target).map_err(|error| {
        RoleSurfaceSetupFailure {
            error,
            lifecycle: Some(Arc::clone(&lifecycle)),
        }
    })?;
    Ok(lifecycle)
}

#[cfg(windows)]
fn install_windows_role_surface_handlers(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
) -> RuntimeResult<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_PROCESS_FAILED_KIND,
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL, ICoreWebView2, ICoreWebView2_14,
        },
        PermissionRequestedEventHandler, ProcessFailedEventHandler,
        ServerCertificateErrorDetectedEventHandler,
    };
    use windows::core::Interface;

    let navigation_role_id = match &target {
        SurfaceFailureTarget::Role { role_id, .. } => role_id.clone(),
        _ => {
            return Err(RuntimeError::new(
                "SYSTEM_ROLE_SETUP_FAILED",
                "WebView2 role setup requires a role surface target.",
            )
            .with_setup_diagnostic("target-validation", None));
        }
    };
    let navigation_webview_label = webview.label().to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> RuntimeResult<()> {
                let controller = platform_webview.controller();
                let core: ICoreWebView2 = controller
                    .CoreWebView2()
                    .map_err(|error| windows_role_setup_error("core-webview", error))?;

                let permission_handler =
                    PermissionRequestedEventHandler::create(Box::new(move |_webview, args| {
                        if let Some(args) = args {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                        Ok(())
                    }));
                let mut permission_token = 0;
                core.add_PermissionRequested(&permission_handler, &mut permission_token)
                    .map_err(|error| windows_role_setup_error("permission-handler", error))?;

                let certificate_handler = ServerCertificateErrorDetectedEventHandler::create(
                    Box::new(move |_webview, args| {
                        if let Some(args) = args {
                            args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                        }
                        Ok(())
                    }),
                );
                let certificate_core: ICoreWebView2_14 = core
                    .cast()
                    .map_err(|error| windows_role_setup_error("certificate-interface", error))?;
                let mut certificate_token = 0;
                certificate_core
                    .add_ServerCertificateErrorDetected(
                        &certificate_handler,
                        &mut certificate_token,
                    )
                    .map_err(|error| windows_role_setup_error("certificate-handler", error))?;

                let event_app = app.clone();
                let event_target = target.clone();
                let process_handler =
                    ProcessFailedEventHandler::create(Box::new(move |_webview, args| {
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
                let mut process_token = 0;
                core.add_ProcessFailed(&process_handler, &mut process_token)
                    .map_err(|error| windows_role_setup_error("process-failed-handler", error))?;

                register_windows_document_navigation_handler(
                    &core,
                    app.clone(),
                    navigation_role_id.clone(),
                    navigation_webview_label.clone(),
                )
                .map_err(|error| windows_role_setup_error("document-navigation-handler", error))?;

                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| {
            RuntimeError::new(
                "SYSTEM_ROLE_SETUP_FAILED",
                format!("WebView2 role setup callback could not run: {error}"),
            )
            .with_setup_diagnostic("with-webview", None)
        })?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_ROLE_SETUP_TIMEOUT",
                "WebView2 security, process, and navigation setup timed out.",
            )
            .with_setup_diagnostic("handler-timeout", None)
        })?
}
