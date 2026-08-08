#[test]
    fn native_launch_errors_keep_their_code_and_message_in_diagnostics() {
        let error = log_error_details("SYSTEM_ROLE_SETUP_FAILED", "WebView2 setup failed");
        assert_eq!(error.name, "SYSTEM_ROLE_SETUP_FAILED");
        assert_eq!(error.message, "WebView2 setup failed");
        assert!(error.stack.is_none());
        assert!(error.cause.is_none());
    }

    #[test]
    fn matching_fullscreen_runtime_targets_preserve_native_window_presentation() {
        for (platform, fullscreen, presentation, expected) in [
            ("macos", true, "fullscreen", false),
            ("windows", true, "fullscreen", false),
            ("macos", false, "fullscreen", true),
            ("windows", false, "fullscreen", true),
            ("macos", true, "normal", true),
            ("windows", true, "normal", true),
            ("macos", true, "maximized", true),
            ("windows", true, "maximized", true),
        ] {
            assert_eq!(
                runtime_target_requires_placement_reapply(presentation, fullscreen),
                expected,
                "unexpected placement policy on {platform}: fullscreen={fullscreen}, presentation={presentation}"
            );
        }
    }

    #[test]
    fn surface_host_initialization_requires_a_visible_parent_only_on_windows() {
        for (platform, expected) in [("windows", true), ("macos", false), ("linux", false)] {
            assert_eq!(
                surface_host_initialization_requires_visible_parent(platform),
                expected,
                "unexpected parent-window initialization policy on {platform}"
            );
        }
    }

    #[test]
    fn native_font_script_loads_current_settings_through_the_role_bound_bridge() {
        let source = native_font_document_start_script();
        assert!(source.contains("rion_browser_font_payload"));
        assert!(source.contains("rion-studio-browser-fonts"));
        assert!(source.contains("FontFace"));
        assert!(source.contains("CanvasRenderingContext2D"));
        assert!(source.contains("OffscreenCanvasRenderingContext2D"));
        assert!(source.contains("fillText"));
        assert!(source.contains("measureText"));
        assert!(source.contains("textRendering"));
        assert!(source.contains("fontKerning"));
        assert!(source.contains("fontSmoothingEnabled"));
        assert!(source.contains("-webkit-font-smoothing"));
        assert!(source.contains("font-optical-sizing"));
        assert!(source.contains("!important"));
        assert!(source.contains("numeric"));
        assert!(source.contains("monospace"));
        assert!(!source.contains("fonts.googleapis.com"));
        assert!(!source.contains("WebGLRenderingContext"));
        assert!(!source.contains("imageSmoothingEnabled"));
    }

    #[test]
    fn shared_macro_overlay_builds_with_the_tauri_only_bridge() {
        let template = macro_overlay_document_start_script_template().unwrap();
        let source = macro_overlay_document_start_script(&template, "test-capability").unwrap();
        assert!(source.contains("rion_overlay_request"));
        assert!(source.contains("rion_overlay_ready"));
        assert!(source.contains("binding.ready"));
        assert!(source.contains("test-capability"));
        assert!(source.contains("event.isTrusted === true"));
        assert!(source.contains("rion-studio-macro-overlay-v60"));
        assert!(source.contains("createMacroCoordinateMeasurement"));
        assert!(source.contains(MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER_SOURCE));
        assert!(source.contains("const overlayCss = \"/*"));
        assert!(source.contains("--font-ui: system-ui"));
        assert!(source.contains("*{box-sizing:border-box;font-family:var(--font-ui)"));
        assert!(source.contains("@media (prefers-reduced-motion:reduce)"));
        assert!(!source.contains(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_BINDING_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_CAPABILITY_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_TRUSTED_EVENT_GUARD_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_CSS_TOKEN));
        assert!(!source.contains(MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE_TOKEN));
        assert!(!source.contains(MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER_TOKEN));
        assert!(!source.contains("globalThis.rionStudioMacroOverlay"));
        assert!(!source.contains("chrome.webview"));
        assert!(!source.contains("webkit.messageHandlers"));
    }

    #[test]
    fn webview2_key_payload_matches_chromium_input_semantics() {
        let modifiers = cdp_modifier_mask(&[
            "ControlLeft".to_owned(),
            "ShiftRight".to_owned(),
            "KeyA".to_owned(),
        ]);
        assert_eq!(modifiers, 10);
        assert_eq!(
            cdp_key_descriptor("KeyA", modifiers),
            json!({
                "code": "KeyA",
                "key": "A",
                "windowsVirtualKeyCode": 65
            })
        );
        assert_eq!(
            cdp_key_descriptor("ShiftRight", modifiers),
            json!({
                "code": "ShiftRight",
                "key": "Shift",
                "windowsVirtualKeyCode": 16,
                "location": 2
            })
        );
        assert_eq!(
            resolve_modifier_codes(
                &["primary".to_owned(), "ctrl".to_owned(), "alt".to_owned()],
                false
            )
            .unwrap(),
            vec!["ControlLeft", "AltLeft"]
        );
    }

    #[test]
    fn windows_tab_shortcut_handoff_preserves_physical_modifier_sides() {
        assert_eq!(
            windows_shortcut_modifier_codes(true, false, false, false, false),
            ["ControlLeft"]
        );
        assert_eq!(
            windows_shortcut_modifier_codes(false, true, true, false, true),
            ["ControlRight", "ShiftRight"]
        );
        assert_eq!(
            windows_shortcut_modifier_codes(false, false, true, false, false),
            ["ControlLeft", "ShiftLeft"]
        );
        assert_eq!(
            windows_shortcut_modifier_codes(true, true, true, true, true),
            ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"]
        );
    }

    #[test]
    fn tab_shortcut_handoff_releases_shift_before_control() {
        let effects = shortcut_modifier_release_effects(&[
            "ControlRight".to_owned(),
            "ShiftRight".to_owned(),
        ]);
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0].phase, "keyUp");
        assert_eq!(effects[0].code, "ShiftRight");
        assert_eq!(effects[0].active_codes, ["ControlRight"]);
        assert_eq!(effects[1].code, "ControlRight");
        assert!(effects[1].active_codes.is_empty());
        assert!(effects.iter().all(|effect| !effect.suppress_shortcut));
    }

    #[test]
    fn overlay_focus_requires_the_requesting_tab_to_still_be_selected() {
        assert!(overlay_focus_target_is_selected(
            false,
            Some("tab-a"),
            Some("tab-a")
        ));
        assert!(!overlay_focus_target_is_selected(
            false,
            Some("tab-a"),
            Some("tab-b")
        ));
        assert!(!overlay_focus_target_is_selected(
            false,
            Some("tab-a"),
            None
        ));
        assert!(overlay_focus_target_is_selected(true, None, None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_input_preserves_active_modifier_flags() {
        assert_eq!(mac_modifier_flags(&[]), 0);
        assert_eq!(mac_modifier_flags(&["ShiftLeft".to_owned()]), 1 << 17);
        assert_eq!(
            mac_modifier_flags(&[
                "ControlLeft".to_owned(),
                "AltRight".to_owned(),
                "MetaLeft".to_owned(),
            ]),
            (1 << 18) | (1 << 19) | (1 << 20)
        );
        assert_eq!(
            resolve_modifier_codes(&["primary".to_owned(), "ctrl".to_owned()], true).unwrap(),
            vec!["MetaLeft", "ControlLeft"]
        );
        assert!(!macos_key_dispatch_needs_settle(None, "role-a"));
        assert!(!macos_key_dispatch_needs_settle(Some("role-a"), "role-a"));
        assert!(macos_key_dispatch_needs_settle(Some("role-a"), "role-b"));
    }

    #[test]
    fn surface_recovery_budget_is_bounded_and_resets_after_the_window() {
        let started = Instant::now();
        let mut budget = RecoveryBudget {
            attempts: 0,
            window_started: started,
        };
        assert!(budget.claim(started));
        assert!(budget.claim(started + Duration::from_secs(1)));
        assert!(!budget.claim(started + Duration::from_secs(2)));
        assert!(budget.claim(started + SURFACE_RECOVERY_WINDOW + Duration::from_millis(1)));
        assert_eq!(budget.attempts, 1);
    }

    #[test]
    fn click_coordinates_apply_anchor_units_and_clamp_to_viewport() {
        let viewport = ViewportSize {
            width: 1000.0,
            height: 800.0,
        };
        assert_eq!(
            resolve_click_point(Some("center"), "percent", 10.0, -25.0, viewport, 1.0)
                .unwrap(),
            ClickPoint { x: 600, y: 200 }
        );
        assert_eq!(
            resolve_click_point(
                Some("bottom-right"),
                "px",
                -10.0,
                100.0,
                viewport,
                1.0,
            )
            .unwrap(),
            ClickPoint { x: 990, y: 799 }
        );
        assert_eq!(
            resolve_click_point(None, "px", -5.0, -7.0, viewport, 1.0).unwrap(),
            ClickPoint { x: 0, y: 0 }
        );
        assert_eq!(
            resolve_click_point(
                Some("bottom-right"),
                "reference-px",
                -75.0,
                -150.0,
                viewport,
                0.75,
            )
            .unwrap(),
            ClickPoint { x: 900, y: 600 }
        );
        for (anchor, x, y, expected) in [
            ("top-left", 75.0, 75.0, ClickPoint { x: 100, y: 100 }),
            ("top-center", 75.0, 75.0, ClickPoint { x: 600, y: 100 }),
            ("top-right", -75.0, 75.0, ClickPoint { x: 900, y: 100 }),
            ("center-left", 75.0, 75.0, ClickPoint { x: 100, y: 500 }),
            ("center", 75.0, 75.0, ClickPoint { x: 600, y: 500 }),
            ("center-right", -75.0, 75.0, ClickPoint { x: 900, y: 500 }),
            ("bottom-left", 75.0, -75.0, ClickPoint { x: 100, y: 700 }),
            ("bottom-center", 75.0, -75.0, ClickPoint { x: 600, y: 700 }),
            ("bottom-right", -75.0, -75.0, ClickPoint { x: 900, y: 700 }),
        ] {
            assert_eq!(
                resolve_click_point(
                    Some(anchor),
                    "reference-px",
                    x,
                    y,
                    viewport,
                    0.75,
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn viewport_parsers_accept_webview2_and_tauri_results() {
        assert_eq!(
            parse_devtools_viewport(
                r#"{"cssVisualViewport":{"clientWidth":1024,"clientHeight":768}}"#
            ),
            Some(ViewportSize {
                width: 1024.0,
                height: 768.0
            })
        );
        assert_eq!(
            parse_evaluated_viewport(r#"{"width":640,"height":480}"#),
            Some(ViewportSize {
                width: 640.0,
                height: 480.0
            })
        );
    }

    #[test]
    fn window_and_role_zoom_layers_compose_and_clamp_on_both_platforms() {
        for platform in ["macos", "windows"] {
            assert_eq!(next_zoom_factor(1.0, "in", 0.25, 5.0), 1.05, "{platform}");
            assert_eq!(next_zoom_factor(1.0, "out", 0.25, 5.0), 0.95, "{platform}");
            assert_eq!(next_zoom_factor(0.33, "in", 0.25, 3.0), 0.38, "{platform}");
            assert_eq!(next_zoom_factor(1.8, "reset", 0.25, 5.0), 1.0, "{platform}");
            assert_eq!(next_zoom_factor(0.25, "out", 0.25, 5.0), 0.25, "{platform}");
            assert_eq!(next_zoom_factor(3.0, "in", 0.25, 3.0), 3.0, "{platform}");
            assert_eq!(effective_zoom_factor(1.25, 1.1), 1.375, "{platform}");
            assert_eq!(effective_zoom_factor(3.0, 2.0), 5.0, "{platform}");
            assert_eq!(effective_zoom_factor(0.25, 0.25), 0.25, "{platform}");
        }
    }

    #[test]
    fn role_zoom_shortcuts_cover_platform_modifiers_rows_numpad_and_repeats() {
        for platform in ["macos", "windows"] {
            let action = |key: &str, shift: bool, wrong_modifier: bool| match platform {
                "macos" => macos_role_zoom_action(
                    match key {
                        "0" => 29,
                        "numpad0" => 82,
                        "minus" => 27,
                        "numpadMinus" => 78,
                        "plus" => 24,
                        _ => 69,
                    },
                    true,
                    wrong_modifier,
                    false,
                    shift,
                ),
                _ => windows_role_zoom_action(
                    match key {
                        "0" => 0x30,
                        "numpad0" => 0x60,
                        "minus" => 0xBD,
                        "numpadMinus" => 0x6D,
                        "plus" => 0xBB,
                        _ => 0x6B,
                    },
                    true,
                    false,
                    wrong_modifier,
                    shift,
                ),
            };
            assert_eq!(action("0", false, false), Some("reset"), "{platform}");
            assert_eq!(action("numpad0", false, false), Some("reset"), "{platform}");
            assert_eq!(action("minus", false, false), Some("out"), "{platform}");
            assert_eq!(
                action("numpadMinus", false, false),
                Some("out"),
                "{platform}"
            );
            assert_eq!(action("plus", true, false), Some("in"), "{platform}");
            assert_eq!(action("numpadPlus", false, false), Some("in"), "{platform}");
            assert_eq!(action("0", false, true), None, "{platform}");
            assert_eq!(action("numpadPlus", true, false), None, "{platform}");
            for _repeat in 0..3 {
                assert_eq!(action("plus", false, false), Some("in"), "{platform}");
            }
        }
    }

    #[test]
    fn windows_application_shortcuts_cover_discrete_commands_and_repeats() {
        use crate::application_menu::ApplicationShortcutCommand;

        assert_eq!(
            windows_application_shortcut_command(0x4E, true, false, false, false, false),
            Some(ApplicationShortcutCommand::NewGameWindow)
        );
        assert_eq!(
            windows_application_shortcut_command(0x7A, false, false, false, false, false),
            Some(ApplicationShortcutCommand::ToggleFullscreen)
        );
        assert_eq!(
            windows_application_shortcut_command(0xBB, true, false, false, true, true),
            Some(ApplicationShortcutCommand::ZoomIn)
        );
        assert_eq!(
            windows_application_shortcut_command(0x4E, true, false, false, false, true),
            None
        );
        assert_eq!(
            windows_application_shortcut_command(0x7A, false, false, false, false, true),
            None
        );
        assert_eq!(
            windows_application_shortcut_command(0x7A, false, true, false, false, false),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_role_zoom_shortcut_responder_consumes_only_supported_combinations() {
        unsafe extern "C" {
            fn rion_wk_role_zoom_shortcut_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_role_zoom_shortcut_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_background_input_preserves_the_foreground_responder() {
        unsafe extern "C" {
            fn rion_wk_background_input_focus_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_background_input_focus_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_mouse_coordinates_scale_from_dom_viewport_to_native_bounds() {
        unsafe extern "C" {
            fn rion_wk_mouse_coordinate_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_mouse_coordinate_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_mouse_dispatch_preserves_target_order_and_foreground_responder() {
        unsafe extern "C" {
            fn rion_wk_mouse_dispatch_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_mouse_dispatch_self_test() });
    }

    #[test]
    fn shared_runtime_indicators_are_isolated_and_reset_the_zoom_timer() {
        let source = runtime_indicator_document_start_script().unwrap();
        assert!(source.contains("rion-studio-runtime-indicators-v1"));
        assert!(source.contains("attachShadow({ mode: \"open\" })"));
        assert!(source.contains("__rionStudioWorkspaceResizeIndicator"));
        assert!(source.contains("__rionStudioZoomIndicator"));
        assert!(source.contains("clearTimeout(zoomTimer)"));
        assert!(source.contains("1200"));
        assert!(source.contains("element.remove()"));
        assert!(!source.contains(RUNTIME_INDICATOR_CSS_TOKEN));
    }

    #[test]
    fn role_zoom_persistence_is_last_write_wins() {
        let key = ("workspace-1".to_owned(), "role-1".to_owned());
        let mut pending = HashMap::from([(key.clone(), 2)]);
        assert!(!take_latest_role_zoom_write(&mut pending, &key, 1));
        assert_eq!(pending.get(&key), Some(&2));
        assert!(take_latest_role_zoom_write(&mut pending, &key, 2));
        assert!(!pending.contains_key(&key));
    }

    #[test]
    fn private_session_files_are_published_atomically() {
        let root = tempfile::tempdir().unwrap();
        let transaction = root.path().join("transaction");
        write_private_file(&transaction, "committed", b"complete").unwrap();
        assert_eq!(
            fs::read(transaction.join("committed")).unwrap(),
            b"complete"
        );

        fs::remove_file(transaction.join("committed")).unwrap();
        fs::create_dir(transaction.join("committed")).unwrap();
        assert!(write_private_file(&transaction, "committed", b"partial").is_err());
        assert!(transaction.join("committed").is_dir());
        assert!(
            fs::read_dir(&transaction)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp"))
        );
    }
