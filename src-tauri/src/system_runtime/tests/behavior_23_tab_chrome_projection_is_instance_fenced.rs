fn tab_chrome_ready(instance: &str) -> RuntimeTabChromeReadyRecord {
    RuntimeTabChromeReadyRecord {
        renderer_instance_id: instance.to_owned(),
        window_id: "window-1".to_owned(),
        window_generation: 7,
        lifecycle_epoch: 3,
    }
}

fn tab_chrome_projection(instance: &str, active_tab_id: Option<&str>) -> RuntimeTabChromeProjectionRecord {
    RuntimeTabChromeProjectionRecord {
        renderer_instance_id: Some(instance.to_owned()),
        window_id: "window-1".to_owned(),
        window_generation: 7,
        lifecycle_epoch: 3,
        projection_revision: 0,
        topology_revision: 19,
        tabs: Vec::new(),
        tab_order: vec!["tab-1".to_owned(), "tab-2".to_owned()],
        active_tab_id: active_tab_id.map(str::to_owned),
        display_id: 11,
        displays: Vec::new(),
        window_name: "Rion Studio".to_owned(),
        window_maximized: false,
        fullscreen: false,
        window_fullscreen: false,
        toolbar_visible: true,
        always_hide_tab_close_button: false,
        always_show_toolbar_in_full_screen: false,
        language: "en".to_owned(),
        theme: "light".to_owned(),
    }
}

fn tab_intent(instance: &str, sequence: u64) -> RuntimeTabIntentRecord {
    RuntimeTabIntentRecord {
        intent_id: format!("intent-{sequence}"),
        adapter_sequence: sequence,
        renderer_instance_id: instance.to_owned(),
        intent_kind: "stop".to_owned(),
        tab_id: "tab-1".to_owned(),
    }
}

#[test]
fn tab_chrome_native_window_queries_run_after_runtime_state_is_released() {
    let state = Mutex::new(41_u32);
    let (query_started_tx, query_started_rx) = std::sync::mpsc::channel();
    let (release_query_tx, release_query_rx) = std::sync::mpsc::channel();

    std::thread::scope(|scope| {
        let state_for_query = &state;
        let query = scope.spawn(move || {
            query_tab_chrome_window_state_unlocked(
                state_for_query,
                |state| Ok(*state),
                |snapshot| {
                    query_started_tx.send(()).unwrap();
                    release_query_rx.recv().unwrap();
                    Ok(snapshot + 1)
                },
            )
            .unwrap()
        });

        query_started_rx.recv().unwrap();
        let runtime_state_available = state.try_lock().is_ok();
        release_query_tx.send(()).unwrap();
        let result = query.join().unwrap();

        assert!(
            runtime_state_available,
            "a blocked native tab-chrome query must not retain the runtime-state mutex"
        );
        assert_eq!(result, 42);
    });
}

#[test]
fn windows_tab_chrome_reveal_waits_for_visibility_and_renderer_readiness() {
    for signals in [
        [
            WindowsTabChromeRevealSignal::VisibilityRequested,
            WindowsTabChromeRevealSignal::RendererReady,
            WindowsTabChromeRevealSignal::ProjectionApplied,
        ],
        [
            WindowsTabChromeRevealSignal::RendererReady,
            WindowsTabChromeRevealSignal::ProjectionApplied,
            WindowsTabChromeRevealSignal::VisibilityRequested,
        ],
        [
            WindowsTabChromeRevealSignal::ProjectionApplied,
            WindowsTabChromeRevealSignal::VisibilityRequested,
            WindowsTabChromeRevealSignal::RendererReady,
        ],
    ] {
        let mut reveal = WindowsTabChromeRevealState::new(true);
        assert!(!reveal.observe(signals[0]).reveal);
        assert!(!reveal.observe(signals[1]).reveal);
        assert!(reveal.observe(signals[2]).reveal);
        assert!(!reveal.observe(signals[2]).reveal);
    }

    let mut uncloaked = WindowsTabChromeRevealState::new(false);
    assert!(
        !uncloaked
            .observe(WindowsTabChromeRevealSignal::VisibilityRequested)
            .reveal
    );
    assert!(
        !uncloaked
            .observe(WindowsTabChromeRevealSignal::RendererReady)
            .reveal
    );
    assert!(
        !uncloaked
            .observe(WindowsTabChromeRevealSignal::ProjectionApplied)
            .reveal
    );
}

#[test]
fn empty_windows_tab_chrome_projection_acknowledgement_allows_reveal() {
    let coordinator = TabChromeProjectionCoordinator::default();
    coordinator
        .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
        .unwrap();
    let mut requested = tab_chrome_projection("renderer-1", None);
    requested.tab_order.clear();
    let projection = coordinator.resolve_projection(requested).unwrap();
    assert!(coordinator.claim_delivery(&projection));
    coordinator
        .acknowledge(
            "tab-strip-1",
            RuntimeTabChromeAcknowledgementRecord {
                renderer_instance_id: "renderer-1".to_owned(),
                projection_revision: projection.projection_revision,
                topology_revision: projection.topology_revision,
                observed_tab_order: Vec::new(),
                observed_active_tab_id: None,
                status: "applied".to_owned(),
            },
        )
        .unwrap();

    let outcome = coordinator.wait(
        "window-1",
        "renderer-1",
        projection.projection_revision,
        Duration::from_millis(1),
    );
    assert_eq!(outcome, TabChromeProjectionWaitOutcome::Applied);
    let reveal_signal = windows_tab_chrome_reveal_signal_for_projection(outcome)
        .expect("an applied empty projection must allow the Windows host to reveal");

    let mut reveal = WindowsTabChromeRevealState::new(true);
    assert!(!reveal.request_presentation(None).reveal);
    assert!(
        !reveal
            .observe(WindowsTabChromeRevealSignal::RendererReady)
            .reveal
    );
    assert!(reveal.observe(reveal_signal).reveal);
}

#[test]
fn only_applied_tab_chrome_projections_allow_windows_reveal() {
    assert_eq!(
        windows_tab_chrome_reveal_signal_for_projection(
            TabChromeProjectionWaitOutcome::Applied
        ),
        Some(WindowsTabChromeRevealSignal::ProjectionApplied)
    );
    for outcome in [
        TabChromeProjectionWaitOutcome::Failed,
        TabChromeProjectionWaitOutcome::Superseded,
        TabChromeProjectionWaitOutcome::Timeout,
    ] {
        assert_eq!(
            windows_tab_chrome_reveal_signal_for_projection(outcome),
            None,
            "{outcome:?}"
        );
    }
}

#[test]
fn windows_tab_chrome_reveal_defers_the_latest_focus_intent_until_uncloaked() {
    let mut reveal = WindowsTabChromeRevealState::new(true);
    let first = reveal.request_presentation(Some(41));
    assert!(first.defer_focus);
    assert!(!first.reveal);
    let replacement = reveal.request_presentation(Some(42));
    assert!(replacement.defer_focus);
    assert!(!replacement.reveal);
    assert!(
        !reveal
            .observe(WindowsTabChromeRevealSignal::ProjectionApplied)
            .reveal
    );
    let ready = reveal.observe(WindowsTabChromeRevealSignal::RendererReady);
    assert!(ready.reveal);
    assert_eq!(ready.focus_sequence, Some(42));
}

#[test]
fn windows_host_reveal_does_not_wait_for_role_geometry() {
    let mut reveal = WindowsTabChromeRevealState::new(true);
    assert!(
        !reveal
            .observe(WindowsTabChromeRevealSignal::ProjectionApplied)
            .reveal
    );
    let presentation = reveal.request_presentation(Some(17));
    assert!(presentation.defer_focus);
    assert!(!presentation.reveal);
    let renderer_ready = reveal.observe(WindowsTabChromeRevealSignal::RendererReady);
    assert!(renderer_ready.reveal);
    assert_eq!(renderer_ready.focus_sequence, Some(17));

    let mut already_visible = WindowsTabChromeRevealState::new(false);
    let direct = already_visible.request_presentation(Some(18));
    assert!(!direct.defer_focus);
    assert!(!direct.reveal);
    assert_eq!(direct.focus_sequence, None);
}

#[test]
fn semantic_projection_revision_survives_a_renderer_reload() {
    let platform = "windows";
    {
        let coordinator = TabChromeProjectionCoordinator::default();
        coordinator
            .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
            .unwrap();
        assert_eq!(
            coordinator.renderer("window-1").map(|renderer| renderer.renderer_instance_id),
            Some("renderer-1".to_owned()),
            "{platform}"
        );
        let first = coordinator
            .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
            .unwrap();
        coordinator
            .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-2"))
            .unwrap();
        let replay = coordinator
            .resolve_projection(tab_chrome_projection("renderer-2", Some("tab-1")))
            .unwrap();
        let changed = coordinator
            .resolve_projection(tab_chrome_projection("renderer-2", Some("tab-2")))
            .unwrap();

        assert_eq!(first.projection_revision, replay.projection_revision, "{platform}");
        assert!(changed.projection_revision > replay.projection_revision, "{platform}");
    }
}

#[test]
fn tab_intent_is_renderer_instance_and_adapter_sequence_fenced() {
    let coordinator = TabChromeProjectionCoordinator::default();
    coordinator
        .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
        .unwrap();

    assert!(matches!(
        coordinator.admit_intent("tab-strip-1", &tab_intent("renderer-1", 1)),
        Ok(RuntimeTabIntentAdmission::Accepted {
            window_generation: 7,
            ref window_id,
        }) if window_id == "window-1"
    ));
    assert!(matches!(
        coordinator.admit_intent("tab-strip-1", &tab_intent("renderer-1", 1)),
        Ok(RuntimeTabIntentAdmission::Superseded {
            failure_code: "TAB_INTENT_SEQUENCE_SUPERSEDED",
            window_generation: 7,
            ref window_id,
        }) if window_id == "window-1"
    ));
    assert!(matches!(
        coordinator.admit_intent("tab-strip-1", &tab_intent("renderer-stale", 2)),
        Ok(RuntimeTabIntentAdmission::Superseded {
            failure_code: "TAB_INTENT_ADAPTER_STALE",
            window_generation: 7,
            ref window_id,
        }) if window_id == "window-1"
    ));
}

#[test]
fn failed_windows_reveal_restores_the_cloak_and_exact_focus_sequence() {
    let mut reveal = WindowsTabChromeRevealState::new(false);
    reveal.restore_failed_reveal(Some(73));
    assert!(reveal.cloaked);
    assert_eq!(reveal.pending_focus_sequence, Some(73));
}

#[test]
fn initial_lifecycle_epoch_does_not_invalidate_the_registered_tab_adapter() {
    // Lifecycle epoch zero is the valid initial application epoch. Adapter
    // authority comes from the registered host generation and WebView identity,
    // not from treating zero as an uninitialized sentinel.
    assert!(tab_intent_source_identity_is_current(
        7,
        "tab-strip-1",
        7,
        "tab-strip-1"
    ));
    assert!(!tab_intent_source_identity_is_current(
        8,
        "tab-strip-1",
        7,
        "tab-strip-1"
    ));
    assert!(!tab_intent_source_identity_is_current(
        7,
        "tab-strip-replaced",
        7,
        "tab-strip-1"
    ));
}

#[test]
fn window_chrome_identity_and_maximize_state_advance_the_projection_revision() {
    let coordinator = TabChromeProjectionCoordinator::default();
    coordinator
        .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
        .unwrap();
    let initial = coordinator
        .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
        .unwrap();
    let mut renamed = tab_chrome_projection("renderer-1", Some("tab-1"));
    renamed.window_name = "Raid Window".to_owned();
    let renamed = coordinator.resolve_projection(renamed).unwrap();
    let mut maximized = tab_chrome_projection("renderer-1", Some("tab-1"));
    maximized.window_name = "Raid Window".to_owned();
    maximized.window_maximized = true;
    let maximized = coordinator.resolve_projection(maximized).unwrap();

    assert!(renamed.projection_revision > initial.projection_revision);
    assert!(maximized.projection_revision > renamed.projection_revision);
}

#[test]
fn renderer_instance_and_projection_readback_are_exactly_fenced() {
    let platform = "windows";
    {
        let coordinator = TabChromeProjectionCoordinator::default();
        coordinator
            .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
            .unwrap();
        let projection = coordinator
            .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
            .unwrap();
        assert!(coordinator.claim_delivery(&projection), "{platform}");
        assert_eq!(
            coordinator.acknowledge(
                "tab-strip-1",
                RuntimeTabChromeAcknowledgementRecord {
                    renderer_instance_id: "renderer-1".to_owned(),
                    projection_revision: projection.projection_revision,
                    topology_revision: projection.topology_revision.saturating_add(1),
                    observed_tab_order: projection.tab_order.clone(),
                    observed_active_tab_id: projection.active_tab_id.clone(),
                    status: "applied".to_owned(),
                },
            ),
            Err("TAB_CHROME_PROJECTION_STALE"),
            "{platform}"
        );
        assert_eq!(
            coordinator.acknowledge(
                "tab-strip-1",
                RuntimeTabChromeAcknowledgementRecord {
                    renderer_instance_id: "renderer-1".to_owned(),
                    projection_revision: projection.projection_revision,
                    topology_revision: projection.topology_revision,
                    observed_tab_order: vec!["tab-2".to_owned(), "tab-1".to_owned()],
                    observed_active_tab_id: Some("tab-1".to_owned()),
                    status: "applied".to_owned(),
                },
            ),
            Err("TAB_CHROME_PROJECTION_READBACK_MISMATCH"),
            "{platform}"
        );
        coordinator
            .acknowledge(
                "tab-strip-1",
                RuntimeTabChromeAcknowledgementRecord {
                    renderer_instance_id: "renderer-1".to_owned(),
                    projection_revision: projection.projection_revision,
                    topology_revision: projection.topology_revision,
                    observed_tab_order: projection.tab_order.clone(),
                    observed_active_tab_id: projection.active_tab_id.clone(),
                    status: "applied".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(
            coordinator.wait(
                "window-1",
                "renderer-1",
                projection.projection_revision,
                Duration::from_millis(1),
            ),
            TabChromeProjectionWaitOutcome::Applied,
            "{platform}"
        );
        coordinator.finish(
            "window-1",
            "renderer-1",
            projection.projection_revision,
            NativeOperationStatus::Applied,
        );
        assert_eq!(
            coordinator.last_status("window-1", projection.projection_revision),
            Some(NativeOperationStatus::Applied),
            "{platform}"
        );
        assert_eq!(
            coordinator.wait_for_projection_status(
                "window-1",
                &projection.tab_order,
                projection.active_tab_id.as_deref(),
                Duration::from_millis(1),
            ),
            Some(NativeOperationStatus::Applied),
            "{platform}"
        );
    }
}

#[test]
fn superseded_and_failed_projection_acknowledgements_allow_observed_intent_mismatch() {
    let platform = "windows";
    for (status, expected) in [
        ("superseded", TabChromeProjectionWaitOutcome::Superseded),
        ("failed", TabChromeProjectionWaitOutcome::Failed),
    ] {
        let coordinator = TabChromeProjectionCoordinator::default();
        coordinator
            .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
            .unwrap();
        let projection = coordinator
            .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
            .unwrap();
        assert!(coordinator.claim_delivery(&projection), "{platform}:{status}");
        coordinator
            .acknowledge(
                "tab-strip-1",
                RuntimeTabChromeAcknowledgementRecord {
                    renderer_instance_id: "renderer-1".to_owned(),
                    projection_revision: projection.projection_revision,
                    topology_revision: projection.topology_revision,
                    observed_tab_order: vec!["tab-2".to_owned(), "tab-1".to_owned()],
                    observed_active_tab_id: Some("tab-2".to_owned()),
                    status: status.to_owned(),
                },
            )
            .unwrap();
        assert_eq!(
            coordinator.wait(
                "window-1",
                "renderer-1",
                projection.projection_revision,
                Duration::from_millis(1),
            ),
            expected,
            "{platform}:{status}"
        );
    }
}

#[test]
fn projection_acknowledgement_rejects_a_stale_revision() {
    let coordinator = TabChromeProjectionCoordinator::default();
    coordinator
        .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
        .unwrap();
    let projection = coordinator
        .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
        .unwrap();
    assert!(coordinator.claim_delivery(&projection));
    assert_eq!(
        coordinator.acknowledge(
            "tab-strip-1",
            RuntimeTabChromeAcknowledgementRecord {
                renderer_instance_id: "renderer-1".to_owned(),
                projection_revision: projection.projection_revision.saturating_add(1),
                topology_revision: projection.topology_revision,
                observed_tab_order: vec!["tab-2".to_owned(), "tab-1".to_owned()],
                observed_active_tab_id: Some("tab-2".to_owned()),
                status: "superseded".to_owned(),
            },
        ),
        Err("TAB_CHROME_PROJECTION_STALE")
    );
}

#[test]
#[cfg(windows)]
fn superseded_drag_terminal_remains_a_superseded_native_receipt() {
    assert_eq!(
        RuntimeTabDragTerminalStatus::Superseded.native_status(),
        NativeOperationStatus::Superseded
    );
}

#[test]
fn a_new_renderer_supersedes_the_old_pending_projection() {
    let platform = "windows";
    {
        let coordinator = TabChromeProjectionCoordinator::default();
        coordinator
            .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
            .unwrap();
        let projection = coordinator
            .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
            .unwrap();
        assert!(coordinator.claim_delivery(&projection), "{platform}");
        coordinator
            .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-2"))
            .unwrap();
        assert_eq!(
            coordinator.wait(
                "window-1",
                "renderer-1",
                projection.projection_revision,
                Duration::from_millis(1),
            ),
            TabChromeProjectionWaitOutcome::Superseded,
            "{platform}"
        );
        assert_eq!(
            coordinator.acknowledge(
                "tab-strip-1",
                RuntimeTabChromeAcknowledgementRecord {
                    renderer_instance_id: "renderer-1".to_owned(),
                    projection_revision: projection.projection_revision,
                    topology_revision: projection.topology_revision,
                    observed_tab_order: projection.tab_order,
                    observed_active_tab_id: projection.active_tab_id,
                    status: "applied".to_owned(),
                },
            ),
            Err("TAB_CHROME_RENDERER_INSTANCE_STALE"),
            "{platform}"
        );
    }
}

#[test]
fn retiring_the_exact_host_generation_supersedes_its_pending_projection() {
    let coordinator = TabChromeProjectionCoordinator::default();
    coordinator
        .register_renderer("tab-strip-1", &tab_chrome_ready("renderer-1"))
        .unwrap();
    let projection = coordinator
        .resolve_projection(tab_chrome_projection("renderer-1", Some("tab-1")))
        .unwrap();
    assert!(coordinator.claim_delivery(&projection));

    coordinator.retire_renderer("window-1", 6);
    assert_eq!(
        coordinator.renderer("window-1").map(|renderer| renderer.window_generation),
        Some(7)
    );
    coordinator.retire_renderer("window-1", 7);
    assert_eq!(
        coordinator.wait(
            "window-1",
            "renderer-1",
            projection.projection_revision,
            Duration::from_millis(1),
        ),
        TabChromeProjectionWaitOutcome::Superseded
    );
}

#[cfg(windows)]
#[test]
fn retiring_the_exact_host_generation_supersedes_legacy_tab_chrome_ack_waiters() {
    let registry = PresentationRegistry::default();
    registry
        .begin_tab_chrome_acknowledgement("tab-strip-1", 7)
        .unwrap();
    registry.retire_tab_chrome_acknowledgements("tab-strip-1", 6);
    assert_eq!(
        registry.wait_for_tab_chrome_acknowledgement(
            "tab-strip-1",
            7,
            19,
            Duration::from_millis(1),
        ),
        WindowsTabChromeAcknowledgementWaitOutcome::Timeout
    );

    registry.retire_tab_chrome_acknowledgements("tab-strip-1", 7);
    assert_eq!(
        registry.wait_for_tab_chrome_acknowledgement(
            "tab-strip-1",
            7,
            19,
            Duration::from_millis(1),
        ),
        WindowsTabChromeAcknowledgementWaitOutcome::Superseded
    );

    registry
        .begin_tab_chrome_acknowledgement("tab-strip-1", 8)
        .unwrap();
    assert!(!registry.acknowledge_tab_chrome("tab-strip-1", 7, 20));
    assert!(registry.acknowledge_tab_chrome("tab-strip-1", 8, 20));
    assert_eq!(
        registry.wait_for_tab_chrome_acknowledgement(
            "tab-strip-1",
            8,
            20,
            Duration::from_millis(1),
        ),
        WindowsTabChromeAcknowledgementWaitOutcome::Applied
    );
}
#[test]
fn an_idempotent_native_move_still_reconciles_the_visible_target_host() {
    let plan = provisional_move_follower_plan(true, true);

    assert!(!plan.reparent_surfaces);
    assert!(plan.reconcile_target_presentation);
    assert_eq!(
        provisional_move_follower_plan(true, false),
        ProvisionalMoveFollowerPlan {
            reconcile_target_presentation: false,
            reparent_surfaces: false,
        }
    );
}

#[test]
fn a_dormant_native_tab_reservation_is_not_a_stable_launcher_destination() {
    assert!(!launcher_tab_is_materialized_stable(true, false, true));
    assert!(!launcher_tab_is_materialized_stable(true, true, false));
    assert!(!launcher_tab_is_materialized_stable(false, false, false));
    assert!(launcher_tab_is_materialized_stable(true, false, false));
}
#[test]
fn surface_unbind_releases_projection_before_entering_the_window_actor() {
    let projection = Mutex::new(false);
    assert!(mutate_projection_before_actor(&projection, |state| {
        *state = true;
        true
    }));
    let state = projection
        .try_lock()
        .expect("projection lock must be released before entering the actor");
    assert!(*state);
}
