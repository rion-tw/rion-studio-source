use super::*;
    use serde_json::json;

    fn command(value: serde_json::Value) -> BrowserRuntimeCommand {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn owns_tab_order_visibility_display_moves_and_role_transitions() {
        let mut runtime = BrowserRuntime::default();
        let created = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"w1","name":"Party","windowId":"window-1",
                "tabType":"workspace","workspaceId":"w1","roleIds":["r1","r2"]
            })))
            .unwrap();
        let tab_id = created.created_tab_id.unwrap();
        for role_id in ["r1", "r2"] {
            runtime
                .invoke(command(json!({
                    "type":"roleTransition","roleId":role_id,"runtime":"embedded",
                    "workspaceId":"w1","tabId":tab_id,"state":"launching"
                })))
                .unwrap();
            runtime
                .invoke(command(json!({
                    "type":"roleTransition","roleId":role_id,"runtime":"embedded",
                    "workspaceId":"w1","tabId":tab_id,"state":"running"
                })))
                .unwrap();
        }
        runtime
            .invoke(command(json!({"type":"activateTab","tabId":tab_id})))
            .unwrap();
        let moved = runtime
            .invoke(command(
                json!({"type":"moveTab","tabId":tab_id,"windowId":"window-2"}),
            ))
            .unwrap();
        assert_eq!(moved.snapshot.windows[0].window_id, "window-1");
        assert_eq!(moved.snapshot.workspaces[0].state, "running");
        assert_eq!(
            moved.snapshot.workspaces[0].window_id.as_deref(),
            Some("window-2")
        );
    }

    #[test]
    fn rejects_duplicate_workspace_roles_and_invalid_transitions() {
        let mut runtime = BrowserRuntime::default();
        runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"w1","name":"One","windowId":"window-1",
                "tabType":"workspace","workspaceId":"w1","roleIds":["r1"]
            })))
            .unwrap();
        assert_eq!(
            runtime
                .invoke(command(json!({
                    "type":"createTab","sourceId":"w2","name":"Two","windowId":"window-2",
                    "tabType":"workspace","workspaceId":"w2","roleIds":["r1"]
                })))
                .unwrap_err()
                .code(),
            "ROLE_ALREADY_RUNNING"
        );
        assert_eq!(
            runtime
                .invoke(command(json!({
                    "type":"roleTransition","roleId":"r1","runtime":"embedded","state":"running"
                })))
                .unwrap_err()
                .code(),
            "RUNTIME_TRANSITION_INVALID"
        );
    }

    #[test]
    fn owns_window_show_and_adjacent_tab_selection() {
        let mut runtime = BrowserRuntime::default();
        let first = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"r1","name":"One","windowId":"window-1",
                "tabType":"role","roleIds":["r1"]
            })))
            .unwrap()
            .created_tab_id
            .unwrap();
        let second = runtime
            .invoke(command(json!({
                "type":"createTab","sourceId":"r2","name":"Two","windowId":"window-1",
                "tabType":"role","roleIds":["r2"]
            })))
            .unwrap()
            .created_tab_id
            .unwrap();
        let shown = runtime
            .invoke(command(json!({"type":"showWindow","windowId":"window-1"})))
            .unwrap();
        assert_eq!(shown.snapshot.windows[0].active_tab_id, Some(first.clone()));
        assert!(
            !shown
                .snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == first)
                .unwrap()
                .hidden
        );
        runtime
            .invoke(command(json!({"type":"activateTab","tabId":second})))
            .unwrap();
        let adjacent = runtime
            .invoke(command(json!({
                "type":"activateAdjacentTab","windowId":"window-1","direction":"previous"
            })))
            .unwrap();
        assert_eq!(adjacent.snapshot.windows[0].active_tab_id, Some(first));
    }

    #[test]
    fn moving_the_active_tab_selects_next_then_previous_in_the_source_window() {
        let mut runtime = BrowserRuntime::default();
        let mut tab_ids = Vec::new();
        for (source_id, name) in [("r1", "One"), ("r2", "Two"), ("r3", "Three")] {
            tab_ids.push(
                runtime
                    .invoke(command(json!({
                        "type":"createTab", "sourceId":source_id, "name":name,
                        "windowId":"window-1", "tabType":"role", "roleIds":[source_id]
                    })))
                    .unwrap()
                    .created_tab_id
                    .unwrap(),
            );
        }
        for tab_id in &tab_ids {
            runtime
                .invoke(command(json!({"type":"activateTab","tabId":tab_id})))
                .unwrap();
        }
        runtime
            .invoke(command(json!({"type":"activateTab","tabId":tab_ids[1]})))
            .unwrap();
        let moved_middle = runtime
            .invoke(command(json!({
                "type":"moveTab", "tabId":tab_ids[1], "windowId":"window-2"
            })))
            .unwrap();
        assert_eq!(
            moved_middle
                .snapshot
                .windows
                .iter()
                .find(|window| window.window_id == "window-1")
                .and_then(|window| window.active_tab_id.as_deref()),
            Some(tab_ids[2].as_str())
        );

        let moved_last = runtime
            .invoke(command(json!({
                "type":"moveTab", "tabId":tab_ids[2], "windowId":"window-3"
            })))
            .unwrap();
        assert_eq!(
            moved_last
                .snapshot
                .windows
                .iter()
                .find(|window| window.window_id == "window-1")
                .and_then(|window| window.active_tab_id.as_deref()),
            Some(tab_ids[0].as_str())
        );
    }

    #[test]
    fn snapshots_tabs_in_window_order_and_appends_new_tabs_last() {
        let mut runtime = BrowserRuntime::default();
        let first = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        let second = "00000000-0000-4000-8000-000000000000";
        let third = "88888888-8888-4888-8888-888888888888";

        for (tab_id, role_id, name) in [(first, "r1", "First"), (second, "r2", "Second")] {
            runtime
                .invoke(command(json!({
                    "type":"createTab","tabId":tab_id,"sourceId":role_id,"name":name,
                    "windowId":"window-1","tabType":"role","roleIds":[role_id]
                })))
                .unwrap();
        }

        assert_eq!(
            runtime
                .snapshot()
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            [first, second]
        );

        runtime
            .invoke(command(json!({
                "type":"reorderTab","tabId":second,"beforeTabId":first
            })))
            .unwrap();
        let created = runtime
            .invoke(command(json!({
                "type":"createTab","tabId":third,"sourceId":"r3","name":"Third",
                "windowId":"window-1","tabType":"role","roleIds":["r3"]
            })))
            .unwrap();

        assert_eq!(created.snapshot.windows[0].tab_ids, [second, first, third]);
        assert_eq!(
            created
                .snapshot
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            [second, first, third]
        );
    }

    #[test]
    fn moving_tabs_reveals_the_target_and_keeps_source_active_tab_visible() {
        for platform in ["darwin", "win32"] {
            let mut runtime = BrowserRuntime::default();
            let create = |runtime: &mut BrowserRuntime, tab_id: &str, role_id: &str| {
                runtime
                    .invoke(command(json!({
                        "type":"createTab","tabId":tab_id,"sourceId":role_id,
                        "name":role_id,"windowId":"source","tabType":"role",
                        "roleIds":[role_id]
                    })))
                    .unwrap();
            };
            let hidden_skip = "11111111-1111-4111-8111-111111111111";
            let hidden_moved = "22222222-2222-4222-8222-222222222222";
            let visible_fallback = "33333333-3333-4333-8333-333333333333";
            let active_moved = "44444444-4444-4444-8444-444444444444";
            for (tab_id, role_id) in [
                (hidden_skip, "role-hidden"),
                (hidden_moved, "role-hidden-moved"),
                (visible_fallback, "role-visible"),
                (active_moved, "role-active"),
            ] {
                create(&mut runtime, tab_id, role_id);
            }

            let hidden_result = runtime
                .invoke(command(json!({
                    "type":"moveTab","tabId":hidden_moved,"windowId":"target"
                })))
                .unwrap();
            assert!(
                !hidden_result
                    .snapshot
                    .tabs
                    .iter()
                    .find(|tab| tab.id == hidden_moved)
                    .unwrap()
                    .hidden,
                "{platform}"
            );

            runtime
                .invoke(command(
                    json!({"type":"activateTab","tabId":visible_fallback}),
                ))
                .unwrap();
            runtime
                .invoke(command(json!({"type":"activateTab","tabId":active_moved})))
                .unwrap();
            let moved = runtime
                .invoke(command(json!({
                    "type":"moveTab","tabId":active_moved,"windowId":"target"
                })))
                .unwrap();
            let source = moved
                .snapshot
                .windows
                .iter()
                .find(|window| window.window_id == "source")
                .unwrap();
            let target = moved
                .snapshot
                .windows
                .iter()
                .find(|window| window.window_id == "target")
                .unwrap();
            assert_eq!(
                source.active_tab_id.as_deref(),
                Some(visible_fallback),
                "{platform}"
            );
            assert_eq!(
                target.active_tab_id.as_deref(),
                Some(active_moved),
                "{platform}"
            );
        }
    }
