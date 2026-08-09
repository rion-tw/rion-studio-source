// windows system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

#[cfg(windows)]
pub(in crate::system_runtime) fn dispatch_key_effect(
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
pub(in crate::system_runtime) fn dispatch_mouse_effect(
    webview: &Webview,
    _viewport: ViewportSize,
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

#[cfg(windows)]
pub(in crate::system_runtime) fn install_platform_security_policy(webview: &Webview) -> RuntimeResult<()> {
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
pub(crate) fn defer_runtime_tab_shortcut(
    app: AppHandle,
    webview_label: String,
    direction: String,
    modifier_codes: Vec<String>,
) {
    let scheduling_app = app.clone();
    let task_app = app.clone();
    let scheduling = app.run_on_main_thread(move || {
        execute_runtime_tab_shortcut(
            &task_app,
            &webview_label,
            &direction,
            modifier_codes,
        );
    });
    if let Err(error) = scheduling {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = scheduling_app.emit(
                "rion://shell-error",
                json!({
                    "code": "TAURI_RUNTIME_TAB_SHORTCUT_SCHEDULING_FAILED",
                    "message": error.to_string()
                }),
            );
        });
    }
}

#[cfg(windows)]
fn execute_runtime_tab_shortcut(
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
    let Some((tab_id, provisional, _operation_id)) = target else {
        return;
    };
    if !provisional {
        let _ = crate::commit_previewed_tab_selection(
            app,
            &state,
            &window_id,
            &tab_id,
        );
    }
    let Ok(Some(handoff_window_id)) = state.runtime.begin_windows_shortcut_modifier_handoff(
        webview_label,
        modifier_codes,
        &tab_id,
    ) else {
        return;
    };
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
#[derive(Clone)]
enum WindowsApplicationShortcutTarget {
    MainWindow,
    RoleWebview(String),
}

#[cfg(windows)]
fn defer_windows_application_shortcut(
    app: AppHandle,
    target: WindowsApplicationShortcutTarget,
    command: crate::application_menu::ApplicationShortcutCommand,
) {
    let task_app = app.clone();
    let scheduling_app = app.clone();
    let scheduling = app.run_on_main_thread(move || {
        let result = task_app
            .try_state::<crate::CoreState>()
            .ok_or_else(|| "The Rion Studio runtime is unavailable.".to_owned())
            .and_then(|state| match target {
                WindowsApplicationShortcutTarget::MainWindow => {
                    let main = task_app.get_webview_window("main").ok_or_else(|| {
                        "The Rion Studio main window is unavailable.".to_owned()
                    })?;
                    crate::application_menu::execute_shortcut(
                        &task_app,
                        &state,
                        command,
                        crate::application_menu::ApplicationShortcutTarget::MainWindow(&main),
                    )
                }
                WindowsApplicationShortcutTarget::RoleWebview(shortcut_label) => {
                    crate::application_menu::execute_shortcut(
                        &task_app,
                        &state,
                        command,
                        crate::application_menu::ApplicationShortcutTarget::RoleWebview(
                            &shortcut_label,
                        ),
                    )
                }
            });
        if let Err(message) = result {
            let _ = task_app.emit(
                "rion://shell-error",
                json!({
                    "code": "TAURI_APPLICATION_SHORTCUT_FAILED",
                    "message": message
                }),
            );
        }
    });
    if let Err(error) = scheduling {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = scheduling_app.emit(
                "rion://shell-error",
                json!({
                    "code": "TAURI_APPLICATION_SHORTCUT_SCHEDULING_FAILED",
                    "message": error.to_string()
                }),
            );
        });
    }
}

#[cfg(windows)]
pub(in crate::system_runtime) fn install_main_application_shortcut_handler(
    webview: &Webview,
    app: AppHandle,
) -> RuntimeResult<()> {
    install_windows_application_shortcut_handler(
        webview,
        app,
        WindowsApplicationShortcutTarget::MainWindow,
    )
}

#[cfg(windows)]
pub(in crate::system_runtime) fn install_role_zoom_shortcut_handler(
    webview: &Webview,
    app: AppHandle,
) -> RuntimeResult<()> {
    install_windows_application_shortcut_handler(
        webview,
        app,
        WindowsApplicationShortcutTarget::RoleWebview(webview.label().to_owned()),
    )
}

#[cfg(windows)]
fn install_windows_application_shortcut_handler(
    webview: &Webview,
    app: AppHandle,
    target: WindowsApplicationShortcutTarget,
) -> RuntimeResult<()> {
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

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let shortcut_app = app.clone();
            let shortcut_target = target.clone();
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
                        let WindowsApplicationShortcutTarget::RoleWebview(shortcut_label) =
                            &shortcut_target
                        else {
                            return Ok(());
                        };
                        args.SetHandled(true)?;
                        let modifier_codes = windows_shortcut_modifier_codes(
                            pressed(VK_LCONTROL.0),
                            pressed(VK_RCONTROL.0),
                            shift,
                            pressed(VK_LSHIFT.0),
                            pressed(VK_RSHIFT.0),
                        );
                        defer_runtime_tab_shortcut(
                            shortcut_app.clone(),
                            shortcut_label.clone(),
                            if shift { "previous" } else { "next" }.to_owned(),
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
                    defer_windows_application_shortcut(
                        shortcut_app.clone(),
                        shortcut_target.clone(),
                        command,
                    );
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
pub(in crate::system_runtime) fn platform_role_surface_setup(
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
pub(in crate::system_runtime) fn install_windows_role_surface_handlers(
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

    if !matches!(&target, SurfaceFailureTarget::Role { .. }) {
        return Err(RuntimeError::new(
            "SYSTEM_ROLE_SETUP_FAILED",
            "WebView2 role setup requires a role surface target.",
        )
        .with_setup_diagnostic("target-validation", None));
    }
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
                "WebView2 security and process setup timed out.",
            )
            .with_setup_diagnostic("handler-timeout", None)
        })?
}
