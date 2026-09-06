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
            Path::new("/runtime/roles/role-a/browser/system")
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
    fn workspace_web_surfaces_share_one_profile_outside_role_storage() {
        let root = Path::new("/runtime");
        let first = global_web_session_paths(root);
        let second = global_web_session_paths(root);
        let role = role_session_paths(root, "role-a").unwrap();

        assert_eq!(first.webview2, Path::new("/runtime/web-profiles/global-web/webview2"));
        assert_eq!(first.webview2, second.webview2);
        assert_eq!(first.webkit_identifier, second.webkit_identifier);
        assert_ne!(first.webview2, role.webview2);
        assert_ne!(first.webkit_identifier, role.webkit_identifier);
    }

    #[test]
    fn role_cookie_checkpoint_deduplicates_native_keys_with_last_write_wins() {
        let record = |name: &str, value: &str, domain: &str| SessionCookieRecord {
            name: name.to_owned(),
            value: value.to_owned(),
            domain: Some(domain.to_owned()),
            path: "/".to_owned(),
            secure: true,
            http_only: false,
            same_site: "none".to_owned(),
            expires_unix_ms: Some(2_000),
        };
        let records = deduplicate_role_cookie_checkpoint_records(vec![
            record("analytics", "stale", ".GAME.EXAMPLE.TEST"),
            record("session", "retained", "game.example.test"),
            record("analytics", "current", "game.example.test"),
        ]);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].name, "session");
        assert_eq!(records[0].value, "retained");
        assert_eq!(records[1].name, "analytics");
        assert_eq!(records[1].value, "current");

        let restored = records
            .iter()
            .map(role_cookie_from_checkpoint)
            .collect::<RuntimeResult<Vec<_>>>()
            .unwrap();
        verify_cookie_readback(&restored, &restored).unwrap();
    }

    #[test]
    fn role_cookie_checkpoint_read_prefers_system_storage_and_accepts_the_legacy_location() {
        let directory = tempfile::tempdir().unwrap();
        let browser = role_browser_directory(directory.path(), "role-a").unwrap();
        fs::create_dir_all(&browser).unwrap();
        fs::write(browser.join(ROLE_COOKIE_CHECKPOINT_FILE), b"legacy").unwrap();

        assert_eq!(
            read_role_cookie_checkpoint_blob(directory.path(), "role-a").unwrap(),
            Some(b"legacy".to_vec())
        );

        let system = browser.join("system");
        fs::create_dir_all(&system).unwrap();
        fs::write(system.join(ROLE_COOKIE_CHECKPOINT_FILE), b"current").unwrap();
        assert_eq!(
            read_role_cookie_checkpoint_blob(directory.path(), "role-a").unwrap(),
            Some(b"current".to_vec())
        );
    }

    #[cfg(windows)]
    #[test]
    fn role_cookie_checkpoint_write_does_not_traverse_the_live_webview2_profile() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = tempfile::tempdir().unwrap();
        let paths = role_session_paths(directory.path(), "role-a").unwrap();
        fs::create_dir_all(&paths.webview2).unwrap();
        let live_profile_file = paths.webview2.join("locked-session");
        fs::write(&live_profile_file, b"live").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&live_profile_file)
            .unwrap();

        let checkpoint_directory =
            role_cookie_checkpoint_directory(directory.path(), "role-a").unwrap();
        write_private_file(
            &checkpoint_directory,
            ROLE_COOKIE_CHECKPOINT_FILE,
            b"checkpoint",
        )
        .unwrap();

        assert_eq!(
            fs::read(checkpoint_directory.join(ROLE_COOKIE_CHECKPOINT_FILE)).unwrap(),
            b"checkpoint"
        );
        drop(lock);
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

    #[test]
    fn dormant_tabs_skip_window_cookie_checkpoint_only_without_native_fences() {
        for platform in ["macos", "windows"] {
            assert!(
                native_absent_tab_can_skip_window_cookie_checkpoint(false, false),
                "{platform}: a dormant logical tab has no live session to capture"
            );
            assert!(
                !native_absent_tab_can_skip_window_cookie_checkpoint(true, false),
                "{platform}: a registered surface makes native absence stale"
            );
            assert!(
                !native_absent_tab_can_skip_window_cookie_checkpoint(false, true),
                "{platform}: an active close fence must remain authoritative"
            );
        }
    }

    #[test]
    fn workspace_contained_fullscreen_is_scoped_to_web_surfaces_and_their_popups() {
        assert!(WebviewSurfaceFeaturePolicy::Role.installs_role_features());
        assert!(!WebviewSurfaceFeaturePolicy::Role.installs_contained_fullscreen());
        assert!(!WebviewSurfaceFeaturePolicy::WorkspaceWeb.installs_role_features());
        assert!(WebviewSurfaceFeaturePolicy::WorkspaceWeb.installs_contained_fullscreen());
        assert!(!WebviewSurfaceFeaturePolicy::Utility.installs_role_features());
        assert!(!WebviewSurfaceFeaturePolicy::Utility.installs_contained_fullscreen());
    }

    #[test]
    fn workspace_contained_fullscreen_native_guard_failure_is_fail_closed() {
        let failure = require_workspace_contained_fullscreen_policy(Err(RuntimeError::new(
            "SYSTEM_CONTAINED_FULLSCREEN_POLICY_FAILED",
            "fixture failure",
        )))
        .expect_err("native guard failure must reject provisional setup");
        assert_eq!(
            failure.error.code,
            "SYSTEM_CONTAINED_FULLSCREEN_POLICY_FAILED"
        );
        assert!(failure.lifecycle.is_none());
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
    fn macos_workspace_web_policy_preserves_element_fullscreen_capability() {
        unsafe extern "C" {
            fn rion_wk_contained_fullscreen_policy_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_contained_fullscreen_policy_self_test() });
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_navigation_scope_excludes_iframes_fragments_same_urls_and_new_windows() {
        unsafe extern "C" {
            fn rion_wk_navigation_scope_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_navigation_scope_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn loaded_webkit_framework_reports_its_own_build_version() {
        let version = macos_webkit_runtime_version().expect("loaded WebKit build version");
        assert!(version.contains('.'));
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
