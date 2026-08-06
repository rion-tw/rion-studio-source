#[test]
fn stopping_a_launching_workspace_retires_native_tab_after_core_topology_cancellation() {
    let (_directory, core) = core();
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
            let CoreEvent::CoreEffects { effects } = event else {
                continue;
            };
            let mut results = Vec::new();
            for effect in effects {
                match &effect.action {
                    CoreEffectAction::EmbeddedCreateTab { tab } => {
                        created_tab_id = Some(tab.tab_id.clone());
                    }
                    CoreEffectAction::EmbeddedLoadRoles { .. } if stop.is_none() => {
                        let stop_core = Arc::clone(&core);
                        let stop_workspace_id = workspace_id.clone();
                        stop = Some(thread::spawn(move || {
                            stop_core.invoke(CoreCommand::EmbeddedWorkspaceStop {
                                workspace_id: stop_workspace_id,
                            })
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
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.roles.is_empty());
    assert!(snapshot.tabs.is_empty());
    core.shutdown();
}
