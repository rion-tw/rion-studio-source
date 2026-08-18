pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(StartupWindowState::default())
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }
            let app = webview.app_handle();
            let startup = app.try_state::<StartupWindowState>();
            if startup.as_ref().is_some_and(|state| state.reveal_once())
            {
                request_main_window_show(app, true, "startup-page-load");
            }
            if payload.event() == PageLoadEvent::Finished
                && let Some(message) = startup.and_then(|state| state.failure())
            {
                let encoded = serde_json::to_string(&message)
                    .unwrap_or_else(|_| "\"Rion Studio could not finish starting.\"".to_owned());
                let _ = webview.eval(format!("window.__rionShowStartupFailure?.({encoded});"));
            }
        });
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    let builder = if update_manager::embedded_updater_public_key().is_some() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if let Some(state) = webview.app_handle().try_state::<CoreState>() {
            state.runtime.handle_web_content_process_terminated(
                webview.label(),
                "web-content-process-terminated",
            );
        }
    });
    let builder = builder.on_menu_event(|app, event| {
        if !quick_menu::handle_event(app, event.id().as_ref()) {
            application_menu::handle_event(app, event.id().as_ref());
        }
    });
    let builder = builder
        .setup(|app| {
            let setup_result = (|| -> Result<(), Box<dyn std::error::Error>> {
            #[cfg(target_os = "macos")]
            runtime_tabs_macos::install_safe_tao_event_dispatch()
                .map_err(std::io::Error::other)?;
            #[cfg(windows)]
            if let Some(startup) = app.try_state::<StartupWindowState>() {
                let mica_enabled = app
                    .get_webview_window("main")
                    .is_some_and(|window| {
                        system_runtime::apply_windows_main_window_material(&window)
                    });
                startup.set_windows_mica_enabled(mica_enabled);
            }
            let user_data_dir = shared_user_data_dir(app)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            #[cfg(feature = "desktop-e2e")]
            let desktop_e2e_control = desktop_e2e::initialize(&user_data_dir)
                .map_err(std::io::Error::other)?;
            let app_version = app.package_info().version.to_string();
            let core = match AppCore::create_with_startup_backup(
                AppCoreOptions {
                    app_version: app_version.clone(),
                    platform: platform_name()
                        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?
                        .to_owned(),
                    user_data_dir: user_data_dir.to_string_lossy().into_owned(),
                    performance_telemetry_path: None,
                },
                "tauri-stable",
            ) {
                Ok(core) => Arc::new(core),
                Err(error) if error.code() == "APP_INSTANCE_LOCKED" => {
                    for _ in 0..20 {
                        if activation::forward_activation(&user_data_dir) {
                            std::process::exit(0);
                        }
                        thread::sleep(std::time::Duration::from_millis(75));
                    }
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            };
            let activation_app_handle = app.handle().clone();
            let activation = ActivationServer::start(&user_data_dir, move || {
                let dispatch_handle = activation_app_handle.clone();
                let window_handle = dispatch_handle.clone();
                let _ = dispatch_handle.run_on_main_thread(move || {
                    request_main_window_show(&window_handle, true, "secondary-activation");
                });
            })?;
            let runtime = Arc::new(SystemRuntimeExecutor::new(
                app.handle().clone(),
                user_data_dir.clone(),
                Arc::clone(&core),
            )?);
            let completion_runtime = Arc::downgrade(&runtime);
            let completion_app = app.handle().clone();
            core.set_browser_launch_completion_sink(Arc::new(move |completion| {
                let error = completion.error.clone();
                let reveal_error = completion_runtime
                    .upgrade()
                    .is_none_or(|runtime| runtime.resolve_browser_launch_completion(completion));
                if reveal_error && let Some(error) = error {
                    reveal_shell_error(&completion_app, error);
                }
            }))?;
            runtime.start_effect_executor()?;
            let power_monitor = power_lifecycle::PowerMonitor::install(Arc::downgrade(&runtime))?;
            runtime.schedule_webview_prewarm();
            core.invoke(CoreCommand::SystemWebViewRuntimeRegister {
                registration: runtime.registration(),
            })?;
            let receiver = core.subscribe()?;
            let quick_menu_refresh = quick_menu::RefreshCoordinator::default();
            let runtime_launcher_refresh = runtime_tab_menu::RefreshCoordinator::default();
            runtime_launcher_refresh
                .prime(&app.handle().clone(), "en")
                .map_err(std::io::Error::other)?;
            let quick_menu = quick_menu::create(&app.handle().clone())?;
            let legal_accepted = core
                .invoke(CoreCommand::LegalAcceptanceStatus)
                .ok()
                .and_then(|status| status["isAccepted"].as_bool())
                .unwrap_or(false);
            let updates = Arc::new(update_manager::UpdateManager::new(
                app.handle().clone(),
                app.package_info().version.to_string(),
                &user_data_dir,
                legal_accepted,
            ));
            updates.start_automatic_checks();
            let launch_intents = runtime_tab_menu::LaunchIntentDispatcher::start(
                app.handle().clone(),
                Arc::clone(&core),
                Arc::clone(&runtime),
            );
            let app_handle = app.handle().clone();
            let effect_core = Arc::clone(&core);
            let effect_runtime = Arc::clone(&runtime);
            let effect_quick_menu_refresh = quick_menu_refresh.clone();
            let effect_runtime_launcher_refresh = runtime_launcher_refresh.clone();
            thread::Builder::new()
                .name("rion-tauri-core-events".to_owned())
                .spawn(move || {
                    while let Ok(events) = receiver.recv() {
                        let mut renderer_events = Vec::new();
                        let mut shutdown = false;
                        for event in events {
                            match event {
                                CoreEvent::CoreEffects { effects } => {
                                    for effect in effects {
                                        let action_name = core_effect_action_name(&effect.action);
                                        let persist_runtime = matches!(
                                                &effect.action,
                                            rion_core::CoreEffectAction::EmbeddedFollowRoleOwnership { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyRole { .. }
                                                | rion_core::CoreEffectAction::EmbeddedDestroyTab { .. }
                                        );
                                        if let Err(error) = effect_runtime.enqueue_effect(
                                            effect,
                                            action_name,
                                            persist_runtime,
                                        ) {
                                            eprintln!(
                                                "System WebView effect executor failed: {error}"
                                            );
                                            if let Some(state) =
                                                app_handle.try_state::<CoreState>()
                                            {
                                                state.application_exit_guard.permit();
                                            }
                                            app_handle.exit(9);
                                            break;
                                        }
                                    }
                                }
                                CoreEvent::OverlayChanged { role_ids } => {
                                    effect_runtime.refresh_macro_overlays(&role_ids);
                                    renderer_events.push(CoreEvent::OverlayChanged { role_ids });
                                }
                                CoreEvent::Shutdown => {
                                    shutdown = true;
                                    renderer_events.push(CoreEvent::Shutdown);
                                }
                                event => {
                                    if let CoreEvent::MacroStatuses { statuses, .. } = &event {
                                        effect_runtime.record_macro_badge_statuses(statuses);
                                    }
                                    #[cfg(feature = "desktop-e2e")]
                                    if let CoreEvent::BrowserStatuses { statuses } = &event {
                                        let input_diagnostics =
                                            effect_core.macro_input_diagnostics().ok();
                                        for status in statuses {
                                            let input_diagnostic = input_diagnostics
                                                .as_ref()
                                                .and_then(|diagnostics| {
                                                    diagnostics.roles.iter().find(|role| {
                                                        role.role_id == status.role_id
                                                    })
                                                });
                                            desktop_e2e::record_event(
                                                &format!(
                                                    "browser-status:{}:{}",
                                                    status.role_id, status.state
                                                ),
                                                None,
                                                None,
                                                None,
                                                json!({
                                                    "inputDiagnostic": input_diagnostic,
                                                    "roleId": status.role_id,
                                                    "state": status.state,
                                                }),
                                            );
                                        }
                                    }
                                    #[cfg(feature = "desktop-e2e")]
                                    if let CoreEvent::MacroStatuses { reliable, statuses } = &event {
                                        desktop_e2e::record_event(
                                            "macro-statuses",
                                            None,
                                            None,
                                            None,
                                            json!({
                                                "reliable": reliable,
                                                "statuses": statuses,
                                            }),
                                        );
                                    }
                                    let refresh_quick_menu =
                                        matches!(&event, CoreEvent::BrowserStatuses { .. })
                                            || matches!(
                                        &event,
                                        CoreEvent::StateChanged {
                                            changed_collections,
                                            ..
                                        }
                                            if changed_collections.iter().any(|collection| {
                                                matches!(
                                                    collection,
                                                     StateCollection::Roles
                                                        | StateCollection::LaunchWorkspaces
                                                        | StateCollection::GameWindows
                                                )
                                            })
                                    );
                                    let refresh_runtime_launcher = matches!(
                                        &event,
                                        CoreEvent::StateChanged {
                                            changed_collections,
                                            ..
                                        } if changed_collections.iter().any(|collection| {
                                            matches!(
                                                collection,
                                                StateCollection::Roles
                                                    | StateCollection::LaunchWorkspaces
                                                    | StateCollection::GameWindows
                                            )
                                        })
                                    );
                                    if matches!(
                                        &event,
                                        CoreEvent::StateChanged { changed_collections, .. }
                                            if changed_collections.iter().any(|collection| {
                                                matches!(collection, StateCollection::GameWindows)
                                            })
                                    ) {
                                        let game_windows = effect_core
                                            .invoke(CoreCommand::GameWindowsList)
                                            .ok()
                                            .and_then(|value| {
                                                serde_json::from_value::<
                                                    Vec<StateGameWindowRecord>,
                                                >(value)
                                                .ok()
                                            });
                                        if let Some(game_windows) = game_windows
                                            && let Err(message) = effect_runtime
                                                .refresh_saved_game_windows(&game_windows)
                                        {
                                            reveal_shell_error(
                                                &app_handle,
                                                shell_error("SHELL_WINDOW_FAILED", message),
                                            );
                                        }
                                    }
                                    if refresh_quick_menu || refresh_runtime_launcher {
                                        let language = app_handle
                                            .try_state::<CoreState>()
                                            .and_then(|state| {
                                                state
                                                    .menu_language
                                                    .lock()
                                                    .ok()
                                                    .map(|value| value.clone())
                                            })
                                            .unwrap_or_else(|| "en".to_owned());
                                        if refresh_quick_menu {
                                            let _ = effect_quick_menu_refresh.request(
                                                app_handle.clone(),
                                                Arc::clone(&effect_core),
                                                Arc::clone(&effect_runtime),
                                                language.clone(),
                                            );
                                        }
                                        if refresh_runtime_launcher {
                                            let _ = effect_runtime_launcher_refresh.request(
                                                app_handle.clone(),
                                                Arc::clone(&effect_core),
                                                language,
                                            );
                                        }
                                    }
                                    renderer_events.push(event);
                                }
                            }
                        }
                        if !renderer_events.is_empty() {
                            let _ = app_handle.emit(CORE_EVENTS_EVENT, &renderer_events);
                        }
                        if shutdown {
                            break;
                        }
                    }
                })?;
            let recovery_core = Arc::clone(&core);
            app.manage(CoreState {
                _activation: activation,
                _power_monitor: power_monitor,
                _quick_menu: quick_menu,
                core,
                display_topology: DisplayTopologyCoordinator::default(),
                application_exit_guard: ApplicationExitGuard::default(),
                application_shutdown: ApplicationShutdownCoordinator::default(),
                main_window_zoom: Mutex::new(1.0),
                menu_language: Mutex::new("en".to_owned()),
                quick_menu_refresh: quick_menu_refresh.clone(),
                runtime_launcher_refresh: runtime_launcher_refresh.clone(),
                launch_intents,
                runtime,
                tab_drag: Mutex::new(None),
                tab_drag_finished: Mutex::new(VecDeque::new()),
                tab_drag_lane: tokio::sync::Mutex::new(()),
                #[cfg(target_os = "macos")]
                macos_tab_drag_actions: OnceLock::new(),
                updates: Arc::clone(&updates),
            });
            #[cfg(feature = "desktop-e2e")]
            {
                app.manage(desktop_e2e_control);
                desktop_e2e::record_event(
                    "application-runtime-ready",
                    None,
                    None,
                    None,
                    json!({ "pid": std::process::id() }),
                );
            }
            if let Some(state) = app.try_state::<CoreState>() {
                let _ = state.quick_menu_refresh.request(
                    app.handle().clone(),
                    Arc::clone(&state.core),
                    Arc::clone(&state.runtime),
                    "en".to_owned(),
                );
                let _ = state.runtime_launcher_refresh.request(
                    app.handle().clone(),
                    Arc::clone(&state.core),
                    "en".to_owned(),
                );
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = recovery_core.recover_pending_chrome_profile_imports().await {
                    eprintln!("Chrome profile import recovery failed: {error}");
                }
            });
            if let Some(state) = app.try_state::<CoreState>() {
                application_menu::install(app.handle(), &state.core, "en")?;
            }
            #[cfg(windows)]
            if let Some(main) = app.get_webview_window("main") {
                system_runtime::install_windows_main_application_shortcut_handler(
                    &main,
                    app.handle().clone(),
                )
                .map_err(|error| std::io::Error::other(error.message))?;
            }
            start_display_watcher(app.handle().clone())?;
            let ready_app = app.handle().clone();
            thread::Builder::new()
                .name("rion-tauri-renderer-ready".to_owned())
                .spawn(move || {
                    thread::sleep(RENDERER_READY_TIMEOUT);
                    if ready_app
                        .try_state::<StartupWindowState>()
                        .is_some_and(|state| !state.should_report_timeout())
                    {
                        return;
                    }
                    let dispatch_app = ready_app.clone();
                    let _ = ready_app.run_on_main_thread(move || {
                        if dispatch_app
                            .try_state::<StartupWindowState>()
                            .is_some_and(|state| !state.should_report_timeout())
                        {
                            return;
                        }
                        show_startup_failure_message(
                            &dispatch_app,
                            "The desktop renderer did not become ready within 15 seconds. Check the diagnostics log and restart Rion Studio.".to_owned(),
                        );
                    });
                })?;
                Ok(())
            })();
            match setup_result {
                Ok(()) => {
                    if let Some(startup) = app.try_state::<StartupWindowState>() {
                        startup.mark_native_startup_ready();
                    }
                }
                Err(error) => {
                    let message = startup_failure_message(error.as_ref());
                    if let Some(startup) = app.try_state::<StartupWindowState>() {
                        startup.mark_native_startup_failed(message.clone());
                    }
                    show_startup_failure_message(app.handle(), message);
                }
            }
            Ok(())
        });
    #[cfg(not(feature = "desktop-e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
            rion_core_invoke,
            rion_browser_font_payload,
            rion_divider_pointer,
            rion_macro_badge_timing,
            rion_macro_key_event_observed,
            rion_overlay_request,
            rion_overlay_ready,
            rion_runtime_audio_state,
            rion_runtime_role_slot_action,
            rion_runtime_role_slot_ready,
            rion_runtime_tab_action,
            rion_dispatch_core_effect_results,
            rion_shared_user_data_dir,
            rion_shell_invoke
        ]);
    #[cfg(feature = "desktop-e2e")]
    let builder = builder.invoke_handler(tauri::generate_handler![
            rion_core_invoke,
            rion_browser_font_payload,
            rion_divider_pointer,
            rion_macro_badge_timing,
            rion_macro_key_event_observed,
            rion_overlay_request,
            rion_overlay_ready,
            rion_runtime_audio_state,
            rion_runtime_role_slot_action,
            rion_runtime_role_slot_ready,
            rion_runtime_tab_action,
            rion_dispatch_core_effect_results,
            rion_shared_user_data_dir,
            rion_shell_invoke,
            desktop_e2e::desktop_e2e_probe,
            desktop_e2e::desktop_e2e_wait_event,
            desktop_e2e::desktop_e2e_window_snapshot,
            desktop_e2e::desktop_e2e_inject_duplicate_role_cookie_checkpoint,
            desktop_e2e::desktop_e2e_arm_indeterminate_macro_input,
            desktop_e2e::desktop_e2e_inject_page_finish_failure,
            desktop_e2e::desktop_e2e_control_window,
            desktop_e2e::desktop_e2e_runtime_ui_action,
            desktop_e2e::desktop_e2e_input_diagnostics,
            desktop_e2e::desktop_e2e_keyboard_input,
            desktop_e2e::desktop_e2e_shutdown
        ]);
    builder
        .build(tauri::generate_context!())
        .expect("failed to build Rion Studio")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let Some(state) = app_handle.try_state::<CoreState>() else {
                        return;
                    };
                    if state.application_exit_guard.should_prevent() {
                        api.prevent_exit();
                        let _ = state
                            .runtime
                            .request_main_window_show(true, "exit-guard");
                        let _ = app_handle.emit("rion://application-quit-requested", ());
                        return;
                    }
                    match state.application_shutdown.request_exit() {
                        ApplicationExitRequest::Exit => return,
                        ApplicationExitRequest::WaitForShutdown => {
                            api.prevent_exit();
                            return;
                        }
                        ApplicationExitRequest::StartShutdown => {}
                    }
                    api.prevent_exit();
                    start_application_shutdown(app_handle, &state);
                }
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    let Some(state) = app_handle.try_state::<CoreState>() else {
                        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                            && label == "main"
                        {
                            app_handle.exit(1);
                        }
                        return;
                    };
                    if matches!(event, tauri::WindowEvent::Focused(true)) {
                        state.updates.notify_foregrounded();
                        state.runtime.observe_application_foreground(true);
                    }
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } if label == "main" => {
                            api.prevent_close();
                            if let Err(error) = state
                                .runtime
                                .request_main_window_hide("os-close-requested")
                            {
                                let _ = app_handle.emit(
                                    "rion://shell-error",
                                    json!({
                                        "code": error.code,
                                        "message": error.message,
                                        "windowLabel": label
                                    }),
                                );
                            }
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } if label != "main" => {
                            #[cfg(windows)]
                            {
                                // A Win32 CloseRequested callback runs on the UI thread. Native
                                // WebView creation, navigation, or projection work can briefly own
                                // the runtime-state lock while waiting for that same thread. Defer
                                // close admission so the callback returns before it waits on any
                                // runtime owner; the exact destroyed event remains the terminal
                                // authority for the accepted close generation.
                                api.prevent_close();
                                let app = app_handle.clone();
                                let runtime = Arc::clone(&state.runtime);
                                tauri::async_runtime::spawn(
                                    process_deferred_windows_close_requested(
                                        app,
                                        label.clone(),
                                        runtime,
                                    ),
                                );
                            }
                            #[cfg(not(windows))]
                            match state.runtime.begin_window_close_requested(&label) {
                                Ok(system_runtime::RuntimeWindowCloseRequest::PassThrough) => {}
                                Ok(system_runtime::RuntimeWindowCloseRequest::Pending) => {
                                    api.prevent_close();
                                }
                                Ok(system_runtime::RuntimeWindowCloseRequest::Start {
                                    operation_id,
                                    window_id,
                                    window,
                                }) => {
                                    api.prevent_close();
                                    let app = app_handle.clone();
                                    tauri::async_runtime::spawn(
                                        process_game_window_close_requested(
                                            app,
                                            label.clone(),
                                            operation_id,
                                            window_id,
                                            *window,
                                        ),
                                    );
                                }
                                Err(error) => {
                                    api.prevent_close();
                                    let _ = app_handle.emit(
                                        "rion://shell-error",
                                        json!({
                                            "code": error.code,
                                            "message": error.message,
                                            "windowLabel": label
                                        }),
                                    );
                                }
                            }
                        }
                        tauri::WindowEvent::Resized(size) => {
                            state.runtime.observe_resize_window(
                                &label,
                                size.width,
                                size.height,
                                None,
                            );
                            if label == "main" {
                                let _ = request_display_topology(
                                    app_handle,
                                    &state,
                                    "window-resized",
                                );
                                state.runtime.publish_main_window_state();
                            }
                        }
                        tauri::WindowEvent::Moved(position) if label != "main" => {
                            state.runtime.move_window(&label, position.x, position.y);
                        }
                        tauri::WindowEvent::ScaleFactorChanged {
                            scale_factor,
                            new_inner_size,
                            ..
                        } if label != "main" => {
                            state.runtime.observe_resize_window(
                                &label,
                                new_inner_size.width,
                                new_inner_size.height,
                                Some(scale_factor),
                            );
                        }
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                            if label == "main" => {
                            let _ = request_display_topology(
                                app_handle,
                                &state,
                                "window-moved-or-scale-changed",
                            );
                            state.runtime.publish_main_window_state();
                        }
                        tauri::WindowEvent::Focused(focused) if label == "main" => {
                            state.runtime.observe_main_window_focus(focused);
                        }
                        tauri::WindowEvent::Focused(true) if label != "main" => {
                            state.runtime.observe_window_focus(&label);
                            state
                                .runtime
                                .begin_performance_diagnostic_for_focused_window();
                            let runtime = Arc::clone(&state.runtime);
                            let _ = thread::Builder::new()
                                .name("rion-runtime-focus-persist".to_owned())
                                .spawn(move || {
                                    let _ = runtime.persist_restore_session(false);
                                });
                        }
                        tauri::WindowEvent::Focused(false) if label != "main" => {
                            state.runtime.observe_window_blur(&label);
                        }
                        tauri::WindowEvent::Destroyed => {
                            state.runtime.complete_window_destroyed(&label);
                        }
                        _ => {}
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    activate_main_window(app_handle, "application-reopen");
                }
                tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<CoreState>() {
                        state.core.shutdown();
                    }
                }
                _ => {}
            }
        });
}
