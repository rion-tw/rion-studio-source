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
            assert_eq!(shutdown.requested_exit_code(), 0, "{platform}");
            assert!(!shutdown.allows_core_shutdown_on_run_exit(), "{platform}");
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
            assert!(!shutdown.allows_core_shutdown_on_run_exit(), "{platform}");

            shutdown.mark_ready_to_exit();

            assert!(shutdown.allows_core_shutdown_on_run_exit(), "{platform}");
            assert_eq!(
                shutdown.request_exit(),
                ApplicationExitRequest::Exit,
                "{platform}"
            );
        }
    }

    #[test]
    fn fatal_exit_code_survives_a_joined_verified_shutdown() {
        for platform in ["darwin", "win32"] {
            let normalized = ApplicationShutdownCoordinator::default();
            assert_eq!(
                normalized.request_fatal_exit(0),
                ApplicationExitRequest::StartShutdown,
                "{platform}"
            );
            assert_eq!(normalized.requested_exit_code(), 9, "{platform}");

            let shutdown = ApplicationShutdownCoordinator::default();
            assert_eq!(
                shutdown.request_exit(),
                ApplicationExitRequest::StartShutdown,
                "{platform}"
            );
            assert_eq!(
                shutdown.request_fatal_exit(9),
                ApplicationExitRequest::WaitForShutdown,
                "{platform}"
            );
            assert_eq!(shutdown.requested_exit_code(), 9, "{platform}");
            assert_eq!(
                shutdown.request_fatal_exit(7),
                ApplicationExitRequest::WaitForShutdown,
                "{platform}"
            );
            assert_eq!(shutdown.requested_exit_code(), 9, "{platform}");

            shutdown.mark_ready_to_exit();

            assert_eq!(
                shutdown.request_exit(),
                ApplicationExitRequest::Exit,
                "{platform}"
            );
            assert_eq!(shutdown.requested_exit_code(), 9, "{platform}");
        }
    }

    #[test]
    fn stable_tauri_quit_entries_route_through_the_verified_coordinator() {
        let activation = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/lib/section_01_activation.rs"
        ));
        let shell = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/lib/section_04_rion_shell_invoke.rs"
        ));
        let quick_menu = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/quick_menu/section_01_tray_id.rs"
        ));
        let quick_menu_actions = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/quick_menu/section_02_handle_menu_event.rs"
        ));
        let run = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/lib/section_09_run.rs"
        ));

        let shell_quit = shell
            .split_once("\"quitApplication\" =>")
            .expect("the renderer quit operation exists")
            .1
            .split_once("\"confirmApplicationQuit\" =>")
            .expect("the quit request precedes confirmation")
            .0;
        assert!(shell_quit.contains("request_application_shutdown(&app, &state)"));
        assert!(!shell_quit.contains("app.exit("));
        assert!(quick_menu.contains("crate::request_application_shutdown_from_app(app)"));
        assert!(!quick_menu.contains("app.exit("));
        assert!(quick_menu_actions.contains("crate::request_application_shutdown_from_app(app)"));
        assert!(!quick_menu_actions.contains("app.exit("));

        let verified_exit = activation
            .split_once("fn exit_application_after_verified_shutdown")
            .expect("one verified exit adapter exists")
            .1
            .split_once("fn confirm_application_shutdown")
            .expect("the verified exit adapter is bounded")
            .0;
        let ready = verified_exit
            .find("allows_core_shutdown_on_run_exit()")
            .expect("verified exit checks the coordinator terminal");
        let exit = verified_exit
            .find("app.exit(state.application_shutdown.requested_exit_code())")
            .expect("verified exit preserves the requested code");
        assert!(ready < exit);

        let executor_failure = run
            .split_once("System WebView effect executor failed")
            .expect("the native executor failure is explicit")
            .1
            .split_once("CoreEvent::CoreEffectCancellations")
            .expect("the executor failure branch is bounded")
            .0;
        assert!(executor_failure.contains("request_fatal_application_shutdown"));
        assert!(!executor_failure.contains("app_handle.exit("));
    }

    #[test]
    fn irreversible_exit_only_releases_core_after_verified_ordered_shutdown() {
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

        let verified = exit_arm
            .find("allows_core_shutdown_on_run_exit()")
            .expect("RunEvent::Exit checks the ordered shutdown coordinator");
        let checked_shutdown = exit_arm
            .find("state.core.shutdown_checked()")
            .expect("verified RunEvent::Exit uses checked Core shutdown");
        assert!(verified < checked_shutdown);
        assert!(!exit_arm.contains("runtime.close_all()"));
    }

    #[test]
    fn shutdown_exit_decision_accepts_only_safe_native_and_core_terminals() {
        for platform in ["darwin", "win32"] {
            for status in [
                SystemRuntimeOperationStatus::Applied,
                SystemRuntimeOperationStatus::Degraded,
            ] {
                assert_eq!(
                    application_shutdown_exit_decision(&status, true),
                    ApplicationShutdownExitDecision::Clean,
                    "{platform}: {status:?}"
                );
                assert_eq!(
                    application_shutdown_exit_decision(&status, false),
                    ApplicationShutdownExitDecision::HardExit,
                    "{platform}: {status:?}"
                );
            }
            for status in [
                SystemRuntimeOperationStatus::Cancelled,
                SystemRuntimeOperationStatus::Failed,
                SystemRuntimeOperationStatus::Indeterminate,
                SystemRuntimeOperationStatus::Superseded,
            ] {
                assert_eq!(
                    application_shutdown_exit_decision(&status, true),
                    ApplicationShutdownExitDecision::HardExit,
                    "{platform}: {status:?}"
                );
            }
        }
    }

    #[test]
    fn application_shutdown_quiesces_automatic_input_before_native_hosts_close() {
        let activation = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/lib/section_01_activation.rs"
        ));
        let worker = activation
            .split_once("tauri::async_runtime::spawn_blocking(move ||")
            .expect("application shutdown owns a blocking terminal worker")
            .1;
        let input_quiesce = worker
            .find("core.quiesce_automatic_input_for_shutdown();")
            .expect("automatic input is quiesced during shutdown");
        let native_close = worker
            .find("runtime.close_all_until(shutdown_deadline);")
            .expect("native hosts close during shutdown");

        assert!(input_quiesce < native_close);
    }

    #[test]
    fn shutdown_fences_core_clear_commands_before_native_drain_and_waits_after_results() {
        for source in [
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/lib/section_01_activation.rs"
            )),
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/lib/section_01_update_install.rs"
            )),
        ] {
            let deadline = source
                .find("let shutdown_deadline = system_runtime::system_runtime_shutdown_deadline();")
                .expect("shutdown creates one shared destructive drain deadline");
            let core_fence = source
                .find("begin_role_browser_data_clear_command_drain()")
                .expect("Core clear-command admission is fenced");
            let native_drain = source
                .find("close_all_until(shutdown_deadline)")
                .expect("the native runtime uses the shared deadline");
            let core_terminal = source
                .find("wait_for_role_browser_data_clear_command_drain(shutdown_deadline)")
                .expect("Core command terminal uses the same deadline");

            assert!(deadline < core_fence);
            assert!(core_fence < native_drain);
            assert!(native_drain < core_terminal);
        }
    }

    #[test]
    fn core_effect_cancellations_reach_the_native_identity_fence_before_renderer_forwarding() {
        let run = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/lib/section_09_run.rs"
        ));
        let cancellation_arm = run
            .split_once("CoreEvent::CoreEffectCancellations { cancellations } =>")
            .expect("the stable runtime consumes Core effect cancellations")
            .1
            .split_once("CoreEvent::OverlayChanged")
            .expect("the cancellation arm precedes the next Core event arm")
            .0;
        let native_consumer = cancellation_arm
            .find("consume_core_effect_cancellations(&cancellations)")
            .expect("the native destructive-work registry consumes cancellations");
        let renderer_forward = cancellation_arm
            .find("renderer_events.push(CoreEvent::CoreEffectCancellations")
            .expect("the same cancellation stream remains renderer-visible");

        assert!(native_consumer < renderer_forward);
    }

    #[test]
    fn unsafe_shutdown_terminal_bypasses_checked_core_shutdown() {
        for source in [
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/lib/section_01_activation.rs"
            )),
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/lib/section_01_update_install.rs"
            )),
        ] {
            let unsafe_terminal = source
                .find("ApplicationShutdownExitDecision::HardExit")
                .expect("unsafe shutdown terminal is handled explicitly");
            let hard_exit = source[unsafe_terminal..]
                .find("std::process::exit(9);")
                .expect("unsafe shutdown terminal uses a non-zero hard exit");
            let core_shutdown = source[unsafe_terminal..]
                .find("shutdown_checked()")
                .expect("safe shutdown retains the checked Core shutdown path");

            assert!(hard_exit < core_shutdown);
        }
    }

    #[test]
    fn unproven_checked_shutdown_phase_invalidates_a_persisted_clean_restore_marker() {
        for (platform, error) in [
            (
                "darwin",
                rion_core::CoreError::Domain {
                    code: "CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED",
                    message: "controlled active browser operation".to_owned(),
                },
            ),
            (
                "win32",
                rion_core::CoreError::Internal(
                    "controlled browser-operation precheck lock poison".to_owned(),
                ),
            ),
            (
                "darwin",
                rion_core::CoreError::Domain {
                    code: "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED",
                    message: "controlled structured pre-terminal failure".to_owned(),
                },
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let core = AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                build_commit: None,
                packaged: false,
                platform: platform.to_owned(),
                runtime_contract_version: Some(22),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            })
            .unwrap();
            let persisted_clean = core
                .update_runtime_restore_session(|session| {
                    session.session_generation =
                        session.session_generation.checked_add(1).unwrap();
                    session.clean_exit = true;
                    session.last_focused_window_id = Some("window-clean".to_owned());
                    session.live_window_ids = Some(vec!["window-clean".to_owned()]);
                })
                .unwrap();
            assert!(persisted_clean.clean_exit, "{platform}");

            let failure = compensate_checked_core_shutdown_result(&core, Err(error)).unwrap_err();
            assert!(failure.contains("clean restore marker was invalidated"));
            let invalidated = core.runtime_restore_session().unwrap();
            assert!(!invalidated.clean_exit, "{platform}");
            assert_eq!(
                invalidated.session_generation,
                persisted_clean.session_generation + 1,
                "{platform}"
            );
            assert_eq!(
                invalidated.last_focused_window_id,
                persisted_clean.last_focused_window_id,
                "{platform}"
            );
            assert_eq!(
                invalidated.live_window_ids,
                persisted_clean.live_window_ids,
                "{platform}"
            );
            core.shutdown();
        }
    }

    #[test]
    fn proven_late_checked_shutdown_failure_retains_the_verified_native_clean_marker() {
        for (platform, error) in [
            (
                "darwin",
                rion_core::CoreError::LogDatabase(
                    "controlled late log teardown failure".to_owned(),
                ),
            ),
            (
                "win32",
                rion_core::CoreError::Domain {
                    code: "CORE_SHUTDOWN_INSTANCE_LOCK_UNVERIFIED",
                    message: "controlled late instance-lock teardown failure".to_owned(),
                },
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let core = AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                build_commit: None,
                packaged: false,
                platform: platform.to_owned(),
                runtime_contract_version: Some(22),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            })
            .unwrap();
            let persisted_clean = core
                .update_runtime_restore_session(|session| {
                    session.session_generation =
                        session.session_generation.checked_add(1).unwrap();
                    session.clean_exit = true;
                })
                .unwrap();

            let failure = compensate_checked_core_shutdown_result(&core, Err(error)).unwrap_err();
            assert!(failure.contains("native clean restore marker remains authoritative"));
            let retained = core.runtime_restore_session().unwrap();
            assert!(retained.clean_exit, "{platform}");
            assert_eq!(
                retained.session_generation, persisted_clean.session_generation,
                "{platform}"
            );
            core.shutdown();
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
            "/../crates/rion-appkit/native/macos/RionRuntimeTabsController/03_shortcut_model.mm"
        ));
        let view = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../crates/rion-appkit/native/macos/RionRuntimeTabsController/04_view_model.mm"
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
                "hidden": false,
                "audioMuted": false
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
    fn crash_recovery_restores_shared_role_placeholders_without_duplicate_tab_sources() {
        let window = |id: &str, tab_type: &str, source_id: &str| {
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
                    "tabType": tab_type,
                    "sourceId": source_id,
                    "name": source_id,
                    "roleSlots": [{
                        "slotId": format!("slot-{id}"), "roleId": "role-shared",
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
        let role_window = window("role-window", "role", "role-shared");
        let workspace_window = window("workspace-window", "workspace", "workspace-shared");
        let duplicate_workspace = window("duplicate-workspace", "workspace", "workspace-shared");
        let runtime = serde_json::from_value::<BrowserRuntimeSnapshot>(json!({
            "windows": [],
            "tabs": [],
            "roles": [],
            "workspaces": []
        }))
        .unwrap();

        let selected = select_recovery_restore_saved_windows(
            &[role_window, workspace_window, duplicate_workspace],
            Some("workspace-window"),
            &runtime,
        );

        assert_eq!(
            selected
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["workspace-window", "role-window"],
            "recovery preserves shared Role placeholders but never duplicates an exact tab source"
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
                "hidden": false,
                "audioMuted": false
            }],
            "roles": [],
            "workspaces": []
        }))
        .unwrap();
        assert!(saved_window_conflicts_with_runtime(
            &workspace_window,
            &live_runtime,
        ));
        assert!(!saved_window_duplicates_runtime_tab_source(
            &workspace_window,
            &live_runtime,
        ));
        let mut duplicate_source_runtime = live_runtime.clone();
        duplicate_source_runtime.tabs[0].source_id = workspace_window.tabs[0].source_id.clone();
        duplicate_source_runtime.tabs[0].tab_type = workspace_window.tabs[0].tab_type.clone();
        assert!(saved_window_duplicates_runtime_tab_source(
            &workspace_window,
            &duplicate_source_runtime,
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
            json!({
                "documentInstanceId": "document-1",
                "revision": 1,
                "target": "game",
                "type": "game-input-context"
            }),
        ] {
            assert!(!overlay_request_activates_webview(&payload));
        }
    }

    #[test]
    fn shortcut_lifecycle_diagnostics_accept_only_bounded_configured_key_metadata() {
        assert_eq!(
            parse_macro_shortcut_lifecycle(&json!({
                "code": "Digit2",
                "macroId": "macro-a",
                "phase": "physical-keydown-managed",
                "type": "macro-shortcut-lifecycle"
            }))
            .unwrap(),
            (
                "macro-a".to_owned(),
                "Digit2".to_owned(),
                "physical-keydown-managed".to_owned()
            )
        );
        for payload in [
            json!({
                "code": "Digit2",
                "extra": true,
                "macroId": "macro-a",
                "phase": "macro-dispatched",
                "type": "macro-shortcut-lifecycle"
            }),
            json!({
                "code": "typed text",
                "macroId": "macro-a",
                "phase": "macro-dispatched",
                "type": "macro-shortcut-lifecycle"
            }),
            json!({
                "code": "Digit2",
                "macroId": "typed text",
                "phase": "macro-dispatched",
                "type": "macro-shortcut-lifecycle"
            }),
            json!({
                "code": "Digit2",
                "macroId": "macro-a",
                "phase": "unknown",
                "type": "macro-shortcut-lifecycle"
            }),
        ] {
            assert_eq!(
                parse_macro_shortcut_lifecycle(&payload).unwrap_err().code,
                "OVERLAY_REQUEST_INVALID"
            );
        }
    }

    #[test]
    fn macro_input_context_loss_accepts_only_ordered_blur_or_hidden_events() {
        for reason in ["blur", "hidden"] {
            MacroInputContextLossRequest {
                reason: reason.to_owned(),
                revision: 1,
            }
            .validate()
            .unwrap();
        }
        for request in [
            MacroInputContextLossRequest {
                reason: "blur".to_owned(),
                revision: 0,
            },
            MacroInputContextLossRequest {
                reason: "pagehide".to_owned(),
                revision: 1,
            },
        ] {
            assert_eq!(
                request.validate().unwrap_err().code,
                "MACRO_INPUT_CONTEXT_LOSS_INVALID"
            );
        }
    }

    #[test]
    fn flyff_caret_diagnostics_accept_only_bounded_content_free_metadata() {
        let valid = json!({
            "activeElement": "text_input",
            "code": "Enter",
            "defaultPrevented": false,
            "event": "focus-after",
            "isTrusted": true,
            "repeat": false,
            "requestedEnd": null,
            "requestedStart": null,
            "selectionEnd": 4,
            "selectionStart": 4,
            "sequence": 7,
            "textEditInvocation": 1,
            "type": "flyff-caret-diagnostic",
            "valueLength": 4
        });
        let diagnostic = parse_flyff_caret_diagnostic(&valid).unwrap();
        assert_eq!(diagnostic.event, "focus-after");
        assert_eq!(diagnostic.selection_start, Some(4));
        let context = diagnostic.context("role-a", "role-webview-a");
        assert_eq!(context.get("valueLength"), Some(&json!(4)));
        assert!(context.get("value").is_none());

        let mut extra = valid.clone();
        extra["chatText"] = json!("must-not-be-accepted");
        let mut too_many = valid.clone();
        too_many["sequence"] = json!(257);
        let mut invalid_selection = valid.clone();
        invalid_selection["selectionStart"] = json!(5);
        let mut invalid_code = valid;
        invalid_code["code"] = json!("KeyA");
        for payload in [extra, too_many, invalid_selection, invalid_code] {
            assert_eq!(
                parse_flyff_caret_diagnostic(&payload).unwrap_err().code,
                "OVERLAY_REQUEST_INVALID"
            );
        }
    }

    #[test]
    fn managed_shortcut_requests_validate_identity_phase_and_modifier_sides() {
        ManagedShortcutKeyPhaseRequest {
            press_id: "press-1".to_owned(),
            macro_id: "macro-a".to_owned(),
            code: "Digit2".to_owned(),
            phase: "replay".to_owned(),
            modifier_codes: vec!["ShiftRight".to_owned(), "ControlLeft".to_owned()],
        }
        .validate()
        .unwrap();

        for request in [
            ManagedShortcutKeyPhaseRequest {
                press_id: "press 1".to_owned(),
                macro_id: "macro-a".to_owned(),
                code: "Digit2".to_owned(),
                phase: "replay".to_owned(),
                modifier_codes: Vec::new(),
            },
            ManagedShortcutKeyPhaseRequest {
                press_id: "press-1".to_owned(),
                macro_id: "macro-a".to_owned(),
                code: "Digit2".to_owned(),
                phase: "unknown".to_owned(),
                modifier_codes: Vec::new(),
            },
            ManagedShortcutKeyPhaseRequest {
                press_id: "press-1".to_owned(),
                macro_id: "macro-a".to_owned(),
                code: "Digit2".to_owned(),
                phase: "keyDown".to_owned(),
                modifier_codes: vec!["ShiftLeft".to_owned(), "ShiftLeft".to_owned()],
            },
            ManagedShortcutKeyPhaseRequest {
                press_id: "press-1".to_owned(),
                macro_id: "macro-a".to_owned(),
                code: "Digit2".to_owned(),
                phase: "keyUp".to_owned(),
                modifier_codes: vec!["KeyA".to_owned()],
            },
        ] {
            assert_eq!(request.validate().unwrap_err().code, "MANAGED_SHORTCUT_INVALID");
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
