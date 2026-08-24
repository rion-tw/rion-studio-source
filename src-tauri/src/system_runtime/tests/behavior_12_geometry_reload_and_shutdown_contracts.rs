#[cfg(windows)]
use std::cell::RefCell;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::SIZE_MINIMIZED;

#[cfg(feature = "desktop-e2e")]
#[test]
fn desktop_e2e_visible_chrome_drag_rejects_a_stationary_pointer() {
    let stationary = DesktopE2eWindowControlRequest::DragVisibleChrome {
        delta_x: 0,
        delta_y: 0,
    };
    assert_eq!(
        stationary.validate().unwrap_err(),
        "Desktop E2E visible chrome drag must move the pointer."
    );
    assert!(DesktopE2eWindowControlRequest::DragVisibleChrome {
        delta_x: 56,
        delta_y: 36,
    }
    .validate()
    .is_ok());
}

#[cfg(windows)]
#[test]
fn windows_live_resize_contract_is_reachable_from_system_runtime_parent() {
    let mut counters = WindowsLiveResizeCounters::default();
    counters.record_native_resize_applied();
    counters.record_parent_position(2, 1);

    let bounds = WindowsLiveResizeBounds {
        height: 720,
        width: 1_280,
        x: 0,
        y: 0,
    };
    let receipt = WindowsGeometryReceipt {
        key: WindowsGeometryKey {
            dpi: 144,
            frame_revision: 7,
            generation: 3,
            height: bounds.height as u32,
            plan_revision: 5,
            presentation: WindowsGeometryPresentation::Restored,
            width: bounds.width as u32,
        },
        status: WindowsGeometryStatus::Applied,
        terminal: true,
    };

    assert_eq!(counters.applied, 1);
    assert_eq!(counters.parent_position_applied, 2);
    assert_eq!(counters.parent_position_errors, 1);
    assert_eq!(receipt.key.generation, 3);
    assert_eq!(receipt.key.width, 1_280);
    assert!(receipt.terminal);
}

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

#[tokio::test]
async fn input_readiness_revision_wakes_ready_before_and_after_subscribe() {
    let registry = InputReadinessRegistry::new();
    registry.notify();
    let before = registry.subscribe();
    assert_eq!(*before.borrow(), 1);

    let mut after = registry.subscribe();
    registry.notify();
    after.changed().await.unwrap();
    assert_eq!(*after.borrow_and_update(), 2);
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
fn windows_resize_submission_returns_without_native_acknowledgement() {
    let (submission_tx, submission_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let native = std::thread::spawn(move || {
        let submitted = submission_rx.recv().unwrap();
        release_rx.recv().unwrap();
        submitted
    });

    let failures = collect_native_layout_submission_failures(
        &[42_u32],
        |submission| submission.to_string(),
        |submission| {
            submission_tx.send(*submission).unwrap();
            Ok(())
        },
    );

    assert!(failures.is_empty());
    release_tx.send(()).unwrap();
    assert_eq!(native.join().unwrap(), 42);
}

#[test]
fn resize_metrics_preserve_windows_two_hundred_percent_scaling() {
    let metrics = logical_resize_metrics(3_756, 2_510, 2.0);
    assert_eq!(metrics.width, 1_878.0);
    assert_eq!(metrics.height, 1_255.0);
    let adjusted = resize_metrics_with_tab_strip(metrics, 44.0);
    assert_eq!(adjusted.top_inset, 44.0);
    assert_eq!(adjusted.height, 1_211.0);
    assert_eq!(resize_snapshot_tab_strip_height(adjusted), 44.0);
}

#[cfg(windows)]
fn two_column_live_resize_plan() -> WindowsLiveResizePlan {
    WindowsLiveResizePlan {
        dividers: vec![WindowsLiveResizeDividerPlan {
            axis: "vertical".to_owned(),
            index: 0,
            label: "divider".to_owned(),
        }],
        gap: 4,
        generation: 7,
        revision: 11,
        roles: vec![
            WindowsLiveResizeRolePlan {
                chrome_label: None,
                fullscreen: false,
                input: LayoutRoleInput {
                    role_id: "left".to_owned(),
                    rect: LayoutRect {
                        x: 0.0,
                        y: 0.0,
                        width: 0.5,
                        height: 1.0,
                    },
                },
                label: "left".to_owned(),
            },
            WindowsLiveResizeRolePlan {
                chrome_label: None,
                fullscreen: false,
                input: LayoutRoleInput {
                    role_id: "right".to_owned(),
                    rect: LayoutRect {
                        x: 0.5,
                        y: 0.0,
                        width: 0.5,
                        height: 1.0,
                    },
                },
                label: "right".to_owned(),
            },
        ],
        tab_strip_height: 44.0,
        tab_strip_label: "tabs".to_owned(),
    }
}

#[cfg(windows)]
#[test]
fn empty_host_live_resize_plan_materializes_the_tab_strip() {
    let plan = windows_empty_host_live_resize_plan(7, 11, 44.0, "tabs");
    let bounds = windows_live_resize_resolve_bounds(&plan, 1_440, 1_080, 2.0).unwrap();

    assert!(plan.roles.is_empty());
    assert!(plan.dividers.is_empty());
    assert_eq!(plan.generation, 7);
    assert_eq!(plan.revision, 11);
    assert_eq!(plan.tab_strip_label, "tabs");
    assert_eq!(
        bounds,
        vec![WindowsLiveResizeBounds {
            height: 88,
            width: 1_440,
            x: 0,
            y: 0,
        }]
    );
}

#[cfg(all(windows, feature = "desktop-e2e"))]
#[test]
fn desktop_e2e_client_extent_uses_the_actual_custom_chrome_frame() {
    assert_eq!(
        desktop_e2e_outer_extent_for_client(600, 2.0, 1_095, 1_080, 2.0),
        1_215
    );
    assert_eq!(
        desktop_e2e_outer_extent_for_client(600, 1.25, 1_095, 1_080, 2.0),
        759
    );
}

#[cfg(windows)]
#[test]
fn windows_live_resize_resolves_complete_physical_edges_at_common_dpi() {
    for scale in [1.0, 1.25, 1.5, 2.0] {
        let physical_width = (1_601.0_f64 * scale).round() as u32;
        let physical_height = (1_001.0_f64 * scale).round() as u32;
        let bounds = windows_live_resize_resolve_bounds(
            &two_column_live_resize_plan(),
            physical_width,
            physical_height,
            scale,
        )
        .unwrap();
        let [tab_strip, left, right, divider] = bounds.as_slice() else {
            panic!("expected tab strip, two roles, and one divider");
        };
        assert_eq!(tab_strip.x, 0);
        assert_eq!(tab_strip.width, physical_width as i32);
        assert_eq!(tab_strip.y + tab_strip.height, left.y);
        assert_eq!(left.y, right.y);
        assert_eq!(left.height, right.height);
        assert_eq!(right.x + right.width, physical_width as i32);
        assert_eq!(right.y + right.height, physical_height as i32);
        let expected_gap = (4.0_f64 * scale).round() as i32;
        assert_eq!(right.x - (left.x + left.width), expected_gap);
        assert!(divider.x <= left.x + left.width);
        assert!(divider.x + divider.width >= right.x);
    }
}

#[cfg(windows)]
#[test]
fn windows_single_role_fills_the_root_client_frame_after_tab_strip() {
    let plan = WindowsLiveResizePlan {
        dividers: Vec::new(),
        gap: 0,
        generation: 7,
        revision: 11,
        roles: vec![WindowsLiveResizeRolePlan {
            chrome_label: None,
            fullscreen: false,
            input: LayoutRoleInput {
                role_id: "role".to_owned(),
                rect: LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            },
            label: "role".to_owned(),
        }],
        tab_strip_height: 44.0,
        tab_strip_label: "tabs".to_owned(),
    };
    for scale in [1.0, 1.25, 1.5, 2.0] {
        let physical_width = (1_601.0_f64 * scale).round() as u32;
        let physical_height = (1_001.0_f64 * scale).round() as u32;
        let bounds = windows_live_resize_resolve_bounds(
            &plan,
            physical_width,
            physical_height,
            scale,
        )
        .unwrap();
        let [tab_strip, role] = bounds.as_slice() else {
            panic!("expected tab strip and one role surface");
        };
        assert_eq!(tab_strip.x, 0);
        assert_eq!(tab_strip.width, physical_width as i32);
        assert_eq!(role.x, 0);
        assert_eq!(role.y, tab_strip.height);
        assert_eq!(role.x + role.width, physical_width as i32);
        assert_eq!(role.y + role.height, physical_height as i32);
    }
}

#[cfg(windows)]
#[test]
fn windows_client_frame_uses_its_own_dpi_for_logical_size() {
    for (dpi, expected_width, expected_height) in [
        (96, 1_200.0, 800.0),
        (120, 960.0, 640.0),
        (144, 800.0, 533.333_333_333_333_4),
        (192, 600.0, 400.0),
    ] {
        let logical = windows_live_resize_logical_client_size(WindowsClientFrame {
            dpi,
            height: 800,
            width: 1_200,
        });
        assert!((logical.0 - expected_width).abs() < f64::EPSILON);
        assert!((logical.1 - expected_height).abs() < f64::EPSILON);
    }
}

#[cfg(windows)]
#[test]
fn windows_live_resize_plan_fences_generation_and_revision() {
    assert!(windows_live_resize_plan_is_current(7, Some(10), 7, 11));
    assert!(windows_live_resize_plan_is_current(7, Some(11), 7, 11));
    assert!(!windows_live_resize_plan_is_current(7, Some(12), 7, 11));
    assert!(!windows_live_resize_plan_is_current(8, None, 7, 99));
}

#[cfg(windows)]
#[test]
fn windows_geometry_receipts_are_fenced_by_host_plan_and_epoch() {
    let submission = WindowsGeometrySubmission {
        bounds: Vec::new(),
        key: WindowsGeometryKey {
            dpi: 144,
            frame_revision: 8,
            generation: 7,
            height: 720,
            plan_revision: 11,
            presentation: WindowsGeometryPresentation::Restored,
            width: 1_280,
        },
        last_batch_failed: false,
        last_surface_bounds: HashMap::new(),
        plan_epoch: 3,
        surfaces: Vec::new(),
        terminal: true,
    };
    assert!(windows_geometry_submission_is_current(7, 3, Some(11), &submission));
    assert!(!windows_geometry_submission_is_current(8, 3, Some(11), &submission));
    assert!(!windows_geometry_submission_is_current(7, 4, Some(11), &submission));
    assert!(!windows_geometry_submission_is_current(7, 3, Some(12), &submission));
}

#[cfg(windows)]
#[test]
fn windows_geometry_key_fences_size_dpi_and_presentation() {
    let key = WindowsGeometryKey {
        dpi: 144,
        frame_revision: 8,
        generation: 7,
        height: 720,
        plan_revision: 11,
        presentation: WindowsGeometryPresentation::Restored,
        width: 1_280,
    };
    let mut changed = key;
    changed.dpi = 192;
    assert_ne!(key, changed);
    changed = key;
    changed.width += 1;
    assert_ne!(key, changed);
    changed = key;
    changed.presentation = WindowsGeometryPresentation::Maximized;
    assert_ne!(key, changed);
}

#[cfg(windows)]
#[test]
fn equivalent_live_resize_plan_preserves_the_native_frame_epoch() {
    let current = two_column_live_resize_plan();
    let mut next_revision = current.clone();
    next_revision.revision += 1;
    assert!(windows_live_resize_plans_match(&current, &next_revision));

    next_revision.roles[0].input.rect.width = 0.6;
    assert!(!windows_live_resize_plans_match(&current, &next_revision));

    let mut next_generation = current.clone();
    next_generation.generation += 1;
    assert!(!windows_live_resize_plans_match(&current, &next_generation));
}

#[cfg(windows)]
#[test]
fn live_resize_frame_matching_uses_client_size_and_plan_epoch() {
    let host = WindowsLiveResizeHost {
        counters: WindowsLiveResizeCounters::default(),
        flush_posted: false,
        frame_sequence: 9,
        generation: 7,
        interactive_resize: false,
        last_batch_failed: false,
        last_materialized_key: Some(WindowsGeometryKey {
            dpi: 144,
            frame_revision: 9,
            generation: 7,
            height: 720,
            plan_revision: 11,
            presentation: WindowsGeometryPresentation::Restored,
            width: 1_280,
        }),
        last_surface_bounds: HashMap::new(),
        pending_frame: None,
        plan: Some(two_column_live_resize_plan()),
        plan_epoch: 3,
        projection_suspended: false,
        receipt_handler: Arc::new(|_| {}),
        subclass_id: 7,
        #[cfg(feature = "desktop-e2e")]
        window_id: "window-a".to_owned(),
    };
    assert_eq!(
        windows_live_resize_frame_match(&host, Some((1_280, 720))),
        (true, "matched")
    );
    assert_eq!(
        windows_live_resize_frame_match(&host, Some((1_279, 720))),
        (false, "size-mismatch")
    );
    let mut fenced = host;
    fenced.plan.as_mut().unwrap().revision += 1;
    assert_eq!(
        windows_live_resize_frame_match(&fenced, Some((1_280, 720))),
        (false, "plan-fence")
    );
}

#[cfg(windows)]
#[test]
fn windows_minimize_messages_never_enter_native_geometry_projection() {
    assert!(!windows_live_resize_message_is_actionable(
        SIZE_MINIMIZED as usize,
        1_280,
        720,
    ));
    assert!(!windows_live_resize_message_is_actionable(0, 0, 720));
    assert!(!windows_live_resize_message_is_actionable(0, 1_280, 0));
    assert!(windows_live_resize_message_is_actionable(0, 1_280, 720));
}

#[cfg(windows)]
#[test]
fn windows_minimize_suspends_projection_before_default_window_processing() {
    let source = include_str!("../platform/windows/live_resize.rs");
    let procedure = source
        .split("unsafe extern \"system\" fn windows_live_resize_subclass_proc")
        .nth(1)
        .expect("the Windows geometry subclass procedure must exist");
    let suspend = procedure
        .find("windows_live_resize_note_minimized(hwnd);")
        .expect("SIZE_MINIMIZED must suspend the geometry host");
    let default_dispatch = procedure
        .find("DefSubclassProc(hwnd, message, wparam, lparam)")
        .expect("the subclass must preserve default window processing");
    assert!(
        suspend < default_dispatch,
        "SIZE_MINIMIZED must suspend projection before re-entrant default processing"
    );
}

#[cfg(windows)]
#[test]
fn windows_minimize_actor_receipt_only_claims_native_submission() {
    assert_eq!(
        native_presentation_completion_scope(Some(NativeWindowMode::Minimized)),
        SystemRuntimeOperationCompletionScope::NativeSubmission,
    );
    assert_eq!(
        native_presentation_completion_scope(Some(NativeWindowMode::Maximized)),
        SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
    );
}

#[cfg(windows)]
#[test]
fn windows_minimize_suspends_pending_geometry_without_discarding_materialized_bounds() {
    let materialized_key = WindowsGeometryKey {
        dpi: 144,
        frame_revision: 9,
        generation: 7,
        height: 720,
        plan_revision: 11,
        presentation: WindowsGeometryPresentation::Maximized,
        width: 1_280,
    };
    let surface_bounds = HashMap::from([(
        "role".to_owned(),
        WindowsLiveResizeBounds {
            height: 676,
            width: 1_280,
            x: 0,
            y: 44,
        },
    )]);
    let mut host = WindowsLiveResizeHost {
        counters: WindowsLiveResizeCounters::default(),
        flush_posted: true,
        frame_sequence: 10,
        generation: 7,
        interactive_resize: false,
        last_batch_failed: false,
        last_materialized_key: Some(materialized_key),
        last_surface_bounds: surface_bounds.clone(),
        pending_frame: Some(WindowsGeometryPendingFrame {
            dpi: 144,
            frame_revision: 10,
            height: 31,
            presentation: WindowsGeometryPresentation::Restored,
            terminal: true,
            width: 160,
        }),
        plan: Some(two_column_live_resize_plan()),
        plan_epoch: 3,
        projection_suspended: false,
        receipt_handler: Arc::new(|_| {}),
        subclass_id: 7,
        #[cfg(feature = "desktop-e2e")]
        window_id: "window-a".to_owned(),
    };

    windows_live_resize_suspend_host(&mut host);

    assert!(host.projection_suspended);
    assert!(host.pending_frame.is_none());
    assert!(!host.flush_posted);
    assert_eq!(host.last_materialized_key, Some(materialized_key));
    assert_eq!(host.last_surface_bounds, surface_bounds);
    assert!(!windows_live_resize_host_accepts_geometry(&host, false, true));

    host.projection_suspended = false;
    assert!(windows_live_resize_host_accepts_geometry(&host, false, true));
    assert!(!windows_live_resize_host_accepts_geometry(&host, true, true));
    assert!(!windows_live_resize_host_accepts_geometry(
        &host, false, false
    ));
}

#[cfg(windows)]
#[test]
fn unchanged_native_frame_requires_every_surface_to_match() {
    let labels = ["tabs".to_owned(), "role".to_owned()];
    let bounds = [
        WindowsLiveResizeBounds {
            height: 44,
            width: 1_280,
            x: 0,
            y: 0,
        },
        WindowsLiveResizeBounds {
            height: 676,
            width: 1_280,
            x: 0,
            y: 44,
        },
    ];
    let cache = HashMap::from([
        (labels[0].clone(), bounds[0]),
        (labels[1].clone(), bounds[1]),
    ]);
    assert!(windows_geometry_cached_bounds_match(
        &labels,
        &bounds,
        &cache,
        false,
    ));
    assert!(!windows_geometry_cached_bounds_match(
        &labels[..1],
        &bounds,
        &cache,
        false,
    ));
    assert!(!windows_geometry_cached_bounds_match(
        &labels,
        &bounds,
        &cache,
        true,
    ));
}

#[cfg(windows)]
#[test]
fn unchanged_native_diagnostics_exclude_mixed_or_failed_batches() {
    let mut counters = WindowsLiveResizeCounters {
        received: 1,
        unchanged: 1,
        ..WindowsLiveResizeCounters::default()
    };
    assert!(windows_live_resize_counters_are_unchanged(counters, true));
    assert!(!windows_live_resize_counters_are_unchanged(counters, false));

    counters.received = 2;
    assert!(!windows_live_resize_counters_are_unchanged(counters, true));
    counters.received = 1;
    counters.applied = 1;
    assert!(!windows_live_resize_counters_are_unchanged(counters, true));
    counters.applied = 0;
    counters.errors = 1;
    assert!(!windows_live_resize_counters_are_unchanged(counters, true));
}

#[cfg(windows)]
#[test]
fn posted_geometry_frames_coalesce_to_the_latest_terminal_revision() {
    let frame = |revision, width, terminal| WindowsGeometryPendingFrame {
        dpi: 144,
        frame_revision: revision,
        height: 720,
        presentation: WindowsGeometryPresentation::Restored,
        terminal,
        width,
    };
    let (pending, coalesced) =
        windows_geometry_merge_pending(Some(frame(1, 1_280, true)), frame(2, 1_440, false));
    assert!(coalesced);
    assert_eq!(pending.frame_revision, 2);
    assert_eq!(pending.width, 1_440);
    assert!(pending.terminal);
}

#[cfg(windows)]
#[test]
fn live_resize_parent_position_notification_reaches_every_active_surface() {
    let surfaces = ["tabs", "left", "right", "divider"];
    let notified = RefCell::new(Vec::new());
    let (applied, errors) = windows_live_resize_notify_each(&surfaces, |label| {
        notified.borrow_mut().push(*label);
        if *label == "left" {
            Err(())
        } else {
            Ok(())
        }
    });

    assert_eq!(notified.into_inner(), surfaces);
    assert_eq!(applied, 3);
    assert_eq!(errors, 1);
}

#[cfg(windows)]
#[test]
fn live_resize_counters_keep_resize_and_parent_position_events_distinct() {
    let mut counters = WindowsLiveResizeCounters::default();
    counters.record_native_resize_applied();

    assert_eq!(counters.applied, 1);
    assert_eq!(counters.parent_position_received, 0);
    assert_eq!(counters.parent_position_applied, 0);
    assert_eq!(counters.parent_position_errors, 0);

    counters.record_parent_position(3, 1);
    assert_eq!(counters.applied, 1);
    assert_eq!(counters.parent_position_received, 1);
    assert_eq!(counters.parent_position_applied, 3);
    assert_eq!(counters.parent_position_errors, 1);
}

#[cfg(windows)]
#[test]
fn live_resize_updates_shared_child_host_once_then_complete_controller_rects() {
    let surfaces = [("tabs", 7_usize), ("left", 7_usize), ("right", 7_usize)];
    let events = RefCell::new(Vec::new());
    let controller_bounds = RefCell::new(HashMap::new());
    let submit = |height| {
        let bounds = [
            WindowsLiveResizeBounds {
                height: 44,
                width: 1_200,
                x: 0,
                y: 0,
            },
            WindowsLiveResizeBounds {
                height: height - 44,
                width: 600,
                x: 0,
                y: 44,
            },
            WindowsLiveResizeBounds {
                height: height - 44,
                width: 600,
                x: 600,
                y: 44,
            },
        ];
        windows_live_resize_submit_ordered(
            &surfaces,
            &bounds,
            |surface| surface.1,
            |surface, bounds| {
                events
                    .borrow_mut()
                    .push(format!("host:{}:{}x{}", surface.1, bounds.width, bounds.height));
                Ok(())
            },
            |surface, bounds| {
                events
                    .borrow_mut()
                    .push(format!("controller:{}", surface.0));
                controller_bounds
                    .borrow_mut()
                    .insert(surface.0, *bounds);
                Ok(())
            },
        )
    };

    submit(320).unwrap();
    submit(900).unwrap();
    assert_eq!(
        controller_bounds.borrow().get("left"),
        Some(&WindowsLiveResizeBounds {
            height: 856,
            width: 600,
            x: 0,
            y: 44,
        })
    );
    assert_eq!(
        controller_bounds.borrow().get("right"),
        Some(&WindowsLiveResizeBounds {
            height: 856,
            width: 600,
            x: 600,
            y: 44,
        })
    );
    assert_eq!(
        events.into_inner(),
        [
            "host:7:1200x320",
            "controller:tabs",
            "controller:left",
            "controller:right",
            "host:7:1200x900",
            "controller:tabs",
            "controller:left",
            "controller:right",
        ]
    );
}

#[cfg(windows)]
#[test]
fn live_resize_keeps_independent_wry_hosts_inside_their_own_surfaces() {
    let surfaces = [
        ("tabs", 1_usize),
        ("left", 2_usize),
        ("right", 3_usize),
        ("divider", 4_usize),
    ];
    let bounds = [
        WindowsLiveResizeBounds {
            height: 44,
            width: 1_200,
            x: 0,
            y: 0,
        },
        WindowsLiveResizeBounds {
            height: 856,
            width: 600,
            x: 0,
            y: 44,
        },
        WindowsLiveResizeBounds {
            height: 856,
            width: 600,
            x: 600,
            y: 44,
        },
        WindowsLiveResizeBounds {
            height: 856,
            width: 10,
            x: 595,
            y: 44,
        },
    ];
    let hosts = RefCell::new(Vec::new());
    let controllers = RefCell::new(Vec::new());

    windows_live_resize_submit_ordered(
        &surfaces,
        &bounds,
        |surface| surface.1,
        |surface, bounds| {
            hosts.borrow_mut().push((surface.0, *bounds));
            Ok(())
        },
        |surface, bounds| {
            controllers.borrow_mut().push((surface.0, *bounds));
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(hosts.into_inner(), surfaces.map(|surface| surface.0).into_iter().zip(bounds).collect::<Vec<_>>());
    assert_eq!(
        controllers.into_inner(),
        [
            ("tabs", WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 }),
            ("left", WindowsLiveResizeBounds { height: 856, width: 600, x: 0, y: 0 }),
            ("right", WindowsLiveResizeBounds { height: 856, width: 600, x: 0, y: 0 }),
            ("divider", WindowsLiveResizeBounds { height: 856, width: 10, x: 0, y: 0 }),
        ]
    );
}

#[cfg(windows)]
#[test]
fn live_resize_uses_per_parent_unions_for_mixed_host_topologies() {
    let surfaces = [("tabs", 1_usize), ("left", 2_usize), ("right", 2_usize)];
    let bounds = [
        WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 },
        WindowsLiveResizeBounds { height: 856, width: 600, x: 0, y: 44 },
        WindowsLiveResizeBounds { height: 856, width: 600, x: 600, y: 44 },
    ];
    let hosts = RefCell::new(Vec::new());
    let controllers = RefCell::new(Vec::new());

    windows_live_resize_submit_ordered(
        &surfaces,
        &bounds,
        |surface| surface.1,
        |surface, bounds| {
            hosts.borrow_mut().push((surface.1, *bounds));
            Ok(())
        },
        |surface, bounds| {
            controllers.borrow_mut().push((surface.0, *bounds));
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(
        hosts.into_inner(),
        [
            (1, WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 }),
            (2, WindowsLiveResizeBounds { height: 856, width: 1_200, x: 0, y: 44 }),
        ]
    );
    assert_eq!(
        controllers.into_inner(),
        [
            ("tabs", WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 }),
            ("left", WindowsLiveResizeBounds { height: 856, width: 600, x: 0, y: 0 }),
            ("right", WindowsLiveResizeBounds { height: 856, width: 600, x: 600, y: 0 }),
        ]
    );
}

#[cfg(windows)]
#[test]
fn live_resize_readback_requires_exact_host_and_controller_bounds() {
    let surfaces = [("tabs", 1_usize), ("left", 2_usize), ("right", 2_usize)];
    let bounds = [
        WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 },
        WindowsLiveResizeBounds { height: 856, width: 600, x: 0, y: 44 },
        WindowsLiveResizeBounds { height: 856, width: 600, x: 600, y: 44 },
    ];
    let host_bounds = HashMap::from([
        (1_usize, WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 }),
        (2_usize, WindowsLiveResizeBounds { height: 856, width: 1_200, x: 0, y: 44 }),
    ]);
    let controller_bounds = HashMap::from([
        ("tabs", WindowsLiveResizeBounds { height: 44, width: 1_200, x: 0, y: 0 }),
        ("left", WindowsLiveResizeBounds { height: 856, width: 600, x: 0, y: 0 }),
        ("right", WindowsLiveResizeBounds { height: 856, width: 600, x: 600, y: 0 }),
    ]);
    let verify = |hosts: &HashMap<usize, WindowsLiveResizeBounds>,
                  controllers: &HashMap<&str, WindowsLiveResizeBounds>| {
        windows_live_resize_verify_ordered(
            &surfaces,
            &bounds,
            |surface| surface.1,
            |surface| hosts.get(&surface.1).copied().ok_or(()),
            |surface| controllers.get(surface.0).copied().ok_or(()),
        )
    };

    assert!(verify(&host_bounds, &controller_bounds).is_ok());

    let mut stale_host = host_bounds.clone();
    stale_host.get_mut(&2).unwrap().width -= 1;
    assert!(verify(&stale_host, &controller_bounds).is_err());

    let mut stale_controller = controller_bounds.clone();
    stale_controller.get_mut("right").unwrap().width -= 1;
    assert!(verify(&host_bounds, &stale_controller).is_err());
}

#[cfg(windows)]
#[test]
fn live_resize_batch_failure_stops_the_native_frame_and_enables_fallback() {
    let surfaces = [("tabs", 7_usize), ("role", 7_usize)];
    let bounds = [
        WindowsLiveResizeBounds {
            height: 44,
            width: 800,
            x: 0,
            y: 0,
        },
        WindowsLiveResizeBounds {
            height: 556,
            width: 800,
            x: 0,
            y: 44,
        },
    ];
    let controllers = RefCell::new(Vec::new());
    let result = windows_live_resize_submit_ordered(
        &surfaces,
        &bounds,
        |surface| surface.1,
        |_, _| Err(()),
        |surface, _| {
            controllers.borrow_mut().push(surface.0);
            Ok(())
        },
    );

    assert!(result.is_err());
    assert_eq!(controllers.into_inner(), ["tabs", "role"]);
}

#[cfg(windows)]
#[test]
fn live_resize_controller_rect_keeps_parent_local_surface_offsets() {
    let rect = windows_live_resize_controller_rect(&WindowsLiveResizeBounds {
        height: 900,
        width: 600,
        x: 620,
        y: 44,
    });

    assert_eq!((rect.left, rect.top), (620, 44));
    assert_eq!((rect.right, rect.bottom), (1_220, 944));
}

#[cfg(windows)]
#[test]
fn live_resize_controller_geometry_only_submits_bounds() {
    let bounds = WindowsLiveResizeBounds {
        height: 900,
        width: 10,
        x: 795,
        y: 44,
    };
    let events = RefCell::new(Vec::new());
    windows_live_resize_submit_controller_bounds(
        &"divider",
        &bounds,
        |label, bounds| {
            events
                .borrow_mut()
                .push(format!("bounds:{label}:{}", bounds.height));
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(events.into_inner(), ["bounds:divider:900"]);
}

#[cfg(windows)]
#[test]
fn live_resize_controller_bounds_propagates_failure() {
    let bounds = WindowsLiveResizeBounds {
        height: 900,
        width: 10,
        x: 795,
        y: 44,
    };
    let result = windows_live_resize_submit_controller_bounds(&"divider", &bounds, |_, _| Err(()));

    assert!(result.is_err());
}

#[cfg(windows)]
#[test]
fn incomplete_live_resize_plan_uses_fallback_without_native_submission() {
    let registry = WindowsLiveResizeRegistry::default();
    assert!(windows_live_resize_collect_surfaces(
        &registry,
        &two_column_live_resize_plan()
    )
    .is_none());
}

#[cfg(windows)]
#[test]
fn live_resize_projects_attached_surfaces_while_a_role_controller_restarts() {
    let plan = two_column_live_resize_plan();
    let resolved = windows_live_resize_resolve_bounds(&plan, 1_280, 720, 1.0).unwrap();
    let labels = [
        plan.tab_strip_label.as_str(),
        plan.roles[1].label.as_str(),
    ];

    let projected =
        windows_live_resize_project_available_bounds(&plan, &labels, &resolved).unwrap();

    assert_eq!(projected, [resolved[0], resolved[2]]);
    assert!(windows_live_resize_project_available_bounds(
        &plan,
        &["detached-surface"],
        &resolved,
    )
    .is_none());
}

#[cfg(windows)]
#[test]
fn roles_can_materialize_before_optional_divider_surfaces_attach() {
    let mut plan = two_column_live_resize_plan();
    plan.dividers.clear();

    let bounds = windows_live_resize_resolve_bounds(&plan, 1_280, 720, 1.0).unwrap();
    let [tab_strip, left, right] = bounds.as_slice() else {
        panic!("expected tab strip and both role surfaces");
    };
    assert_eq!(tab_strip.y + tab_strip.height, left.y);
    assert_eq!(left.y, right.y);
    assert_eq!(right.x + right.width, 1_280);
    assert_eq!(right.y + right.height, 720);
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

#[test]
fn force_restart_can_defer_the_main_window_projection_until_page_load() {
    assert!(main_window_initial_projection_can_defer(
        "runtime error: failed to receive message from webview"
    ));
    assert!(!main_window_initial_projection_can_defer(
        "window bounds were rejected"
    ));
}
