use serde_json::json;

    use crate::MacosHighRefreshMode;
    use super::*;

    fn macro_input(value: Value) -> MacroCreateInputRecord {
        serde_json::from_value(value).unwrap()
    }

    fn macro_update(value: Value) -> MacroUpdateInputRecord {
        serde_json::from_value(value).unwrap()
    }

    fn workspace_input(value: Value) -> WorkspaceCreateInputRecord {
        serde_json::from_value(value).unwrap()
    }

    fn game_window_input(name: &str) -> GameWindowCreateInputRecord {
        serde_json::from_value(json!({
            "name": name,
            "targetDisplay": { "id": 7 },
            "placement": {
                "normalBounds": { "x": 900, "y": 600, "width": 100, "height": 100 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1000, "height": 700 },
                "presentation": "normal"
            }
        }))
        .unwrap()
    }

    fn game_record(value: Value) -> StateGameRecord {
        serde_json::from_value(value).unwrap()
    }

    fn role_record(value: Value) -> StateRoleRecord {
        serde_json::from_value(value).unwrap()
    }

    fn assert_workspace_template(template: &str, expected_rects: &[[f64; 4]]) {
        let mut workspaces = Vec::new();
        let workspace = create_workspace(
            &mut workspaces,
            workspace_input(json!({"name":"Layout","template":template})),
        )
        .unwrap();
        assert_eq!(workspace.slots.len(), expected_rects.len());
        for (slot, expected) in workspace.slots.iter().zip(expected_rects) {
            assert_eq!(
                [slot.rect.x, slot.rect.y, slot.rect.width, slot.rect.height],
                *expected
            );
        }
    }

    #[test]
    fn validates_typed_domain_records() {
        let game = json!({
            "id":"g1","source":"custom","name":"Game",
            "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
        });
        validate_collection_record(StateCollection::Games, &game).unwrap();
        let mut invalid = game;
        invalid["defaultLaunchUrl"] = json!("file:///tmp/game");
        assert!(validate_collection_record(StateCollection::Games, &invalid).is_err());
    }

    #[test]
    fn game_windows_normalize_geometry_enforce_limits_and_reject_role_conflicts() {
        let mut windows = Vec::new();
        let first = create_game_window(&mut windows, game_window_input("  Main  ")).unwrap();
        assert_eq!(first.name, "Main");
        assert_eq!(first.placement.normal_bounds.width, 640);
        assert_eq!(first.placement.normal_bounds.height, 480);
        assert_eq!(first.placement.normal_bounds.x, 360);
        assert_eq!(first.placement.normal_bounds.y, 220);
        assert_eq!(
            create_game_window(&mut windows, game_window_input("main"))
                .unwrap_err()
                .code(),
            "GAME_WINDOW_NAME_DUPLICATE"
        );

        let second = create_game_window(&mut windows, game_window_input("Second")).unwrap();
        let role_tab = |id: String| {
            serde_json::from_value(json!({
                "id": id,
                "tabType": "role",
                "sourceId": "role-1",
                "name": "Role 1",
                "roleIds": ["role-1"],
                "hidden": false,
                "audioMuted": false,
                "roleViews": []
            }))
            .unwrap()
        };
        update_game_window(
            &mut windows,
            &first.id,
            GameWindowUpdateInputRecord {
                tabs: Some(vec![role_tab(Uuid::new_v4().to_string())]),
                ..GameWindowUpdateInputRecord::default()
            },
        )
        .unwrap();
        update_game_window(
            &mut windows,
            &second.id,
            GameWindowUpdateInputRecord {
                tabs: Some(vec![role_tab(Uuid::new_v4().to_string())]),
                ..GameWindowUpdateInputRecord::default()
            },
        )
        .unwrap();
        assert_eq!(
            update_game_window(
                &mut windows,
                &second.id,
                GameWindowUpdateInputRecord {
                    tabs: Some(vec![
                        role_tab(Uuid::new_v4().to_string()),
                        role_tab(Uuid::new_v4().to_string()),
                    ]),
                    ..GameWindowUpdateInputRecord::default()
                },
            )
            .unwrap_err()
            .code(),
            "GAME_WINDOW_TAB_CONFLICT"
        );

        for number in 3..=32 {
            create_game_window(&mut windows, game_window_input(&format!("Window {number}")))
                .unwrap();
        }
        assert_eq!(
            create_game_window(&mut windows, game_window_input("Window 33"))
                .unwrap_err()
                .code(),
            "GAME_WINDOW_LIMIT_REACHED"
        );

        let mut tab_windows = Vec::new();
        let tab_window =
            create_game_window(&mut tab_windows, game_window_input("Tab limit")).unwrap();
        let tabs = (0..257)
            .map(|index| {
                let role_id = format!("role-{index}");
                serde_json::from_value(json!({
                    "id": Uuid::new_v4().to_string(),
                    "tabType": "role",
                    "sourceId": role_id,
                    "name": format!("Role {index}"),
                    "roleIds": [role_id],
                    "hidden": false,
                    "audioMuted": false,
                    "roleViews": []
                }))
                .unwrap()
            })
            .collect();
        assert_eq!(
            update_game_window(
                &mut tab_windows,
                &tab_window.id,
                GameWindowUpdateInputRecord {
                    tabs: Some(tabs),
                    ..GameWindowUpdateInputRecord::default()
                },
            )
            .unwrap_err()
            .code(),
            "GAME_WINDOW_TAB_LIMIT_REACHED"
        );
    }

    #[test]
    fn runtime_game_window_save_is_atomic_and_idempotent() {
        let mut windows = Vec::new();
        let create = game_window_input("Runtime Window");
        let role_tab = |role_id: &str| {
            serde_json::from_value(json!({
                "id": Uuid::new_v4().to_string(),
                "tabType": "role",
                "sourceId": role_id,
                "name": role_id,
                "roleIds": [role_id],
                "hidden": false,
                "audioMuted": true,
                "roleViews": []
            }))
            .unwrap()
        };
        let input = GameWindowSaveRuntimeInputRecord {
            window_id: Uuid::new_v4().to_string(),
            name: create.name,
            target_display: create.target_display,
            placement: create.placement,
            tabs: vec![role_tab("role-1")],
            active_tab_id: None,
        };
        let saved = save_runtime_game_window(&mut windows, input.clone()).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(saved.tabs.len(), 1);
        assert!(saved.tabs[0].audio_muted);

        let retried = save_runtime_game_window(&mut windows, input).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(retried.id, saved.id);
        assert_eq!(retried.created_at, saved.created_at);

        let invalid_create = game_window_input("Invalid Runtime Window");
        let invalid = GameWindowSaveRuntimeInputRecord {
            window_id: Uuid::new_v4().to_string(),
            name: invalid_create.name,
            target_display: invalid_create.target_display,
            placement: invalid_create.placement,
            tabs: vec![role_tab("role-2"), role_tab("role-2")],
            active_tab_id: None,
        };
        assert_eq!(
            save_runtime_game_window(&mut windows, invalid)
                .unwrap_err()
                .code(),
            "GAME_WINDOW_TAB_CONFLICT"
        );
        assert_eq!(windows.len(), 1);

    }

    #[test]
    fn game_window_active_tab_normalization_excludes_hidden_tabs() {
        for platform in ["darwin", "win32"] {
            let mut windows = Vec::new();
            let window = create_game_window(&mut windows, game_window_input("Main")).unwrap();
            let hidden_id = Uuid::new_v4().to_string();
            let visible_id = Uuid::new_v4().to_string();
            let tab = |id: &str, role_id: &str, hidden: bool| {
                serde_json::from_value(json!({
                    "id": id,
                    "tabType": "role",
                    "sourceId": role_id,
                    "name": role_id,
                    "roleIds": [role_id],
                    "hidden": hidden,
                    "audioMuted": false,
                    "roleViews": []
                }))
                .unwrap()
            };

            let normalized = update_game_window(
                &mut windows,
                &window.id,
                GameWindowUpdateInputRecord {
                    tabs: Some(vec![
                        tab(&hidden_id, "role-hidden", true),
                        tab(&visible_id, "role-visible", false),
                    ]),
                    active_tab_id: Some(Some(hidden_id.clone())),
                    ..GameWindowUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert_eq!(
                normalized.active_tab_id.as_deref(),
                Some(visible_id.as_str()),
                "{platform}"
            );

            let all_hidden = update_game_window(
                &mut windows,
                &window.id,
                GameWindowUpdateInputRecord {
                    tabs: Some(vec![tab(&hidden_id, "role-hidden", true)]),
                    active_tab_id: Some(Some(hidden_id.clone())),
                    ..GameWindowUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert_eq!(all_hidden.active_tab_id, None, "{platform}");
        }
    }

    #[test]
    fn normalizes_browser_and_macro_settings_before_persistence() {
        let settings = serde_json::from_value(json!({
            "fonts":{"mode":"custom","slots":{"monospace":{"source":"system","family":"  Courier   New  "}}},
            "graphics":{"mode":"high_performance"},
            "launchMode":"external",
            "macroBadgePosition":{"horizontalAlign":"right","horizontalMarginPx":80,"topPx":280},
            "performance":{"macosHighRefreshRate":true},
            "workspace":{"background":"black","gap":12}
        }))
        .unwrap();
        let settings = normalize_game_browser_settings(settings);
        assert_eq!(
            serde_json::to_value(&settings.fonts).unwrap()["slots"]["monospace"],
            json!({"source":"system","family":"Courier New"})
        );
        assert_eq!(
            settings.performance.macos_high_refresh_mode,
            MacosHighRefreshMode::Enabled
        );
        validate_game_browser_settings(&settings).unwrap();
        assert!(
            serde_json::to_value(&settings)
                .unwrap()
                .get("graphics")
                .is_none()
        );

        {
            let macros = normalize_macro_settings(MacroSettingsRecord {
                startup_delay_ms: 10_001,
                key_hold_ms: 0,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 86_400_001,
            });
            assert_eq!(macros.startup_delay_ms, 100);
            assert_eq!(macros.key_hold_ms, 30);
            assert_eq!(macros.post_input_delay_ms, 30);
            assert_eq!(macros.default_loop_delay_ms, 1_000);
        };

        {
            let defaults = default_game_browser_settings();
            validate_game_browser_settings(&defaults).unwrap();
            assert_eq!(defaults.fonts.mode, "custom");
            assert!(defaults.fonts.font_smoothing_enabled);
            assert_eq!(defaults.fonts.preset_id.as_deref(), Some("system-default"));
            assert_eq!(
                serde_json::to_value(&defaults.fonts).unwrap()["slots"]["latin"],
                json!({"source":"system","family":"system-ui"})
            );
            let legacy_default: GameBrowserSettingsRecord = serde_json::from_value(json!({
                "fonts":{"mode":"default"},
                "macroBadgePosition":{"horizontalAlign":"center","horizontalMarginPx":8,"topPx":128},
                "workspace":{"background":"material","gap":4}
            }))
            .unwrap();
            assert_eq!(
                serde_json::to_value(normalize_game_browser_settings(legacy_default.clone()).fonts)
                    .unwrap(),
                serde_json::to_value(&defaults.fonts).unwrap()
            );
            let opted_out_default: GameBrowserSettingsRecord =
                serde_json::from_value(json!({
                    "fonts":{"mode":"default","fontSmoothingEnabled":false},
                    "macroBadgePosition":{"horizontalAlign":"center","horizontalMarginPx":8,"topPx":128},
                    "workspace":{"background":"material","gap":4}
                }))
                .unwrap();
            assert!(
                !normalize_game_browser_settings(opted_out_default)
                    .fonts
                    .font_smoothing_enabled
            );
            assert_eq!(defaults.workspace.background, "material");
            assert_eq!(defaults.workspace.gap, 4);
            assert_eq!(
                defaults.performance.macos_high_refresh_mode,
                MacosHighRefreshMode::Auto
            );
            assert!(defaults.macro_overlay.show_tool_button);
            assert!(defaults.macro_overlay.show_running_badges);
            assert!(defaults.macro_overlay.show_click_markers);
            assert!(legacy_default.macro_overlay.show_tool_button);
            let invalid_overlay: GameBrowserSettingsRecord = serde_json::from_value(json!({
                "fonts":{"mode":"default"},
                "macroBadgePosition":{"horizontalAlign":"center","horizontalMarginPx":8,"topPx":128},
                "macroOverlay":{
                    "showToolButton":false,
                    "showRunningBadges":"false",
                    "showClickMarkers":null
                },
                "workspace":{"background":"material","gap":4}
            }))
            .unwrap();
            assert!(!invalid_overlay.macro_overlay.show_tool_button);
            assert!(invalid_overlay.macro_overlay.show_running_badges);
            assert!(invalid_overlay.macro_overlay.show_click_markers);
        };
        {
            let defaults = default_macro_settings();
            validate_macro_settings(&defaults).unwrap();
            assert_eq!(defaults.startup_delay_ms, 100);
            assert_eq!(defaults.key_hold_ms, 30);
            assert_eq!(defaults.post_input_delay_ms, 30);
            assert_eq!(defaults.default_loop_delay_ms, 1_000);
        };
    }

    #[test]
    fn validates_custom_google_font_family_identity_for_portable_settings() {
        let family = "Cormorant Garamond";
        let catalog_id = crate::font_catalog::custom_catalog_id(family).unwrap();
        let mut settings = default_game_browser_settings();
        settings.fonts.preset_id = None;
        settings.fonts.slots.insert(
            "latin".to_owned(),
            crate::model::BrowserFontSelectionRecord::Google {
                catalog_id: catalog_id.to_ascii_uppercase(),
                family: Some("  Cormorant   Garamond  ".to_owned()),
            },
        );

        let normalized = normalize_game_browser_settings(settings);
        assert_eq!(
            serde_json::to_value(&normalized.fonts.slots["latin"]).unwrap(),
            json!({
                "source": "google",
                "catalogId": catalog_id,
                "family": family
            })
        );
        validate_game_browser_settings(&normalized).unwrap();

        let mut invalid = normalized;
        invalid.fonts.slots.insert(
            "latin".to_owned(),
            crate::model::BrowserFontSelectionRecord::Google {
                catalog_id: crate::font_catalog::custom_catalog_id("Another Font").unwrap(),
                family: Some(family.to_owned()),
            },
        );
        assert!(
            !normalize_game_browser_settings(invalid)
                .fonts
                .slots
                .contains_key("latin")
        );
    }

    #[test]
    fn normalizes_runtime_restore_sessions_and_keeps_cross_window_sources() {
        let session: RuntimeRestoreSessionRecord = serde_json::from_value(json!({
            "schemaVersion": 9,
            "updatedAt": "stale",
            "cleanExit": false,
            "lastFocusedWindowId": "window-2",
            "liveWindowIds": [" window-2 ", "window-1", "window-2", ""],
            "windows": [
                {
                    "id": " window-1 ",
                    "targetDisplay": { "id": 7 },
                    "wasVisible": true,
                    "activeSourceId": "missing",
                    "tabs": [
                        {
                            "tabType": "role",
                            "sourceId": " role-1 ",
                            "name": " Main ",
                            "roleIds": ["role-1", "role-1", ""],
                            "hidden": false,
                            "audioMuted": true
                        },
                        {
                            "tabType": "invalid",
                            "sourceId": "ignored",
                            "name": "Ignored",
                            "roleIds": [],
                            "hidden": false,
                            "audioMuted": false
                        }
                    ]
                },
                {
                    "id": "window-2",
                    "targetDisplay": { "id": 8 },
                    "wasVisible": false,
                    "activeSourceId": "role-2",
                    "tabs": [
                        {
                            "tabType": "role",
                            "sourceId": "role-1",
                            "name": "Duplicate",
                            "roleIds": ["role-1"],
                            "hidden": false,
                            "audioMuted": false
                        },
                        {
                            "tabType": "workspace",
                            "sourceId": "workspace-conflict",
                            "name": "Conflicting Workspace",
                            "roleIds": ["role-1"],
                            "hidden": false,
                            "audioMuted": false
                        },
                        {
                            "tabType": "role",
                            "sourceId": "role-2",
                            "name": "",
                            "roleIds": ["role-2"],
                            "hidden": true,
                            "audioMuted": false
                        }
                    ]
                }
            ]
        }))
        .unwrap();

        let normalized = normalize_runtime_restore_session(session).unwrap();

        assert_eq!(normalized.schema_version, 2);
        assert!(!normalized.clean_exit);
        assert_eq!(
            normalized.last_focused_window_id.as_deref(),
            Some("window-2")
        );
        assert_eq!(normalized.windows.len(), 2);
        assert_eq!(normalized.windows[0].id, "window-1");
        assert_eq!(normalized.windows[0].active_source_id, None);
        assert_eq!(normalized.windows[0].tabs[0].name, "Main");
        assert_eq!(normalized.windows[0].tabs[0].role_ids, ["role-1"]);
        assert_eq!(normalized.windows[1].tabs.len(), 2);
        assert_eq!(normalized.windows[1].tabs[0].source_id, "role-1");
        assert_eq!(normalized.windows[1].tabs[1].source_id, "role-2");
        assert_eq!(normalized.windows[1].tabs[1].name, "role-2");
        assert_eq!(normalized.windows[1].active_source_id, None);
        assert_eq!(
            normalized.live_window_ids,
            Some(vec!["window-1".to_owned(), "window-2".to_owned()])
        );
    }

    #[test]
    fn runtime_window_preferences_default_to_startup_restore() {
        let preferences = default_runtime_window_preferences();
        assert!(!preferences.always_hide_tab_close_button);
        assert!(!preferences.always_show_toolbar_in_full_screen);
        assert!(preferences.restore_game_windows_on_startup);
        let legacy: RuntimeWindowPreferencesRecord = serde_json::from_value(json!({
            "alwaysShowToolbarInFullScreen": true
        }))
        .unwrap();
        assert!(!legacy.always_hide_tab_close_button);
        assert!(legacy.restore_game_windows_on_startup);
    }
