#[tauri::command]
async fn rion_shell_invoke(
    app: tauri::AppHandle,
    window: WebviewWindow,
    startup: State<'_, StartupWindowState>,
    operation: String,
    args: Vec<Value>,
) -> Result<Value, CoreErrorPayload> {
    if prepare_shell_invoke(&app, &startup, &operation, &args).await? {
        return Ok(Value::Null);
    }
    let state = app.try_state::<CoreState>().ok_or_else(|| {
        shell_error(
            "SHELL_STARTUP_FAILED",
            "Rion Studio native startup completed without managed core state.",
        )
    })?;

    match operation.as_str() {
        "rendererReady" => {
            startup.mark_renderer_ready();
            state.updates.mark_renderer_ready();
            window
                .show()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "appSnapshot" => app_snapshot(&state, &window),
        "createGameWindow" => {
            let input = args
                .first()
                .cloned()
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_SHELL_INPUT_INVALID",
                        "Game window create input is required.",
                    )
                })
                .and_then(|value| {
                    serde_json::from_value::<GameWindowCreateInputRecord>(value).map_err(|error| {
                        shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string())
                    })
                })?;
            create_game_window_transaction(&app, &state, input).await
        }
        "currentWindowState" => Ok(json!({ "fullscreen": window.is_fullscreen()
            .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))? })),
        "refreshQuickMenu" => state
            .quick_menu_refresh
            .request(
                app.clone(),
                Arc::clone(&state.core),
                Arc::clone(&state.runtime),
                state
                    .menu_language
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_else(|_| "en".to_owned()),
            )
            .map(|()| Value::Null)
            .map_err(|error| shell_error("SHELL_MENU_FAILED", error)),
        "quitApplication" => {
            app.exit(0);
            Ok(Value::Null)
        }
        "confirmApplicationQuit" => {
            state.application_exit_guard.permit();
            app.exit(0);
            Ok(Value::Null)
        }
        "requestCurrentWindowClose" => {
            window
                .close()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "startCurrentWindowDrag" => {
            window
                .start_dragging()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            Ok(Value::Null)
        }
        "toggleCurrentWindowMaximize" => {
            let maximized = window
                .is_maximized()
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            if maximized {
                window
                    .unmaximize()
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            } else {
                window
                    .maximize()
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            }
            Ok(Value::Null)
        }
        "executeApplicationShortcut" => {
            if window.label() != "main" {
                return Err(shell_error(
                    "TAURI_SHELL_UNAUTHORIZED",
                    "Application shortcuts from the renderer are restricted to the main window.",
                ));
            }
            let command = string_argument(&args, 0, "Application shortcut command")?;
            let command = application_menu::ApplicationShortcutCommand::parse(&command)
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_SHELL_INPUT_INVALID",
                        "Application shortcut command is not supported.",
                    )
                })?;
            application_menu::execute_shortcut(
                &app,
                &state,
                command,
                application_menu::ApplicationShortcutTarget::MainWindow(&window),
            )
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_APPLICATION_SHORTCUT_FAILED", error))
        }
        "displays" => display_inventory(&window),
        "launchRole" => launch_role_from_shell(&app, &state, &window, &args).await,
        "launchWorkspace" => launch_workspace_from_shell(&app, &state, &window, &args).await,
        "showGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            let saved = game_window_record(&state.core, &window_id)?;
            if saved.tabs.is_empty() {
                let target = launch_target_for_game_window(&app, &window_id)?;
                Arc::clone(&state.core)
                    .invoke_async(CoreCommand::EmbeddedWindowRegister { target })
                    .await
                    .map_err(error_payload)
            } else {
                restore_saved_game_windows(
                    &state,
                    &window,
                    &[json!({ "scope": "window", "windowId": window_id })],
                )
                .await
            }
        }
        "updateGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            let input = args
                .get(1)
                .cloned()
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_SHELL_INPUT_INVALID",
                        "Game window update input is required.",
                    )
                })
                .and_then(|value| {
                    serde_json::from_value::<GameWindowUpdateInputRecord>(value).map_err(|error| {
                        shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string())
                    })
                })?;
            let should_relocate = input.target_display.is_some() || input.placement.is_some();
            let previous = game_window_record(&state.core, &window_id)?;
            let updated = state
                .core
                .invoke(CoreCommand::GameWindowUpdate {
                    id: window_id.clone(),
                    input,
                })
                .map_err(error_payload)
                .and_then(|value| {
                    serde_json::from_value::<StateGameWindowRecord>(value).map_err(|error| {
                        shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let mut operation_record = updated;
            if state.runtime.window_for_id(&window_id).is_some() {
                let native_result = (|| {
                    let game_windows = state
                        .core
                        .invoke(CoreCommand::GameWindowsList)
                        .map_err(error_payload)
                        .and_then(|value| {
                            serde_json::from_value::<Vec<StateGameWindowRecord>>(value).map_err(
                                |error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()),
                            )
                        })?;
                    state
                        .runtime
                        .refresh_saved_game_windows(&game_windows)
                        .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error))?;
                    if should_relocate {
                        let target = launch_target_for_game_window(&app, &window_id)?;
                        operation_record = game_window_record(&state.core, &window_id)?;
                        state
                            .runtime
                            .relocate_game_window(target)
                            .map_err(|error| {
                                shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", error)
                            })?;
                    }
                    Ok::<(), CoreErrorPayload>(())
                })();
                if let Err(native_error) = native_result {
                    let current = game_window_record(&state.core, &window_id)?;
                    let _authoritative = if same_game_window_record(&current, &operation_record) {
                        match state
                            .core
                            .invoke(CoreCommand::GameWindowUpdate {
                                id: window_id.clone(),
                                input: game_window_update_input_from_record(&previous),
                            })
                            .map_err(error_payload)
                            .and_then(|value| {
                                serde_json::from_value::<StateGameWindowRecord>(value).map_err(
                                    |error| {
                                        shell_error(
                                            "SHELL_GAME_WINDOW_ROLLBACK_FAILED",
                                            error.to_string(),
                                        )
                                    },
                                )
                            }) {
                            Ok(record) => record,
                            Err(rollback_error) => {
                                return Err(game_window_recovery_error(
                                    "SHELL_GAME_WINDOW_ROLLBACK_FAILED",
                                    &native_error,
                                    format!("{}: {}", rollback_error.code, rollback_error.message),
                                ));
                            }
                        }
                    } else {
                        current
                    };
                    let authoritative_windows = state
                        .core
                        .invoke(CoreCommand::GameWindowsList)
                        .map_err(error_payload)
                        .and_then(|value| {
                            serde_json::from_value::<Vec<StateGameWindowRecord>>(value).map_err(
                                |error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()),
                            )
                        })?;
                    if let Err(error) = state
                        .runtime
                        .refresh_saved_game_windows(&authoritative_windows)
                    {
                        return Err(game_window_recovery_error(
                            "SHELL_GAME_WINDOW_RECONCILE_FAILED",
                            &native_error,
                            error,
                        ));
                    }
                    if should_relocate {
                        let target =
                            launch_target_for_game_window(&app, &window_id).map_err(|error| {
                                game_window_recovery_error(
                                    "SHELL_GAME_WINDOW_RECONCILE_FAILED",
                                    &native_error,
                                    format!("{}: {}", error.code, error.message),
                                )
                            })?;
                        state
                            .runtime
                            .relocate_game_window(target)
                            .map_err(|error| {
                                game_window_recovery_error(
                                    "SHELL_GAME_WINDOW_RECONCILE_FAILED",
                                    &native_error,
                                    error,
                                )
                            })?;
                    }
                    return Err(native_error);
                }
            }
            let authoritative = game_window_record(&state.core, &window_id)?;
            serde_json::to_value(authoritative)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        }
        "hideGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            if let Some(runtime_window) = state.runtime.window_for_id(&window_id) {
                runtime_window
                    .hide()
                    .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))?;
            }
            state.runtime.publish_projection();
            Ok(Value::Null)
        }
        "stopGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWindowStop { window_id })
                .await
                .map_err(error_payload)
        }
        "deleteGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWindowDelete { window_id })
                .await
                .map_err(error_payload)
        }
        "showGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            preview_and_commit_tab_selection(&app, &state, &tab_id)
                .map_err(|message| shell_error("TAURI_RUNTIME_VISIBILITY_FAILED", message))?;
            Ok(Value::Null)
        }
        "moveGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let window_id = string_argument(&args, 1, "Game window ID")?;
            let target = launch_target_for_game_window(&app, &window_id)?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabMove { tab_id, target })
                .await
                .map_err(error_payload)
        }
        "moveGameWindowTabToNewWindow" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let created = move_game_window_tab_to_new_window(&app, &state, &tab_id, None).await?;
            serde_json::to_value(created)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        }
        "setGameWindowTabMuted" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let muted = args.get(1).and_then(Value::as_bool).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Muted state is required.")
            })?;
            state
                .runtime
                .set_tab_audio_muted(&tab_id, muted)
                .map_err(|error| shell_error("TAURI_RUNTIME_AUDIO_FAILED", error))?;
            Ok(Value::Null)
        }
        "setGameWindowTabHidden" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let hidden = args.get(1).and_then(Value::as_bool).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Hidden state is required.")
            })?;
            let command = if hidden {
                CoreCommand::EmbeddedTabHide { tab_id }
            } else {
                preview_and_commit_tab_selection(&app, &state, &tab_id)
                    .map_err(|message| shell_error("TAURI_RUNTIME_VISIBILITY_FAILED", message))?;
                return Ok(Value::Null);
            };
            Arc::clone(&state.core)
                .invoke_async(command)
                .await
                .map_err(error_payload)
        }
        "stopGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            if state.runtime.cancel_provisional_tab_launch(&tab_id) {
                return Ok(Value::Null);
            }
            let close_intent = state
                .runtime
                .preview_tab_close(&tab_id)
                .map_err(|message| shell_error("TAURI_RUNTIME_VISIBILITY_FAILED", message))?;
            let result = Arc::clone(&state.core)
                .invoke_async(close_intent.into_core_command())
                .await
                .map_err(error_payload);
            state
                .runtime
                .resolve_tab_close_preview(&tab_id, result.is_ok());
            result
        }
        "restoreSavedGameWindows" => restore_saved_game_windows(&state, &window, &args).await,
        "autoRestoreSavedGameWindows" => {
            if !state.runtime.begin_auto_restore() {
                return Ok(Value::Null);
            }
            restore_saved_game_windows(&state, &window, &[json!({ "scope": "all" })]).await
        }
        "discardSavedGameWindows" => discard_saved_game_windows(&state, &args),
        "stopEmbeddedRuntimeWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::BrowserWindowStop { window_id })
                .await
                .map_err(error_payload)
        }
        "embeddedRuntimeState" => embedded_runtime_state(&state),
        "startMacro" => {
            let macro_id = string_argument(&args, 0, "Macro ID")?;
            invoke_core_async(
                &state,
                json!({
                    "type": "macroStart",
                    "request": { "macroId": macro_id, "sourceRoleId": null }
                }),
            )
            .await
        }
        "exportPortableData" => export_portable_data(&state, &args).await,
        "previewPortableImport" => preview_portable_import(&state).await,
        "applyPortableImport" => {
            let input = args.first().cloned().ok_or_else(|| {
                shell_error(
                    "TAURI_SHELL_INPUT_INVALID",
                    "Portable import input is required.",
                )
            })?;
            let result = invoke_core_async(
                &state,
                json!({
                    "type": "portableApply",
                    "importId": input["importId"],
                    "selection": input["selection"],
                    "resolutions": input.get("resolutions").cloned().unwrap_or_else(|| json!([]))
                }),
            )
            .await?;
            if input["selection"]["gameWindows"].as_bool() == Some(true) {
                let windows = state
                    .core
                    .invoke(CoreCommand::GameWindowsList)
                    .map_err(error_payload)
                    .and_then(|value| {
                        serde_json::from_value::<Vec<StateGameWindowRecord>>(value).map_err(
                            |error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()),
                        )
                    })?;
                for game_window in windows {
                    launch_target_for_game_window(&app, &game_window.id)?;
                }
            }
            Ok(result)
        }
        "previewChromeProfileImport" => preview_chrome_profile_import(&state).await,
        "revealLogs" => reveal_logs(&state).await,
        "collectBrowserPerformanceDiagnostics" => {
            let runtime = Arc::clone(&state.runtime);
            let diagnostics = tauri::async_runtime::spawn_blocking(move || {
                thread::sleep(std::time::Duration::from_millis(1_500));
                runtime.collect_browser_performance_diagnostics(std::time::Duration::from_millis(
                    1_500,
                ))
            })
            .await
            .map_err(|error| shell_error("PERFORMANCE_DIAGNOSTIC_FAILED", error.to_string()))?
            .map_err(|error| shell_error("PERFORMANCE_DIAGNOSTIC_FAILED", error))?;
            serde_json::to_value(diagnostics)
                .map_err(|error| shell_error("PERFORMANCE_DIAGNOSTIC_FAILED", error.to_string()))
        }
        "exportDiagnostics" => export_diagnostics(&app, &window, &state).await,
        "appVersion" => Ok(Value::String(app.package_info().version.to_string())),
        "updateStatus" => Ok(state.updates.status()),
        "checkForUpdates" => {
            let updates = Arc::clone(&state.updates);
            Ok(updates.check_manual().await)
        }
        "setAutoUpdateEnabled" => {
            let enabled = args.first().and_then(Value::as_bool).ok_or_else(|| {
                shell_error(
                    "TAURI_SHELL_INPUT_INVALID",
                    "Auto-update enabled state is required.",
                )
            })?;
            state
                .updates
                .set_auto_update_enabled(enabled)
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error))
        }
        "openUpdateDownload" => state
            .updates
            .open_release_page()
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error)),
        "installDownloadedUpdate" => {
            prepare_application_update_install(&state)
                .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
            state
                .updates
                .install_downloaded()
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error))?;
            prepare_application_update_exit(&app);
            app.restart();
        }
        "consumePendingMacroPageRequest" => Ok(state
            .runtime
            .take_macro_page_request()
            .unwrap_or(Value::Null)),
        _ => Err(shell_error(
            "TAURI_SHELL_OPERATION_UNAVAILABLE",
            format!(
                "Tauri shell operation {operation} is not available ({} argument(s)).",
                args.len()
            ),
        )),
    }
}
