use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn runtime_tab_control_row_uses_exact_half_open_boundaries() {
        let row = (100.0, -44.0, 900.0, 44.0);
        for (point, expected) in [
            ((100.0, -44.0), true),
            ((999.999, -0.001), true),
            ((99.999, -20.0), false),
            ((1000.0, -20.0), false),
            ((500.0, -44.001), false),
            ((500.0, 0.0), false),
        ] {
            assert_eq!(
                point_in_runtime_tab_control_row(row.0, row.1, row.2, row.3, point.0, point.1,),
                expected,
                "point {point:?}"
            );
        }
    }

    #[test]
    fn reversible_fanout_rolls_back_every_attempted_native_mutation() {
        let values = Mutex::new(vec![false, false, false]);
        let rollback_order = Mutex::new(Vec::new());
        let failure = apply_reversible_fanout(
            &[0, 1, 2],
            |index, _| {
                values.lock().unwrap()[index] = true;
                if index == 1 {
                    Err("second surface rejected the update".to_owned())
                } else {
                    Ok(())
                }
            },
            |index, _| {
                values.lock().unwrap()[index] = false;
                rollback_order.lock().unwrap().push(index);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(
            failure,
            ReversibleFanoutFailure {
                apply_error: "second surface rejected the update".to_owned(),
                rollback_errors: Vec::new(),
            }
        );
        assert_eq!(*values.lock().unwrap(), vec![false, false, false]);
        assert_eq!(*rollback_order.lock().unwrap(), vec![1, 0]);
    }

    #[test]
    fn reversible_fanout_reports_failed_compensation() {
        let failure = apply_reversible_fanout(
            &["first", "second"],
            |index, _| {
                if index == 1 {
                    Err("apply failed".to_owned())
                } else {
                    Ok(())
                }
            },
            |index, item| {
                if index == 0 {
                    Err(format!("rollback {item} failed"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();

        assert_eq!(failure.rollback_errors, vec!["rollback first failed"]);
        let error = reversible_fanout_runtime_error("APPLY_FAILED", "Updating surfaces", &failure);
        assert_eq!(error.code, "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED");
        assert!(error.message.contains("Restart Rion Studio"));
    }

    #[test]
    fn native_runtime_work_loop_is_fifo_and_non_overlapping() {
        let (sender, receiver) = mpsc::channel();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let worker_observed = Arc::clone(&observed);
        let worker_active = Arc::clone(&active);
        let worker_peak = Arc::clone(&peak);
        let worker = std::thread::spawn(move || {
            run_serial_runtime_work_loop(receiver, |value| {
                let current = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
                worker_peak.fetch_max(current, Ordering::SeqCst);
                worker_observed.lock().unwrap().push(value);
                std::thread::yield_now();
                worker_active.fetch_sub(1, Ordering::SeqCst);
            });
        });

        for value in 0..64 {
            sender.send(value).unwrap();
        }
        drop(sender);
        worker.join().unwrap();

        assert_eq!(*observed.lock().unwrap(), (0..64).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn runtime_persistence_preserves_an_active_restore_fence_until_clean_exit() {
        let mut session = RuntimeRestoreSessionRecord {
            schema_version: 1,
            session_generation: 4,
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            clean_exit: true,
            last_focused_window_id: Some("window-1".to_owned()),
            restore_in_progress_window_ids: vec!["window-1".to_owned()],
            windows: Vec::new(),
        };

        prepare_restore_session_for_persist(&mut session, false);
        assert_eq!(session.schema_version, 2);
        assert!(!session.clean_exit);
        assert_eq!(
            session.restore_in_progress_window_ids,
            vec!["window-1".to_owned()]
        );

        prepare_restore_session_for_persist(&mut session, true);
        assert!(session.clean_exit);
        assert!(session.restore_in_progress_window_ids.is_empty());
    }

    #[test]
    fn runtime_effect_success_requires_restore_session_persistence() {
        let success = CoreEffectResult {
            effect_id: "effect-a".to_owned(),
            operation_id: "operation-a".to_owned(),
            ok: true,
            value_json: Some("{}".to_owned()),
            error: None,
        };
        let failed =
            finalize_persisted_effect_result(success.clone(), true, Some("disk full".to_owned()));
        assert!(!failed.ok);
        assert!(failed.value_json.is_none());
        assert_eq!(
            failed.error.as_ref().map(|error| error.code.as_str()),
            Some("SYSTEM_RUNTIME_PERSIST_FAILED")
        );

        assert!(finalize_persisted_effect_result(success.clone(), true, None).ok);
        assert!(finalize_persisted_effect_result(success, false, Some("ignored".to_owned())).ok);
    }

    #[test]
    fn minimized_and_zero_sized_windows_do_not_relayout_game_surfaces() {
        for (width, height, minimized, expected) in [
            (1280, 720, false, true),
            (0, 720, false, false),
            (1280, 0, false, false),
            (1280, 720, true, false),
        ] {
            assert_eq!(
                runtime_window_resize_is_actionable(width, height, minimized),
                expected,
                "{width}x{height}, minimized={minimized}"
            );
        }
    }

    #[test]
    fn surface_release_barrier_is_platform_explicit() {
        for (
            platform,
            controller_released,
            native_surface_released,
            browser_process_exited,
            expected,
        ) in [
            ("macos", false, false, false, false),
            ("macos", true, false, false, false),
            ("macos", true, true, false, true),
            ("windows", false, true, true, false),
            ("windows", true, false, true, false),
            ("windows", true, true, false, true),
            ("windows", true, true, true, true),
        ] {
            assert_eq!(
                surface_store_reusable(
                    platform,
                    &SurfaceReleaseState {
                        #[cfg(windows)]
                        browser_process_exited,
                        controller_released,
                        isolation_progress: if native_surface_released {
                            SurfaceIsolationProgress::Isolated
                        } else {
                            SurfaceIsolationProgress::Live
                        },
                        isolated: native_surface_released,
                        native_surface_released,
                    }
                ),
                expected,
                "{platform}: controller={controller_released}, native={native_surface_released}, browser={browser_process_exited}"
            );
        }
    }

    #[test]
    fn managed_surfaces_close_role_pages_before_dividers() {
        assert!(
            managed_surface_close_priority(ManagedSurfaceKind::Popup)
                < managed_surface_close_priority(ManagedSurfaceKind::Recovery)
        );
        assert!(
            managed_surface_close_priority(ManagedSurfaceKind::Recovery)
                < managed_surface_close_priority(ManagedSurfaceKind::Role)
        );
        assert!(
            managed_surface_close_priority(ManagedSurfaceKind::Role)
                < managed_surface_close_priority(ManagedSurfaceKind::Divider)
        );
    }

    #[test]
    fn close_presentation_selects_right_then_left_without_reopening_the_closed_tab() {
        let ids = ["a", "b", "c", "d"].map(str::to_owned);
        assert_eq!(
            successor_tab_after_close(&ids, "a", |_| true).as_deref(),
            Some("b")
        );
        assert_eq!(
            successor_tab_after_close(&ids, "b", |_| true).as_deref(),
            Some("c")
        );
        assert_eq!(
            successor_tab_after_close(&ids, "d", |_| true).as_deref(),
            Some("c")
        );
        assert_eq!(
            successor_tab_after_close(&ids, "b", |candidate| candidate == "a").as_deref(),
            Some("a")
        );
        assert_eq!(successor_tab_after_close(&ids[..1], "a", |_| true), None);
    }

    #[test]
    fn presentation_barrier_waits_for_the_applied_revision_and_is_bounded() {
        let actor = Arc::new(NativeWindowActor {
            generation: 1,
            liveness: Arc::new(AtomicBool::new(true)),
            queue: Arc::new((
                Mutex::new(NativeWindowActorState::default()),
                Condvar::new(),
            )),
        });
        let completing_actor = Arc::clone(&actor);
        let completion = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            let (lock, changed) = &*completing_actor.queue;
            let mut state = lock.lock().unwrap();
            state.applied_revision = 7;
            changed.notify_all();
        });

        assert!(actor.wait_until_applied(7, Duration::from_millis(100)));
        completion.join().unwrap();
        assert!(!actor.wait_until_applied(8, Duration::from_millis(1)));
    }

    #[test]
    fn native_window_actor_generation_and_stop_fence_reopened_windows() {
        let actor = NativeWindowActor {
            generation: 7,
            liveness: Arc::new(AtomicBool::new(true)),
            queue: Arc::new((
                Mutex::new(NativeWindowActorState::default()),
                Condvar::new(),
            )),
        };
        assert!(actor.matches_generation(7));
        assert!(!actor.matches_generation(8));
        actor.stop();
        assert!(!actor.matches_generation(7));
        assert!(actor.queue.0.lock().unwrap().stopped);
    }

    fn presentation_tab(id: &str, _phase: TabRuntimePhase) -> LiveTabRecord {
        LiveTabRecord {
            audio_muted: false,
            closable: true,
            icon_data_url: None,
            id: id.to_owned(),
            persistable: true,
            role_ids: vec![format!("role-{id}")],
            role_slots: Vec::new(),
            source_id: format!("source-{id}"),
            tab_type: "role".to_owned(),
            title: format!("Tab {id}"),
            #[cfg(any(windows, target_os = "macos"))]
            workspace_template: None,
        }
    }

    #[test]
    fn presentation_selection_is_independent_from_launch_phase_and_core_metadata() {
        let mut state = LiveWindowRecord::default();
        let statuses = TabRuntimeStatusStore::default();
        state.insert_tab(
            presentation_tab("tab-a", TabRuntimePhase::Ready),
            1,
            true,
        );
        state.insert_tab(
            presentation_tab("preview-b", TabRuntimePhase::Reserved),
            2,
            true,
        );

        state.update_metadata(
            "tab-a",
            "role-a",
            "role",
            &["role-a".to_owned()],
            "Updated A",
        );
        statuses.set_presentation_phase("preview-b", TabRuntimePhase::Loading);
        state.reorder_known_tabs(&["tab-a".to_owned()]);

        assert_eq!(state.selected_tab_id.as_deref(), Some("preview-b"));
        assert!(state.contains_tab("preview-b"));
        assert_eq!(state.revision, 2);

        state.replace_tab_id(
            "preview-b",
            presentation_tab("tab-b", TabRuntimePhase::Attaching),
            3,
        );
        assert_eq!(state.selected_tab_id.as_deref(), Some("tab-b"));
        assert_eq!(
            state.aliases.get("preview-b").map(String::as_str),
            Some("tab-b")
        );

        statuses.replace_tab_id("preview-b", "tab-b");
        statuses.set_presentation_phase("tab-b", TabRuntimePhase::Failed);
        state.select(Some("tab-b".to_owned()), 4);
        assert_eq!(state.selected_tab_id.as_deref(), Some("tab-b"));
        assert_eq!(
            statuses.tabs.lock().unwrap()["tab-b"].presentation_phase,
            TabRuntimePhase::Failed
        );
    }

    #[test]
    fn live_hidden_state_controls_visible_order_and_selection_without_core() {
        let mut state = LiveWindowRecord::default();
        state.insert_tab(
            presentation_tab("tab-a", TabRuntimePhase::Ready),
            1,
            true,
        );
        state.insert_tab(
            presentation_tab("tab-b", TabRuntimePhase::Ready),
            2,
            false,
        );

        assert!(state.set_tab_hidden("tab-a", true, 3));
        state.select(Some("tab-b".to_owned()), 3);
        assert_eq!(state.all_tab_ids(), ["tab-a", "tab-b"]);
        assert_eq!(state.tab_ids(), ["tab-b"]);
        assert!(state.tab_is_hidden("tab-a"));

        state.select(Some("tab-a".to_owned()), 4);
        assert_eq!(state.tab_ids(), ["tab-a", "tab-b"]);
        assert!(!state.tab_is_hidden("tab-a"));
    }

    #[test]
    fn moving_a_selected_presentation_tab_commits_both_windows_without_core_state() {
        let registry = PresentationRegistry::default();
        let source = registry.coordinator("window-a").unwrap();
        {
            let mut source = source.lock().unwrap();
            source.insert_tab(
                presentation_tab("tab-a", TabRuntimePhase::Ready),
                1,
                false,
            );
            source.insert_tab(
                presentation_tab("tab-b", TabRuntimePhase::Loading),
                2,
                true,
            );
        }

        registry
            .move_tab("tab-b", "window-a", "window-b", 3)
            .unwrap();

        let source = registry.existing("window-a").unwrap();
        let source = source.lock().unwrap();
        assert_eq!(source.selected_tab_id.as_deref(), Some("tab-a"));
        assert!(!source.contains_tab("tab-b"));
        drop(source);
        let target = registry.existing("window-b").unwrap();
        let target = target.lock().unwrap();
        assert_eq!(target.selected_tab_id.as_deref(), Some("tab-b"));
        assert!(target.contains_tab("tab-b"));
    }

    #[test]
    fn moving_a_middle_selected_presentation_tab_prefers_the_next_source_tab() {
        let registry = PresentationRegistry::default();
        let source = registry.coordinator("window-a").unwrap();
        {
            let mut source = source.lock().unwrap();
            source.insert_tab(
                presentation_tab("tab-a", TabRuntimePhase::Ready),
                1,
                false,
            );
            source.insert_tab(
                presentation_tab("tab-b", TabRuntimePhase::Ready),
                2,
                true,
            );
            source.insert_tab(
                presentation_tab("tab-c", TabRuntimePhase::Ready),
                3,
                false,
            );
        }

        registry
            .move_tab("tab-b", "window-a", "window-b", 4)
            .unwrap();

        let source = registry.existing("window-a").unwrap();
        assert_eq!(
            source.lock().unwrap().selected_tab_id.as_deref(),
            Some("tab-c")
        );
    }

    #[test]
    fn tab_drag_presentation_can_detach_attach_and_return_repeatedly() {
        let registry = PresentationRegistry::default();
        let source = registry.coordinator("window-a").unwrap();
        {
            let mut source = source.lock().unwrap();
            for (revision, tab_id, selected) in
                [(1, "tab-a", false), (2, "tab-b", true), (3, "tab-c", false)]
            {
                source.insert_tab(
                    presentation_tab(tab_id, TabRuntimePhase::Ready),
                    revision,
                    selected,
                );
            }
        }
        registry
            .coordinator("window-b")
            .unwrap()
            .lock()
            .unwrap()
            .insert_tab(
                presentation_tab("tab-d", TabRuntimePhase::Ready),
                4,
                true,
            );

        for (revision, from, to) in [
            (5, "window-a", "provisional"),
            (6, "provisional", "window-b"),
            (7, "window-b", "provisional"),
            (8, "provisional", "window-a"),
        ] {
            registry.move_tab("tab-b", from, to, revision).unwrap();
            assert_eq!(registry.tab_window("tab-b").unwrap().as_deref(), Some(to));
        }

        let source = registry.existing("window-a").unwrap();
        let mut source = source.lock().unwrap();
        source.reorder_known_tabs(&["tab-a".to_owned(), "tab-b".to_owned(), "tab-c".to_owned()]);
        source.select(Some("tab-b".to_owned()), 9);
        assert_eq!(source.tab_ids(), ["tab-a", "tab-b", "tab-c"]);
        assert_eq!(source.selected_tab_id.as_deref(), Some("tab-b"));
        drop(source);
        assert_eq!(
            registry
                .existing("window-b")
                .unwrap()
                .lock()
                .unwrap()
                .selected_tab_id
                .as_deref(),
            Some("tab-d")
        );
    }

    #[test]
    fn topology_move_preserves_target_selection_until_runtime_selection_commits() {
        let registry = PresentationRegistry::default();
        let source = registry.coordinator("window-a").unwrap();
        {
            let mut source = source.lock().unwrap();
            source.insert_tab(
                presentation_tab("tab-a", TabRuntimePhase::Ready),
                1,
                false,
            );
            source.insert_tab(
                presentation_tab("tab-b", TabRuntimePhase::Ready),
                2,
                true,
            );
        }
        let target = registry.coordinator("window-b").unwrap();
        target.lock().unwrap().insert_tab(
            presentation_tab("tab-c", TabRuntimePhase::Ready),
            3,
            true,
        );

        registry
            .move_tab_with_activation("tab-b", "window-a", "window-b", 4, false)
            .unwrap();

        let source = registry.existing("window-a").unwrap();
        let source = source.lock().unwrap();
        assert_eq!(source.selected_tab_id.as_deref(), Some("tab-a"));
        assert!(!source.contains_tab("tab-b"));
        drop(source);
        let target = registry.existing("window-b").unwrap();
        let target = target.lock().unwrap();
        assert_eq!(target.selected_tab_id.as_deref(), Some("tab-c"));
        assert!(target.contains_tab("tab-b"));
        drop(target);
        assert_eq!(
            registry.tab_window("tab-b").unwrap().as_deref(),
            Some("window-b")
        );
    }

    #[test]
    fn presentation_registry_rejects_duplicate_tab_ownership() {
        let registry = PresentationRegistry::default();
        for window_id in ["window-a", "window-b"] {
            registry
                .coordinator(window_id)
                .unwrap()
                .lock()
                .unwrap()
                .insert_tab(
                    presentation_tab("tab-a", TabRuntimePhase::Ready),
                    1,
                    false,
                );
        }

        assert!(
            registry
                .tab_window("tab-a")
                .unwrap_err()
                .contains("more than one")
        );
    }

    #[test]
    fn native_surface_ownership_fences_stale_cross_window_visibility_work() {
        let mut owners = HashMap::new();
        let mut expected_revisions = HashMap::new();
        assert!(native_surface_mutation_is_current(
            &owners,
            &expected_revisions,
            "surface-a",
            "window-a",
        ));

        owners.insert(
            "surface-a".to_owned(),
            SurfacePresentationOwner {
                instance_id: "surface-a:1".to_owned(),
                revision: 1,
                window_id: "window-b".to_owned(),
            },
        );
        expected_revisions.insert("surface-a".to_owned(), 1);
        assert!(!native_surface_mutation_is_current(
            &owners,
            &expected_revisions,
            "surface-a",
            "window-a",
        ));
        assert!(native_surface_mutation_is_current(
            &owners,
            &expected_revisions,
            "surface-a",
            "window-b",
        ));

        owners.insert(
            "surface-a".to_owned(),
            SurfacePresentationOwner {
                instance_id: "surface-a:1".to_owned(),
                revision: 2,
                window_id: "window-a".to_owned(),
            },
        );
        assert!(!native_surface_mutation_is_current(
            &owners,
            &expected_revisions,
            "surface-a",
            "window-a",
        ));
        expected_revisions.insert("surface-a".to_owned(), 2);
        assert!(native_surface_mutation_is_current(
            &owners,
            &expected_revisions,
            "surface-a",
            "window-a",
        ));
    }

    #[test]
    fn only_unisolated_surface_phases_block_role_relaunch() {
        for phase in [
            ManagedSurfacePhase::Live,
            ManagedSurfacePhase::CloseRequested,
            ManagedSurfacePhase::Isolating,
            ManagedSurfacePhase::Provisional,
            ManagedSurfacePhase::Quarantined,
        ] {
            assert!(phase.blocks_role_relaunch(), "{phase:?}");
        }
        for phase in [
            ManagedSurfacePhase::Isolated,
            ManagedSurfacePhase::Released,
            ManagedSurfacePhase::Retired,
        ] {
            assert!(!phase.blocks_role_relaunch(), "{phase:?}");
        }
    }

    #[test]
    fn native_window_actor_bounds_and_coalesces_pending_presentation_work() {
        let mut queue = NativePresentationQueue::default();
        for revision in 1..=20 {
            let replaced = queue.enqueue_latest(revision).unwrap();
            assert_eq!(replaced, (revision > 1).then_some(revision - 1));
        }
        assert_eq!(queue.begin_next(), Some(20));
        assert!(queue.in_flight);
        assert!(queue.pending.is_empty());

        for revision in 21..=40 {
            let _ = queue.enqueue_latest(revision).unwrap();
        }
        assert_eq!(queue.begin_next(), None);
        assert_eq!(queue.back(), Some(&40));
        queue.finish();
        assert_eq!(queue.begin_next(), Some(40));
        queue.finish();
        assert!(!queue.in_flight);
        assert!(queue.pending.is_empty());
    }

    #[test]
    fn native_window_actor_preserves_ordered_window_controls() {
        let mut queue = NativePresentationQueue::default();
        queue.enqueue_ordered(1).unwrap();
        queue.enqueue_ordered(2).unwrap();
        assert_eq!(queue.begin_next(), Some(1));
        assert_eq!(queue.begin_next(), None);
        queue.finish();
        assert_eq!(queue.begin_next(), Some(2));
        queue.finish();
        assert!(queue.is_empty());

        let mut bounded = NativePresentationQueue::default();
        for revision in 0..NATIVE_WINDOW_PRESENTATION_QUEUE_CAPACITY {
            bounded.enqueue_ordered(revision).unwrap();
        }
        assert!(bounded.enqueue_ordered(usize::MAX).is_err());
    }
