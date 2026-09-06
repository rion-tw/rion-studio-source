#[test]
fn role_creation_and_selected_browser_directory_reset() {
    let (directory, core) = core();
    let game_id = first_game_id(&core);
    let first_id = create_role(&core, &game_id, 1);
    let second_id = create_role(&core, &game_id, 2);
    let first_browser = directory
        .path()
        .join("roles")
        .join(&first_id)
        .join("browser");
    let second_browser = directory
        .path()
        .join("roles")
        .join(&second_id)
        .join("browser");

    {
        let role: StateRoleRecord = serde_json::from_value(
            core.invoke(CoreCommand::RoleGet {
                id: first_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(first_browser.is_dir());
        let value = serde_json::to_value(role).unwrap();
        assert!(value.get("windowWidth").is_none());
        assert!(value.get("windowHeight").is_none());
        assert!(value.get("launchPreset").is_none());
    };

    fs::write(first_browser.join("session"), b"first").unwrap();
    fs::write(second_browser.join("session"), b"second").unwrap();
    core.invoke(CoreCommand::RoleBrowserDirectoryReset {
        id: first_id.clone(),
    })
    .unwrap();

    {
        assert!(first_browser.is_dir());
        assert!(!first_browser.join("session").exists());
        assert_eq!(fs::read(second_browser.join("session")).unwrap(), b"second");
        assert!(
            core.invoke(CoreCommand::RoleGet {
                id: first_id.clone()
            })
            .is_ok()
        );
    };
    core.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_role_deletions_do_not_restore_either_role() {
    let (directory, core) = core();
    let game_id = first_game_id(&core);
    let first_id = create_role(&core, &game_id, 1);
    let second_id = create_role(&core, &game_id, 2);
    let first_core = Arc::clone(&core);
    let second_core = Arc::clone(&core);
    let first = first_core.invoke_async(CoreCommand::RoleDelete {
        id: first_id.clone(),
    });
    let second = second_core.invoke_async(CoreCommand::RoleDelete {
        id: second_id.clone(),
    });
    let (first_result, second_result) = tokio::join!(first, second);

    {
        first_result.unwrap();
        second_result.unwrap();
        assert!(
            core.invoke(CoreCommand::RolesList)
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(!directory.path().join("roles").join(first_id).exists());
        assert!(!directory.path().join("roles").join(second_id).exists());
    };
    core.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn runtime_aware_role_delete_restores_data_and_lease_when_sqlite_commit_fails() {
    let (directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"signed-in").unwrap();

    let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_role_delete
                 BEFORE DELETE ON roles
                 BEGIN
                   SELECT RAISE(ABORT, 'fixture rejects role deletion');
                 END;",
        )
        .unwrap();
    drop(connection);

    let error = core
        .clone()
        .invoke_async(CoreCommand::RoleDelete {
            id: role_id.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), "CORE_STATE_DATABASE_FAILED");
    assert_eq!(
        fs::read(browser.join("session")).unwrap(),
        b"signed-in".to_vec()
    );
    assert_eq!(
        core.invoke(CoreCommand::RolesList)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );

    let lease = core
        .browser_operations
        .acquire(BrowserOperationRequest {
            role_ids: vec![role_id],
            kind: "normal".to_owned(),
        })
        .unwrap();
    core.browser_operations.complete(&lease.id).unwrap();
    core.shutdown();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn runtime_aware_role_delete_defers_locked_windows_profile_cleanup_durably() {
    use std::os::windows::fs::OpenOptionsExt;

    let (directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let role_directory = directory.path().join("roles").join(&role_id);
    let locked_path = role_directory.join("browser/webview2/locked-session");
    fs::write(&locked_path, b"locked").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&locked_path)
        .unwrap();

    core.clone()
        .invoke_async(CoreCommand::RoleDelete {
            id: role_id.clone(),
        })
        .await
        .unwrap();
    assert!(
        core.invoke(CoreCommand::RolesList)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(role_directory.exists());
    let journals = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0].phase, "committed");

    drop(lock);
    core.with_runtime(|runtime| recover_operation_journals(&runtime.state, directory.path()))
        .unwrap();
    assert!(!role_directory.exists());
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    core.shutdown();
}

#[test]
fn game_browser_setting_patches_merge_non_font_sections_atomically() {
    let (_directory, core) = core();
    let initial = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
    let initial_fonts = initial["fonts"].clone();
    let workspace_core = Arc::clone(&core);
    let overlay_core = Arc::clone(&core);

    let workspace = thread::spawn(move || {
        workspace_core.invoke(command(json!({
            "type": "gameBrowserSettingsPatch",
            "patch": { "workspace": { "background": "black", "gap": 12 } }
        })))
    });
    let overlay = thread::spawn(move || {
        overlay_core.invoke(command(json!({
            "type": "gameBrowserSettingsPatch",
            "patch": { "macroOverlay": { "showRunningBadges": false } }
        })))
    });
    workspace.join().unwrap().unwrap();
    overlay.join().unwrap().unwrap();
    core.invoke(command(json!({
        "type": "gameBrowserSettingsPatch",
        "patch": {
            "macroBadgePosition": {
                "horizontalAlign": "right",
                "horizontalMarginPx": 16,
                "topPx": 240
            }
        }
    })))
    .unwrap();
    core.invoke(command(json!({
        "type": "gameBrowserSettingsPatch",
        "patch": { "macroOverlay": { "showToolButton": false } }
    })))
    .unwrap();
    core.invoke(command(json!({
        "type": "gameBrowserSettingsPatch",
        "patch": { "macroOverlay": { "showClickMarkers": false } }
    })))
    .unwrap();

    let settings = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
    assert_eq!(settings["fonts"], initial_fonts);
    assert_eq!(
        settings["workspace"],
        json!({ "background": "black", "gap": 12 })
    );
    assert!(settings.get("performance").is_none());
    assert_eq!(settings["macroBadgePosition"]["horizontalAlign"], "right");
    assert_eq!(settings["macroOverlay"]["showToolButton"], false);
    assert_eq!(settings["macroOverlay"]["showClickMarkers"], false);
    assert_eq!(settings["macroOverlay"]["showRunningBadges"], false);
    core.shutdown();
}

#[test]
fn overlay_requests_validate_and_return_rust_projected_view_models_and_ui_effects() {
    let (_directory, core) = core();
    let game_id = first_game_id(&core);
    let role_id = create_role(&core, &game_id, 1);
    let unassigned_role_id = create_role(&core, &game_id, 2);
    let macro_record = core
        .invoke(command(json!({
            "type": "macroCreate",
            "input": {
                "name": "Overlay macro",
                "roleIds": [role_id.clone()],
                "trigger": {"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false},
                "shortcutSourceScope": {
                    "type": "selected_roles",
                    "roleIds": [unassigned_role_id.clone()]
                },
                "steps": [{"type": "delay", "ms": 10}]
            }
        })))
        .unwrap();
    let macro_id = macro_record["id"].as_str().unwrap().to_owned();
    let mut settings = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
    settings["macroBadgePosition"] =
        json!({"horizontalAlign":"right","horizontalMarginPx":80,"topPx":280});
    settings["macroOverlay"] = json!({
        "showToolButton": false,
        "showRunningBadges": true,
        "showClickMarkers": false
    });
    core.invoke(command(json!({
        "type": "gameBrowserSettingsReplace",
        "settings": settings
    })))
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let view = runtime
        .block_on(core.invoke_async(command(json!({
            "type": "overlayRequest",
            "roleId": role_id.clone(),
            "requestJson": "{\"type\":\"list\"}",
            "language": "zh-TW"
        }))))
        .unwrap();
    assert_eq!(view["language"], "zh-TW");
    assert_eq!(view["resolvedTheme"], "light");
    assert_eq!(view["macros"][0]["id"], macro_id);
    assert_eq!(view["shortcutMacroIds"], json!([]));
    assert_eq!(view["shortcutStatuses"], json!([]));
    assert_eq!(view["statuses"], json!([]));
    {
        assert_eq!(view["macroBadgePosition"]["horizontalAlign"], "right");
        assert!(view["macroBadgePosition"]["topPx"].is_number());
        assert_eq!(view["macroOverlay"]["showToolButton"], false);
        assert_eq!(view["macroOverlay"]["showRunningBadges"], true);
        assert_eq!(view["macroOverlay"]["showClickMarkers"], false);
    };
    {
        assert_eq!(view["statuses"], json!([]));
    };

    core.invoke(CoreCommand::RuntimeThemeSet {
        theme: "dark".to_owned(),
    })
    .unwrap();
    let themed_view = runtime
        .block_on(core.invoke_async(command(json!({
            "type": "overlayRequest",
            "roleId": role_id.clone(),
            "requestJson": "{\"type\":\"list\"}"
        }))))
        .unwrap();
    assert_eq!(themed_view["resolvedTheme"], "dark");

    let controller_view = runtime
        .block_on(core.invoke_async(command(json!({
            "type": "overlayRequest",
            "roleId": unassigned_role_id.clone(),
            "requestJson": "{\"type\":\"list\"}"
        }))))
        .unwrap();
    assert_eq!(controller_view["macros"][0]["id"], macro_id);
    assert_eq!(
        controller_view["shortcutMacroIds"],
        json!([macro_id.clone()])
    );
    assert_eq!(controller_view["statuses"], json!([]));
    assert_eq!(controller_view["shortcutStatuses"], json!([]));

    let error = runtime
        .block_on(core.invoke_async(command(json!({
            "type": "overlayRequest",
            "roleId": role_id.clone(),
            "requestJson": "{\"type\":\"start\",\"macroId\":\"not-assigned\"}"
        }))))
        .unwrap_err();
    assert_eq!(error.code(), "MACRO_ROLE_INVALID");

    let start_error = runtime
        .block_on(core.invoke_async(command(json!({
            "type": "overlayRequest",
            "roleId": unassigned_role_id.clone(),
            "requestJson": json!({"type": "start", "macroId": macro_id.clone()}).to_string()
        }))))
        .unwrap_err();
    let stop_error = runtime
        .block_on(core.invoke_async(command(json!({
            "type": "overlayRequest",
            "roleId": unassigned_role_id,
            "requestJson": json!({"type": "stop", "macroId": macro_id.clone()}).to_string()
        }))))
        .unwrap_err();
    {
        assert_eq!(start_error.code(), "MACRO_ROLE_INVALID");
        assert_eq!(stop_error.code(), "MACRO_ROLE_INVALID");
        assert!(core.macro_runtime.statuses().unwrap().is_empty());
    };

    let (opened, actions, _) = drive_async_command(
        Arc::clone(&core),
        command(json!({
            "type": "overlayRequest",
            "roleId": role_id.clone(),
            "requestJson": "{\"type\":\"open\"}"
        })),
        None,
    );
    assert!(opened.is_ok());
    {
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::OverlayOpenMacroPage { role_id: current }
                if current == &role_id
        )));
    };

    let (copied, actions, _) = drive_async_command(
        Arc::clone(&core),
        command(json!({
            "type": "overlayRequest",
            "roleId": role_id.clone(),
            "requestJson": "{\"type\":\"copy-coordinate\",\"anchor\":\"top-left\",\"appliedPageZoom\":1,\"referenceViewportHeightPx\":100,\"referenceViewportWidthPx\":100,\"xPercent\":12.5,\"xPx\":10,\"xReferencePx\":10,\"viewportHeightPx\":100,\"viewportWidthPx\":100,\"yPercent\":25,\"yPx\":20,\"yReferencePx\":20}"
        })),
        None,
    );
    assert!(copied.is_ok());
    {
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::OverlayCopyCoordinate { coordinate }
                if coordinate.x_px == 10 && coordinate.y_px == 20
        )));
    };
    core.shutdown();
}

#[test]
fn startup_recovery_restores_or_discards_role_delete_quarantines_by_phase() {
    let directory = tempfile::tempdir().unwrap();
    let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();

    crate::role_browser_data::ensure(directory.path(), "restore-role").unwrap();
    crate::role_browser_data::quarantine(directory.path(), "restore-role", "role-delete-restore")
        .unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: "role-delete-restore".to_owned(),
            kind: "role_delete_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({ "roleId": "restore-role" }),
        })
        .unwrap();
    recover_operation_journals(&state, directory.path()).unwrap();
    assert!(directory.path().join("roles/restore-role/browser").exists());

    crate::role_browser_data::ensure(directory.path(), "discard-role").unwrap();
    crate::role_browser_data::quarantine(directory.path(), "discard-role", "role-delete-discard")
        .unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: "role-delete-discard".to_owned(),
            kind: "role_delete_v1".to_owned(),
            phase: "committed".to_owned(),
            payload: json!({ "roleId": "discard-role" }),
        })
        .unwrap();
    recover_operation_journals(&state, directory.path()).unwrap();
    assert!(!directory.path().join("roles/discard-role").exists());
    assert!(state.operation_journals().unwrap().is_empty());
}

#[test]
fn role_browser_data_clear_commits_only_after_the_native_session_is_cleared() {
    let (directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    let chromium = browser.join("chromium");
    fs::write(browser.join("session"), b"signed-in").unwrap();
    fs::write(chromium.join("Cookies"), b"signed-in").unwrap();

    let (result, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::RoleBrowserDataClear {
            role_id: role_id.clone(),
        },
        None,
    );

    {
        let _: StateRoleRecord = serde_json::from_value(result.unwrap()).unwrap();
        assert!(browser.is_dir());
        assert!(!browser.join("session").exists());
        assert!(chromium.is_dir());
        assert!(!chromium.join("Cookies").exists());
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::RoleBrowserDataClearSession {
                role_id: effect_role_id,
                ..
            } if effect_role_id == &role_id
        )));
        assert!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );
    };
    core.shutdown();
}

#[test]
fn v23_role_browser_data_clear_atomically_commits_explicit_reset_evidence() {
    let (directory, legacy) = core();
    let role_id = create_role(&legacy, &first_game_id(&legacy), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"legacy-login").unwrap();
    legacy.shutdown();

    let core = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        })
        .unwrap(),
    );
    assert!(
        core.role_session_migration(role_id.clone())
            .unwrap()
            .is_none()
    );

    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::RoleBrowserDataClear {
            role_id: role_id.clone(),
        },
        |effect| {
            let operation_id = effect.operation_id.clone();
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: operation_id.clone(),
                ok: true,
                value_json: Some(
                    json!({
                        "roleId": role_id,
                        "operationId": operation_id,
                        "clearedStorages": [
                            "cookies", "filesystem", "indexdb", "localstorage",
                            "shadercache", "serviceworkers", "cachestorage"
                        ],
                        "cookieReadbackCount": 0,
                        "evidence": "electron-clear-storage-data-promise-and-cookie-readback"
                    })
                    .to_string(),
                ),
                error: None,
            }
        },
    );

    let _: StateRoleRecord = serde_json::from_value(result.unwrap()).unwrap();
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::RoleBrowserDataClearSession {
            role_id: effect_role_id,
            ..
        } if effect_role_id == &role_id
    )));
    let journal = core
        .role_session_migration(role_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(journal.phase, crate::RoleSessionMigrationPhase::V23Ready);
    assert_eq!(
        journal.outcome,
        Some(crate::RoleSessionMigrationOutcome::ExplicitReset)
    );
    assert_eq!(journal.target_revision, Some(1));
    assert!(
        journal
            .clean_flush_receipt_id
            .unwrap()
            .starts_with("chromium-session-clear:")
    );
    assert!(
        journal
            .reset_receipt_id
            .unwrap()
            .starts_with("role-browser-clear:")
    );
    assert!(!browser.join("session").exists());
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    core.shutdown();
}

#[test]
fn v23_role_browser_data_clear_rejects_unfenced_receipt_and_restores_source() {
    let (directory, legacy) = core();
    let role_id = create_role(&legacy, &first_game_id(&legacy), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"legacy-login").unwrap();
    legacy.shutdown();
    let core = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        })
        .unwrap(),
    );

    let (result, _, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::RoleBrowserDataClear {
            role_id: role_id.clone(),
        },
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: true,
            value_json: Some("{}".to_owned()),
            error: None,
        },
    );

    assert_eq!(
        result.unwrap_err().code(),
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RECEIPT_INVALID"
    );
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"legacy-login");
    assert!(core.role_session_migration(role_id).unwrap().is_none());
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    core.shutdown();
}

#[test]
fn role_browser_data_clear_rejects_unknown_roles_before_runtime_or_effect_work() {
    let (_directory, core) = core();
    let receiver = core.subscribe().unwrap();
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(core.invoke_async(CoreCommand::RoleBrowserDataClear {
            role_id: "missing".to_owned(),
        }));

    {
        let error = result.unwrap_err();
        assert_eq!(error.code(), "ROLE_NOT_FOUND");
        assert_eq!(error.to_string(), "Role not found.");
        assert!(
            receiver
                .try_iter()
                .flatten()
                .all(|event| { !matches!(event, CoreEvent::CoreEffects { .. }) })
        );
    };
    core.shutdown();
}

#[test]
fn role_browser_data_clear_restores_the_login_directory_after_effect_failure() {
    let (directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    let chromium = browser.join("chromium");
    fs::write(browser.join("session"), b"signed-in").unwrap();
    fs::write(chromium.join("Cookies"), b"signed-in").unwrap();

    let (result, _, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::RoleBrowserDataClear {
            role_id: role_id.clone(),
        },
        Some("roleBrowserDataClearSession"),
    );

    assert_eq!(result.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert_eq!(fs::read(chromium.join("Cookies")).unwrap(), b"signed-in");
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    let lease = core
        .browser_operations
        .acquire(BrowserOperationRequest {
            role_ids: vec![role_id],
            kind: "normal".to_owned(),
        })
        .unwrap();
    core.browser_operations.complete(&lease.id).unwrap();
    core.shutdown();
}

#[cfg(windows)]
#[test]
fn role_browser_data_clear_uses_native_clear_when_windows_profile_is_locked() {
    use std::os::windows::fs::OpenOptionsExt;

    let (directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let locked_path = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser/webview2/locked-session");
    fs::write(&locked_path, b"locked").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&locked_path)
        .unwrap();

    let (result, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::RoleBrowserDataClear {
            role_id: role_id.clone(),
        },
        None,
    );

    let _: StateRoleRecord = serde_json::from_value(result.unwrap()).unwrap();
    assert!(locked_path.exists());
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::RoleBrowserDataClearSession {
            role_id: effect_role_id,
            ..
        } if effect_role_id == &role_id
    )));
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );

    drop(lock);
    core.shutdown();
}

#[cfg(windows)]
#[test]
fn role_browser_data_clear_preserves_a_locked_profile_after_effect_failure() {
    use std::os::windows::fs::OpenOptionsExt;

    let (directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let locked_path = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser/webview2/locked-session");
    fs::write(&locked_path, b"locked").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&locked_path)
        .unwrap();

    let (result, _, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::RoleBrowserDataClear { role_id },
        Some("roleBrowserDataClearSession"),
    );

    assert_eq!(result.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
    drop(lock);
    assert_eq!(fs::read(&locked_path).unwrap(), b"locked");
    assert!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    core.shutdown();
}

#[test]
fn startup_recovery_restores_a_quarantined_browser_data_clear() {
    let directory = tempfile::tempdir().unwrap();
    let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    let browser = PathBuf::from(
        crate::role_browser_data::ensure(directory.path(), "recover-role")
            .unwrap()
            .browser_user_data_dir,
    );
    fs::write(browser.join("session"), b"signed-in").unwrap();
    crate::role_browser_data::quarantine(
        directory.path(),
        "recover-role",
        "browser-clear-recovery",
    )
    .unwrap();
    crate::role_browser_data::ensure(directory.path(), "recover-role").unwrap();
    fs::write(browser.join("new-session"), b"partial-clear").unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: "browser-clear-recovery".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({ "roleId": "recover-role", "hadDirectory": true }),
        })
        .unwrap();

    recover_operation_journals(&state, directory.path()).unwrap();

    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert!(!browser.join("new-session").exists());
    assert!(state.operation_journals().unwrap().is_empty());
}

#[test]
fn startup_recovery_rolls_back_a_deferred_browser_data_clear_without_deleting_the_source() {
    let directory = tempfile::tempdir().unwrap();
    let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    let browser = PathBuf::from(
        crate::role_browser_data::ensure(directory.path(), "recover-role")
            .unwrap()
            .browser_user_data_dir,
    );
    fs::write(browser.join("session"), b"signed-in").unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: "browser-clear-deferred".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "deferred".to_owned(),
            payload: json!({
                "roleId": "recover-role",
                "hadDirectory": true,
                "deferredByWindowsLock": true
            }),
        })
        .unwrap();

    recover_operation_journals(&state, directory.path()).unwrap();

    assert!(browser.is_dir());
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert!(state.operation_journals().unwrap().is_empty());
}

#[test]
fn startup_recovery_keeps_an_ambiguous_deferred_clear_journal_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: "browser-clear-deferred-missing-source".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "deferred".to_owned(),
            payload: json!({
                "roleId": "recover-role",
                "hadDirectory": true,
                "deferredByWindowsLock": true
            }),
        })
        .unwrap();

    let error = recover_operation_journals(&state, directory.path()).unwrap_err();

    assert_eq!(error.code(), "CORE_MIGRATION_FAILED");
    assert_eq!(state.operation_journals().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn startup_recovery_keeps_a_deferred_clear_source_symlink_and_journal_fail_closed() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    let source_target = directory.path().join("deferred-source-target");
    fs::create_dir_all(&source_target).unwrap();
    fs::write(source_target.join("session"), b"signed-in").unwrap();
    let role_source = directory.path().join("roles/recover-role");
    fs::create_dir_all(role_source.parent().unwrap()).unwrap();
    symlink(&source_target, &role_source).unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: "browser-clear-deferred-source-symlink".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "deferred".to_owned(),
            payload: json!({
                "roleId": "recover-role",
                "hadDirectory": true,
                "deferredByWindowsLock": true
            }),
        })
        .unwrap();

    let error = recover_operation_journals(&state, directory.path()).unwrap_err();

    assert_eq!(error.code(), "CORE_MIGRATION_FAILED");
    assert!(
        fs::symlink_metadata(&role_source)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read(source_target.join("session")).unwrap(),
        b"signed-in"
    );
    let journals = state.operation_journals().unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0].id, "browser-clear-deferred-source-symlink");
}

#[test]
fn startup_recovery_keeps_unexpected_deferred_clear_quarantine_and_source_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    let browser = PathBuf::from(
        crate::role_browser_data::ensure(directory.path(), "recover-role")
            .unwrap()
            .browser_user_data_dir,
    );
    fs::write(browser.join("session"), b"signed-in").unwrap();
    let operation_id = "browser-clear-deferred-with-quarantine";
    let quarantine = directory
        .path()
        .join("roles/.quarantine")
        .join(operation_id);
    fs::create_dir_all(&quarantine).unwrap();
    fs::write(quarantine.join("session"), b"quarantined").unwrap();
    state
        .put_operation_journal(OperationJournalRecord {
            id: operation_id.to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "deferred".to_owned(),
            payload: json!({
                "roleId": "recover-role",
                "hadDirectory": true,
                "deferredByWindowsLock": true
            }),
        })
        .unwrap();

    let error = recover_operation_journals(&state, directory.path()).unwrap_err();

    assert_eq!(error.code(), "CORE_MIGRATION_FAILED");
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert_eq!(
        fs::read(quarantine.join("session")).unwrap(),
        b"quarantined"
    );
    let journals = state.operation_journals().unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0].id, operation_id);
}

#[test]
fn portable_apply_keeps_the_preview_when_an_affected_macro_is_running() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let macro_id = core
        .invoke(command(json!({
            "type":"macroCreate",
            "input":{
                "name":"Auto heal",
                "roleIds":[role_id],
                "steps":[{"type":"delay","ms":1}]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let selection = crate::model::PortableDataSelectionRecord {
        games: true,
        roles: true,
        launch_workspaces: true,
        game_windows: false,
        macros: true,
        preferences: false,
    };
    let mut portable = core
        .invoke(CoreCommand::PortableExport {
            preferences: None,
            selection: selection.clone(),
        })
        .unwrap();
    portable["macros"][0]["steps"][0]["ms"] = json!(2);
    let preview = core
        .invoke(CoreCommand::PortablePreview {
            raw_json: portable.to_string(),
            file_path: "/tmp/busy-portable.json".to_owned(),
        })
        .unwrap();
    let import_id = preview["importId"].as_str().unwrap().to_owned();
    core.macro_runtime
        .seed_running_status(&macro_id, &role_id)
        .unwrap();

    let busy = core.invoke(CoreCommand::PortableApply {
        import_id: import_id.clone(),
        selection: selection.clone(),
        resolutions: Vec::new(),
    });
    core.macro_runtime.stop_macro(&macro_id).unwrap();
    let retry = core.invoke(CoreCommand::PortableApply {
        import_id,
        selection,
        resolutions: Vec::new(),
    });

    {
        assert_eq!(busy.unwrap_err().code(), "PORTABLE_IMPORT_BUSY");
        assert_eq!(retry.unwrap()["macroCount"], 1);
        assert_eq!(
            core.invoke(CoreCommand::MacroGet {
                id: macro_id.clone()
            })
            .unwrap()["steps"][0]["ms"],
            2
        );
    };
    core.shutdown();
}

#[test]
fn portable_game_window_import_is_blocked_while_a_role_is_running() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let _game_window = core
        .invoke(command(json!({
            "type": "gameWindowCreate",
            "input": {
                "name": "Import target",
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": 20, "y": 20, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                }
            }
        })))
        .unwrap();
    let selection = crate::model::PortableDataSelectionRecord {
        games: true,
        roles: true,
        launch_workspaces: false,
        game_windows: true,
        macros: false,
        preferences: false,
    };
    let portable = core
        .invoke(CoreCommand::PortableExport {
            preferences: None,
            selection: selection.clone(),
        })
        .unwrap();
    let preview = core
        .invoke(CoreCommand::PortablePreview {
            raw_json: portable.to_string(),
            file_path: "/tmp/rion-game-window-running-import.json".to_owned(),
        })
        .unwrap();
    let tab_id = core
        .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            tab_id: Some(uuid::Uuid::new_v4().to_string()),
            source_id: role_id.clone(),
            name: "Role 1".to_owned(),
            tab_type: "role".to_owned(),
            workspace_id: None,
            audio_muted: false,
            attempt_generation: Some("portable-running-role-attempt".to_owned()),
            window_id: "portable-running-role-window".to_owned(),
            role_slots: test_role_slots(&[&role_id]),
            web_surfaces: Vec::new(),
        })
        .unwrap()
        .created_tab_id
        .unwrap();
    core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
        role_id: role_id.clone(),
        runtime: "embedded".to_owned(),
        tab_id: tab_id.clone(),
        slot_id: None,
        state: "launching".to_owned(),
        launched_at: None,
    })
    .unwrap();
    core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
        role_id,
        runtime: "embedded".to_owned(),
        tab_id,
        slot_id: None,
        state: "running".to_owned(),
        launched_at: Some(chrono::Utc::now().to_rfc3339()),
    })
    .unwrap();

    let error = core
        .invoke(CoreCommand::PortableApply {
            import_id: preview["importId"].as_str().unwrap().to_owned(),
            selection,
            resolutions: Vec::new(),
        })
        .unwrap_err();

    assert_eq!(error.code(), "PORTABLE_IMPORT_GAME_WINDOWS_RUNNING");
    core.shutdown();
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn privileged_core_session_migration_mutations_are_absent_from_public_commands() {
    let (platform, migration_platform, source_engine) = native_session_migration_test_runtime();
    let (_directory, core) = core_for_platform(platform);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let start_input = crate::RoleSessionMigrationStartInput {
        role_id: role_id.clone(),
        transfer_id: transfer_id.clone(),
        platform: migration_platform,
        source_engine,
        target_engine: crate::RoleSessionMigrationEngine::Chromium,
        source_revision: 1,
    };
    let start_wire = json!({
        "type": "roleSessionMigrationStart",
        "input": serde_json::to_value(&start_input).unwrap()
    });
    assert!(serde_json::from_value::<CoreCommand>(start_wire).is_err());
    let started = core.start_role_session_migration(start_input).unwrap();
    let evidence = publish_empty_session_transfer_vault(
        &core,
        &role_id,
        &transfer_id,
        migration_platform,
        source_engine,
    );

    assert_eq!(started.journal_revision, 1);
    let get_command = CoreCommand::RoleSessionMigrationGet {
        role_id: role_id.clone(),
    };
    assert!(!get_command.requires_async_dispatch());
    let get_wire = serde_json::to_value(get_command).unwrap();
    assert_eq!(get_wire["type"], "roleSessionMigrationGet");
    assert_eq!(
        serde_json::from_value::<Option<crate::RoleSessionMigrationRecord>>(
            core.invoke(serde_json::from_value(get_wire).unwrap())
                .unwrap()
        )
        .unwrap(),
        Some(started)
    );
    let list_command = CoreCommand::RoleSessionMigrationsList;
    assert!(!list_command.requires_async_dispatch());
    let list_wire = serde_json::to_value(list_command).unwrap();
    assert_eq!(list_wire["type"], "roleSessionMigrationsList");
    assert_eq!(
        serde_json::from_value::<Vec<crate::RoleSessionMigrationRecord>>(
            core.invoke(serde_json::from_value(list_wire).unwrap())
                .unwrap()
        )
        .unwrap()
        .len(),
        1
    );

    let transition_input = crate::RoleSessionMigrationTransitionInput {
        role_id,
        transfer_id,
        transition_id: uuid::Uuid::new_v4().to_string(),
        expected_phase: crate::RoleSessionMigrationPhase::V22Ready,
        expected_journal_revision: 1,
        next_phase: crate::RoleSessionMigrationPhase::Exported,
        target_revision: None,
        envelope_sha256: Some(evidence.envelope_sha256),
        inventory_sha256: Some(evidence.inventory_sha256),
        cookie_count: Some(evidence.cookie_count),
        local_storage_origin_count: Some(evidence.local_storage_origin_count),
        local_storage_entry_count: Some(evidence.local_storage_entry_count),
        stable_error_code: None,
        outcome: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: "2026-08-30T04:00:00Z".to_owned(),
    };
    let transition_wire = json!({
        "type": "roleSessionMigrationTransition",
        "input": serde_json::to_value(&transition_input).unwrap()
    });
    assert!(serde_json::from_value::<CoreCommand>(transition_wire).is_err());
    let exported = core
        .transition_role_session_migration(transition_input)
        .unwrap();
    assert_eq!(exported.journal_revision, 2);
    assert_eq!(exported.phase, crate::RoleSessionMigrationPhase::Exported);
    core.shutdown();
}
