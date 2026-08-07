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
fn windows_tab_chrome_reveal_waits_for_visibility_and_painted_content() {
    for signals in [
        [
            WindowsTabChromeRevealSignal::VisibilityRequested,
            WindowsTabChromeRevealSignal::ContentPainted,
        ],
        [
            WindowsTabChromeRevealSignal::ContentPainted,
            WindowsTabChromeRevealSignal::VisibilityRequested,
        ],
    ] {
        let mut reveal = WindowsTabChromeRevealState::new(true);
        assert!(!reveal.observe(signals[0]));
        assert!(reveal.observe(signals[1]));
        assert!(!reveal.observe(signals[1]));
    }

    let mut fallback = WindowsTabChromeRevealState::new(true);
    assert!(!fallback.observe(WindowsTabChromeRevealSignal::FallbackElapsed));
    assert!(fallback.observe(WindowsTabChromeRevealSignal::VisibilityRequested));

    let mut uncloaked = WindowsTabChromeRevealState::new(false);
    assert!(!uncloaked.observe(WindowsTabChromeRevealSignal::VisibilityRequested));
    assert!(!uncloaked.observe(WindowsTabChromeRevealSignal::ContentPainted));
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
