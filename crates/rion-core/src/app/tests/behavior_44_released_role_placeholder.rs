#[test]
fn released_role_placeholder_reopens_after_source_tab_close() {
    for (platform, same_window) in [("darwin", false), ("darwin", true), ("win32", false), ("win32", true)] {
        let (_directory, core) = chromium_web_core(platform);
        let game_id = first_game_id(&core);
        let shared = create_role(&core, &game_id, 1);
        let sibling = create_role(&core, &game_id, 2);
        let workspace = core.invoke(command(json!({
            "type": "workspaceCreate", "input": {
                "name": "Target", "template": "two_columns", "slots": [
                    {"roleId": shared, "rect": workspace_rect(0, 2)},
                    {"roleId": sibling, "rect": workspace_rect(1, 2)}
                ]
            }
        }))).unwrap()["id"].as_str().unwrap().to_owned();
        let target_window = if same_window { "source-window" } else { "target-window" };
        for launch in [
            json!({"type": "embeddedRoleLaunch", "roleId": shared, "target": {
                "windowId": "source-window", "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }}),
            json!({"type": "embeddedWorkspaceLaunch", "workspaceId": workspace, "target": {
                "windowId": target_window, "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }})
        ] {
            drive_command(Arc::clone(&core), command(launch), None).0.unwrap();
        }
        let before = core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot).unwrap().snapshot;
        let source = before.tabs.iter().find(|tab| tab.source_id == shared).unwrap();
        let target = before.tabs.iter().find(|tab| tab.source_id == workspace).unwrap();
        let slot = target.slots.iter().find(|slot| slot.role_id == shared).unwrap();
        let old_generation = slot.owner.as_ref().unwrap().generation;
        let sibling_owner = before.roles.iter().find(|role| role.role_id == sibling).unwrap().owner.clone();
        let native = core.browser_runtime.snapshot().unwrap();
        let window = &native.windows["source-window"];
        let stop = if platform == "darwin" {
            let mut observation = appkit_test_observation("source-window", 1);
            observation.window_generation = window.window_generation;
            observation.topology_revision = window.revision;
            CoreCommand::BrowserAppKitRuntimeEvent {
                event: crate::model::AppKitRuntimeEventRecord {
                    event_id: uuid::Uuid::new_v4().to_string(), adapter_sequence: 1,
                    hosts: vec![observation],
                    action: crate::model::AppKitRuntimeEventActionRecord::Stop {
                        tab_id: source.id.clone(),
                        ordered_tab_ids: window.tabs.iter().filter(|tab| tab.id != source.id)
                            .map(|tab| tab.id.clone()).collect(),
                    },
                },
            }
        } else {
            CoreCommand::EmbeddedTabStop {
                request: crate::model::RuntimeTabMutationRequestRecord {
                    operation_id: uuid::Uuid::new_v4().to_string(), mutation_kind: "stop".to_owned(),
                    tab_id: source.id.clone(), source_window_id: source.window_id.clone(),
                    source_window_generation: window.window_generation, lifecycle_epoch: 1,
                },
                source_id: shared.clone(), tab_type: "role".to_owned(),
            }
        };
        let (stopped, actions, _) = drive_async_command(Arc::clone(&core), stop, None);
        let stopped = stopped.unwrap();
        if platform == "darwin" { assert_eq!(stopped["status"], "applied"); }
        let destroy = actions.iter().position(|action| matches!(action,
            CoreEffectAction::EmbeddedDestroyTab { tab_id, .. } if tab_id == &source.id)).unwrap();
        let follow = actions.iter().position(|action| matches!(action,
            CoreEffectAction::EmbeddedFollowRoleOwnership { roles, windows, .. }
                if !roles.iter().any(|role| role.role_id == shared)
                    && windows.iter().any(|window| window.window_id == target_window))).unwrap();
        assert!(destroy < follow);
        if same_window && platform == "darwin" {
            let membership = actions.iter().position(|action| matches!(action,
                CoreEffectAction::EmbeddedApplyAppKitProjection { .. })).unwrap();
            assert!(membership < follow);
        }
        let released = core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot).unwrap().snapshot;
        assert!(!released.tabs.iter().any(|tab| tab.id == source.id));
        assert!(!released.roles.iter().any(|role| role.role_id == shared));
        let target_slot = released.tabs.iter().find(|tab| tab.id == target.id).unwrap()
            .slots.iter().find(|candidate| candidate.slot_id == slot.slot_id).unwrap();
        assert_eq!(target_slot.state, "available");
        assert!(target_slot.owner.is_none());
        let claim = |expected_owner_generation| CoreCommand::BrowserRoleSlotClaim {
            tab_id: target.id.clone(), slot_id: slot.slot_id.clone(), expected_owner_generation,
        };
        let (stale, stale_actions, _) = drive_async_command(Arc::clone(&core), claim(Some(old_generation)), None);
        assert_eq!(stale.unwrap_err().code(), "RUNTIME_ROLE_OWNER_STALE");
        assert!(stale_actions.is_empty());
        let (failed, _, _) = drive_async_command(Arc::clone(&core), claim(None), Some("embeddedLoadRoles"));
        assert_eq!(failed.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");
        let (reopened, actions, _) = drive_async_command(Arc::clone(&core), claim(None), None);
        reopened.unwrap();
        assert!(!actions.iter().any(|action| matches!(action,
            CoreEffectAction::EmbeddedDestroyRole { .. })));
        let after = core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot).unwrap().snapshot;
        let owner = after.roles.iter().find(|role| role.role_id == shared).unwrap();
        assert_eq!(owner.state, "running");
        assert_eq!(owner.owner.tab_id, target.id);
        assert!(owner.owner.generation > old_generation);
        assert_eq!(after.roles.iter().find(|role| role.role_id == sibling).unwrap().owner, sibling_owner);
        core.shutdown();
    }
}
