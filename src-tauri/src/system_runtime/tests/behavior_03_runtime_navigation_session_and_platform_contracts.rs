use uuid::Uuid;

    #[test]
    fn overlay_refresh_continues_after_an_invalid_handle() {
        let mut attempted = Vec::new();
        refresh_macro_overlay_handles(["role-a", "destroyed", "role-b"], |label| {
            attempted.push(label);
            if label == "destroyed" {
                Err("WebView was destroyed")
            } else {
                Ok(())
            }
        });
        assert_eq!(attempted, ["role-a", "destroyed", "role-b"]);
    }

    #[test]
    fn macro_release_is_limited_to_top_level_game_page_navigation_schemes() {
        for url in ["https://game.example/", "http://game.example/"] {
            assert!(should_release_macros_for_navigation(
                &Url::parse(url).unwrap()
            ));
        }
        for url in ["about:blank", "data:text/plain,internal"] {
            assert!(!should_release_macros_for_navigation(
                &Url::parse(url).unwrap()
            ));
        }
    }

    #[test]
    fn main_frame_and_controlled_reload_are_the_only_navigation_fence_sources() {
        assert_eq!(
            NavigationInputFenceSource::MainFrame.trigger(),
            "mainFrameNavigationInputFence"
        );
        assert_eq!(
            NavigationInputFenceSource::MainFrame.reason(),
            "main-frame-navigation"
        );
        assert_eq!(
            NavigationInputFenceSource::ControlledReload.trigger(),
            "controlledReloadInputFence"
        );
        assert_eq!(
            NavigationInputFenceSource::ControlledReload.reason(),
            "controlled-reload"
        );
    }

    #[test]
    fn macos_and_windows_tab_activation_share_one_display_host_plan() {
        for platform in ["macos", "windows"] {
            let live = HashMap::from([
                ("tab-a".to_owned(), "window-11".to_owned()),
                ("tab-b".to_owned(), "window-11".to_owned()),
            ]);
            let plan = resolve_runtime_tab_host_plan(
                &runtime_tab_host_snapshot("tab-b"),
                &live,
                &["window-11".to_owned()],
                Some("tab-b"),
            );
            assert_eq!(
                plan.iter()
                    .map(|entry| entry.window_id.clone())
                    .collect::<HashSet<_>>(),
                HashSet::from(["window-11".to_owned()]),
                "{platform} must retain one window host"
            );
            assert_eq!(
                plan.iter().filter(|entry| entry.active).count(),
                1,
                "{platform}"
            );
            assert!(plan.iter().all(|entry| !entry.moved), "{platform}");
            assert!(
                plan.iter()
                    .find(|entry| entry.tab_id == "tab-b")
                    .unwrap()
                    .focus
            );
        }
    }

    #[test]
    fn display_host_plan_marks_only_cross_display_tabs_for_reparenting() {
        let mut snapshot = runtime_tab_host_snapshot("tab-b");
        snapshot.tabs[1].window_id = "window-b".to_owned();
        snapshot.windows = vec![
            rion_core::BrowserRuntimeWindowRecord {
                window_id: "window-11".to_owned(),
                active_tab_id: Some("tab-a".to_owned()),
                tab_ids: vec!["tab-a".to_owned()],
            },
            rion_core::BrowserRuntimeWindowRecord {
                window_id: "window-b".to_owned(),
                active_tab_id: Some("tab-b".to_owned()),
                tab_ids: vec!["tab-b".to_owned()],
            },
        ];
        let live = HashMap::from([
            ("tab-a".to_owned(), "window-11".to_owned()),
            ("tab-b".to_owned(), "window-11".to_owned()),
        ]);
        let plan = resolve_runtime_tab_host_plan(
            &snapshot,
            &live,
            &["window-b".to_owned()],
            Some("tab-b"),
        );
        assert!(
            !plan
                .iter()
                .find(|entry| entry.tab_id == "tab-a")
                .unwrap()
                .moved
        );
        let moved = plan.iter().find(|entry| entry.tab_id == "tab-b").unwrap();
        assert!(moved.moved);
        assert!(moved.active);
        assert!(moved.focus);
    }

    #[test]
    fn macos_navigation_tracker_accepts_http_finish_without_started() {
        let tracker = NavigationTracker::new_for_platform("macos");
        tracker.reset();
        tracker.page_event(PageLoadEvent::Finished, &Url::parse("about:blank").unwrap());
        assert!(!tracker.state.lock().unwrap().finished);

        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/redirected").unwrap(),
        );
        assert!(tracker.state.lock().unwrap().finished);
    }

    #[tokio::test]
    async fn navigation_tracker_async_wait_does_not_require_a_blocking_worker() {
        let tracker = Arc::new(NavigationTracker::new_for_platform("macos"));
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
        );
        tracker.begin_operation(&operation).unwrap();
        let waiting = Arc::clone(&tracker);
        let waiter = tokio::spawn(async move { waiting.wait_operation_async(operation).await });
        tokio::task::yield_now().await;
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/ready").unwrap(),
        );
        assert_eq!(
            waiter.await.unwrap().status,
            NativeOperationStatus::Applied
        );
    }

    #[tokio::test]
    async fn closing_a_launching_surface_supersedes_its_async_navigation_wait_immediately() {
        let tracker = Arc::new(NavigationTracker::new_for_platform("windows"));
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(30),
        );
        tracker.begin_operation(&operation).unwrap();
        let waiting = Arc::clone(&tracker);
        let waiter = tokio::spawn(async move { waiting.wait_operation_async(operation).await });
        tokio::task::yield_now().await;

        tracker.reset();

        let receipt = tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("navigation cancellation must not wait for its native deadline")
            .unwrap();
        assert_eq!(receipt.status, NativeOperationStatus::Superseded);
        assert_eq!(
            receipt.failure_code.as_deref(),
            Some("SYSTEM_NAVIGATION_SUPERSEDED")
        );
    }

    #[tokio::test]
    async fn navigation_tracker_retains_completion_before_async_subscription() {
        let tracker = NavigationTracker::new_for_platform("macos");
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
        );
        tracker.begin_operation(&operation).unwrap();
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/already-ready").unwrap(),
        );
        assert_eq!(
            tracker.wait_operation_async(operation).await.status,
            NativeOperationStatus::Applied
        );
    }

    #[tokio::test]
    async fn windows_navigation_failure_terminalizes_the_exact_operation() {
        let tracker = NavigationTracker::new_for_platform("windows");
        let operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
            "windows",
        );
        tracker.begin_operation(&operation).unwrap();
        assert!(tracker.native_navigation_started(41));
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/error-page").unwrap(),
        );
        assert_eq!(
            tracker.operation_state(&operation).unwrap(),
            NavigationOperationState::Pending
        );
        assert!(tracker.native_navigation_completed(
            41,
            false,
            Some("SYSTEM_NAVIGATION_WEBVIEW2_FAILED"),
        ));

        let receipt = tracker.wait_operation(operation.clone());
        assert_eq!(receipt.status, NativeOperationStatus::Failed);
        assert_eq!(
            receipt.failure_code.as_deref(),
            Some("SYSTEM_NAVIGATION_WEBVIEW2_FAILED")
        );
        let async_receipt = tracker.wait_operation_async(operation).await;
        assert_eq!(async_receipt.status, NativeOperationStatus::Failed);
        assert_eq!(
            async_receipt.failure_code.as_deref(),
            Some("SYSTEM_NAVIGATION_WEBVIEW2_FAILED")
        );
    }

    #[test]
    fn windows_navigation_success_requires_native_and_page_completion() {
        let tracker = NavigationTracker::new_for_platform("windows");
        let operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
            "windows",
        );
        tracker.begin_operation(&operation).unwrap();
        assert!(tracker.native_navigation_started(51));
        assert!(!tracker.native_navigation_completed(51, true, None));
        assert_eq!(
            tracker.operation_state(&operation).unwrap(),
            NavigationOperationState::Pending
        );

        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/ready").unwrap(),
        );
        assert_eq!(
            tracker.wait_operation(operation).status,
            NativeOperationStatus::Applied
        );
    }

    #[test]
    fn windows_navigation_tracker_ignores_a_stale_native_completion() {
        let tracker = NavigationTracker::new_for_platform("windows");
        let operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
            "windows",
        );
        tracker.begin_operation(&operation).unwrap();
        assert!(tracker.native_navigation_started(61));
        assert!(tracker.native_navigation_started(62));
        assert!(!tracker.native_navigation_completed(
            61,
            false,
            Some("SYSTEM_NAVIGATION_WEBVIEW2_FAILED"),
        ));
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/latest").unwrap(),
        );
        assert_eq!(
            tracker.operation_state(&operation).unwrap(),
            NavigationOperationState::Pending
        );
        assert!(tracker.native_navigation_completed(62, true, None));
        assert_eq!(
            tracker.wait_operation(operation).status,
            NativeOperationStatus::Applied
        );
    }

    #[test]
    fn native_creation_gate_never_exceeds_its_global_limit() {
        let gate = Arc::new(NativeCreationGate::new(2));
        let active = Arc::new(AtomicU64::new(0));
        let maximum = Arc::new(AtomicU64::new(0));
        let threads = (0..8)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    let _permit = gate.acquire().unwrap();
                    let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                    maximum.fetch_max(current, Ordering::AcqRel);
                    std::thread::sleep(Duration::from_millis(5));
                    active.fetch_sub(1, Ordering::AcqRel);
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert!(maximum.load(Ordering::Acquire) <= 2);
    }

    #[test]
    fn windows_serializes_native_creation_while_macos_keeps_two_slots() {
        assert_eq!(native_creation_limit("windows"), 1);
        assert_eq!(native_creation_limit("macos"), 2);

        let gate = Arc::new(NativeCreationGate::new(native_creation_limit("windows")));
        let active = Arc::new(AtomicU64::new(0));
        let maximum = Arc::new(AtomicU64::new(0));
        let roles = (0..29)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    let _permit = gate.acquire().unwrap();
                    let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                    maximum.fetch_max(current, Ordering::AcqRel);
                    std::thread::yield_now();
                    active.fetch_sub(1, Ordering::AcqRel);
                })
            })
            .collect::<Vec<_>>();
        for role in roles {
            role.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::Acquire), 1);
    }

    #[test]
    fn session_transfer_scripts_are_document_start_origin_scoped_and_json_escaped() {
        let entries = vec![rion_core::LocalStorageEntryRecord {
            key: "token\"</script>".to_owned(),
            value: "value\nline".to_owned(),
        }];
        let script =
            local_storage_document_start_script("https://game.example.test", true, &entries)
                .unwrap();
        assert!(script.contains("globalThis.top !== globalThis"));
        assert!(script.contains("location.origin !== \"https://game.example.test\""));
        assert!(script.contains("localStorage.clear()"));
        assert!(script.contains("token\\\"</script>"));

        let restore = local_storage_restore_script(
            "https://game.example.test",
            &[("key".to_owned(), "old".to_owned())],
        )
        .unwrap();
        assert!(restore.contains("localStorage.clear()"));
        assert!(restore.contains("__rionSessionRestoreState"));
        assert!(validate_transaction_id("../escape").is_err());
        assert!(validate_transaction_id("transaction-1").is_ok());
    }

    #[test]
    fn session_transfer_omits_false_cookie_flags_and_preserves_true_flags() {
        let launch = Url::parse("https://game.example.test/play").unwrap();
        let plain = transfer_cookie(
            &SessionCookieRecord {
                name: "plain".to_owned(),
                value: "value".to_owned(),
                domain: Some(".example.test".to_owned()),
                path: "/".to_owned(),
                secure: false,
                http_only: false,
                same_site: "lax".to_owned(),
                expires_unix_ms: None,
            },
            &launch,
        )
        .unwrap();
        assert_eq!(plain.secure(), None);
        assert_eq!(plain.http_only(), None);

        let protected = transfer_cookie(
            &SessionCookieRecord {
                name: "protected".to_owned(),
                value: "value".to_owned(),
                domain: Some(".example.test".to_owned()),
                path: "/".to_owned(),
                secure: true,
                http_only: true,
                same_site: "strict".to_owned(),
                expires_unix_ms: None,
            },
            &launch,
        )
        .unwrap();
        assert_eq!(protected.secure(), Some(true));
        assert_eq!(protected.http_only(), Some(true));
    }

    #[test]
    fn session_transfer_cookie_scope_includes_parent_domains_and_valid_paths() {
        let launch = Url::parse("https://universe.flyff.com/play/character").unwrap();
        for domain in [".flyff.com", "flyff.com", "universe.flyff.com"] {
            let cookie = Cookie::build(("session", "value"))
                .domain(domain)
                .path("/play")
                .secure(true)
                .build();
            assert!(
                native_cookie_matches_launch(&cookie, &launch),
                "expected {domain} to match the launch URL"
            );
        }

        for (domain, path) in [
            ("account.flyff.com", "/play"),
            ("notflyff.com", "/play"),
            (".flyff.com", "/player"),
        ] {
            let cookie = Cookie::build(("session", "value"))
                .domain(domain)
                .path(path)
                .build();
            assert!(
                !native_cookie_matches_launch(&cookie, &launch),
                "did not expect {domain}{path} to match the launch URL"
            );
        }

        let secure_cookie = Cookie::build(("session", "value"))
            .domain(".flyff.com")
            .path("/")
            .secure(true)
            .build();
        let insecure_launch = Url::parse("http://universe.flyff.com/play").unwrap();
        assert!(!native_cookie_matches_launch(
            &secure_cookie,
            &insecure_launch
        ));
    }

    #[test]
    fn session_transfer_cookie_verification_normalizes_unspecified_same_site() {
        let unspecified = Cookie::build(("session", "value"))
            .domain("universe.flyff.com")
            .path("/")
            .build();
        let native_readback = Cookie::build(("session", "value"))
            .domain("universe.flyff.com")
            .path("/")
            .same_site(SameSite::None)
            .build();

        verify_cookie_readback(&[unspecified], &[native_readback]).unwrap();
    }

    #[test]
    fn role_cookie_checkpoint_uses_the_role_browser_boundary_and_rejects_expired_entries() {
        let directory = role_cookie_checkpoint_directory(Path::new("/runtime"), "role-a").unwrap();
        assert_eq!(
            directory,
            Path::new("/runtime/roles/role-a/browser")
        );

        let mut record = SessionCookieRecord {
            name: "session".to_owned(),
            value: "value".to_owned(),
            domain: Some("game.example.test".to_owned()),
            path: "/".to_owned(),
            secure: true,
            http_only: true,
            same_site: "strict".to_owned(),
            expires_unix_ms: Some(2_000),
        };
        assert!(role_cookie_checkpoint_entry_is_live(&record, 1_999));
        assert!(!role_cookie_checkpoint_entry_is_live(&record, 2_000));

        let cookie = role_cookie_from_checkpoint(&record).unwrap();
        assert_eq!(cookie.domain(), Some("game.example.test"));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));

        record.domain = None;
        assert_eq!(
            role_cookie_from_checkpoint(&record).unwrap_err().code,
            "ROLE_COOKIE_CHECKPOINT_INVALID"
        );
    }

    #[test]
    fn role_cookie_checkpoint_payload_has_an_explicit_format_version() {
        let checkpoint = PersistedRoleCookieCheckpoint {
            version: ROLE_COOKIE_CHECKPOINT_VERSION,
            cookies: Vec::new(),
        };
        let serialized = serde_json::to_vec(&checkpoint).unwrap();
        let decoded: PersistedRoleCookieCheckpoint = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(decoded.version, 1);
        assert!(decoded.cookies.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_security_policy_installs_dialogs_and_denies_undefined_media_permissions() {
        unsafe extern "C" {
            fn rion_wk_security_policy_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_security_policy_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_high_refresh_rate_finds_only_the_expected_webkit_feature() {
        unsafe extern "C" {
            fn rion_wk_high_refresh_rate_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_high_refresh_rate_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_debug_webgl_experiment_finds_only_the_exact_webkit_feature() {
        unsafe extern "C" {
            fn rion_wk_maximum_webgl_performance_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_maximum_webgl_performance_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_surface_leases_keep_exact_webviews_isolated() {
        unsafe extern "C" {
            fn rion_wk_surface_lifecycle_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_surface_lifecycle_self_test() });
    }

    #[test]
    fn performance_diagnostic_probe_is_foreground_scoped_and_privacy_bounded() {
        let source = PERFORMANCE_DIAGNOSTIC_SOURCE_TEMPLATE;
        assert!(source.contains("requestAnimationFrame(tick)"));
        assert!(source.contains("PerformanceObserver"));
        assert!(source.contains("longtask"));
        assert!(source.contains("takeRecords"));
        assert!(source.contains("document.visibilityState"));
        assert!(source.contains("document.hasFocus()"));
        assert!(source.contains("intervals.length * 1000"));
        assert!(source.contains("globalThis.GLctx"));
        assert!(!source.contains("getContext("));
        assert!(source.contains("WEBGL_debug_renderer_info"));
        assert!(source.contains("querySelectorAll(\"canvas\")"));
        assert!(source.contains("primaryCanvas"));
        assert!(source.contains("pagehide"));
        for source in [source, PERFORMANCE_DIAGNOSTIC_GAME_LOOP_DEV_SOURCE_TEMPLATE] {
            assert!(!source.contains("localStorage"));
            assert!(!source.contains("document.cookie"));
            assert!(!source.contains("location.href"));
        }
        assert!(PERFORMANCE_DIAGNOSTIC_GAME_LOOP_DEV_SOURCE_TEMPLATE
            .contains("MainLoop"));
        assert!(PERFORMANCE_DIAGNOSTIC_GAME_LOOP_DEV_SOURCE_TEMPLATE
            .contains("webglcontextlost"));
        assert!(PERFORMANCE_DIAGNOSTIC_GAME_LOOP_DEV_SOURCE_TEMPLATE
            .contains("elapsedSamplePeriods"));
        let first = performance_diagnostic_source("start", "operation-one", true);
        let second = performance_diagnostic_source("cancel", "operation-two", false);
        assert!(first.contains("operation-one"));
        assert!(first.contains("})();\n/* global"));
        assert!(!first.contains("operation-two"));
        assert!(second.contains("operation-two"));
        assert!(!second.contains("globalThis.MainLoop"));
    }

    #[test]
    fn performance_diagnostic_cancellation_wakes_a_deadline_bound_sample() {
        let cancellation = Arc::new(PerformanceDiagnosticCancellation::default());
        let worker_cancellation = Arc::clone(&cancellation);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let worker_barrier = Arc::clone(&barrier);
        let worker = thread::spawn(move || {
            worker_barrier.wait();
            worker_cancellation.wait(Duration::from_secs(60))
        });
        barrier.wait();
        cancellation.cancel();
        assert!(!worker.join().expect("diagnostic worker joins"));
    }

    #[test]
    fn game_loop_target_requires_all_local_fps_and_frame_pacing_gates() {
        let passing = PerformanceTargetEvidence {
            context_loss_count: Some(0),
            display_refresh_rate_hz: Some(60.0),
            game_loop_fps: Some(112.0),
            game_loop_p10_fps: Some(104.0),
            hardware_acceleration_enabled: Some(true),
            missed_vsync_count: Some(0),
            presentation_fps: Some(59.5),
            presentation_sample_count: 90,
        };
        assert_eq!(
            performance_target_status(PerformanceTargetStatus::NotRun, passing),
            PerformanceTargetStatus::Passed
        );
        let failing = PerformanceTargetEvidence {
            game_loop_p10_fps: Some(90.0),
            ..passing
        };
        assert_eq!(
            performance_target_status(PerformanceTargetStatus::NotRun, failing),
            PerformanceTargetStatus::Failed
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn loaded_webkit_framework_reports_its_own_build_version() {
        let version = macos_webkit_runtime_version().expect("loaded WebKit build version");
        assert!(version.contains('.'));
    }

    #[test]
    fn webview2_gpu_diagnostics_decode_cdp_system_information() {
        let diagnostics = decode_webview2_gpu_diagnostics(
            r#"{
              "gpu": {
                "devices": [{
                  "deviceString": "Hardware GPU",
                  "vendorString": "GPU Vendor"
                }],
                "featureStatus": { "webgl": "enabled_on" }
              }
            }"#,
        )
        .unwrap();
        assert_eq!(diagnostics.graphics_renderer.as_deref(), Some("Hardware GPU"));
        assert_eq!(diagnostics.graphics_vendor.as_deref(), Some("GPU Vendor"));
        assert_eq!(diagnostics.hardware_acceleration_enabled, Some(true));
    }

    #[test]
    fn macos_high_refresh_modes_resolve_against_the_selected_display() {
        assert!(macos_high_refresh_mode_requests(
            MacosHighRefreshMode::Auto,
            Some(144.0)
        ));
        assert!(!macos_high_refresh_mode_requests(
            MacosHighRefreshMode::Auto,
            Some(60.0)
        ));
        assert!(!macos_high_refresh_mode_requests(
            MacosHighRefreshMode::Auto,
            None
        ));
        assert!(macos_high_refresh_mode_requests(
            MacosHighRefreshMode::Enabled,
            None
        ));
        assert!(!macos_high_refresh_mode_requests(
            MacosHighRefreshMode::Disabled,
            Some(144.0)
        ));
    }

    #[test]
    fn performance_diagnostic_phase_order_fences_completion_after_cancel() {
        let mut operation = PerformanceDiagnosticOperationState {
            cancellation: Arc::new(PerformanceDiagnosticCancellation::default()),
            operation_id: "performance-diagnostic-test".to_owned(),
            phase: BrowserPerformanceDiagnosticOperationPhase::WaitingForFocus,
            revision: 1,
        };
        assert!(transition_performance_diagnostic_phase(
            &mut operation,
            &[BrowserPerformanceDiagnosticOperationPhase::WaitingForFocus],
            BrowserPerformanceDiagnosticOperationPhase::Sampling,
        ));
        assert_eq!(operation.revision, 2);
        assert!(transition_performance_diagnostic_phase(
            &mut operation,
            &[BrowserPerformanceDiagnosticOperationPhase::Sampling],
            BrowserPerformanceDiagnosticOperationPhase::Cancelled,
        ));
        assert_eq!(operation.revision, 3);
        assert!(!transition_performance_diagnostic_phase(
            &mut operation,
            &[BrowserPerformanceDiagnosticOperationPhase::Sampling],
            BrowserPerformanceDiagnosticOperationPhase::Completed,
        ));
        assert_eq!(
            operation.phase,
            BrowserPerformanceDiagnosticOperationPhase::Cancelled
        );
        assert_eq!(operation.revision, 3);
    }

    #[test]
    fn performance_diagnostic_readback_accepts_nested_webview_json() {
        let value = json!({
            "documentVisibilityState": "visible",
            "documentHasFocus": true,
            "viewportWidth": 1280.0,
            "viewportHeight": 720.0,
            "devicePixelRatio": 2.0,
            "hardwareConcurrency": 8,
            "frameCount": 188,
            "observedDurationMs": 1500.0,
            "presentationFps": 125.3,
            "primaryCanvas": {
                "cssWidth": 1280.0,
                "cssHeight": 720.0,
                "pixelWidth": 2560,
                "pixelHeight": 1440,
                "devicePixelRatio": 2.0,
                "megapixels": 3.6864
            },
            "frameIntervalsMs": [8.0, 8.2, 17.0],
            "p50FrameIntervalMs": 8.0,
            "p95FrameIntervalMs": 8.4,
            "p99FrameIntervalMs": 16.0,
            "longestFrameIntervalMs": 16.1,
            "longTaskCount": 1,
            "longTaskTotalDurationMs": 62.0,
            "longestTaskMs": 62.0,
            "graphics": {
                "renderer": "Apple GPU",
                "vendor": "Apple",
                "webgl": "available",
                "webgl2": "available",
                "webgpu": "available"
            }
        });
        let nested = serde_json::to_string(&serde_json::to_string(&value).unwrap()).unwrap();
        let readback = decode_performance_diagnostic_readback(&nested).unwrap();
        assert_eq!(readback.document_visibility_state, "visible");
        assert!(readback.document_has_focus);
        assert_eq!(readback.frame_count, 188);
        assert_eq!(readback.presentation_fps, Some(125.3));
        assert_eq!(readback.primary_canvas.unwrap().pixel_width, 2560);
        assert_eq!(readback.frame_intervals_ms, vec![8.0, 8.2, 17.0]);
        assert_eq!(readback.p99_frame_interval_ms, Some(16.0));
        assert_eq!(readback.long_task_count, Some(1));
        assert_eq!(readback.graphics.renderer.as_deref(), Some("Apple GPU"));
    }

    #[test]
    fn performance_diagnostic_counts_slow_frames_against_explicit_refresh_rates() {
        for (refresh_rate, intervals, expected) in [
            (60.0, vec![16.7, 26.0, 34.0, 51.0], (Some(3), Some(6))),
            (120.0, vec![8.3, 13.0, 17.0, 26.0], (Some(3), Some(6))),
        ] {
            assert_eq!(
                frame_budget_diagnostics(&intervals, Some(refresh_rate)),
                expected
            );
        }
        assert_eq!(frame_budget_diagnostics(&[16.7], None), (None, None));
        assert_eq!(
            frame_budget_diagnostics(&[f64::NAN, -1.0, 16.0], Some(60.0)),
            (Some(0), Some(0))
        );
    }

    #[test]
    fn performance_environment_maps_platform_power_and_thermal_states() {
        assert_eq!(
            windows_low_power_mode_from_system_status_flag(0),
            Some(false)
        );
        assert_eq!(
            windows_low_power_mode_from_system_status_flag(1),
            Some(true)
        );
        assert_eq!(windows_low_power_mode_from_system_status_flag(255), None);

        for (raw, expected) in [
            (0, Some("nominal")),
            (1, Some("fair")),
            (2, Some("serious")),
            (3, Some("critical")),
            (4, Some("unknown")),
            (-1, None),
        ] {
            assert_eq!(decode_macos_thermal_state(raw).as_deref(), expected);
        }
    }

    #[test]
    fn high_refresh_diagnostic_status_labels_are_stable() {
        for (status, expected) in [
            (HighRefreshRateDiagnosticStatus::Applied, "applied"),
            (HighRefreshRateDiagnosticStatus::Disabled, "disabled"),
            (HighRefreshRateDiagnosticStatus::Unavailable, "unavailable"),
            (HighRefreshRateDiagnosticStatus::Failed, "failed"),
            (HighRefreshRateDiagnosticStatus::Timeout, "timeout"),
            (
                HighRefreshRateDiagnosticStatus::ScheduleFailed,
                "schedule-failed",
            ),
            (
                HighRefreshRateDiagnosticStatus::NotApplicable,
                "not-applicable",
            ),
        ] {
            assert_eq!(high_refresh_rate_status_label(status), expected);
        }
    }
    #[test]
    fn role_session_identity_matches_the_core_uuid_v8_algorithm() {
        let paths = role_session_paths(Path::new("/tmp/rion"), "role-1").unwrap();
        assert_eq!(
            Uuid::from_bytes(paths.webkit_identifier).to_string(),
            "32792c51-c7ee-8dce-afb2-a97ea4a6bc46"
        );
    }

    #[test]
    fn role_bounds_are_relative_to_the_host_work_area() {
        let target = EmbeddedLaunchTargetRecord {
            window_id: "window-7".to_owned(),
            persisted_name: None,
            display_id: 7,
            scale_factor: 2.0,
            work_area: rion_core::StatePixelBoundsRecord {
                x: 100,
                y: 50,
                width: 1_200,
                height: 800,
            },
            bounds: rion_core::StatePixelBoundsRecord {
                x: 100,
                y: 50,
                width: 1_200,
                height: 800,
            },
            presentation: "normal".to_owned(),
        };
        let bounds = role_bounds_for_size(
            target.work_area.width as f64,
            target.work_area.height as f64,
            &rion_core::StateNormalizedRectRecord {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
        );
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (600.0, 0.0, 600.0, 800.0)
        );
    }

    #[test]
    fn window_move_coordinates_remain_scaled_after_unlocked_native_queries() {
        for (platform, physical_x, physical_y, scale, expected) in [
            ("macos", 1_846, 60, 2.0, (923, 30)),
            ("windows", -300, 225, 1.5, (-200, 150)),
        ] {
            let logical = logical_window_position(physical_x, physical_y, scale);
            assert_eq!(
                logical, expected,
                "unexpected logical position on {platform}"
            );
            assert_eq!(
                physical_window_position(logical.0, logical.1, scale),
                (physical_x, physical_y),
                "unexpected restored physical position on {platform}"
            );
        }
        assert_eq!(physical_window_position(120, -40, f64::NAN), (120, -40));
    }

    #[test]
    fn native_window_query_runs_after_runtime_mutex_is_released() {
        let state = Mutex::new(41);
        let result = query_unlocked_snapshot(
            &state,
            |value| Some(*value),
            |snapshot| {
                assert!(state.try_lock().is_ok());
                snapshot + 1
            },
        );
        assert_eq!(result, Some(42));
    }

    #[test]
    fn runtime_host_visibility_policy_is_resolved_after_the_state_snapshot() {
        for (platform, reveal, retain_visibility, currently_visible, expected) in [
            ("macos", true, false, false, true),
            ("macos", false, true, true, true),
            ("windows", false, false, true, false),
            ("windows", false, true, false, false),
        ] {
            assert_eq!(
                runtime_host_should_be_visible(reveal, retain_visibility, currently_visible),
                expected,
                "unexpected runtime host visibility on {platform}"
            );
        }
    }

    #[test]
    fn initialized_surface_hosts_follow_explicit_visibility_ownership() {
        for (platform, initialized, desired_visibility, applied_visibility, expected) in [
            ("macos", true, Some(true), None, false),
            ("windows", true, Some(true), None, false),
            ("macos", true, Some(false), None, true),
            ("windows", true, Some(false), None, true),
            ("macos", true, Some(false), Some(true), false),
            ("windows", true, Some(false), Some(true), false),
            ("macos", true, Some(true), Some(false), true),
            ("windows", true, Some(true), Some(false), true),
            ("macos", true, None, None, false),
            ("windows", true, None, None, false),
            ("macos", false, Some(false), Some(false), false),
            ("windows", false, Some(false), Some(false), false),
        ] {
            assert_eq!(
                surface_host_initialization_should_restore_hidden(
                    initialized,
                    desired_visibility,
                    applied_visibility,
                ),
                expected,
                "{platform}: initialized={initialized}, desired={desired_visibility:?}, applied={applied_visibility:?}"
            );
        }
    }

    #[test]
    fn unchanged_surface_host_initialization_skips_the_state_snapshot() {
        let snapshot_called = std::cell::Cell::new(false);
        let skipped = snapshot_initialized_surface_host(false, || {
            snapshot_called.set(true);
            "window-1"
        });
        assert_eq!(skipped, None);
        assert!(!snapshot_called.get());

        let captured = snapshot_initialized_surface_host(true, || {
            snapshot_called.set(true);
            "window-1"
        });
        assert_eq!(captured, Some("window-1"));
        assert!(snapshot_called.get());
    }

    #[test]
    fn empty_runtime_hosts_honor_explicit_focus_requests_on_macos_and_windows() {
        for (platform, focus_requested, has_active_tab, expected) in [
            ("macos", true, false, true),
            ("windows", true, false, true),
            ("macos", true, true, false),
            ("windows", true, true, false),
            ("macos", false, false, false),
            ("windows", false, false, false),
        ] {
            assert_eq!(
                runtime_host_should_receive_window_focus(focus_requested, has_active_tab),
                expected,
                "{platform}: focus={focus_requested}, activeTab={has_active_tab}"
            );
        }
    }
