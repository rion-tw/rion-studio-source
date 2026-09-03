#[test]
fn stopping_a_launching_workspace_retires_native_tab_after_core_topology_cancellation() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "Cancelled workspace",
                "template": "single",
                "slots": [{"roleId": role_id, "rect": workspace_rect(0, 1)}]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let receiver = core.subscribe().unwrap();
    let launch_core = Arc::clone(&core);
    let launch_workspace_id = workspace_id.clone();
    let launch = thread::spawn(move || {
        launch_core.invoke(command(json!({
            "type": "embeddedWorkspaceLaunch",
            "workspaceId": launch_workspace_id,
            "target": {
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })))
    });
    let mut stop = None;
    let mut created_tab_id = None;
    let mut destroyed_tab_id = None;
    let mut observed_actions = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !launch.is_finished()
        || stop
            .as_ref()
            .is_some_and(|stop: &thread::JoinHandle<_>| !stop.is_finished())
    {
        assert!(
            std::time::Instant::now() < deadline,
            "workspace launch cancellation did not complete before the deadline"
        );
        let events = match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(events) => events,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(error) => panic!("core event channel disconnected: {error}"),
        };
        for event in events {
            let effects = match event {
                CoreEvent::CoreEffectCancellations { cancellations } => {
                    let results = cancellations
                        .into_iter()
                        .map(|cancellation| CoreEffectResult {
                            effect_id: cancellation.effect_id,
                            operation_id: cancellation.operation_id,
                            ok: false,
                            value_json: None,
                            error: Some(crate::CoreErrorPayload {
                                code: "CHROMIUM_RUNTIME_EFFECT_CANCELLED".to_owned(),
                                message: "the exact Chromium continuation was cancelled".to_owned(),
                            }),
                        })
                        .collect();
                    core.dispatch_core_effect_results(results).unwrap();
                    continue;
                }
                CoreEvent::CoreEffects { effects } => effects,
                _ => continue,
            };
            let mut results = Vec::new();
            for effect in effects {
                observed_actions.push(effect.action.clone());
                match &effect.action {
                    CoreEffectAction::EmbeddedCreateTab { tab } => {
                        created_tab_id = Some(tab.tab_id.clone());
                    }
                    CoreEffectAction::EmbeddedLoadRoles { .. } if stop.is_none() => {
                        let stop_core = Arc::clone(&core);
                        let tab_id = created_tab_id
                            .clone()
                            .expect("native create must precede the gated Role load");
                        let runtime = core.browser_runtime.snapshot().unwrap();
                        let window = runtime
                            .windows
                            .values()
                            .find(|window| window.contains_tab(&tab_id))
                            .expect("launching AppKit tab must have one logical window");
                        let mut observation =
                            appkit_test_observation(&window.window_id, 1);
                        observation.window_generation = window.window_generation;
                        observation.topology_revision = window.revision;
                        let event = crate::model::AppKitRuntimeEventRecord {
                            event_id: uuid::Uuid::new_v4().to_string(),
                            adapter_sequence: 1,
                            hosts: vec![observation],
                            action: crate::model::AppKitRuntimeEventActionRecord::Stop {
                                tab_id,
                                ordered_tab_ids: Vec::new(),
                            },
                        };
                        stop = Some(thread::spawn(move || {
                            tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .unwrap()
                                .block_on(stop_core.invoke_async(
                                    CoreCommand::BrowserAppKitRuntimeEvent { event },
                                ))
                        }));
                        continue;
                    }
                    CoreEffectAction::EmbeddedDestroyTab { tab_id, .. } => {
                        destroyed_tab_id = Some(tab_id.clone());
                    }
                    _ => {}
                }
                results.push(effect_result(effect, None));
            }
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
    }
    assert_eq!(
        launch.join().unwrap().unwrap_err().code(),
        "LAUNCH_CANCELLED"
    );
    assert!(stop.unwrap().join().unwrap().is_ok());
    assert_eq!(destroyed_tab_id, created_tab_id);
    let native_destroy_index = observed_actions
        .iter()
        .position(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
        .expect("cancelled launch must destroy its exact native tab");
    assert!(!observed_actions[..native_destroy_index]
        .iter()
        .any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedFollowRoleOwnership { windows, .. }
                if windows.iter().any(|window| window.tab_ids.is_empty())
        )));
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.roles.is_empty());
    assert!(snapshot.tabs.is_empty());
    let app_snapshot = core.app_snapshot().unwrap();
    assert!(app_snapshot.logical_windows.is_empty());
    assert!(app_snapshot.browser_runtime.windows.is_empty());
    core.shutdown();
}
