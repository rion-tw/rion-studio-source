fn next_timed_role_browser_data_clear_effect(
    receiver: &crossbeam_channel::Receiver<Vec<CoreEvent>>,
    role_id: &str,
) -> CoreEffectRequest {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let events = receiver
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .expect("role browser-data clear effect must be emitted");
        for event in events {
            let CoreEvent::CoreEffects { effects } = event else {
                continue;
            };
            if let Some(effect) = effects.into_iter().find(|effect| {
                matches!(
                    &effect.action,
                    CoreEffectAction::RoleBrowserDataClearSession {
                        role_id: effect_role_id,
                        ..
                    } if effect_role_id == role_id
                )
            }) {
                return effect;
            }
        }
    }
}

fn defer_role_browser_data_clear_for_logical_windows_lock(
    _user_data_dir: &std::path::Path,
    _role_id: &str,
    _operation_id: &str,
) -> CoreResult<crate::role_browser_data::DeleteQuarantineOutcome> {
    Ok(crate::role_browser_data::DeleteQuarantineOutcome::DeferredByWindowsLock)
}

#[test]
fn accepted_clear_worker_outlives_its_caller_and_drain_waits_for_domain_terminal() {
    let (directory, core) = core_for_platform_contract("darwin", 22);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"signed-in").unwrap();

    let (terminal_hook_entered_sender, terminal_hook_entered_receiver) =
        std::sync::mpsc::channel();
    let (terminal_hook_release_sender, terminal_hook_release_receiver) =
        std::sync::mpsc::channel();
    let terminal_hook_release_receiver = Arc::new(Mutex::new(terminal_hook_release_receiver));
    *core
        .role_browser_data_clear_before_domain_terminal_hook
        .lock()
        .unwrap() = Some(Arc::new(move || {
        terminal_hook_entered_sender.send(()).unwrap();
        terminal_hook_release_receiver
            .lock()
            .unwrap()
            .recv()
            .unwrap();
    }));

    let receiver = core.subscribe().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let caller_core = Arc::clone(&core);
        let caller_role_id = role_id.clone();
        let caller = tokio::spawn(async move {
            caller_core
                .clear_role_browser_data_with_effect_timeout(
                    caller_role_id,
                    Duration::from_secs(3),
                )
                .await
        });
        tokio::task::yield_now().await;
        let effect = next_timed_role_browser_data_clear_effect(&receiver, &role_id);
        assert_eq!(
            core.role_browser_data_clear_commands.active_count(),
            1
        );

        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        core.begin_role_browser_data_clear_command_drain().unwrap();
        core.dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: true,
            value_json: None,
            error: None,
        }])
        .unwrap();
        terminal_hook_entered_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap();

        assert!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );
        assert!(browser.exists());
        assert!(!browser.join("session").exists());
        assert_eq!(core.browser_operations.active_ticket_count(), 1);
        assert!(!core
            .wait_for_role_browser_data_clear_command_drain(
                std::time::Instant::now() + Duration::from_millis(20),
            )
            .unwrap());
        assert_eq!(
            core.clear_role_browser_data_with_effect_timeout(
                role_id.clone(),
                Duration::from_secs(3),
            )
            .await
            .unwrap_err()
            .code(),
            "CORE_SHUTTING_DOWN"
        );

        terminal_hook_release_sender.send(()).unwrap();
        assert!(core
            .wait_for_role_browser_data_clear_command_drain(
                std::time::Instant::now() + Duration::from_secs(3),
            )
            .unwrap());
        assert_eq!(core.browser_operations.active_ticket_count(), 0);
        assert_eq!(
            core.role_browser_data_clear_commands.active_count(),
            0
        );
    });
    assert_eq!(
        core.shutdown_checked().unwrap(),
        AppCoreShutdownOutcome::Completed
    );
    assert_eq!(
        core.shutdown_checked().unwrap(),
        AppCoreShutdownOutcome::AlreadyCompleted
    );
}

#[test]
fn shutdown_without_a_proven_clear_drain_retains_runtime_and_instance_lock() {
    let (directory, core) = core_for_platform_contract("darwin", 22);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"signed-in").unwrap();

    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation_role_id = role_id.clone();
    let invocation = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(invocation_core.clear_role_browser_data_with_effect_timeout(
                invocation_role_id,
                Duration::from_secs(3),
            ))
    });
    let effect = next_timed_role_browser_data_clear_effect(&receiver, &role_id);

    assert_eq!(
        core.shutdown_checked().unwrap_err().code(),
        "CORE_SHUTDOWN_ROLE_BROWSER_DATA_CLEAR_UNVERIFIED"
    );
    assert!(core.runtime.read().unwrap().is_some());
    assert!(core.instance_lock.lock().unwrap().is_some());
    let competing = AppCore::create(AppCoreOptions {
        app_version: "2.1.0-test".to_owned(),
        build_commit: None,
        packaged: false,
        platform: "darwin".to_owned(),
        runtime_contract_version: Some(22),
        user_data_dir: directory.path().to_string_lossy().into_owned(),
    });
    assert!(matches!(
        competing,
        Err(CoreError::Domain {
            code: "APP_INSTANCE_LOCKED",
            ..
        })
    ));

    let report = core
        .dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "SYSTEM_RUNTIME_SHUTTING_DOWN".to_owned(),
                message: "native runtime shutdown cancelled the clear".to_owned(),
            }),
        }])
        .unwrap();
    assert_eq!(report.accepted.len(), 1);
    assert_eq!(
        invocation.join().unwrap().unwrap_err().code(),
        "SYSTEM_RUNTIME_SHUTTING_DOWN"
    );
    assert!(core
        .wait_for_role_browser_data_clear_command_drain(
            std::time::Instant::now() + Duration::from_secs(1),
        )
        .unwrap());
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");

    assert_eq!(
        core.shutdown_checked().unwrap(),
        AppCoreShutdownOutcome::Completed
    );
    assert!(core.runtime.read().unwrap().is_none());
    assert!(core.instance_lock.lock().unwrap().is_none());
    let replacement = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(22),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap(),
    );
    replacement.shutdown();
}

#[test]
fn checked_shutdown_reports_runtime_lock_failure_without_releasing_the_instance_lock() {
    let (_directory, core) = core_for_platform_contract("darwin", 22);
    let poisoned = Arc::clone(&core);
    assert!(
        thread::spawn(move || {
            let _runtime = poisoned.runtime.write().unwrap();
            panic!("poison the Core runtime lock");
        })
        .join()
        .is_err()
    );

    assert_eq!(
        core.shutdown_checked().unwrap_err().code(),
        "CORE_INTERNAL_FAILED"
    );
    let runtime = match core.runtime.read() {
        Ok(_) => panic!("the Core runtime lock must remain poisoned"),
        Err(error) => error.into_inner(),
    };
    assert!(runtime.is_some());
    assert!(core.instance_lock.lock().unwrap().is_some());
}

#[test]
fn checked_shutdown_reports_instance_lock_failure_before_releasing_the_runtime() {
    let (_directory, core) = core_for_platform_contract("darwin", 22);
    let poisoned = Arc::clone(&core);
    assert!(
        thread::spawn(move || {
            let _instance_lock = poisoned.instance_lock.lock().unwrap();
            panic!("poison the Core instance lock");
        })
        .join()
        .is_err()
    );

    assert_eq!(
        core.shutdown_checked().unwrap_err().code(),
        "CORE_INTERNAL_FAILED"
    );
    assert!(core.runtime.read().unwrap().is_some());
    assert!(
        core.instance_lock
            .lock()
            .unwrap_err()
            .into_inner()
            .is_some()
    );
}

#[test]
fn checked_shutdown_classifies_clear_precheck_failure_before_one_shot_teardown() {
    let (_directory, core) = core_for_platform_contract("darwin", 22);
    let poisoned = Arc::clone(&core);
    assert!(
        thread::spawn(move || {
            poisoned
                .role_browser_data_clear_commands
                .poison_state_lock_for_test();
        })
        .join()
        .is_err()
    );

    let error = core.shutdown_checked().unwrap_err();
    assert_eq!(error.code(), "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED");
    assert!(
        error
            .to_string()
            .contains("role browser-data clear command lock poisoned")
    );
    assert!(!core.shutdown_started.load(Ordering::Acquire));
    assert!(core.runtime.read().unwrap().is_some());
    assert!(core.instance_lock.lock().unwrap().is_some());
}

#[test]
fn checked_shutdown_classifies_browser_operation_precheck_failure_before_one_shot_teardown() {
    let (_directory, core) = core_for_platform_contract("win32", 22);
    let poisoned = Arc::clone(&core);
    assert!(
        thread::spawn(move || {
            poisoned.browser_operations.poison_state_lock_for_test();
        })
        .join()
        .is_err()
    );

    let error = core.shutdown_checked().unwrap_err();
    assert_eq!(error.code(), "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED");
    assert!(error.to_string().contains("browser operation lock poisoned"));
    assert!(!core.shutdown_started.load(Ordering::Acquire));
    assert!(core.runtime.read().unwrap().is_some());
    assert!(core.instance_lock.lock().unwrap().is_some());
}

#[test]
fn failed_checked_shutdown_drop_retains_the_instance_lock_until_process_termination() {
    let (directory, core) = core_for_platform_contract("darwin", 23);
    core.retain_failed_shutdown_instance_lock_for_test
        .store(true, Ordering::Release);
    let _retained_lease = core
        .browser_operations
        .acquire(BrowserOperationRequest {
            kind: "destructiveMutation".to_owned(),
            role_ids: vec!["role-with-unverified-owner".to_owned()],
        })
        .unwrap();
    assert_eq!(
        core.shutdown_checked().unwrap_err().code(),
        "CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED"
    );
    drop(core);

    let options = || AppCoreOptions {
        app_version: "2.1.0-test".to_owned(),
        build_commit: None,
        packaged: false,
        platform: "darwin".to_owned(),
        runtime_contract_version: Some(23),
        user_data_dir: directory.path().to_string_lossy().into_owned(),
    };
    let competing = match AppCore::create(options()) {
        Ok(_) => panic!("a dropped unverified Core released its process instance lock"),
        Err(error) => error,
    };
    assert_eq!(competing.code(), "APP_INSTANCE_LOCKED");

    // This test-only release models the OS closing every process handle. The
    // production registry has no release boundary before process termination.
    assert!(release_process_retained_instance_lock_for_test(directory.path()).unwrap());
    let replacement = AppCore::create(options()).unwrap();
    assert_eq!(
        replacement.shutdown_checked().unwrap(),
        AppCoreShutdownOutcome::Completed
    );
    drop(replacement);
    assert!(!release_process_retained_instance_lock_for_test(directory.path()).unwrap());
}

#[test]
fn timed_out_role_browser_data_clear_stays_quarantined_and_late_result_cannot_commit() {
    let (directory, core) = core_for_platform_contract("darwin", 23);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"signed-in").unwrap();
    let migration_before = core.role_session_migration(role_id.clone()).unwrap();

    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation_role_id = role_id.clone();
    let invocation = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(invocation_core.clear_role_browser_data_with_effect_timeout(
                invocation_role_id,
                Duration::from_millis(10),
            ))
    });
    let effect = next_timed_role_browser_data_clear_effect(&receiver, &role_id);
    assert_eq!(
        effect.completion_policy,
        crate::model::OperationCompletionPolicy::DeadlineBound
    );
    assert!(effect.deadline_ms.is_some());
    assert_eq!(
        invocation.join().unwrap().unwrap_err().code(),
        "CORE_EFFECT_TIMEOUT"
    );

    assert!(!browser.exists());
    let journals = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0].phase, "quarantined");
    assert_eq!(
        journals[0].payload["roleId"],
        serde_json::Value::String(role_id.clone())
    );
    let journal_id = journals[0].id.clone();
    let journal_payload = journals[0].payload.clone();
    assert_eq!(core.browser_operations.active_ticket_count(), 1);

    let report = core
        .dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id.clone(),
            operation_id: effect.operation_id.clone(),
            ok: true,
            value_json: Some(
                json!({
                    "roleId": role_id.clone(),
                    "operationId": effect.operation_id.clone(),
                    "clearedStorages": [
                        "cookies", "filesystem", "indexdb", "localstorage",
                        "shadercache", "serviceworkers", "cachestorage"
                    ],
                    "cookieReadbackCount": 0,
                    "evidence": CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RECEIPT_EVIDENCE
                })
                .to_string(),
            ),
            error: None,
        }])
        .unwrap();
    assert_eq!(report.late, vec![effect.effect_id]);
    assert!(!browser.exists());
    let late_journals = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert_eq!(late_journals.len(), 1);
    assert_eq!(late_journals[0].id, journal_id);
    assert_eq!(late_journals[0].phase, "quarantined");
    assert_eq!(late_journals[0].payload, journal_payload);
    assert_eq!(
        core.role_session_migration(role_id.clone()).unwrap(),
        migration_before
    );
    assert_eq!(core.browser_operations.active_ticket_count(), 1);

    core.shutdown();
    drop(core);
    let replacement = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap(),
    );
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert!(
        replacement
            .with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        replacement.role_session_migration(role_id).unwrap(),
        migration_before
    );
    replacement.shutdown();
}

#[test]
fn unverified_native_clear_terminal_retains_quarantine_journal_and_role_lease() {
    let (directory, core) = core_for_platform_contract("darwin", 23);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"signed-in").unwrap();
    let migration_before = core.role_session_migration(role_id.clone()).unwrap();

    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation_role_id = role_id.clone();
    let invocation = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(invocation_core.clear_role_browser_data_with_effect_timeout(
                invocation_role_id,
                Duration::from_secs(3),
            ))
    });
    let effect = next_timed_role_browser_data_clear_effect(&receiver, &role_id);
    let report = core
        .dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "SYSTEM_BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED".to_owned(),
                message: "native completion or utility release stream was lost".to_owned(),
            }),
        }])
        .unwrap();
    assert_eq!(report.accepted.len(), 1);
    assert_eq!(
        invocation.join().unwrap().unwrap_err().code(),
        "SYSTEM_BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED"
    );

    assert!(!browser.exists());
    let journals = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0].phase, "quarantined");
    assert_eq!(journals[0].payload["roleId"], role_id);
    assert_eq!(core.browser_operations.active_ticket_count(), 1);
    assert_eq!(
        core.role_session_migration(role_id.clone()).unwrap(),
        migration_before
    );

    core.begin_role_browser_data_clear_command_drain().unwrap();
    assert!(
        core.wait_for_role_browser_data_clear_command_drain(
            std::time::Instant::now() + Duration::from_secs(1),
        )
        .unwrap()
    );
    assert_eq!(core.role_browser_data_clear_commands.active_count(), 0);
    assert_eq!(core.browser_operations.active_ticket_count(), 1);
    assert_eq!(
        core.shutdown_checked().unwrap_err().code(),
        "CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED"
    );
    assert!(core.runtime.read().unwrap().is_some());
    assert!(core.instance_lock.lock().unwrap().is_some());

    core.shutdown();
    drop(core);
    let replacement = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap(),
    );
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert!(
        replacement
            .with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        replacement.role_session_migration(role_id).unwrap(),
        migration_before
    );
    replacement.shutdown();
}

#[test]
fn logical_windows_deferred_timeout_late_result_and_restart_preserve_the_source() {
    let (directory, core) = core_for_platform_contract("win32", 23);
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let browser = directory
        .path()
        .join("roles")
        .join(&role_id)
        .join("browser");
    fs::write(browser.join("session"), b"signed-in").unwrap();
    let migration_before = core.role_session_migration(role_id.clone()).unwrap();

    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let invocation_role_id = role_id.clone();
    let invocation = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(
                invocation_core.clear_role_browser_data_with_effect_timeout_and_quarantine(
                    invocation_role_id,
                    Duration::from_millis(10),
                    defer_role_browser_data_clear_for_logical_windows_lock,
                ),
            )
    });
    let effect = next_timed_role_browser_data_clear_effect(&receiver, &role_id);
    assert_eq!(
        invocation.join().unwrap().unwrap_err().code(),
        "CORE_EFFECT_TIMEOUT"
    );

    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    let journals = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0].phase, "deferred");
    assert_eq!(journals[0].payload["hadDirectory"], true);
    assert_eq!(journals[0].payload["deferredByWindowsLock"], true);
    let journal_id = journals[0].id.clone();

    let report = core
        .dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: effect.effect_id.clone(),
            operation_id: effect.operation_id.clone(),
            ok: true,
            value_json: Some(
                json!({
                    "roleId": role_id.clone(),
                    "operationId": effect.operation_id.clone(),
                    "clearedStorages": [
                        "cookies", "filesystem", "indexdb", "localstorage",
                        "shadercache", "serviceworkers", "cachestorage"
                    ],
                    "cookieReadbackCount": 0,
                    "evidence": CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RECEIPT_EVIDENCE
                })
                .to_string(),
            ),
            error: None,
        }])
        .unwrap();
    assert_eq!(report.late, vec![effect.effect_id]);
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    let late_journals = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert_eq!(late_journals.len(), 1);
    assert_eq!(late_journals[0].id, journal_id);
    assert_eq!(late_journals[0].phase, "deferred");
    assert_eq!(
        core.role_session_migration(role_id.clone()).unwrap(),
        migration_before
    );
    assert_eq!(core.browser_operations.active_ticket_count(), 1);
    core.begin_role_browser_data_clear_command_drain().unwrap();
    assert!(core
        .wait_for_role_browser_data_clear_command_drain(
            std::time::Instant::now() + Duration::from_secs(1),
        )
        .unwrap());
    assert_eq!(core.browser_operations.active_ticket_count(), 1);

    core.shutdown();
    drop(core);
    let replacement = Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "win32".to_owned(),
            runtime_contract_version: Some(23),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap(),
    );
    assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
    assert!(
        replacement
            .with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        replacement.role_session_migration(role_id).unwrap(),
        migration_before
    );
    replacement.shutdown();
}
