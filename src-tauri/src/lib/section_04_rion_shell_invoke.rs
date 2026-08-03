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
            state
                .runtime
                .show_main_window(false, "renderer-ready")
                .map_err(|error| shell_error(error.code, error.message))
                .and_then(|receipt| {
                    runtime_operation_receipt_result(receipt)
                        .map_err(|code| shell_error(&code, "The main window could not be shown."))
                })?;
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
        "currentWindowState" => state
            .runtime
            .main_window_state()
            .map_err(|error| shell_error(error.code, error.message))
            .and_then(|record| serde_json::to_value(record)
                .map_err(|error| shell_error("SHELL_WINDOW_STATE_INVALID", error.to_string()))),
        "applicationLifecycleStatus" =>
            serde_json::to_value(state.runtime.application_lifecycle_status()).map_err(|error| {
                shell_error("SHELL_LIFECYCLE_STATE_INVALID", error.to_string())
            }),
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
            let receipt = state
                .runtime
                .hide_main_window("renderer-close-requested")
                .map_err(|error| shell_error(error.code, error.message))?;
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("SHELL_WINDOW_RECEIPT_INVALID", error.to_string()))
        }
        "startCurrentWindowDrag" => {
            let receipt = state
                .runtime
                .start_main_window_drag()
                .map_err(|error| shell_error(error.code, error.message))?;
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("SHELL_WINDOW_RECEIPT_INVALID", error.to_string()))
        }
        "toggleCurrentWindowMaximize" => {
            let receipt = state
                .runtime
                .toggle_main_window_maximized()
                .map_err(|error| shell_error(error.code, error.message))?;
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("SHELL_WINDOW_RECEIPT_INVALID", error.to_string()))
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
            if command == application_menu::ApplicationShortcutCommand::ToggleFullscreen {
                let receipt = state
                    .runtime
                    .toggle_main_window_fullscreen("renderer-shortcut")
                    .map_err(|error| shell_error(error.code, error.message))?;
                runtime_operation_receipt_result(receipt).map_err(|code| {
                    shell_error(&code, "The main window fullscreen state could not be changed.")
                })?;
                return Ok(Value::Null);
            }
            application_menu::execute_shortcut(
                &app,
                &state,
                command,
                application_menu::ApplicationShortcutTarget::MainWindow(&window),
            )
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_APPLICATION_SHORTCUT_FAILED", error))
        }
        "displayTopology" => display_topology(&state, &window, "getter"),
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
            let receipt = state
                .runtime
                .hide_runtime_window(&window_id)
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error))?;
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("SHELL_WINDOW_FAILED", error.to_string()))
        }
        "stopGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            execute_game_window_close_transaction(
                &app,
                &state,
                window_id.clone(),
                CoreCommand::BrowserWindowStop { window_id },
                "renderer-stop-window",
            )
            .await
        }
        "deleteGameWindow" => {
            let window_id = string_argument(&args, 0, "Game window ID")?;
            execute_game_window_close_transaction(
                &app,
                &state,
                window_id.clone(),
                CoreCommand::BrowserWindowDelete { window_id },
                "renderer-delete-window",
            )
            .await
        }
        "showGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let receipt = preview_and_commit_tab_selection(&app, &state, &tab_id)
                .map_err(|message| shell_error("TAURI_RUNTIME_VISIBILITY_FAILED", message))?;
            serde_json::to_value(receipt).map_err(|error| {
                shell_error("TAURI_RUNTIME_VISIBILITY_FAILED", error.to_string())
            })
        }
        "moveGameWindowTab" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let window_id = string_argument(&args, 1, "Game window ID")?;
            let target = launch_target_for_game_window(&app, &window_id)?;
            let receipt = execute_tab_mutation(&state, "move", &tab_id, Some(target), None).await?;
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("TAURI_RUNTIME_TAB_MUTATION_FAILED", error.to_string()))
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
            let receipt = state
                .runtime
                .set_tab_audio_muted(&tab_id, muted)
                .map_err(|error| shell_error("TAURI_RUNTIME_AUDIO_FAILED", error))?;
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("TAURI_RUNTIME_AUDIO_FAILED", error.to_string()))
        }
        "setGameWindowTabHidden" => {
            let tab_id = string_argument(&args, 0, "Runtime tab ID")?;
            let hidden = args.get(1).and_then(Value::as_bool).ok_or_else(|| {
                shell_error("TAURI_SHELL_INPUT_INVALID", "Hidden state is required.")
            })?;
            let receipt = if hidden {
                execute_tab_mutation(&state, "hide", &tab_id, None, None).await?
            } else {
                preview_and_commit_tab_selection(&app, &state, &tab_id)
                    .map_err(|message| shell_error("TAURI_RUNTIME_VISIBILITY_FAILED", message))?
            };
            serde_json::to_value(receipt)
                .map_err(|error| shell_error("TAURI_RUNTIME_TAB_MUTATION_FAILED", error.to_string()))
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
        "updateStatus" => serde_json::to_value(state.updates.status_record())
            .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error.to_string())),
        "checkForUpdates" => {
            let updates = Arc::clone(&state.updates);
            serde_json::to_value(updates.check_manual().await)
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error.to_string()))
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
                .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error))
        }
        "openUpdateDownload" => state
            .updates
            .open_release_page()
            .map(|()| Value::Null)
            .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error)),
        "installDownloadedUpdate" => {
            let (attempt, leader) = state
                .updates
                .accept_install()
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error))?;
            if leader {
                let app = app.clone();
                let runtime = Arc::clone(&state.runtime);
                let updates = Arc::clone(&state.updates);
                tauri::async_runtime::spawn_blocking(move || {
                    run_downloaded_update_install(app, runtime, updates)
                });
            }
            serde_json::to_value(attempt)
                .map_err(|error| shell_error("TAURI_UPDATE_FAILED", error.to_string()))
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
