#[test]
    fn portable_role_import_is_blocked_while_the_affected_role_is_running() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let selection = crate::model::PortableDataSelectionRecord {
            games: true,
            roles: true,
            launch_workspaces: false,
            game_windows: false,
            macros: false,
            preferences: false,
        };
        let mut portable = core
            .invoke(CoreCommand::PortableExport {
                preferences: None,
                selection: selection.clone(),
            })
            .unwrap();
        portable["roles"][0]["launchUrl"] = json!("https://example.com/imported");
        let preview = core
            .invoke(CoreCommand::PortablePreview {
                raw_json: portable.to_string(),
                file_path: "/tmp/rion-running-role-import.json".to_owned(),
            })
            .unwrap();
        seed_running_role(&core, &role_id);

        let error = core
            .invoke(CoreCommand::PortableApply {
                import_id: preview["importId"].as_str().unwrap().to_owned(),
                selection,
                resolutions: Vec::new(),
            })
            .unwrap_err();

        assert_eq!(error.code(), "PORTABLE_IMPORT_ROLES_RUNNING");
        assert_eq!(
            core.invoke(CoreCommand::RoleGet { id: role_id }).unwrap()["launchUrl"],
            "https://example.com/play/1"
        );
        core.shutdown();
    }

    #[test]
    fn launches_and_stops_an_embedded_role_through_typed_effects() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (launch, launch_actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok());
        assert!(matches!(
            launch_actions.first(),
            Some(CoreEffectAction::EmbeddedCreateTab { tab })
                if tab.roles.iter().all(|role| {
                    role.resolved_engine == crate::model::ResolvedBrowserEngine::Wkwebview
                })
        ));
        assert!(
            launch_actions
                .iter()
                .all(|action| !matches!(action, CoreEffectAction::EmbeddedFollowRoleOwnership { .. }))
        );
        assert!(launch_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedLoadRoles { roles }
                if roles.len() == 1
                    && roles[0].resolved_engine
                        == crate::model::ResolvedBrowserEngine::Wkwebview
        )));
        assert!(launch_actions.iter().all(|action| !matches!(
            action,
            CoreEffectAction::EmbeddedFollowRoleOwnership { roles, .. }
                if roles.iter().any(|role| role.state == "running")
        )));
        let running_snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(
            running_snapshot
                .roles
                .iter()
                .any(|role| role.role_id == role_id && role.state == "running")
        );
        let (statuses, _) = drive_command(Arc::clone(&core), CoreCommand::BrowserStatuses, None);
        assert!(
            statuses
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|status| { status["roleId"] == role_id && status["state"] == "running" })
        );
        let (stop, stop_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        );
        assert!(stop.is_ok());
        assert!(
            stop_actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyRole { .. }))
        );
        let destroy_index = stop_actions
            .iter()
            .position(|action| matches!(action, CoreEffectAction::EmbeddedDestroyRole { .. }))
            .unwrap();
        let projection_index = stop_actions
            .iter()
            .position(|action| matches!(action, CoreEffectAction::EmbeddedFollowRoleOwnership { .. }))
            .unwrap();
        assert!(destroy_index < projection_index);
        let stopped_snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(stopped_snapshot.roles.is_empty());
        assert_eq!(stopped_snapshot.tabs.len(), 1);
        assert_eq!(stopped_snapshot.tabs[0].slots[0].state, "available");
        core.shutdown();
    }

    #[test]
    fn typed_tab_stop_correlates_native_effects_and_commits_saved_state() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let role_id = create_role(&core, &first_game_id(&core), 1);
            drive_command(
                Arc::clone(&core),
                command(json!({
                    "type": "embeddedRoleLaunch",
                    "roleId": role_id,
                    "target": {
                        "displayId": 1,
                        "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                    }
                })),
                None,
            )
            .0
            .unwrap();
            let snapshot = core
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot;
            let tab = snapshot.tabs.first().unwrap();
            let parent_operation_id = format!("native-tabStop-{platform}");
            let (stopped, actions, _) = drive_async_command_with(
                Arc::clone(&core),
                embedded_tab_stop_mutation_command(
                    &parent_operation_id,
                    &tab.id,
                    &tab.window_id,
                    &role_id,
                ),
                |effect| effect_result_with_parent(effect, &parent_operation_id, platform),
            );
            let stopped: BrowserRuntimeSnapshot =
                serde_json::from_value(stopped.unwrap()).unwrap();
            assert!(stopped.tabs.is_empty(), "{platform}");
            assert!(stopped.roles.is_empty(), "{platform}");
            assert!(
                actions
                    .iter()
                    .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. })),
                "{platform}"
            );
            let saved = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert!(
                saved.as_array().unwrap().iter().all(|window| window["tabs"]
                    .as_array()
                    .is_none_or(Vec::is_empty)),
                "{platform}"
            );
            core.shutdown();
        }
    }

    #[test]
    fn public_role_launch_accepts_two_roles_without_waiting_for_native_readiness() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let first_role_id = create_role(&core, &game_id, 1);
        let second_role_id = create_role(&core, &game_id, 2);
        let target = EmbeddedLaunchTargetRecord {
            window_id: uuid::Uuid::new_v4().to_string(),
            persisted_name: None,
            display_id: 1,
            scale_factor: 1.0,
            work_area: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
            bounds: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 960,
                height: 640,
            },
            presentation: "normal".to_owned(),
        };
        // No effect subscriber acknowledges controller creation or navigation. Both public
        // commands must still return their accepted `launching` state; the Core-owned
        // completion coordinator retains the unfinished operations independently of this
        // caller's short-lived runtime.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for role_id in [&first_role_id, &second_role_id] {
            let started = std::time::Instant::now();
            let result = runtime
                .block_on(core.invoke_async(CoreCommand::BrowserRoleLaunch {
                    launch_tab_id: None,
                    role_id: role_id.clone(),
                    target: target.clone(),
                    launch_preview_id: None,
                    zoom_factor: None,
                    restore_role_slots: None,
                }))
                .unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));
            assert_eq!(result["completion"], "pendingNativeCompletion");
            assert_eq!(result["statuses"][0]["roleId"], *role_id);
            assert_eq!(result["statuses"][0]["state"], "launching");
        }
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(
            snapshot
                .roles
                .iter()
                .any(|role| { role.role_id == first_role_id && role.state == "launching" })
        );
        assert!(
            snapshot
                .roles
                .iter()
                .any(|role| { role.role_id == second_role_id && role.state == "launching" })
        );
        core.shutdown();
    }

    #[test]
    fn accepted_role_launch_failure_settles_and_cleans_runtime_in_background() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let target = EmbeddedLaunchTargetRecord {
            window_id: uuid::Uuid::new_v4().to_string(),
            persisted_name: None,
            display_id: 1,
            scale_factor: 1.0,
            work_area: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
            bounds: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 960,
                height: 640,
            },
            presentation: "normal".to_owned(),
        };
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
        let launch_preview_id = "preview-role-launch".to_owned();
        let accepted = runtime
            .block_on(core.invoke_async(CoreCommand::BrowserRoleLaunch {
                launch_tab_id: None,
                role_id: role_id.clone(),
                target,
                launch_preview_id: Some(launch_preview_id.clone()),
                zoom_factor: None,
                restore_role_slots: None,
            }))
            .unwrap();
        assert_eq!(accepted["completion"], "pendingNativeCompletion");
        assert_eq!(accepted["statuses"][0]["state"], "launching");

        let create_effect = loop {
            let events = effects.recv_timeout(Duration::from_secs(2)).unwrap();
            if let Some(effect) = events.into_iter().find_map(|event| match event {
                CoreEvent::CoreEffects { effects } => effects.into_iter().find(|effect| {
                    matches!(effect.action, CoreEffectAction::EmbeddedCreateTab { .. })
                }),
                _ => None,
            }) {
                break effect;
            }
        };
        assert!(matches!(
            &create_effect.action,
            CoreEffectAction::EmbeddedCreateTab { tab }
                if tab.launch_preview_id.as_deref() == Some(launch_preview_id.as_str())
                    && tab.attempt_generation.as_deref() != Some(launch_preview_id.as_str())
        ));
        core.dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: create_effect.effect_id,
            operation_id: create_effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "DESKTOP_EFFECT_FAILED".to_owned(),
                message: "Injected native create failure.".to_owned(),
            }),
        }])
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let completion = loop {
            if let Ok(completion) = completion_receiver.try_recv() {
                break completion;
            }
            assert!(
                Instant::now() < deadline,
                "accepted launch should publish its background failure; metrics={:?}",
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
                .map(|effect| CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: true,
                    value_json: None,
                    error: None,
                })
                .collect::<Vec<_>>();
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        };
        assert_eq!(completion.source_id, role_id);
        assert_eq!(
            completion.launch_preview_id.as_deref(),
            Some(launch_preview_id.as_str())
        );
        assert!(completion.error.is_some());
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty());
        assert!(snapshot.tabs.is_empty());
        core.shutdown();
    }

    #[test]
    fn stop_emits_native_isolation_before_waiting_for_state_persistence() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        seed_running_role(&core, &role_id);
        let events = core.subscribe().unwrap();
        let persistence_guard = core.state_mutation_guard().unwrap();
        let stopping_core = Arc::clone(&core);
        let stopping_role_id = role_id.clone();
        let stop = thread::spawn(move || {
            stopping_core.invoke(CoreCommand::EmbeddedRoleStop {
                role_id: stopping_role_id,
            })
        });

        let effect = loop {
            let events = events
                .recv_timeout(Duration::from_millis(250))
                .expect("native isolation must be emitted before persistence is available");
            if let Some(effect) = events.into_iter().find_map(|event| match event {
                CoreEvent::CoreEffects { effects } => effects.into_iter().find(|effect| {
                    matches!(effect.action, CoreEffectAction::EmbeddedDestroyRole { .. })
                }),
                _ => None,
            }) {
                break effect;
            }
        };
        core.dispatch_core_effect_results(vec![effect_result(effect, None)])
            .unwrap();
        assert!(!stop.is_finished());
        drop(persistence_guard);
        while !stop.is_finished() {
            let Ok(events) = events.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            let results = events
                .into_iter()
                .filter_map(|event| match event {
                    CoreEvent::CoreEffects { effects } => Some(
                        effects
                            .into_iter()
                            .map(|effect| effect_result(effect, None))
                            .collect::<Vec<_>>(),
                    ),
                    _ => None,
                })
                .flatten()
                .collect::<Vec<_>>();
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        assert!(stop.join().unwrap().is_ok());
        core.shutdown();
    }

    #[test]
    fn rapid_independent_tab_stops_both_commit_after_out_of_order_native_results() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let first_role_id = create_role(&core, &game_id, 1);
        let second_role_id = create_role(&core, &game_id, 2);
        seed_running_role(&core, &first_role_id);
        seed_running_role(&core, &second_role_id);
        let events = core.subscribe().unwrap();

        let first_core = Arc::clone(&core);
        let first_stop_role_id = first_role_id.clone();
        let first_stop = thread::spawn(move || {
            first_core.invoke(CoreCommand::EmbeddedRoleStop {
                role_id: first_stop_role_id,
            })
        });
        let second_core = Arc::clone(&core);
        let second_stop_role_id = second_role_id.clone();
        let second_stop = thread::spawn(move || {
            second_core.invoke(CoreCommand::EmbeddedRoleStop {
                role_id: second_stop_role_id,
            })
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut last_statuses = None;
        while (!first_stop.is_finished() || !second_stop.is_finished())
            && std::time::Instant::now() < deadline
        {
            let Ok(batch) = events.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            for event in batch {
                match event {
                    CoreEvent::CoreEffects { effects } => {
                        // Reverse each emitted batch to exercise completion ordering
                        // independently from close request ordering.
                        core.dispatch_core_effect_results(
                            effects
                                .into_iter()
                                .rev()
                                .map(|effect| effect_result(effect, None))
                                .collect(),
                        )
                        .unwrap();
                    }
                    CoreEvent::BrowserStatuses { statuses } => last_statuses = Some(statuses),
                    _ => {}
                }
            }
        }

        assert!(first_stop.is_finished(), "first close transaction stalled");
        assert!(
            second_stop.is_finished(),
            "second close transaction stalled"
        );
        assert!(first_stop.join().unwrap().is_ok());
        assert!(second_stop.join().unwrap().is_ok());
        while let Ok(batch) = events.recv_timeout(Duration::from_millis(50)) {
            for event in batch {
                if let CoreEvent::BrowserStatuses { statuses } = event {
                    last_statuses = Some(statuses);
                }
            }
        }
        assert!(
            last_statuses
                .is_some_and(|statuses| statuses.iter().all(|status| status.state == "stopped")),
            "the final browser status projection must not regress to stopping"
        );
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty());
        assert_eq!(snapshot.tabs.len(), 2);
        assert!(snapshot.tabs.iter().all(|tab| {
            tab.slots.iter().all(|slot| slot.state == "available")
        }));
        core.shutdown();
    }

    #[test]
    fn embedded_macro_from_one_role_runs_balanced_iterations_for_each_available_role() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let role_id = create_role(&core, &game_id, 1);
        let sibling_role_id = create_role(&core, &game_id, 2);
        let unavailable_role_id = create_role(&core, &game_id, 3);
        let (launch, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok());
        let (sibling_launch, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": sibling_role_id,
                "target": {
                    "displayId": 2,
                    "workArea": {"x": 1200, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(sibling_launch.is_ok());
        let macro_id = core
            .invoke(command(json!({
                "type": "macroCreate",
                "input": {
                    "name": "Digit one loop",
                    "roleIds": [
                        role_id.clone(),
                        sibling_role_id.clone(),
                        unavailable_role_id.clone()
                    ],
                    "trigger": {
                        "code": "KeyQ",
                        "ctrl": false,
                        "alt": false,
                        "shift": false,
                        "meta": false
                    },
                    "repeat": {"type": "loop", "intervalMs": 10},
                    "steps": [{
                        "type": "key",
                        "code": "Digit1",
                        "action": "tap"
                    }]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let receiver = core.subscribe().unwrap();
        let start_core = Arc::clone(&core);
        let start_macro_id = macro_id.clone();
        let source_role_id = role_id.clone();
        let start = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(
                    start_core.invoke_async(CoreCommand::OverlayRequest {
                        role_id: source_role_id,
                        request_json: json!({
                            "type": "start",
                            "macroId": start_macro_id
                        })
                        .to_string(),
                        language: Some("zh-TW".to_owned()),
                    }),
                )
        });
        let expected_roles = HashSet::from([role_id.clone(), sibling_role_id.clone()]);
        let mut presses = HashMap::<String, usize>::new();
        let mut releases = HashMap::<String, usize>::new();
        let mut held_roles = HashSet::<String>::new();
        let mut failed = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while releases.get(&role_id).copied().unwrap_or_default() < 3
            || releases.get(&sibling_role_id).copied().unwrap_or_default() < 3
            || !start.is_finished()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "embedded macro did not complete three iterations"
            );
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            let mut results = Vec::new();
            for event in events {
                match event {
                    CoreEvent::CoreEffects { effects } => {
                        for effect in effects {
                            if let CoreEffectAction::BrowserAction { request } = &effect.action
                                && let crate::model::BrowserAction::Key { code, phase, .. } =
                                    &request.action
                            {
                                assert_eq!(code.as_deref(), Some("Digit1"));
                                assert!(expected_roles.contains(&request.role_id));
                                match phase.as_str() {
                                    "hold" => {
                                        assert!(held_roles.insert(request.role_id.clone()));
                                        *presses.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    "release" => {
                                        assert!(held_roles.remove(&request.role_id));
                                        *releases.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    phase => panic!("unexpected macro key phase {phase}"),
                                }
                            }
                            results.push(effect_result(effect, None));
                        }
                    }
                    CoreEvent::MacroStatuses { statuses, .. } => {
                        failed |= statuses.iter().any(|status| status.state == "failed");
                    }
                    _ => {}
                }
            }
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        let start_view = start.join().unwrap().unwrap();
        {
            assert_eq!(start_view["startSummary"]["startedCount"], 2);
            assert_eq!(start_view["startSummary"]["skippedCount"], 1);
        };
        {
            assert!(!failed);
            assert!(releases.get(&role_id).copied().unwrap_or_default() >= 3);
            assert!(releases.get(&sibling_role_id).copied().unwrap_or_default() >= 3);
            // The loop remains active until MacroStop below, so it may already have
            // started the next balanced iteration after both roles released three
            // times. Assert the fully drained key state only after stop completes.
        };

        let stop_core = Arc::clone(&core);
        let stop = thread::spawn(move || stop_core.invoke(CoreCommand::MacroStop { macro_id }));
        while !stop.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            for event in events {
                match event {
                    CoreEvent::CoreEffects { effects } => {
                        let mut results = Vec::new();
                        for effect in effects {
                            if let CoreEffectAction::BrowserAction { request } = &effect.action
                                && let crate::model::BrowserAction::Key { code, phase, .. } =
                                    &request.action
                            {
                                assert_eq!(code.as_deref(), Some("Digit1"));
                                assert!(expected_roles.contains(&request.role_id));
                                match phase.as_str() {
                                    "hold" => {
                                        assert!(held_roles.insert(request.role_id.clone()));
                                        *presses.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    "release" => {
                                        assert!(held_roles.remove(&request.role_id));
                                        *releases.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    phase => panic!("unexpected macro key phase {phase}"),
                                }
                            }
                            results.push(effect_result(effect, None));
                        }
                        core.dispatch_core_effect_results(results).unwrap();
                    }
                    CoreEvent::MacroStatuses { statuses, .. } => {
                        failed |= statuses.iter().any(|status| status.state == "failed");
                    }
                    _ => {}
                }
            }
        }
        assert!(stop.join().unwrap().is_ok());
        assert!(!failed);
        assert!(held_roles.is_empty());
        assert!(!presses.contains_key(&unavailable_role_id));
        assert!(!releases.contains_key(&unavailable_role_id));
        // Each role advances on its own worker. A role may complete another balanced
        // iteration before the global stop reaches every worker, so cross-role totals
        // are not required to match.
        for expected_role_id in [&role_id, &sibling_role_id] {
            let press_count = presses.get(expected_role_id).copied().unwrap_or_default();
            let release_count = releases.get(expected_role_id).copied().unwrap_or_default();
            assert!(
                release_count >= 3,
                "{expected_role_id} completed only {release_count} loops"
            );
            assert_eq!(
                press_count, release_count,
                "{expected_role_id} key state is unbalanced"
            );
        }
        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        );
        assert!(stopped.is_ok());
        let (sibling_stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: sibling_role_id,
            },
            None,
        );
        assert!(sibling_stopped.is_ok());
        core.shutdown();
    }
