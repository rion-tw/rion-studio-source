#[test]
    fn returning_to_the_applied_tab_skips_native_visibility_and_focus_work() {
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
            None,
            None,
            true,
        );
        assert!(!no_op.requires_ui_thread);
        assert!(!no_op.apply_focus);

        let replacement_identities = HashSet::from([("surface-a".to_owned(), 8)]);
        let replacement = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &replacement_identities,
            None,
            None,
            true,
        );
        assert!(replacement.requires_ui_thread);
        assert!(replacement.presentation_changed);
        assert!(replacement.apply_focus);

        let hide_window = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            Some(true),
            Some(false),
            true,
        );
        assert!(hide_window.requires_ui_thread);
        assert!(!hide_window.apply_focus);

        let visibility_no_op = native_presentation_mutation_plan(
            &tab,
            &tab,
            &identities,
            &identities,
            Some(false),
            Some(false),
            false,
        );
        assert!(!visibility_no_op.requires_ui_thread);
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
        let key = "role:role-1";
        let mut state = RuntimeState::default();
        state.automatic_launch_retries.insert(key.to_owned(), 1);
        state.provisional_launches.insert(
            key.to_owned(),
            ProvisionalLaunch {
                cancelled: false,
                failed: false,
                host_created: false,
                id: "tab-1".to_owned(),
                source_id: "role-1".to_owned(),
                tab_type: "role".to_owned(),
                window_id: "window-1".to_owned(),
            },
        );
        assert!(automatic_launch_retry_is_current(&state, key));
        state.provisional_launches.get_mut(key).unwrap().cancelled = true;
        assert!(!automatic_launch_retry_is_current(&state, key));
        state.provisional_launches.get_mut(key).unwrap().cancelled = false;
        state.automatic_launch_retries.remove(key);
        assert!(!automatic_launch_retry_is_current(&state, key));
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
                    closable: true,
                    icon_data_url: None,
                    id: "provisional-a".to_owned(),
                    phase: TabPresentationPhase::Reserved,
                    role_ids: vec!["role-a".to_owned()],
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
                closable: true,
                icon_data_url: None,
                id: "runtime-a".to_owned(),
                phase: TabPresentationPhase::Attaching,
                role_ids: vec!["role-a".to_owned()],
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
    fn provisional_move_surfaces_incomplete_compensation() {
        let original = "second surface hide failed".to_owned();
        assert_eq!(
            provisional_move_failure_message(original.clone(), &[]),
            original
        );
        let message = provisional_move_failure_message(
            "reparent failed".to_owned(),
            &[
                "reparent role-b: denied".to_owned(),
                "layout: stale".to_owned(),
            ],
        );
        assert!(message.starts_with("SYSTEM_PROVISIONAL_MOVE_ROLLBACK_FAILED"));
        assert!(message.contains("reparent role-b: denied"));
        assert!(message.contains("Restart Rion Studio"));
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
                    "roleIds": ["role-a"],
                    "hidden": false
                },
                {
                    "id": "tab-b",
                    "sourceId": "role-b",
                    "name": "Role B",
                    "windowId": "window-11",
                    "tabType": "role",
                    "roleIds": ["role-b"],
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

    #[test]
    fn local_storage_sync_scripts_are_top_frame_origin_scoped_and_mirror_deletions() {
        let config = LocalStorageRuntimeConfig {
            dependent_role_ids: vec!["follower".to_owned()],
            generation: 1,
            keys: vec!["game_client_settings".to_owned()],
            origin: "https://example.test".to_owned(),
            source_role_id: None,
            token: "capability".to_owned(),
        };
        let observer = local_storage_sync_observer_script(&config).unwrap();
        assert!(observer.contains("globalThis.top !== globalThis"));
        assert!(observer.contains("location.origin !== state.origin"));
        assert!(observer.contains("rion_local_storage_sync_changed"));
        assert!(observer.contains("state.inFlight = request"));
        assert!(observer.contains("state.queued = serialized === state.inFlight.serialized"));
        assert!(observer.contains("generation: request.generation"));
        assert!(observer.contains("sequence: request.sequence"));
        assert!(observer.contains("setInterval(schedule, 250)"));
        assert!(observer.contains("setTimeout(publish, 100)"));
        assert!(observer.contains("storagePrototype.setItem"));
        assert!(observer.contains("storagePrototype.removeItem"));
        assert!(observer.contains("storagePrototype.clear"));
        assert!(observer.contains("disable(expectedToken)"));
        assert!(observer.contains("state.keys = []"));

        let configure = local_storage_sync_configure_script(&config).unwrap();
        assert!(configure.contains("__rionLocalStorageSyncObserver?.configure?."));
        assert!(configure.contains("\"generation\":1"));
        let disable = local_storage_sync_disable_script("capability").unwrap();
        assert_eq!(
            disable,
            "globalThis.__rionLocalStorageSyncObserver?.disable?.(\"capability\");"
        );

        let script = local_storage_sync_apply_script(&PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: "source".to_owned(),
            origin: "https://example.test".to_owned(),
            entries: vec![
                ("game_client_settings".to_owned(), Some("{}".to_owned())),
                ("removed".to_owned(), None),
            ],
        })
        .unwrap();
        assert!(script.contains("globalThis.top !== globalThis"));
        assert!(script.contains("localStorage.removeItem(key)"));
        assert!(script.contains("localStorage.setItem(key, value)"));
        assert!(!script.contains("localStorage.clear()"));
    }

    #[test]
    fn local_storage_sync_sequence_fences_duplicates_and_out_of_order_callbacks() {
        let mut last_accepted = 0;
        assert!(accept_local_storage_sync_sequence(&mut last_accepted, 2));
        assert!(!accept_local_storage_sync_sequence(&mut last_accepted, 1));
        assert!(!accept_local_storage_sync_sequence(&mut last_accepted, 2));
        assert!(!accept_local_storage_sync_sequence(&mut last_accepted, 0));
        assert!(accept_local_storage_sync_sequence(&mut last_accepted, 3));
        assert_eq!(last_accepted, 3);
    }
