use super::*;

    #[test]
    fn platform_name_matches_the_build_target() {
        #[cfg(target_os = "macos")]
        assert_eq!(platform_name().unwrap(), "darwin");
        #[cfg(target_os = "windows")]
        assert_eq!(platform_name().unwrap(), "win32");
    }

    #[test]
    fn application_exit_guard_requires_explicit_renderer_confirmation() {
        for platform in ["darwin", "win32"] {
            let guard = ApplicationExitGuard::default();
            assert!(guard.should_prevent(), "{platform}");
            guard.permit();
            assert!(!guard.should_prevent(), "{platform}");
        }
    }

    #[test]
    fn application_shutdown_has_one_worker_and_only_exits_after_it_terminalizes() {
        for platform in ["darwin", "win32"] {
            let shutdown = ApplicationShutdownCoordinator::default();
            assert_eq!(
                shutdown.request_exit(),
                ApplicationExitRequest::StartShutdown,
                "{platform}"
            );
            assert_eq!(
                shutdown.request_exit(),
                ApplicationExitRequest::WaitForShutdown,
                "{platform}"
            );

            shutdown.mark_ready_to_exit();

            assert_eq!(
                shutdown.request_exit(),
                ApplicationExitRequest::Exit,
                "{platform}"
            );
        }
    }

    #[test]
    fn irreversible_exit_never_starts_native_teardown_on_the_event_loop_thread() {
        let run = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/lib/section_09_run.rs"
        ));
        let exit_arm = run
            .split_once("tauri::RunEvent::Exit =>")
            .expect("run loop defines an irreversible Exit arm")
            .1;
        let exit_arm = exit_arm
            .split_once("_ => {}")
            .expect("Exit arm is followed by the fallback arm")
            .0;

        assert!(exit_arm.contains("state.core.shutdown();"));
        assert!(!exit_arm.contains("runtime.close_all()"));
    }

    #[test]
    fn game_window_close_confirmation_is_limited_to_active_work() {
        for platform in ["darwin", "win32"] {
            let ordinary = GameWindowClosePreview {
                launching: false,
                name: "Raid".to_owned(),
                role_count: 3,
                running_macro_count: 0,
            };
            assert!(!ordinary.requires_confirmation(), "{platform}");
            assert!(
                GameWindowClosePreview {
                    launching: true,
                    ..ordinary.clone()
                }
                .requires_confirmation(),
                "{platform}"
            );
            assert!(
                GameWindowClosePreview {
                    running_macro_count: 1,
                    ..ordinary
                }
                .requires_confirmation(),
                "{platform}"
            );
        }
    }

    #[test]
    fn game_window_close_confirmation_copy_covers_every_supported_language() {
        let preview = GameWindowClosePreview {
            launching: true,
            name: "Raid".to_owned(),
            role_count: 3,
            running_macro_count: 2,
        };
        for language in ["en", "zh-TW", "zh-CN", "ja"] {
            let copy = game_window_close_copy(language, &preview);
            assert!(copy.title.contains("Raid"), "{language}");
            assert!(copy.message.contains('3'), "{language}");
            assert!(copy.message.contains('2'), "{language}");
            assert!(!copy.confirm.is_empty(), "{language}");
            assert!(!copy.cancel.is_empty(), "{language}");
        }
    }

    #[test]
    fn display_ids_always_round_trip_through_javascript_numbers() {
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

        for hash in [0, 1, u64::MAX / 2, u64::MAX] {
            let id = safe_display_id(hash);
            assert!((0..MAX_SAFE_INTEGER).contains(&id));
            assert_eq!(id as f64 as i64, id);
        }
    }

    #[test]
    fn physical_drag_monitor_selection_does_not_overlap_mixed_dpi_displays() {
        let physical_rects = [
            (0.0, 0.0, 1920.0, 1080.0),
            (1920.0, 0.0, 2560.0, 1440.0),
            (-1600.0, 0.0, 1600.0, 900.0),
        ];

        assert_eq!(
            nearest_drag_rect_index(&physical_rects, 2100.0, 400.0),
            Some(1)
        );
        assert_eq!(
            nearest_drag_rect_index(&physical_rects, -400.0, 300.0),
            Some(2)
        );
        assert_eq!(
            nearest_drag_rect_index(&physical_rects, 800.0, 300.0),
            Some(0)
        );
    }

    #[test]
    fn replacing_runtime_window_preferences_refreshes_open_runtime_windows() {
        assert!(core_command_refreshes_runtime_projection(
            &CoreCommand::RuntimeWindowPreferencesReplace {
                preferences: rion_core::RuntimeWindowPreferencesRecord {
                    always_hide_tab_close_button: true,
                    always_show_toolbar_in_full_screen: false,
                    restore_game_windows_on_startup: true,
                },
            }
        ));
        assert!(!core_command_refreshes_runtime_projection(
            &CoreCommand::RuntimeWindowPreferencesGet
        ));
    }

    #[test]
    fn game_window_record_mapping_preserves_every_mutable_field() {
        let record = serde_json::from_value::<StateGameWindowRecord>(json!({
            "id": "window-1",
            "name": "Before",
            "targetDisplay": { "id": 7 },
            "placement": {
                "normalBounds": { "x": 20, "y": 30, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [{
                "id": "tab-1",
                "tabType": "role",
                "sourceId": "role-1",
                "name": "Role",
                "roleSlots": [{
                    "slotId":"saved-slot-1","roleId":"role-1",
                    "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }],
                "hidden": false,
                "audioMuted": false
            }],
            "activeTabId": "tab-1",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();

        let input = game_window_update_input_from_record(&record);

        assert_eq!(input.name.as_deref(), Some("Before"));
        assert_eq!(input.target_display.unwrap().id, 7);
        assert_eq!(input.placement.unwrap().normal_bounds.x, 20);
        assert_eq!(input.tabs.unwrap()[0].id, "tab-1");
        assert_eq!(input.active_tab_id, Some(Some("tab-1".to_owned())));

        let mut remapped = record.clone();
        remapped.target_display.id = 8;
        remapped.updated_at = "2026-01-02T00:00:00Z".to_owned();
        let current_after_own_remap = remapped.clone();
        assert!(same_game_window_record(&current_after_own_remap, &remapped));
        let mut concurrent = remapped.clone();
        concurrent.name = "Concurrent edit".to_owned();
        assert!(!same_game_window_record(&concurrent, &remapped));

        let recovery_error = game_window_recovery_error(
            "SHELL_GAME_WINDOW_RECONCILE_FAILED",
            &shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", "move failed"),
            "restore failed",
        );
        assert_eq!(recovery_error.code, "SHELL_GAME_WINDOW_RECONCILE_FAILED");
        assert!(recovery_error.message.contains("move failed"));
        assert!(recovery_error.message.contains("restore failed"));
    }

    #[test]
    fn tab_drag_anchor_preserves_left_middle_and_right_grab_points() {
        let source = StatePixelBoundsRecord {
            x: 40,
            y: 60,
            width: 960,
            height: 640,
        };
        for (anchor_x, expected_x) in [(0.0, 800), (90.0, 710), (180.0, 620)] {
            let bounds = anchored_tab_drag_bounds(&source, 800.0, 240.0, (anchor_x, 20.0));
            assert_eq!(bounds.x, expected_x);
            assert_eq!(bounds.y, 220);
            assert_eq!(bounds.width, 960);
            assert_eq!(bounds.height, 640);
        }
    }

    #[test]
    fn tab_drag_anchor_allows_negative_desktop_coordinates_without_clamping() {
        let source = StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 960,
            height: 640,
        };
        let bounds = anchored_tab_drag_bounds(&source, -120.0, -30.0, (72.5, 14.5));
        assert_eq!((bounds.x, bounds.y), (-193, -45));
    }

    #[test]
    fn tab_drag_screen_points_normalize_only_physical_windows_coordinates() {
        assert_eq!(
            logical_tab_drag_screen_point(2_400.0, -300.0, 1.5, true),
            (1_600.0, -200.0)
        );
        assert_eq!(
            logical_tab_drag_screen_point(1_600.0, -200.0, 2.0, false),
            (1_600.0, -200.0)
        );
    }

    #[test]
    fn tab_drag_latest_sample_and_committed_order_are_compared_directly() {
        assert_eq!(
            latest_tab_drag_sample((3, 100.0, 200.0), (4, -40.0, 88.0)),
            (4, -40.0, 88.0)
        );
        assert_eq!(
            latest_tab_drag_sample((5, 320.0, 180.0), (4, 0.0, 0.0)),
            (5, 320.0, 180.0)
        );

        let original = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let reordered = vec!["b".to_owned(), "a".to_owned(), "c".to_owned()];
        assert!(!tab_drag_order_changed(&original, &original));
        assert!(tab_drag_order_changed(&original, &reordered));
    }

    #[test]
    fn windows_defers_surface_mutation_while_macos_uses_a_live_native_preview() {
        assert!(tab_drag_defers_native_mutations(true, false));
        assert!(!tab_drag_defers_native_mutations(false, true));
        assert!(!tab_drag_defers_native_mutations(false, false));

        assert!(!deferred_tab_drag_terminal_ready(false, true, false));
        assert!(deferred_tab_drag_terminal_ready(false, true, true));
        assert!(deferred_tab_drag_terminal_ready(false, false, false));
        assert!(deferred_tab_drag_terminal_ready(true, true, false));

        assert!(windows_html_tab_drag_target_is_local("source", "source"));
        assert!(!windows_html_tab_drag_target_is_local("source", "target"));
    }

    #[test]
    fn macos_drag_motion_uses_the_original_live_native_preview_without_a_window_snapshot() {
        let model = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/native/macos/RionRuntimeTabsController/03_shortcut_model.mm"
        ));
        let view = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/native/macos/RionRuntimeTabsController/04_view_model.mm"
        ));

        assert!(model.contains("[self.tabsController moveTabDrag:self"));
        assert!(view.contains("handleHoverWithTabIdentifier"));
        assert!(!model.contains("RionRuntimeWindowSnapshot"));
        assert!(!model.contains("detachedWindowPreview"));
    }

    #[test]
    fn only_superseded_terminal_callbacks_may_settle_the_old_session() {
        assert!(superseded_tab_drag_terminal_action("tabDragDrop"));
        assert!(superseded_tab_drag_terminal_action("tabDragEnd"));
        assert!(superseded_tab_drag_terminal_action("tabDragCancel"));
        assert!(!superseded_tab_drag_terminal_action("tabDragHover"));
        assert!(!superseded_tab_drag_terminal_action("tabDragMove"));
    }

    #[test]
    fn restore_selection_prioritizes_last_focus_and_keeps_overlaps_dormant() {
        let window = |id: &str, role_id: &str| {
            serde_json::from_value::<StateGameWindowRecord>(json!({
                "id": id,
                "name": id,
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                },
                "tabs": [{
                    "id": format!("tab-{id}"),
                    "tabType": "role",
                    "sourceId": role_id,
                    "name": role_id,
                    "roleSlots": [{
                        "slotId": format!("slot-{id}"), "roleId": role_id,
                        "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                    }],
                    "hidden": false,
                    "audioMuted": false
                }],
                "activeTabId": format!("tab-{id}"),
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            }))
            .unwrap()
        };
        let windows = vec![
            window("window-a", "role-shared"),
            window("window-b", "role-shared"),
            window("window-c", "role-independent"),
        ];

        let selected = select_non_conflicting_saved_windows(&windows, Some("window-b"));
        assert_eq!(
            selected
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["window-b", "window-c"]
        );
        let restore_order = order_selected_saved_windows_for_restore(selected, Some("window-b"));
        assert_eq!(
            restore_order
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["window-c", "window-b"]
        );

        let runtime = serde_json::from_value::<BrowserRuntimeSnapshot>(json!({
            "windows": [{
                "windowId": "transient-window",
                "activeTabId": "runtime-tab",
                "tabIds": ["runtime-tab"]
            }],
            "tabs": [{
                "id": "runtime-tab",
                "sourceId": "role-shared",
                "name": "Shared role",
                "windowId": "transient-window",
                "tabType": "role",
                "slots": [{
                    "slotId":"runtime-shared","roleId":"role-shared","state":"available",
                    "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }],
                "hidden": false
            }],
            "roles": [],
            "workspaces": []
        }))
        .unwrap();
        let selected = select_auto_restore_saved_windows(&windows, Some("window-b"), &runtime);
        assert_eq!(
            selected
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["window-c"]
        );
    }

    #[test]
    fn saved_workspace_role_membership_is_the_existing_launch_source() {
        let workspace_window = serde_json::from_value::<StateGameWindowRecord>(json!({
            "id": "workspace-window",
            "name": "Workspace window",
            "targetDisplay": { "id": 1 },
            "placement": {
                "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [{
                "id": "workspace-tab",
                "tabType": "workspace",
                "sourceId": "workspace-a",
                "name": "Workspace A",
                "roleSlots": [{
                    "slotId": "test2-slot",
                    "roleId": "test2",
                    "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }],
                "hidden": false,
                "audioMuted": false
            }],
            "activeTabId": "workspace-tab",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        let standalone_window = serde_json::from_value::<StateGameWindowRecord>(json!({
            "id": "standalone-window",
            "name": "Standalone window",
            "targetDisplay": { "id": 1 },
            "placement": {
                "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [{
                "id": "standalone-tab",
                "tabType": "role",
                "sourceId": "test2",
                "name": "test2",
                "roleSlots": [{
                    "slotId": "standalone-slot",
                    "roleId": "test2",
                    "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }],
                "hidden": false,
                "audioMuted": false
            }],
            "activeTabId": "standalone-tab",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();

        assert_eq!(
            saved_tab_for_launcher_source(&workspace_window, "test2", "role")
                .map(|tab| tab.id.as_str()),
            Some("workspace-tab")
        );
        assert_eq!(
            select_non_conflicting_saved_windows(
                &[workspace_window.clone(), standalone_window],
                Some("workspace-window"),
            )
            .iter()
            .map(|window| window.id.as_str())
            .collect::<Vec<_>>(),
            ["workspace-window"]
        );

        let live_runtime = serde_json::from_value::<BrowserRuntimeSnapshot>(json!({
            "windows": [{
                "windowId": "live-window",
                "activeTabId": "live-workspace-tab",
                "tabIds": ["live-workspace-tab"]
            }],
            "tabs": [{
                "id": "live-workspace-tab",
                "sourceId": "live-workspace",
                "name": "Live workspace",
                "windowId": "live-window",
                "tabType": "workspace",
                "slots": [{
                    "slotId":"live-test2",
                    "roleId":"test2",
                    "state":"running",
                    "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }],
                "hidden": false
            }],
            "roles": [],
            "workspaces": []
        }))
        .unwrap();
        assert!(saved_window_conflicts_with_runtime(
            &workspace_window,
            &live_runtime,
        ));

        assert_eq!(
            statuses_for_launch_source(
                json!([
                    {"roleId":"other-role","state":"running"},
                    {"roleId":"test2","state":"running"}
                ]),
                "test2",
                "role",
            ),
            json!([{"roleId":"test2","state":"running"}])
        );
    }

    #[test]
    fn dormant_window_hydration_launches_only_the_requested_saved_tab() {
        let window = serde_json::from_value::<StateGameWindowRecord>(json!({
            "id": "window-priority",
            "name": "Priority",
            "targetDisplay": { "id": 1 },
            "placement": {
                "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [
                {
                    "id": "tab-first", "tabType": "role", "sourceId": "role-first",
                    "name": "First", "hidden": false, "audioMuted": false,
                    "roleSlots": [{
                        "slotId": "slot-first", "roleId": "role-first",
                        "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                    }]
                },
                {
                    "id": "tab-active", "tabType": "role", "sourceId": "role-active",
                    "name": "Active", "hidden": false, "audioMuted": false,
                    "roleSlots": [{
                        "slotId": "slot-active", "roleId": "role-active",
                        "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                    }]
                },
                {
                    "id": "tab-last", "tabType": "role", "sourceId": "role-last",
                    "name": "Last", "hidden": false, "audioMuted": false,
                    "roleSlots": [{
                        "slotId": "slot-last", "roleId": "role-last",
                        "rect": {"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                    }]
                }
            ],
            "activeTabId": "tab-active",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();

        let plan = saved_window_hydration_plan(&window, Some("tab-active"), None);
        assert_eq!(plan.steps.len(), 1);
        assert!(matches!(
            &plan.steps[0],
            SavedWindowHydrationStep::Saved { foreground: true, tab }
                if tab.id == "tab-active"
        ));
    }

    #[test]
    fn only_overlay_activation_requests_focus_the_invoking_webview() {
        assert!(overlay_request_activates_webview(&json!({
            "type": "activate"
        })));
        assert!(overlay_request_activates_webview(&json!({
            "type": "activate",
            "roleId": "untrusted-role"
        })));
        for payload in [
            json!({ "type": "list" }),
            json!({ "type": "toggle", "macroId": "macro-a" }),
            json!({ "type": "press", "macroId": "macro-a", "pressId": "press-a" }),
            json!({ "type": "release", "macroId": "macro-a", "pressId": "press-a" }),
            json!({ "active": true, "type": "game-input-context" }),
        ] {
            assert!(!overlay_request_activates_webview(&payload));
        }
    }

    #[test]
    fn runtime_tab_activation_terminal_evidence_is_platform_neutral() {
        assert_eq!(
            runtime_tab_activation_terminal_details("tab-a", None),
            json!({ "error": null, "status": "completed", "tabId": "tab-a" })
        );
        assert_eq!(
            runtime_tab_activation_terminal_details("tab-b", Some("activation failed")),
            json!({
                "error": "activation failed",
                "status": "failed",
                "tabId": "tab-b"
            })
        );
    }

    #[test]
    fn startup_window_reveals_only_once_across_page_reloads() {
        let state = StartupWindowState::default();

        assert!(state.reveal_once());
        assert!(!state.reveal_once());
    }

    #[test]
    fn renderer_readiness_cancels_the_startup_watchdog_and_clears_failure() {
        let state = StartupWindowState::default();
        assert!(state.should_report_timeout());

        state.set_failure("startup failed".to_owned());

        assert!(!state.should_report_timeout());
        assert_eq!(state.failure().as_deref(), Some("startup failed"));

        state.mark_renderer_ready();

        assert!(!state.should_report_timeout());
        assert_eq!(state.failure(), None);
    }

    #[tokio::test]
    async fn native_startup_readiness_releases_pending_waiters() {
        let state = Arc::new(StartupWindowState::default());
        let first_state = Arc::clone(&state);
        let second_state = Arc::clone(&state);
        let first = tokio::spawn(async move { first_state.wait_for_native_startup().await });
        let second = tokio::spawn(async move { second_state.wait_for_native_startup().await });

        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());

        state.mark_native_startup_ready();

        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn native_startup_failure_preserves_the_original_message() {
        let state = StartupWindowState::default();
        state.mark_native_startup_failed("native database failed".to_owned());

        state.mark_renderer_ready();

        let error = state.wait_for_native_startup().await.unwrap_err();
        assert_eq!(error.code, "SHELL_STARTUP_FAILED");
        assert_eq!(error.message, "native database failed");
        assert_eq!(state.failure().as_deref(), Some("native database failed"));
    }
