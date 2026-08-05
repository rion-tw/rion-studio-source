use std::{
        collections::{HashMap, HashSet},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        error::CoreErrorPayload,
        model::{
            BrowserRuntimeSnapshot, CoreEffectRequest, CoreEffectResult, StatePixelBoundsRecord,
        },
    };

    fn command(mut value: Value) -> CoreCommand {
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("embeddedRoleLaunch" | "embeddedWorkspaceLaunch")
        ) && let Some(target) = value.get_mut("target").and_then(Value::as_object_mut)
        {
            let work_area = target
                .get("workArea")
                .cloned()
                .unwrap_or_else(|| json!({"x": 0, "y": 0, "width": 1200, "height": 800}));
            let display_id = target.get("displayId").and_then(Value::as_i64).unwrap_or(1);
            target
                .entry("windowId")
                .or_insert_with(|| json!(format!("test-window-{display_id}")));
            target.entry("scaleFactor").or_insert_with(|| json!(1.0));
            target.entry("bounds").or_insert(work_area);
            target
                .entry("presentation")
                .or_insert_with(|| json!("normal"));
        }
        serde_json::from_value(value).unwrap()
    }

    fn core() -> (TempDir, Arc<AppCore>) {
        core_for_platform("darwin")
    }

    fn core_for_platform(platform: &str) -> (TempDir, Arc<AppCore>) {
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(
            AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: platform.to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            })
            .unwrap(),
        );
        install_test_system_runtime_for_platform(&core, platform, supported_system_capabilities());
        (directory, core)
    }

    #[test]
    fn application_instance_lock_is_shared_by_both_shell_platforms() {
        for platform in ["darwin", "win32"] {
            let directory = tempfile::tempdir().unwrap();
            let options = || AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: platform.to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            };
            let first = AppCore::create(options()).unwrap();
            let locked = match AppCore::create(options()) {
                Ok(_) => panic!("a second core acquired the same application data lock"),
                Err(error) => error,
            };
            assert_eq!(locked.code(), "APP_INSTANCE_LOCKED");
            first.shutdown();

            let replacement = AppCore::create(options()).unwrap();
            replacement.shutdown();
        }
    }

    #[test]
    fn runtime_theme_command_accepts_only_resolved_themes() {
        let (_directory, core) = core();

        assert_eq!(
            core.invoke(CoreCommand::RuntimeThemeSet {
                theme: "light".to_owned(),
            })
            .unwrap(),
            json!({ "theme": "light" })
        );
        assert_eq!(
            core.invoke(CoreCommand::RuntimeThemeSet {
                theme: "dark".to_owned(),
            })
            .unwrap(),
            json!({ "theme": "dark" })
        );
        let error = core
            .invoke(CoreCommand::RuntimeThemeSet {
                theme: "system".to_owned(),
            })
            .unwrap_err();
        assert_eq!(error.code(), "CORE_INPUT_INVALID");
    }

    #[test]
    fn tauri_stable_startup_creates_a_valid_online_database_backup() {
        let directory = tempfile::tempdir().unwrap();
        let options = || AppCoreOptions {
            app_version: "2.1.0".to_owned(),
            platform: "darwin".to_owned(),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        };
        let stable = AppCore::create(options()).unwrap();
        stable.shutdown();

        let stable = AppCore::create_with_startup_backup(options(), "tauri-stable").unwrap();
        let backup_root = directory.path().join("shell-migration-backups");
        let backup = fs::read_dir(&backup_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(backup.join("rion-studio.sqlite3").is_file());
        assert!(backup.join("logs.sqlite3").is_file());
        let manifest: Value =
            serde_json::from_slice(&fs::read(backup.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["label"], "tauri-stable");
        assert_eq!(manifest["appVersion"], "2.1.0");
        stable.shutdown();
    }

    fn first_game_id(core: &AppCore) -> String {
        core.invoke(CoreCommand::GamesList).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn create_role(core: &AppCore, game_id: &str, index: usize) -> String {
        core.invoke(command(json!({
            "type": "roleCreate",
            "input": {
                "gameId": game_id,
                "name": format!("Role {index}"),
                "launchUrl": format!("https://example.com/play/{index}")
            }
        })))
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn seed_running_role(core: &AppCore, role_id: &str) {
        let tab_id = core
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: Some(uuid::Uuid::new_v4().to_string()),
                source_id: role_id.to_owned(),
                name: "Running role".to_owned(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_slots: test_role_slots(&[role_id]),
            })
            .unwrap()
            .created_tab_id
            .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role_id.to_owned(),
            runtime: "embedded".to_owned(),
            tab_id: tab_id.clone(),
            slot_id: None,
            state: "launching".to_owned(),
            launched_at: None,
        })
        .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role_id.to_owned(),
            runtime: "embedded".to_owned(),
            tab_id,
            slot_id: None,
            state: "running".to_owned(),
            launched_at: Some(chrono::Utc::now().to_rfc3339()),
        })
        .unwrap();
    }

    fn flyff_game_id(core: &AppCore) -> String {
        core.invoke(CoreCommand::GamesList)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|game| game["builtinKey"] == json!("flyff-universe"))
            .and_then(|game| game["id"].as_str())
            .unwrap()
            .to_owned()
    }

    fn create_chrome_import_fixture(source: &std::path::Path) {
        let cookie_path = source.join("Default/Network/Cookies");
        fs::create_dir_all(cookie_path.parent().unwrap()).unwrap();
        fs::write(
            source.join("Local State"),
            br#"{"profile":{"info_cache":{"Default":{"name":"Main"}}}}"#,
        )
        .unwrap();
        let connection = rusqlite::Connection::open(cookie_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO meta(key, value) VALUES ('version', '23');
                 CREATE TABLE cookies(
                   host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER,
                   is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
                   encrypted_value BLOB, top_frame_site_key TEXT
                 );
                 INSERT INTO cookies VALUES
                   ('.flyff.com','remember_session','present','/profile',0,1,1,1,X'','');",
            )
            .unwrap();
    }

    fn preview_chrome_import(core: &AppCore, source: &std::path::Path) -> (String, String) {
        let preview = core
            .invoke(CoreCommand::ChromeProfilePreview {
                source_user_data_dir: source.to_string_lossy().into_owned(),
            })
            .unwrap();
        (
            preview["importId"].as_str().unwrap().to_owned(),
            preview["profiles"][0]["id"].as_str().unwrap().to_owned(),
        )
    }

    fn chrome_import_effect_result(
        effect: CoreEffectRequest,
        auth_state: &str,
    ) -> CoreEffectResult {
        let value_json = matches!(
            effect.action,
            CoreEffectAction::ChromeProfileImportVerify { .. }
        )
        .then(|| json!({ "authState": auth_state }).to_string());
        CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: true,
            value_json,
            error: None,
        }
    }

    fn drive_post_apply_chrome_import_auth(
        core: Arc<AppCore>,
        auth_states: Vec<ChromeProfileImportAuthStateRecord>,
    ) -> (ChromeProfileImportAuthStateRecord, Vec<CoreEffectAction>) {
        assert!(!auth_states.is_empty());
        let receiver = core.subscribe().unwrap();
        let role_id = "auth-verification-role".to_owned();
        let paths = core.resolve_role_paths(&role_id).unwrap();
        let game = core.state_game(&flyff_game_id(&core)).unwrap();
        let probe = chrome_import_auth_probe(&game).unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation_role_id = role_id.clone();
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.verify_chrome_import_auth_after_apply(
                    &invocation_role_id,
                    &paths,
                    probe,
                ))
        });
        let fallback_auth_state = *auth_states.last().unwrap();
        let mut auth_state_index = 0;
        let mut actions = Vec::new();
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .map(|effect| {
                        assert!(matches!(
                            &effect.action,
                            CoreEffectAction::ChromeProfileImportVerify { .. }
                        ));
                        actions.push(effect.action.clone());
                        let auth_state = auth_states
                            .get(auth_state_index)
                            .copied()
                            .unwrap_or(fallback_auth_state);
                        auth_state_index += 1;
                        CoreEffectResult {
                            effect_id: effect.effect_id,
                            operation_id: effect.operation_id,
                            ok: true,
                            value_json: Some(json!({ "authState": auth_state }).to_string()),
                            error: None,
                        }
                    })
                    .collect();
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        (invocation.join().unwrap(), actions)
    }

    fn supported_system_capabilities() -> crate::model::EngineCapabilitySnapshotRecord {
        use crate::model::EngineCapabilityStatus::{Degraded, Supported};

        crate::model::EngineCapabilitySnapshotRecord {
            navigation: Supported,
            persistent_session: Supported,
            trusted_input: Supported,
            background_input: Supported,
            frame_evaluation: Supported,
            popup: Supported,
            audio_mute: Supported,
            custom_fonts: Degraded,
            downloads: Supported,
            file_upload: Supported,
            permissions: Degraded,
            dialogs: Supported,
            certificate_handling: Supported,
        }
    }

    fn install_test_system_runtime(
        core: &AppCore,
        capability_snapshot: crate::model::EngineCapabilitySnapshotRecord,
    ) {
        install_test_system_runtime_for_platform(core, "darwin", capability_snapshot);
    }

    fn install_test_system_runtime_for_platform(
        core: &AppCore,
        platform: &str,
        capability_snapshot: crate::model::EngineCapabilitySnapshotRecord,
    ) {
        let (platform_name, engine) = match platform {
            "darwin" => ("macos", crate::model::ResolvedBrowserEngine::Wkwebview),
            "win32" => ("windows", crate::model::ResolvedBrowserEngine::Webview2),
            _ => panic!("unsupported test platform: {platform}"),
        };
        *core.system_webview_runtime.write().unwrap() = SystemWebViewRuntimeRegistrationRecord {
            platform: platform_name.to_owned(),
            engine,
            adapter_version: "test-wkwebview-1".to_owned(),
            available: true,
            capability_snapshot,
            failure_reason: None,
        };
        core.system_webview_issues.write().unwrap().clear();
    }

    fn drive_command(
        core: Arc<AppCore>,
        command: CoreCommand,
        fail_action: Option<&'static str>,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>) {
        drive_command_with(core, command, |effect| effect_result(effect, fail_action))
    }

    fn drive_command_with(
        core: Arc<AppCore>,
        command: CoreCommand,
        mut result_for: impl FnMut(CoreEffectRequest) -> CoreEffectResult,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>) {
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation = thread::spawn(move || invocation_core.invoke(command));
        let actions = Arc::new(Mutex::new(Vec::new()));
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .map(|effect| {
                        actions.lock().unwrap().push(effect.action.clone());
                        result_for(effect)
                    })
                    .collect();
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        (
            invocation.join().unwrap(),
            Arc::try_unwrap(actions).unwrap().into_inner().unwrap(),
        )
    }

    fn drive_async_command(
        core: Arc<AppCore>,
        command: CoreCommand,
        fail_action: Option<&'static str>,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>, Vec<()>) {
        drive_async_command_with(core, command, |effect| effect_result(effect, fail_action))
    }

    fn embedded_tab_stop_mutation_command(
        parent_operation_id: &str,
        tab_id: &str,
        source_window_id: &str,
        source_id: &str,
    ) -> CoreCommand {
        CoreCommand::EmbeddedTabStop {
            request: crate::model::RuntimeTabMutationRequestRecord {
                operation_id: parent_operation_id.to_owned(),
                mutation_kind: "stop".to_owned(),
                tab_id: tab_id.to_owned(),
                source_window_id: source_window_id.to_owned(),
                source_window_generation: 7,
                lifecycle_epoch: 3,
            },
            source_id: source_id.to_owned(),
            tab_type: "role".to_owned(),
        }
    }

    fn effect_result_with_parent(
        effect: CoreEffectRequest,
        parent_operation_id: &str,
        platform: &str,
    ) -> CoreEffectResult {
        assert_eq!(
            effect.parent_operation_id.as_deref(),
            Some(parent_operation_id),
            "{platform}"
        );
        effect_result(effect, None)
    }

    fn drive_async_command_with(
        core: Arc<AppCore>,
        command: CoreCommand,
        mut result_for: impl FnMut(CoreEffectRequest) -> CoreEffectResult,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>, Vec<()>) {
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.invoke_async(command))
        });
        let actions = Arc::new(Mutex::new(Vec::new()));
        let progress = Arc::new(Mutex::new(Vec::<()>::new()));
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                if let CoreEvent::CoreEffects { effects } = event {
                    let results = effects
                        .into_iter()
                        .map(|effect| {
                            actions.lock().unwrap().push(effect.action.clone());
                            result_for(effect)
                        })
                        .collect();
                    core.dispatch_core_effect_results(results).unwrap();
                }
            }
        }
        (
            invocation.join().unwrap(),
            Arc::try_unwrap(actions).unwrap().into_inner().unwrap(),
            Arc::try_unwrap(progress).unwrap().into_inner().unwrap(),
        )
    }

    fn drive_accepted_launch_to_completion(core: Arc<AppCore>, command: CoreCommand) -> Value {
        let effects = core.subscribe().unwrap();
        let (completion_sender, completion_receiver) = bounded(1);
        core.set_browser_launch_completion_sink(Arc::new(move |completion| {
            let _ = completion_sender.try_send(completion);
        }))
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let accepted = runtime.block_on(core.invoke_async(command)).unwrap();
        let completion_pending = accepted
            .as_array()
            .is_some_and(|statuses| statuses.iter().any(|status| status["state"] == "launching"));
        if !completion_pending {
            return accepted;
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(completion) = completion_receiver.try_recv() {
                assert!(
                    completion.error.is_none(),
                    "accepted launch failed in the background: {:?}",
                    completion.error
                );
                return accepted;
            }
            assert!(
                Instant::now() < deadline,
                "accepted launch did not finish; metrics={:?}",
                core.operation_actor.metrics()
            );
            let Ok(events) = effects.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            let results = events
                .into_iter()
                .filter_map(|event| match event {
                    CoreEvent::CoreEffects { effects } => Some(effects),
                    _ => None,
                })
                .flatten()
                .map(|effect| effect_result(effect, None))
                .collect::<Vec<_>>();
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
    }

    fn drive_chrome_import_recovery(
        core: Arc<AppCore>,
        fail_rollback: bool,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>) {
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.recover_pending_chrome_profile_imports())
        });
        let mut actions = Vec::new();
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .map(|effect| {
                        let failed = fail_rollback
                            && matches!(
                                effect.action,
                                CoreEffectAction::ChromeProfileImportRollback { .. }
                            );
                        actions.push(effect.action.clone());
                        CoreEffectResult {
                            effect_id: effect.effect_id,
                            operation_id: effect.operation_id,
                            ok: !failed,
                            value_json: None,
                            error: failed.then(|| CoreErrorPayload {
                                code: "SESSION_IMPORT_ROLLBACK_FAILED".to_owned(),
                                message: "Injected rollback failure.".to_owned(),
                            }),
                        }
                    })
                    .collect();
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        (invocation.join().unwrap(), actions)
    }

    fn effect_result(effect: CoreEffectRequest, fail_action: Option<&str>) -> CoreEffectResult {
        let action_name = match &effect.action {
            CoreEffectAction::EmbeddedLoadRoles { .. } => "embeddedLoadRoles",
            CoreEffectAction::EmbeddedDestroyRole { .. } => "embeddedDestroyRole",
            CoreEffectAction::EmbeddedDestroyTab { .. } => "embeddedDestroyTab",
            CoreEffectAction::RoleBrowserDataClearSession { .. } => "roleBrowserDataClearSession",
            _ => "other",
        };
        let failed = fail_action == Some(action_name);
        let value_json = None;
        CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: !failed,
            value_json,
            error: failed.then(|| CoreErrorPayload {
                code: if action_name == "embeddedLoadRoles" {
                    "GAME_PAGE_LOAD_FAILED"
                } else {
                    "DESKTOP_EFFECT_FAILED"
                }
                .to_owned(),
                message: "The fixture rejected the desktop shell effect.".to_owned(),
            }),
        }
    }

    fn browser_workspace_launch(
        workspace_id: String,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreCommand {
        CoreCommand::BrowserWorkspaceLaunch {
            workspace_id,
            target,
            launch_preview_id: None,
            restore_role_slots: None,
        }
    }

    fn workspace_rect(index: usize, count: usize) -> Value {
        let columns = if count == 1 {
            1
        } else if count <= 4 {
            2
        } else {
            3
        };
        let rows = count.div_ceil(columns);
        let column = index % columns;
        let row = index / columns;
        json!({
            "x": column as f64 / columns as f64,
            "y": row as f64 / rows as f64,
            "width": 1.0 / columns as f64,
            "height": 1.0 / rows as f64
        })
    }
