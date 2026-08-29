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

        let reparent_into_new_hidden_host = native_presentation_mutation_plan(
            &None,
            &tab,
            &HashSet::new(),
            &identities,
            NativeWindowPresentationTransition::new(
                None,
                Some(true),
                None,
                NativePresentationFocus::None,
            ),
        );
        assert!(reparent_into_new_hidden_host.requires_ui_thread);
        assert!(reparent_into_new_hidden_host.presentation_changed);
        assert!(!reparent_into_new_hidden_host.apply_content_focus);
        assert!(!reparent_into_new_hidden_host.apply_window_focus);
    }

    #[test]
    fn explicit_window_visibility_controls_empty_host_retention() {
        for (platform, tab_id, requested_visibility, expected) in [
            ("macos", None, Some(true), true),
            ("windows", None, Some(true), true),
            ("macos", None, Some(false), false),
            ("windows", None, Some(false), false),
            ("macos", Some("tab-a"), None, true),
            ("windows", Some("tab-a"), None, true),
            ("macos", Some("tab-a"), Some(false), false),
            ("windows", Some("tab-a"), Some(false), false),
        ] {
            assert_eq!(
                native_presentation_host_visibility(tab_id, requested_visibility),
                expected,
                "{platform}: tab={tab_id:?}, requested_visibility={requested_visibility:?}"
            );
        }
    }

    #[test]
    fn ordered_window_activation_can_focus_before_native_content_attaches() {
        for (platform, presentation_current, ordered, requested, current, expected) in [
            ("macos", false, true, true, true, true),
            ("windows", false, true, true, true, true),
            ("macos", false, false, true, true, false),
            ("windows", false, false, true, true, false),
            ("macos", true, false, true, true, true),
            ("windows", true, false, true, true, true),
            ("macos", true, true, true, false, false),
            ("windows", true, true, false, true, false),
        ] {
            assert_eq!(
                native_window_focus_should_apply(
                    presentation_current,
                    ordered,
                    requested,
                    current,
                ),
                expected,
                "{platform}: presentation={presentation_current}, ordered={ordered}, requested={requested}, current={current}"
            );
        }
    }

    #[test]
    fn explicit_visible_focus_uses_an_atomic_foreground_show_unless_reveal_is_deferred() {
        for (visible, focus, deferred, expected) in [
            (Some(true), true, false, true),
            (Some(true), false, false, false),
            (Some(true), true, true, false),
            (Some(false), true, false, false),
            (None, true, false, false),
        ] {
            assert_eq!(
                native_window_foreground_show_should_apply(visible, focus, deferred),
                expected,
                "visible={visible:?}, focus={focus}, deferred={deferred}"
            );
        }
    }

    #[test]
    fn presentation_fence_uses_projection_instance_identities_on_both_threads() {
        let tab_id = Some("tab-a".to_owned());
        let projection_identities =
            HashSet::from([("surface-instance:7".to_owned(), 7)]);
        let native_owner_identities = HashSet::from([("webview-label".to_owned(), 42)]);

        assert!(native_presentation_intent_is_current(
            11,
            &tab_id,
            &projection_identities,
            11,
            &tab_id,
            &projection_identities,
        ));
        assert!(!native_presentation_intent_is_current(
            11,
            &tab_id,
            &projection_identities,
            11,
            &tab_id,
            &native_owner_identities,
        ));
    }

    #[test]
    fn claimed_surface_membership_reconciles_without_a_new_live_revision() {
        let workspace_tab = Some("workspace-tab".to_owned());
        let role_tab = Some("role-tab".to_owned());
        let applied_workspace_surfaces = HashSet::from([
            ("unique-role".to_owned(), 3),
            ("claimed-shared-role".to_owned(), 9),
        ]);
        let current_role_placeholder =
            HashSet::from([("role-placeholder".to_owned(), 10)]);
        let plan = native_presentation_mutation_plan(
            &workspace_tab,
            &role_tab,
            &applied_workspace_surfaces,
            &current_role_placeholder,
            NativeWindowPresentationTransition::new(
                None,
                None,
                None,
                NativePresentationFocus::None,
            ),
        );
        assert!(plan.presentation_changed);
        assert!(plan.requires_ui_thread);
        assert!(native_presentation_intent_is_current(
            27,
            &role_tab,
            &current_role_placeholder,
            27,
            &role_tab,
            &current_role_placeholder,
        ));
    }

    #[test]
    fn late_surface_membership_cannot_rewind_rapid_a_b_c_selection() {
        let selected_c = Some("tab-c".to_owned());
        let surfaces_c = HashSet::from([("surface-c".to_owned(), 30)]);
        for (late_revision, late_tab, late_surface) in [
            (28, "tab-a", "surface-a"),
            (29, "tab-b", "surface-b"),
        ] {
            assert!(!native_presentation_intent_is_current(
                30,
                &selected_c,
                &surfaces_c,
                late_revision,
                &Some(late_tab.to_owned()),
                &HashSet::from([(late_surface.to_owned(), late_revision)]),
            ));
        }

        // A projection-only reconciliation samples the selection after the delayed
        // surface attaches, so it replays C without committing another live revision.
        assert!(native_presentation_intent_is_current(
            30,
            &selected_c,
            &surfaces_c,
            30,
            &selected_c,
            &surfaces_c,
        ));
    }

    #[test]
    fn presentation_native_work_is_fenced_by_lifecycle_epoch_and_actor_liveness() {
        let shutdown_state = AtomicU8::new(RuntimeShutdownState::Accepting as u8);
        let lifecycle = ApplicationLifecycleCoordinator::new_for_platform("macos");
        let actor_liveness = AtomicBool::new(true);
        assert!(native_presentation_native_work_is_current(
            &shutdown_state,
            &lifecycle,
            0,
            &actor_liveness,
        ));

        lifecycle.transition(ApplicationLifecyclePhase::Suspending, 1, "test");
        assert!(!native_presentation_native_work_is_current(
            &shutdown_state,
            &lifecycle,
            0,
            &actor_liveness,
        ));
        lifecycle.suspended.store(false, Ordering::Release);
        lifecycle.transition(ApplicationLifecyclePhase::Active, 1, "test");
        assert!(!native_presentation_native_work_is_current(
            &shutdown_state,
            &lifecycle,
            0,
            &actor_liveness,
        ));
        assert!(native_presentation_native_work_is_current(
            &shutdown_state,
            &lifecycle,
            1,
            &actor_liveness,
        ));

        actor_liveness.store(false, Ordering::Release);
        assert!(!native_presentation_native_work_is_current(
            &shutdown_state,
            &lifecycle,
            1,
            &actor_liveness,
        ));
    }

    #[test]
    fn externally_reparented_surface_preserves_covered_target_surfaces() {
        let mut state = NativeWindowActorState {
            applied_revision: 12,
            applied_surface_identities: HashSet::from([("surface-a".to_owned(), 3)]),
            applied_tab_id: Some("tab-a".to_owned()),
            ..NativeWindowActorState::default()
        };

        state.record_externally_applied_presentation(
            13,
            Some("tab-b".to_owned()),
            HashSet::from([("surface-b".to_owned(), 4)]),
            Vec::new(),
        );
        state.record_externally_applied_presentation(
            11,
            Some("stale-tab".to_owned()),
            HashSet::new(),
            Vec::new(),
        );

        assert_eq!(state.applied_revision, 13);
        assert_eq!(state.applied_tab_id.as_deref(), Some("tab-b"));
        assert_eq!(
            state.applied_surface_identities,
            HashSet::from([("surface-a".to_owned(), 3), ("surface-b".to_owned(), 4)])
        );
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
    fn launcher_source_lookup_uses_presentation_without_runtime_or_page_readiness() {
        let registry = PresentationRegistry::default();
        commit_test_live_window(&registry, "window-a", |state| {
            state.insert_tab(
                LiveTabRecord {
                    audio_muted: false,
                    closable: true,
                    icon_data_url: None,
                    id: "runtime-a".to_owned(),
                    persistable: false,
                    role_ids: vec!["role-a".to_owned()],
                    role_slots: Vec::new(),
                    workspace_slots: Vec::new(),
                    source_id: "role-a".to_owned(),
                    tab_type: "role".to_owned(),
                    title: "Loading".to_owned(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: None,
                },
                1,
                true,
            );
        });
        assert_eq!(
            registry.tab_for_source("role-a", "role").as_deref(),
            Some("runtime-a")
        );
        assert_eq!(registry.tab_for_source("role-a", "workspace"), None);

        commit_test_live_window(&registry, "window-a", |live| {
            let tab = live
                .tabs
                .iter_mut()
                .find(|tab| tab.id == "runtime-a")
                .unwrap();
            tab.persistable = true;
            tab.title = "Role A".to_owned();
        });
        assert_eq!(
            registry.tab_for_source("role-a", "role").as_deref(),
            Some("runtime-a")
        );
    }

    #[test]
    fn launcher_presence_uses_presented_workspace_role_membership_until_removal() {
        let registry = PresentationRegistry::default();
        let mut workspace = presentation_tab("workspace-tab", TabRuntimePhase::Failed);
        workspace.source_id = "workspace-a".to_owned();
        workspace.tab_type = "workspace".to_owned();
        workspace.role_ids = vec!["role-a".to_owned(), "role-b".to_owned()];
        commit_test_live_window(&registry, "window-b", |window| {
            window.insert_tab(workspace, 4, true);
        });

        let presence = registry.launcher_presence().unwrap();
        assert_eq!(presence.tabs.len(), 1);
        assert_eq!(presence.tabs[0].source_id, "workspace-a");
        assert_eq!(presence.tabs[0].role_ids, ["role-a", "role-b"]);
        assert_eq!(presence.windows.len(), 1);
        assert_eq!(presence.windows[0].window_id, "window-b");
        assert_eq!(presence.windows[0].title, "Tab workspace-tab");
        assert!(!presence.windows[0].persisted);
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
        assert_eq!(
            registry.tabs_for_launcher_source("role-b", "role"),
            ["workspace-tab"]
        );

        commit_test_live_window(&registry, "window-b", |window| {
            window.remove_tab("workspace-tab", 5);
        });
        assert!(registry.launcher_presence().unwrap().tabs.is_empty());
        assert!(registry.tab_for_launcher_source("role-b", "role").is_none());
    }

    #[test]
    fn launcher_presence_includes_reserved_role_sources_across_windows() {
        let registry = PresentationRegistry::default();
        commit_test_live_window(&registry, "window-z", |window| {
            window.insert_tab(
                presentation_tab("reserved-role", TabRuntimePhase::Reserved),
                1,
                true,
            );
        });
        commit_test_live_window(&registry, "window-a", |window| {
            window.insert_tab(
                presentation_tab("ready-role", TabRuntimePhase::Ready),
                2,
                true,
            );
        });

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
            windows: Vec::new(),
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
    fn post_batch_selected_surface_reprojection_uses_only_terminal_ready_events() {
        for phase in [
            LaunchPhase::EssentialReady,
            LaunchPhase::Ready,
            LaunchPhase::Degraded,
        ] {
            assert!(launch_phase_reprojects_selected_surfaces(phase), "{phase:?}");
        }
        for phase in [
            LaunchPhase::Attaching,
            LaunchPhase::Navigating,
            LaunchPhase::OptionalHydrating,
        ] {
            assert!(
                !launch_phase_reprojects_selected_surfaces(phase),
                "{phase:?}"
            );
        }
    }

    #[test]
    fn post_batch_selected_surface_reprojection_is_exactly_fenced() {
        let expected = SelectedSurfaceReprojectionFence {
            lifecycle_epoch: 7,
            revision: 19,
            tab_id: "tab-a".to_owned(),
            window_generation: 3,
            window_id: "window-a".to_owned(),
        };
        let current = LiveWindowRecord {
            revision: 19,
            selected_tab_id: Some("tab-a".to_owned()),
            window_generation: 3,
            window_id: "window-a".to_owned(),
            ..LiveWindowRecord::default()
        };
        assert!(selected_surface_reprojection_fence_matches(
            &expected, &current, 7
        ));

        let mut stale_revision = current.clone();
        stale_revision.revision = 20;
        assert!(!selected_surface_reprojection_fence_matches(
            &expected,
            &stale_revision,
            7
        ));
        let mut replacement_host = current.clone();
        replacement_host.window_generation = 4;
        assert!(!selected_surface_reprojection_fence_matches(
            &expected,
            &replacement_host,
            7
        ));
        let mut different_selection = current.clone();
        different_selection.selected_tab_id = Some("tab-b".to_owned());
        assert!(!selected_surface_reprojection_fence_matches(
            &expected,
            &different_selection,
            7
        ));
        assert!(!selected_surface_reprojection_fence_matches(
            &expected, &current, 8
        ));

        let owner = SurfacePresentationOwner {
            instance_id: "surface-a:4".to_owned(),
            owner_epoch: 11,
            window_generation: 3,
            window_id: "window-a".to_owned(),
        };
        assert!(selected_surface_reprojection_identity_matches(
            "surface-a:4",
            6,
            &owner,
            "surface-a:4",
            6,
            &owner,
        ));
        let mut reassigned_owner = owner.clone();
        reassigned_owner.owner_epoch = 12;
        assert!(!selected_surface_reprojection_identity_matches(
            "surface-a:4",
            6,
            &owner,
            "surface-a:4",
            6,
            &reassigned_owner,
        ));
        assert!(!selected_surface_reprojection_identity_matches(
            "surface-a:4",
            6,
            &owner,
            "surface-a:5",
            7,
            &owner,
        ));
    }

    #[test]
    fn selected_surface_reprojection_reads_the_registry_by_instance_id() {
        let registry = HashMap::from([("surface-a:4".to_owned(), 7_u64)]);

        assert_eq!(
            selected_surface_reprojection_registry_entry(&registry, "surface-a:4"),
            Some(&7)
        );
        assert_eq!(
            selected_surface_reprojection_registry_entry(&registry, "surface-a"),
            None
        );
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
            &CoreEffectAction::EmbeddedFollowRoleOwnership {
                roles: Vec::new(),
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            }
        ));
    }

    #[test]
    fn continuous_macro_input_does_not_starve_optional_tab_hydration() {
        let browser_action = CoreEffectAction::BrowserAction {
            request: Box::new(BrowserActionRequest {
                request_id: "request-a".to_owned(),
                role_id: "role-a".to_owned(),
                origin: "macro".to_owned(),
                input_epoch: 7,
                intent: "normal".to_owned(),
                scheduled_at_ms: 10,
                deadline_ms: 20,
                action: BrowserAction::Focus,
            }),
        };

        assert!(is_browser_action_effect(&browser_action));
        assert!(!marks_optional_hydration_critical_activity(
            &browser_action
        ));
        assert!(marks_optional_hydration_critical_activity(
            &CoreEffectAction::EmbeddedLoadRoles { roles: Vec::new() }
        ));
        assert!(marks_optional_hydration_critical_activity(
            &CoreEffectAction::EmbeddedDestroyRole {
                role_id: "role-a".to_owned(),
            }
        ));
        assert!(optional_hydration_is_admitted(
            RuntimeShutdownState::Accepting
        ));
        for state in [
            RuntimeShutdownState::Draining,
            RuntimeShutdownState::Closed,
            RuntimeShutdownState::Indeterminate,
        ] {
            assert!(!optional_hydration_is_admitted(state));
        }
    }

    #[cfg(all(windows, feature = "desktop-e2e"))]
    #[test]
    fn windows_native_menu_input_is_armed_for_the_popup_event() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            VK_DOWN, VK_HOME, VK_RETURN, VK_RIGHT,
        };

        assert_eq!(
            desktop_e2e_windows_tab_menu_key_codes("hide", None).unwrap(),
            vec![
                VK_DOWN.0,
                VK_HOME.0,
                VK_DOWN.0,
                VK_DOWN.0,
                VK_DOWN.0,
                VK_DOWN.0,
                VK_RETURN.0,
            ]
        );
        assert_eq!(
            desktop_e2e_windows_tab_menu_key_codes("moveToNewWindow", None).unwrap(),
            vec![
                VK_DOWN.0,
                VK_HOME.0,
                VK_DOWN.0,
                VK_DOWN.0,
                VK_RETURN.0
            ]
        );
        assert_eq!(
            desktop_e2e_windows_tab_menu_key_codes("move", Some(1)).unwrap(),
            vec![
                VK_DOWN.0,
                VK_HOME.0,
                VK_DOWN.0,
                VK_RIGHT.0,
                VK_DOWN.0,
                VK_RETURN.0,
            ]
        );
        assert!(desktop_e2e_windows_tab_menu_key_codes("unknown", None).is_err());
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
        assert_eq!(
            windows_surface_navigation_completion(91, 91, true),
            WindowsSurfaceNavigationCompletion::Isolated
        );
        assert_eq!(
            windows_surface_navigation_completion(91, 91, false),
            WindowsSurfaceNavigationCompletion::Failed
        );
        assert_eq!(
            windows_surface_navigation_completion(91, 92, true),
            WindowsSurfaceNavigationCompletion::Stale
        );
        assert_eq!(
            windows_surface_navigation_completion(0, 0, true),
            WindowsSurfaceNavigationCompletion::Stale
        );
        assert_eq!(windows_navigation_zoom_refresh_factor(0.25), Some(0.251));
        assert_eq!(windows_navigation_zoom_refresh_factor(5.0), Some(4.999));
        assert_eq!(windows_navigation_zoom_refresh_factor(0.0), None);
        assert_eq!(windows_navigation_zoom_refresh_factor(f64::NAN), None);
    }

    #[test]
    fn surface_release_barrier_requires_explicit_release_events() {
        let tracker = SurfaceLifecycleTracker::default();
        assert!(!tracker.store_is_reusable("windows"));

        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        tracker.mark_controller_released();
        assert!(!tracker.store_is_reusable("macos"));
        assert!(tracker.mark_isolated(2));
        tracker.mark_native_surface_released();
        tracker.mark_controller_released();
        assert!(tracker.store_is_reusable("macos"));
        assert!(!tracker.store_is_reusable("windows"));
        assert!(tracker.mark_browser_process_exited());
        assert!(tracker.store_is_reusable("windows"));
    }

    #[test]
    fn store_reuse_waiter_is_released_by_exact_lifecycle_events_without_polling() {
        let tracker = Arc::new(SurfaceLifecycleTracker::default());
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        assert!(tracker.mark_isolated(2));
        let waiter_tracker = Arc::clone(&tracker);
        let callback_tracker = Arc::clone(&tracker);
        let callback = std::thread::spawn(move || {
            callback_tracker.mark_native_surface_released();
            callback_tracker.mark_controller_released();
        });
        assert!(tauri::async_runtime::block_on(
            waiter_tracker.wait_for_store_reusable_event("macos")
        )
        .is_ok());
        callback.join().unwrap();
    }

    #[test]
    fn parent_window_destroyed_completes_the_exact_surface_release_barrier() {
        for platform in ["macos", "windows"] {
            let tracker = Arc::new(SurfaceLifecycleTracker::default());
            assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
            let callback_tracker = Arc::clone(&tracker);
            let callback_platform = platform;
            let callback = std::thread::spawn(move || {
                assert!(callback_tracker.mark_parent_window_destroyed());
                if callback_platform == "windows" {
                    assert!(callback_tracker.mark_browser_process_exited());
                }
            });

            assert!(tauri::async_runtime::block_on(async {
                tracker.wait_for_isolation_event().await?;
                tracker.wait_for_native_release_event().await?;
                tracker.wait_for_store_reusable_event(platform).await
            })
            .is_ok());
            callback.join().unwrap();
            assert!(tracker.parent_window_destroyed());
            assert_eq!(tracker.native_isolation_event(), 11);
            assert!(!tracker.mark_parent_window_destroyed());
        }
    }

    #[test]
    fn lifecycle_cancellation_is_terminal_and_late_native_events_are_stale() {
        let tracker = SurfaceLifecycleTracker::default();
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        assert!(tracker.cancel_pending(
            "SYSTEM_SURFACE_LIFECYCLE_CANCELLED",
            "application lifecycle ended"
        ));
        assert!(!tracker.cancel_pending(
            "SYSTEM_SURFACE_LIFECYCLE_CANCELLED",
            "duplicate cancellation"
        ));
        assert!(!tracker.mark_isolated(2));
        tracker.mark_native_surface_released();
        tracker.mark_controller_released();
        assert!(!tracker.store_is_reusable("macos"));
        let error = tauri::async_runtime::block_on(tracker.wait_for_isolation_event())
            .unwrap_err();
        assert_eq!(error.code, "SYSTEM_SURFACE_LIFECYCLE_CANCELLED");
        assert_eq!(tracker.native_isolation_event(), 0);
    }

    #[test]
    fn close_group_failure_cancels_a_sibling_before_native_submission() {
        let sibling = SurfaceLifecycleTracker::default();
        assert!(sibling.cancel_accepted_intent(
            "SYSTEM_SURFACE_GROUP_CANCELLED",
            "sibling failed"
        ));
        let error = sibling.claim_isolation().unwrap_err();
        assert_eq!(error.code, "SYSTEM_SURFACE_GROUP_CANCELLED");
        assert!(!sibling.cancel_accepted_intent(
            "SYSTEM_SURFACE_GROUP_CANCELLED",
            "duplicate group event"
        ));
    }

    #[test]
    fn process_termination_is_a_page_stop_only_for_an_accepted_close_intent() {
        let tracker = SurfaceLifecycleTracker::default();
        assert!(!tracker.close_intent_owns_process_failure());
        assert!(!tracker.mark_process_terminated());
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        assert!(tracker.close_intent_owns_process_failure());
        assert!(tracker.mark_process_terminated());
        assert!(tracker.process_termination_completed_close());
        assert_eq!(tracker.native_isolation_event(), 5);
    }

    #[test]
    fn windows_store_waits_for_browser_process_exit_after_native_release() {
        let tracker = Arc::new(SurfaceLifecycleTracker::default());
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        assert!(tracker.mark_isolated(2));
        tracker.mark_native_surface_released();
        tracker.mark_controller_released();
        assert!(!tracker.store_is_reusable("windows"));

        let callback_tracker = Arc::clone(&tracker);
        let callback = std::thread::spawn(move || {
            assert!(callback_tracker.mark_browser_process_exited());
        });
        assert!(tauri::async_runtime::block_on(
            tracker.wait_for_store_reusable_event("windows")
        )
        .is_ok());
        callback.join().unwrap();
        assert_eq!(tracker.native_isolation_event(), 2);
    }

    #[test]
    fn windows_shared_process_surface_releases_without_process_exit() {
        let tracker = SurfaceLifecycleTracker::default();
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        assert!(tracker.mark_isolated(2));
        tracker.mark_native_surface_released();
        tracker.mark_controller_released();

        assert!(tracker.release_is_complete(
            "windows",
            SurfaceReleaseBoundary::SharedBrowserProcess
        ));
        assert!(!tracker.store_is_reusable("windows"));
        assert!(tauri::async_runtime::block_on(tracker.wait_for_release_event(
            "windows",
            SurfaceReleaseBoundary::SharedBrowserProcess,
        ))
        .is_ok());
        assert_eq!(
            ManagedSurfaceKind::Role.release_boundary(),
            SurfaceReleaseBoundary::DedicatedStore
        );
        for kind in [
            ManagedSurfaceKind::Divider,
            ManagedSurfaceKind::Popup,
            ManagedSurfaceKind::Recovery,
        ] {
            assert_eq!(
                kind.release_boundary(),
                SurfaceReleaseBoundary::SharedBrowserProcess
            );
        }
    }

    #[test]
    fn runtime_health_is_diagnostic_and_does_not_own_live_topology() {
        let health = RuntimeHealth::new();
        health.mark_unhealthy();
        assert!(!health.is_healthy());
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
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        let callback_tracker = Arc::clone(&tracker);
        let worker = std::thread::spawn(move || callback_tracker.mark_isolated(2));
        assert!(tauri::async_runtime::block_on(tracker.wait_for_isolation_event()).is_ok());
        worker.join().unwrap();
    }

    #[test]
    fn native_isolation_failure_is_an_explicit_terminal_event() {
        let tracker = Arc::new(SurfaceLifecycleTracker::default());
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        let callback_tracker = Arc::clone(&tracker);
        let worker = std::thread::spawn(move || {
            callback_tracker.fail_isolation(&RuntimeError::new(
                "SYSTEM_SURFACE_NAVIGATION_FAILED",
                "exact navigation failed",
            ));
        });
        let error = tauri::async_runtime::block_on(tracker.wait_for_isolation_event())
            .unwrap_err();
        assert_eq!(error.code, "SYSTEM_SURFACE_NAVIGATION_FAILED");
        worker.join().unwrap();
    }

    #[test]
    fn native_surface_isolation_is_singleflight_and_terminal() {
        let tracker = SurfaceLifecycleTracker::default();
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Joined);

        tracker.mark_isolated(2);
        assert_eq!(
            tracker.claim_isolation().unwrap(),
            SurfaceIsolationClaim::AlreadyIsolated
        );
    }

    #[test]
    fn native_surface_isolation_failure_is_not_retried_destructively() {
        let tracker = SurfaceLifecycleTracker::default();
        assert_eq!(tracker.claim_isolation().unwrap(), SurfaceIsolationClaim::Owner);
        tracker.fail_isolation(&RuntimeError::new(
            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
            "exact controller outcome unknown",
        ));

        let error = tracker.claim_isolation().unwrap_err();
        assert_eq!(error.code, "SYSTEM_SURFACE_RELEASE_UNVERIFIED");
        assert_eq!(error.message, "exact controller outcome unknown");
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
        for platform in ["macos", "windows"] {
            assert_eq!(
                native_runtime_window_title_for_platform(platform, Some(original)),
                original
            );
            assert_eq!(
                native_runtime_window_title_for_platform(platform, None),
                "Rion Studio"
            );
        }
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
