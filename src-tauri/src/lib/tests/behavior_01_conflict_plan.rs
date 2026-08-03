use super::*;

    fn conflict_plan(
        window_id: &str,
        window_index: usize,
        source_id: &str,
    ) -> WorkspaceConflictRollbackPlan {
        let bounds = StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 960,
            height: 640,
        };
        WorkspaceConflictRollbackPlan {
            active: false,
            audio_muted: false,
            before_tab_id: None,
            hidden: false,
            role_zoom_factor: None,
            role_views: Vec::new(),
            source_id: source_id.to_owned(),
            tab_id: format!("tab-{source_id}"),
            tab_type: "role".to_owned(),
            target: EmbeddedLaunchTargetRecord {
                window_id: window_id.to_owned(),
                display_id: 1,
                scale_factor: 1.0,
                work_area: bounds.clone(),
                bounds,
                presentation: "normal".to_owned(),
            },
            window_index,
        }
    }

    #[test]
    fn workspace_conflict_rollback_rebuilds_each_window_in_reverse_tab_order() {
        let mut plans = vec![
            conflict_plan("window-a", 2, "c"),
            conflict_plan("window-a", 0, "a"),
            conflict_plan("window-a", 1, "b"),
        ];

        sort_workspace_conflict_rollback_plans(&mut plans);

        assert_eq!(
            plans
                .iter()
                .rev()
                .map(|plan| plan.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c", "b", "a"]
        );
    }

    #[test]
    fn shell_launch_result_resolves_the_matching_source_type_and_window() {
        let runtime = json!({
            "tabs": [
                { "sourceId": "shared", "tabType": "role", "roleIds": ["shared"], "windowId": "role-window" },
                { "sourceId": "shared", "tabType": "workspace", "roleIds": ["workspace-role"], "windowId": "workspace-window" }
            ]
        });

        assert_eq!(
            launched_source_window_id(&runtime, "shared", "role").as_deref(),
            Some("role-window")
        );
        assert_eq!(
            launched_source_window_id(&runtime, "shared", "workspace").as_deref(),
            Some("workspace-window")
        );
        assert_eq!(
            launched_source_window_id(&runtime, "workspace-role", "role").as_deref(),
            Some("workspace-window")
        );
        assert_eq!(launched_source_window_id(&runtime, "missing", "role"), None);
    }

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
    fn game_window_native_compensation_restores_every_mutable_field() {
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
                "roleIds": ["role-1"],
                "hidden": false,
                "audioMuted": false,
                "roleViews": []
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
    fn game_window_create_rollback_error_preserves_window_and_both_failures() {
        let error = game_window_create_rollback_error(
            "window-created",
            &shell_error("SHELL_WINDOW_FAILED", "native create failed"),
            "metadata cleanup failed",
        );

        assert_eq!(error.code, "SHELL_GAME_WINDOW_ROLLBACK_FAILED");
        assert!(error.message.contains("window-created"));
        assert!(error.message.contains("SHELL_WINDOW_FAILED"));
        assert!(error.message.contains("native create failed"));
        assert!(error.message.contains("metadata cleanup failed"));
    }

    #[test]
    fn tab_drag_rollback_error_preserves_primary_and_cleanup_failures() {
        let error = tab_drag_rollback_error(
            &shell_error("TAURI_TAB_DRAG_FAILED", "position failed"),
            &shell_error("TAURI_TAB_DRAG_ROLLBACK_FAILED", "reparent failed"),
        );

        assert_eq!(error.code, "TAURI_TAB_DRAG_ROLLBACK_FAILED");
        assert!(error.message.contains("TAURI_TAB_DRAG_FAILED"));
        assert!(error.message.contains("position failed"));
        assert!(error.message.contains("reparent failed"));
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
    fn tab_drag_latest_sample_wins_and_terminal_order_is_derived_once() {
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
        assert_eq!(
            tab_drag_before_tab_id(&reordered, "a").as_deref(),
            Some("c")
        );
        assert_eq!(tab_drag_before_tab_id(&reordered, "c"), None);
    }

    #[test]
    fn windows_tab_drag_defers_native_topology_until_source_drag_ends() {
        assert!(tab_drag_defers_native_mutations(true));
        assert!(!tab_drag_defers_native_mutations(false));

        assert!(!windows_tab_drag_terminal_ready(false, true, false));
        assert!(windows_tab_drag_terminal_ready(false, true, true));
        assert!(windows_tab_drag_terminal_ready(false, false, false));
        assert!(windows_tab_drag_terminal_ready(true, true, false));
    }

    #[test]
    fn restore_tab_matching_is_idempotent_and_window_scoped() {
        let snapshot = serde_json::from_value::<BrowserRuntimeSnapshot>(json!({
            "roles": [],
            "tabs": [{
                "id": "runtime-tab-1",
                "sourceId": "role-1",
                "name": "Role 1",
                "windowId": "window-1",
                "tabType": "role",
                "roleIds": ["role-1"],
                "hidden": true
            }],
            "windows": [],
            "workspaces": []
        }))
        .unwrap();
        let saved = GameWindowTabRecord {
            id: "saved-tab-1".to_owned(),
            tab_type: "role".to_owned(),
            source_id: "role-1".to_owned(),
            name: "Role 1".to_owned(),
            role_ids: vec!["role-1".to_owned()],
            hidden: true,
            audio_muted: false,
            role_views: Vec::new(),
        };

        assert_eq!(
            match_runtime_restore_tab(&snapshot, "window-1", &saved),
            RuntimeRestoreTabMatch::InTarget {
                hidden: true,
                id: "runtime-tab-1".to_owned(),
            }
        );
        assert_eq!(
            match_runtime_restore_tab(&snapshot, "window-2", &saved),
            RuntimeRestoreTabMatch::Conflict {
                window_id: "window-1".to_owned(),
            }
        );

        let mut missing = saved;
        missing.source_id = "role-2".to_owned();
        missing.role_ids = vec!["role-2".to_owned()];
        assert_eq!(
            match_runtime_restore_tab(&snapshot, "window-1", &missing),
            RuntimeRestoreTabMatch::Missing
        );
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
                    "roleIds": [role_id],
                    "hidden": false,
                    "audioMuted": false,
                    "roleViews": []
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
                "roleIds": ["role-shared"],
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
