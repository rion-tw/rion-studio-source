#[test]
fn geometry_receipts_keep_readback_and_submission_scopes_distinct_on_both_platforms() {
    for platform in ["macos", "windows"] {
        let acknowledged = NativeOperationReceipt::applied(
            NativeOperationContext::new_for_platform(
                NativeOperationSubsystem::Geometry,
                "contract-test",
                Duration::from_secs(1),
                platform,
            ),
            "geometryPositionAcknowledged",
        );
        assert_eq!(acknowledged.completion_scope(), SystemRuntimeOperationCompletionScope::NativeAcknowledgement);

        for stage in ["geometryLayoutSubmitted", "geometryModeSubmitted"] {
            let submitted = NativeOperationReceipt::applied(
                NativeOperationContext::new_for_platform(
                    NativeOperationSubsystem::Geometry,
                    "contract-test",
                    Duration::from_secs(1),
                    platform,
                )
                .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeSubmission),
                stage,
            );
            assert_eq!(submitted.completion_scope(), SystemRuntimeOperationCompletionScope::NativeSubmission);
        }
    }
}

#[test]
fn geometry_transaction_status_preserves_compensation_truth() {
    let cases = [
        (
            GeometryTransactionClassification {
                applied: true,
                native_truth_matches: true,
                rollback_attempted: false,
                rollback_error_count: 0,
                superseded: false,
            },
            NativeOperationStatus::Applied,
        ),
        (
            GeometryTransactionClassification {
                applied: true,
                native_truth_matches: false,
                rollback_attempted: false,
                rollback_error_count: 0,
                superseded: false,
            },
            NativeOperationStatus::Degraded,
        ),
        (
            GeometryTransactionClassification {
                applied: false,
                native_truth_matches: false,
                rollback_attempted: true,
                rollback_error_count: 0,
                superseded: false,
            },
            NativeOperationStatus::Failed,
        ),
        (
            GeometryTransactionClassification {
                applied: false,
                native_truth_matches: false,
                rollback_attempted: true,
                rollback_error_count: 2,
                superseded: false,
            },
            NativeOperationStatus::Indeterminate,
        ),
        (
            GeometryTransactionClassification {
                applied: false,
                native_truth_matches: false,
                rollback_attempted: false,
                rollback_error_count: 0,
                superseded: true,
            },
            NativeOperationStatus::Superseded,
        ),
    ];
    for _platform in ["macos", "windows"] {
        for (classification, expected) in cases {
            assert_eq!(geometry_transaction_status(classification), expected);
        }
    }
}

#[test]
fn latest_geometry_revision_supersedes_queued_window_work() {
    for _platform in ["macos", "windows"] {
        let registry = NativeWindowMutationRegistry::default();
        let (first, first_lane) = registry.issue("window-1").unwrap();
        let (latest, latest_lane) = registry.issue("window-1").unwrap();
        assert!(Arc::ptr_eq(&first_lane, &latest_lane));
        assert!(!registry.is_latest("window-1", first));
        assert!(registry.is_latest("window-1", latest));
        registry.forget("window-1");
        assert!(!registry.is_latest("window-1", latest));
    }
}

#[test]
fn shutdown_drain_observes_creation_and_window_mutation_lanes() {
    let creation = NativeCreationGate::new(1);
    let creation_permit = creation.acquire().unwrap();
    assert!(!creation.wait_for_idle(Instant::now()));
    drop(creation_permit);
    assert!(creation.wait_for_idle(Instant::now() + Duration::from_millis(10)));

    let mutations = NativeWindowMutationRegistry::default();
    let (_, lane) = mutations.issue("window-1").unwrap();
    let mutation_guard = lane.lock().unwrap();
    assert!(!mutations.wait_for_idle(Instant::now()));
    drop(mutation_guard);
    assert!(mutations.wait_for_idle(Instant::now() + Duration::from_millis(10)));
}

#[test]
fn reload_aggregate_reports_partial_and_unknown_terminal_states_honestly() {
    for _platform in ["macos", "windows"] {
        assert_eq!(
            aggregate_reload_status(&[NativeOperationStatus::Applied; 2]),
            NativeOperationStatus::Applied
        );
        assert_eq!(
            aggregate_reload_status(&[NativeOperationStatus::Superseded; 2]),
            NativeOperationStatus::Superseded
        );
        assert_eq!(
            aggregate_reload_status(&[NativeOperationStatus::Failed; 2]),
            NativeOperationStatus::Failed
        );
        assert_eq!(
            aggregate_reload_status(&[
                NativeOperationStatus::Applied,
                NativeOperationStatus::Failed,
            ]),
            NativeOperationStatus::Degraded
        );
        assert_eq!(
            aggregate_reload_status(&[
                NativeOperationStatus::Applied,
                NativeOperationStatus::Indeterminate,
            ]),
            NativeOperationStatus::Indeterminate
        );
    }
}

#[test]
fn shutdown_state_wire_names_are_stable() {
    let states = [
        (0, RuntimeShutdownState::Accepting, "accepting"),
        (1, RuntimeShutdownState::Draining, "draining"),
        (2, RuntimeShutdownState::Closed, "closed"),
        (3, RuntimeShutdownState::Indeterminate, "indeterminate"),
    ];
    for _platform in ["macos", "windows"] {
        for (raw, expected, wire_name) in states {
            assert_eq!(RuntimeShutdownState::from_raw(raw), expected);
            assert_eq!(expected.as_str(), wire_name);
        }
    }
}

#[test]
fn overlapping_controlled_navigations_release_only_their_own_scope() {
    let mut scopes = HashMap::new();
    begin_controlled_navigation_scope(&mut scopes, "role-webview");
    begin_controlled_navigation_scope(&mut scopes, "role-webview");

    finish_controlled_navigation_scope(&mut scopes, "role-webview");
    assert_eq!(scopes.get("role-webview"), Some(&1));

    finish_controlled_navigation_scope(&mut scopes, "role-webview");
    assert!(!scopes.contains_key("role-webview"));
}

#[test]
fn native_resize_retry_is_bounded_and_stops_during_shutdown() {
    for _platform in ["macos", "windows"] {
        assert!(native_resize_should_retry(
            true,
            RuntimeShutdownState::Accepting,
            PLATFORM_CALLBACK_TIMEOUT - Duration::from_millis(1),
        ));
        assert!(!native_resize_should_retry(
            true,
            RuntimeShutdownState::Accepting,
            PLATFORM_CALLBACK_TIMEOUT,
        ));
        assert!(!native_resize_should_retry(
            true,
            RuntimeShutdownState::Draining,
            Duration::ZERO,
        ));
    }
}

#[test]
fn resize_bursts_keep_only_the_latest_ui_thread_snapshot() {
    let snapshot = |sequence, width| RuntimeWindowResizeSnapshot {
        content_metrics: logical_resize_metrics(width, 1_440, 2.0),
        fullscreen: false,
        maximized: false,
        minimized: false,
        physical_height: 1_440,
        physical_width: width,
        received_at: Instant::now(),
        scale_factor: 2.0,
        sequence,
    };
    let first = coalesce_pending_resize(None, snapshot(1, 2_560));
    let second = coalesce_pending_resize(Some(first), snapshot(2, 2_800));
    let latest = coalesce_pending_resize(Some(second), snapshot(3, 3_000));
    assert_eq!(latest.snapshot.sequence, 3);
    assert_eq!(latest.snapshot.physical_width, 3_000);
    assert_eq!(latest.received_count, 3);
    assert_eq!(latest.coalesced_count, 2);
}

#[test]
fn live_resize_projects_the_active_tab_then_settles_every_tab() {
    assert_eq!(
        resize_projection_tab_ids(Some("active".to_owned()), None),
        ["active"]
    );
    assert_eq!(
        resize_projection_tab_ids(
            Some("active".to_owned()),
            Some(vec!["active".to_owned(), "hidden".to_owned()]),
        ),
        ["active", "hidden"]
    );
}

#[test]
fn resize_metrics_preserve_windows_two_hundred_percent_scaling() {
    let metrics = logical_resize_metrics(3_756, 2_510, 2.0);
    assert_eq!(metrics.width, 1_878.0);
    assert_eq!(metrics.height, 1_255.0);
    let content = resize_metrics_with_tab_strip(metrics, 44.0);
    assert_eq!(content.top_inset, 44.0);
    assert_eq!(content.height, 1_211.0);
}

#[test]
fn unchanged_zoom_is_not_resubmitted_during_resize() {
    assert!(!zoom_factor_changed(1.0, 1.000_01));
    assert!(zoom_factor_changed(1.0, 1.01));
}

#[test]
fn disconnected_webview_layout_is_recoverable_not_global_geometry_corruption() {
    for message in [
        "runtime error: failed to receive message from webview",
        "WebView was closed",
        "native channel closed",
        "broken pipe",
    ] {
        assert!(native_surface_channel_is_unavailable(message));
    }
    assert!(!native_surface_channel_is_unavailable(
        "window bounds were rejected"
    ));
}
