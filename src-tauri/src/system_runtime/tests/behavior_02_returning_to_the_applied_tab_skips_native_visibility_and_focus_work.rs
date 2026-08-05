#[test]
    fn presentation_focus_policy_separates_content_from_parent_window_activation() {
        let tab = Some("tab-a".to_owned());
        let labels = HashSet::from(["surface-a:7".to_owned(), "divider-a:8".to_owned()]);
        assert!(!native_presentation_changed(&tab, &tab, &labels, &labels));

        let replacement = HashSet::from(["surface-a:9".to_owned(), "divider-a:8".to_owned()]);
        assert!(native_presentation_changed(
            &tab,
            &tab,
            &labels,
            &replacement
        ));
        assert!(native_presentation_changed(
            &tab,
            &Some("tab-b".to_owned()),
            &labels,
            &labels
        ));

        let identities = HashSet::from([("surface-a".to_owned(), 7)]);
        let no_op = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            NativeWindowPresentationTransition::new(
                None,
                None,
                None,
                NativePresentationFocus::None,
            ),
        );
        assert!(!no_op.requires_ui_thread);
        assert!(!no_op.apply_content_focus);
        assert!(!no_op.apply_window_focus);

        let tab_strip_focus = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            NativeWindowPresentationTransition::new(
                None,
                None,
                None,
                NativePresentationFocus::ContentOnly,
            ),
        );
        assert!(tab_strip_focus.requires_ui_thread);
        assert!(tab_strip_focus.apply_content_focus);
        assert!(!tab_strip_focus.apply_window_focus);

        let replacement_identities = HashSet::from([("surface-a".to_owned(), 8)]);
        let replacement = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &replacement_identities,
            NativeWindowPresentationTransition::new(
                None,
                None,
                None,
                NativePresentationFocus::ContentOnly,
            ),
        );
        assert!(replacement.requires_ui_thread);
        assert!(replacement.presentation_changed);
        assert!(replacement.apply_content_focus);
        assert!(!replacement.apply_window_focus);

        let external_reveal = native_presentation_mutation_plan(
            &tab,
            &Some("tab-b".to_owned()),
            &identities,
            &replacement_identities,
            NativeWindowPresentationTransition::new(
                None,
                Some(true),
                None,
                NativePresentationFocus::WindowAndContent,
            ),
        );
        assert!(external_reveal.apply_content_focus);
        assert!(external_reveal.apply_window_focus);

        let external_reactivate = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            NativeWindowPresentationTransition::new(
                Some(false),
                Some(true),
                None,
                NativePresentationFocus::WindowAndContent,
            ),
        );
        assert!(external_reactivate.requires_ui_thread);
        assert!(!external_reactivate.presentation_changed);
        assert!(external_reactivate.apply_content_focus);
        assert!(external_reactivate.apply_window_focus);
        assert!(native_window_restore_required(
            external_reactivate.apply_window_focus,
            Some(true)
        ));
        assert!(!native_window_restore_required(
            tab_strip_focus.apply_window_focus,
            Some(true)
        ));
        assert!(!native_window_restore_required(true, Some(false)));
        assert!(!native_window_restore_required(true, None));

        let hide_window = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            NativeWindowPresentationTransition::new(
                Some(true),
                Some(false),
                None,
                NativePresentationFocus::WindowAndContent,
            ),
        );
        assert!(hide_window.requires_ui_thread);
        assert!(!hide_window.apply_content_focus);
        assert!(!hide_window.apply_window_focus);

        let visibility_no_op = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            NativeWindowPresentationTransition::new(
                Some(false),
                Some(false),
                None,
                NativePresentationFocus::None,
            ),
        );
        assert!(!visibility_no_op.requires_ui_thread);

        let maximize_contract = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            NativeWindowPresentationTransition::new(
                Some(true),
                Some(true),
                Some(NativeWindowMode::Maximized),
                NativePresentationFocus::None,
            ),
        );
        assert!(maximize_contract.requires_ui_thread);
    }

    #[test]
    fn rapid_close_preflight_reuses_the_latest_optimistic_preview_revision() {
        assert_eq!(
            close_preflight_plan(
                false,
                42,
                Some("tab-after-latest-close".to_owned()),
                Some("stale-core-successor".to_owned()),
            ),
            ClosePreflightPlan::ReusePreview {
                revision: 42,
                selected_tab_id: Some("tab-after-latest-close".to_owned()),
            }
        );
        assert_eq!(
            close_preflight_plan(
                true,
                41,
                Some("closing-tab".to_owned()),
                Some("validated-successor".to_owned()),
            ),
            ClosePreflightPlan::PresentSuccessor {
                tab_id: "validated-successor".to_owned(),
            }
        );
        assert_eq!(
            close_preflight_plan(true, 41, Some("closing-tab".to_owned()), None),
            ClosePreflightPlan::HideWindow
        );
    }

    #[test]
    fn automatic_setup_retry_policy_is_windows_only_and_single_use() {
        for (platform, completed_retries, error_code, release_verified, expected) in [
            ("windows", 0, "SYSTEM_ROLE_SETUP_FAILED", true, true),
            ("windows", 0, "SYSTEM_ROLE_SETUP_FAILED", false, false),
            ("windows", 1, "SYSTEM_ROLE_SETUP_FAILED", true, false),
            ("windows", 0, "SYSTEM_ROLE_SETUP_TIMEOUT", true, false),
            ("windows", 0, "TAURI_NAVIGATION_FAILED", true, false),
            ("windows", 0, "LAUNCH_CANCELLED", true, false),
            ("macos", 0, "SYSTEM_ROLE_SETUP_FAILED", true, false),
        ] {
            assert_eq!(
                automatic_role_setup_retry_allowed(
                    platform,
                    completed_retries,
                    error_code,
                    release_verified,
                ),
                expected,
                "platform={platform}, completedRetries={completed_retries}, error={error_code}, releaseVerified={release_verified}"
            );
        }
    }

    #[test]
    fn automatic_retry_keeps_provisional_loading_until_the_final_failure() {
        let first_retry =
            automatic_role_setup_retry_allowed("windows", 0, "SYSTEM_ROLE_SETUP_FAILED", true);
        assert!(first_retry);
        let first_failure_retained = !first_retry;
        let first_error_revealed = !first_retry;
        assert!(!first_failure_retained);
        assert!(!first_error_revealed);

        let second_retry =
            automatic_role_setup_retry_allowed("windows", 1, "SYSTEM_ROLE_SETUP_FAILED", true);
        let second_failure_retained = !second_retry;
        let second_error_revealed = !second_retry;
        assert!(!second_retry);
        assert!(second_failure_retained);
        assert!(second_error_revealed);
    }

    #[test]
    fn cancelling_during_retry_delay_invalidates_the_pending_attempt() {
        let launch_preview_id = "preview-1";
        let mut state = RuntimeState::default();
        state
            .automatic_launch_retries
            .insert(launch_preview_id.to_owned(), 1);
        insert_provisional_launch(
            &mut state,
            ProvisionalLaunch {
                cancelled: false,
                failed: false,
                host_created: false,
                id: "tab-1".to_owned(),
                launch_preview_id: launch_preview_id.to_owned(),
                source_id: "role-1".to_owned(),
                tab_type: "role".to_owned(),
                window_id: "window-1".to_owned(),
            },
        );
        assert!(automatic_launch_retry_is_current(
            &state,
            launch_preview_id
        ));
        assert!(cancel_provisional_launch_state(&mut state, "tab-1").is_some());
        assert!(!automatic_launch_retry_is_current(
            &state,
            launch_preview_id
        ));
    }

    #[test]
    fn provisional_aliases_resolve_to_the_attached_runtime_tab() {
        let registry = PresentationRegistry::default();
        let coordinator = registry.coordinator("window-a").unwrap();
        coordinator
            .lock()
            .unwrap()
            .aliases
            .insert("provisional-a".to_owned(), "runtime-a".to_owned());
        assert_eq!(
            registry.resolve_tab_alias("provisional-a").as_deref(),
            Some("runtime-a")
        );
        assert_eq!(registry.resolve_tab_alias("unknown"), None);
    }

    #[test]
    fn launcher_source_lookup_uses_presentation_without_runtime_or_page_readiness() {
        let registry = PresentationRegistry::default();
        let coordinator = registry.coordinator("window-a").unwrap();
        {
            let mut state = coordinator.lock().unwrap();
            state.insert_tab(
                TabPresentation {
                    audio_muted: false,
                    closable: true,
                    icon_data_url: None,
                    id: "provisional-a".to_owned(),
                    phase: TabPresentationPhase::Reserved,
                    persistable: false,
                    role_ids: vec!["role-a".to_owned()],
                    role_slots: Vec::new(),
                    source_id: "role-a".to_owned(),
                    tab_type: "role".to_owned(),
                    title: "Loading".to_owned(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: None,
                },
                1,
                true,
            );
        }
        assert_eq!(
            registry.tab_for_source("role-a", "role").as_deref(),
            Some("provisional-a")
        );
        assert_eq!(registry.tab_for_source("role-a", "workspace"), None);

        coordinator.lock().unwrap().replace_tab_id(
            "provisional-a",
            TabPresentation {
                audio_muted: false,
                closable: true,
                icon_data_url: None,
                id: "runtime-a".to_owned(),
                phase: TabPresentationPhase::Attaching,
                persistable: true,
                role_ids: vec!["role-a".to_owned()],
                role_slots: Vec::new(),
                source_id: "role-a".to_owned(),
                tab_type: "role".to_owned(),
                title: "Role A".to_owned(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: None,
            },
            2,
        );
        assert_eq!(
            registry.tab_for_source("role-a", "role").as_deref(),
            Some("runtime-a")
        );
    }

    #[test]
    fn launcher_presence_uses_presented_workspace_role_membership_until_removal() {
        let registry = PresentationRegistry::default();
        let coordinator = registry.coordinator("window-b").unwrap();
        let mut workspace = presentation_tab("workspace-tab", TabPresentationPhase::Failed);
        workspace.source_id = "workspace-a".to_owned();
        workspace.tab_type = "workspace".to_owned();
        workspace.role_ids = vec!["role-a".to_owned(), "role-b".to_owned()];
        coordinator.lock().unwrap().insert_tab(workspace, 4, true);

        let presence = registry.launcher_presence().unwrap();
        assert_eq!(presence.tabs.len(), 1);
        assert_eq!(presence.tabs[0].source_id, "workspace-a");
        assert_eq!(presence.tabs[0].role_ids, ["role-a", "role-b"]);
        assert_eq!(
            registry
                .tab_for_launcher_source("workspace-a", "workspace")
                .as_deref(),
            Some("workspace-tab")
        );
        assert_eq!(
            registry
                .tab_for_launcher_source("role-b", "role")
                .as_deref(),
            Some("workspace-tab")
        );

        coordinator.lock().unwrap().remove_tab("workspace-tab", 5);
        assert!(registry.launcher_presence().unwrap().tabs.is_empty());
        assert!(registry.tab_for_launcher_source("role-b", "role").is_none());
    }

    #[test]
    fn launcher_presence_includes_reserved_role_tabs_across_windows() {
        let registry = PresentationRegistry::default();
        registry
            .coordinator("window-z")
            .unwrap()
            .lock()
            .unwrap()
            .insert_tab(
                presentation_tab("reserved-role", TabPresentationPhase::Reserved),
                1,
                true,
            );
        registry
            .coordinator("window-a")
            .unwrap()
            .lock()
            .unwrap()
            .insert_tab(
                presentation_tab("ready-role", TabPresentationPhase::Ready),
                2,
                true,
            );

        let presence = registry.launcher_presence().unwrap();
        assert_eq!(
            presence
                .tabs
                .iter()
                .map(|tab| tab.tab_id.as_str())
                .collect::<Vec<_>>(),
            ["ready-role", "reserved-role"]
        );
    }

    #[test]
    fn launcher_presence_drops_tabs_without_live_or_provisional_runtime_ownership() {
        let mut presence = RuntimeLauncherPresence {
            tabs: ["live-tab", "stale-tab"]
                .into_iter()
                .map(|tab_id| RuntimeLauncherPresenceTab {
                    role_ids: vec![format!("role-{tab_id}")],
                    source_id: format!("source-{tab_id}"),
                    tab_id: tab_id.to_owned(),
                    tab_type: "role".to_owned(),
                })
                .collect(),
        };

        retain_live_runtime_launcher_tabs(&mut presence, &HashSet::from(["live-tab".to_owned()]));

        assert_eq!(presence.tabs.len(), 1);
        assert_eq!(presence.tabs[0].tab_id, "live-tab");
    }

    #[test]
    fn optional_native_work_waits_for_every_essential_launch_phase() {
        assert!(LaunchPhase::Attaching.blocks_optional_idle());
        assert!(LaunchPhase::Navigating.blocks_optional_idle());
        for phase in [
            LaunchPhase::EssentialReady,
            LaunchPhase::OptionalHydrating,
            LaunchPhase::Ready,
            LaunchPhase::Degraded,
        ] {
            assert!(!phase.blocks_optional_idle(), "{phase:?}");
        }
    }

    #[test]
    fn close_and_tab_launch_effects_leave_the_global_effect_fifo() {
        assert!(is_surface_close_effect(
            &CoreEffectAction::EmbeddedDestroyRole {
                role_id: "role-a".to_owned()
            }
        ));
        assert!(is_surface_close_effect(
            &CoreEffectAction::EmbeddedDestroyTab {
                tab_id: "tab-a".to_owned(),
                attempt_generation: None,
                next_active_tab_id: None
            }
        ));
        assert!(!is_surface_close_effect(
            &CoreEffectAction::EmbeddedFocusRole {
                role_id: "role-a".to_owned(),
                zoom_factor: None
            }
        ));
        assert!(is_independent_tab_launch_effect(
            &CoreEffectAction::EmbeddedLoadRoles { roles: Vec::new() }
        ));
        assert!(is_independent_tab_launch_effect(
            &CoreEffectAction::EmbeddedInstallOverlays {
                role_ids: Vec::new()
            }
        ));
        assert!(!is_independent_tab_launch_effect(
            &CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: BrowserRuntimeSnapshot {
                    windows: Vec::new(),
                    roles: Vec::new(),
                    tabs: Vec::new(),
                    workspaces: Vec::new(),
                },
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            }
        ));
    }

    #[test]
    fn close_effect_shards_are_stable_for_a_tab_scope() {
        let role_scope = close_effect_scope_key(
            &CoreEffectAction::EmbeddedDestroyRole {
                role_id: "role-a".to_owned(),
            },
            Some("tab-a"),
        )
        .unwrap();
        let tab_scope = close_effect_scope_key(
            &CoreEffectAction::EmbeddedDestroyTab {
                tab_id: "tab-a".to_owned(),
                attempt_generation: None,
                next_active_tab_id: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(role_scope, tab_scope);
        let shard = close_effect_shard_index(&role_scope, CLOSE_EFFECT_SHARD_COUNT);
        assert_eq!(
            close_effect_shard_index(&tab_scope, CLOSE_EFFECT_SHARD_COUNT),
            shard
        );
        assert_ne!(
            close_effect_shard_index("tab-a", CLOSE_EFFECT_SHARD_COUNT),
            close_effect_shard_index("tab-b", CLOSE_EFFECT_SHARD_COUNT)
        );
    }

    #[test]
    fn windows_surface_close_mock_rejects_the_wrong_controller_or_process() {
        assert!(windows_surface_identity_matches(41, 41, 700, 700));
        assert!(!windows_surface_identity_matches(41, 42, 700, 700));
        assert!(!windows_surface_identity_matches(41, 41, 700, 701));
        assert!(!windows_surface_identity_matches(0, 0, 700, 700));
        assert!(!windows_surface_identity_matches(41, 41, 0, 0));
    }

    #[test]
    fn surface_release_barrier_has_a_bounded_timeout() {
        let tracker = SurfaceLifecycleTracker::default();
        let started = Instant::now();
        assert!(!tracker.wait_for_controller_release("windows", Duration::from_millis(5)));
        assert!(started.elapsed() < Duration::from_secs(1));

        tracker.mark_controller_released();
        assert!(!tracker.wait_for_controller_release("macos", Duration::from_millis(5)));
        tracker.mark_native_surface_released();
        assert!(tracker.wait_for_controller_release("macos", Duration::from_millis(5)));

        #[cfg(windows)]
        {
            assert!(tracker.wait_for_controller_release("windows", Duration::from_millis(5)));
            assert!(!tracker.wait_for_browser_process_exit(Duration::from_millis(5)));
            tracker.mark_browser_process_exited();
            assert!(tracker.wait_for_browser_process_exit(Duration::from_millis(5)));
        }
    }

    #[test]
    fn unhealthy_runtime_fails_closed_for_future_lifecycle_mutations() {
        let health = RuntimeHealth::new();
        assert!(health.require_healthy().is_ok());
        health.mark_unhealthy();
        let error = health.require_healthy().unwrap_err();
        assert_eq!(error.code, "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY");
    }

    #[test]
    fn recovery_callbacks_are_coalesced_and_fenced_by_generation() {
        let mut recovering_roles = HashSet::new();
        assert!(claim_surface_recovery(
            7,
            7,
            &mut recovering_roles,
            "role-a"
        ));
        assert!(!claim_surface_recovery(
            7,
            7,
            &mut recovering_roles,
            "role-a"
        ));
        assert!(!claim_surface_recovery(
            7,
            6,
            &mut recovering_roles,
            "role-b"
        ));
        assert!(!claim_surface_recovery(
            7,
            8,
            &mut recovering_roles,
            "role-c"
        ));
    }

    #[test]
    fn native_isolation_wait_observes_the_exact_lease_callback() {
        let tracker = Arc::new(SurfaceLifecycleTracker::default());
        let callback_tracker = Arc::clone(&tracker);
        let worker = std::thread::spawn(move || callback_tracker.mark_isolated());
        assert!(tracker.wait_for_isolation(Duration::from_millis(100)));
        worker.join().unwrap();
    }

    #[test]
    fn native_isolation_wait_is_bounded_without_polling() {
        let tracker = SurfaceLifecycleTracker::default();
        let started = Instant::now();
        assert!(!tracker.wait_for_isolation(Duration::from_millis(5)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn recovery_swap_requires_the_original_surface_and_generation() {
        assert!(surface_recovery_swap_is_current(
            "role-surface-a",
            "role-surface-a",
            7,
            7
        ));
        assert!(!surface_recovery_swap_is_current(
            "role-surface-b",
            "role-surface-a",
            7,
            7
        ));
        assert!(!surface_recovery_swap_is_current(
            "role-surface-a",
            "role-surface-a",
            8,
            7
        ));
    }

    #[test]
    fn close_commit_requires_the_same_authoritative_handle() {
        assert!(surface_close_commit_is_current(
            "tab-a",
            "tab-a",
            "surface-a",
            "surface-a"
        ));
        assert!(!surface_close_commit_is_current(
            "tab-b",
            "tab-a",
            "surface-a",
            "surface-a"
        ));
        assert!(!surface_close_commit_is_current(
            "tab-a",
            "tab-a",
            "surface-b",
            "surface-a"
        ));
    }

    #[test]
    fn popup_renderer_failure_is_isolated_from_role_recovery() {
        let popup = SurfaceFailureTarget::Popup {
            label: "popup-a".to_owned(),
            role_id: "role-a".to_owned(),
            generation: 7,
        };
        let role = SurfaceFailureTarget::Role {
            role_id: "role-a".to_owned(),
            generation: 7,
        };

        assert_eq!(
            surface_failure_action(&popup, SurfaceFailureScope::Renderer),
            SurfaceFailureAction::ClosePopup
        );
        assert_eq!(
            surface_failure_action(&popup, SurfaceFailureScope::Browser),
            SurfaceFailureAction::RecoverRole
        );
        assert_eq!(
            surface_failure_action(&role, SurfaceFailureScope::Renderer),
            SurfaceFailureAction::RecoverRole
        );
    }

    fn runtime_tab_host_snapshot(active_tab_id: &str) -> BrowserRuntimeSnapshot {
        serde_json::from_value(json!({
            "windows": [{
                "windowId": "window-11",
                "activeTabId": active_tab_id,
                "tabIds": ["tab-a", "tab-b"]
            }],
            "roles": [],
            "tabs": [
                {
                    "id": "tab-a",
                    "sourceId": "role-a",
                    "name": "Role A",
                    "windowId": "window-11",
                    "tabType": "role",
                    "slots": [{
                        "slotId":"slot-a","roleId":"role-a","state":"available",
                        "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                    }],
                    "hidden": false
                },
                {
                    "id": "tab-b",
                    "sourceId": "role-b",
                    "name": "Role B",
                    "windowId": "window-11",
                    "tabType": "role",
                    "slots": [{
                        "slotId":"slot-b","roleId":"role-b","state":"available",
                        "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                    }],
                    "hidden": false
                }
            ],
            "workspaces": []
        }))
        .unwrap()
    }

    #[test]
    fn native_runtime_window_title_is_platform_explicit() {
        let original = "遊戲視窗 1";
        for (platform, expected) in [
            ("macos", original.to_owned()),
            ("windows", format!("{original} — Rion Studio")),
        ] {
            assert_eq!(
                native_runtime_window_title_for_platform(platform, Some(original)),
                expected
            );
            assert_eq!(
                native_runtime_window_title_for_platform(platform, None),
                "Rion Studio"
            );
        }
    }

    #[test]
    fn role_zoom_persistence_requires_a_saved_runtime_window() {
        let saved = HashMap::from([("saved-window".to_owned(), "Game Window 1".to_owned())]);
        assert!(should_persist_role_zoom(&saved, "saved-window"));
        assert!(!should_persist_role_zoom(&saved, "transient-window"));
    }

    #[test]
    fn overlay_refresh_selection_supports_all_and_specific_roles() {
        let selected = vec!["role-b".to_owned()];
        assert!(should_refresh_macro_overlay(&[], "role-a"));
        assert!(!should_refresh_macro_overlay(&selected, "role-a"));
        assert!(should_refresh_macro_overlay(&selected, "role-b"));
    }

    #[test]
    fn auth_probe_paths_are_exact_or_descendants_without_prefix_confusion() {
        assert!(valid_auth_probe_path("/profile"));
        assert!(!valid_auth_probe_path("profile"));
        assert!(!valid_auth_probe_path("/profile?token=private"));
        assert!(auth_probe_path_matches("/profile", "/profile"));
        assert!(auth_probe_path_matches("/profile/security", "/profile"));
        assert!(!auth_probe_path_matches("/profiles", "/profile"));
        assert!(auth_probe_path_matches("/", "/"));
    }
