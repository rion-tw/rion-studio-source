use super::*;

    #[test]
    fn reload_label_is_localized_for_every_supported_language() {
        for (language, expected) in [
            ("en", "Reload"),
            ("zh-TW", "重新整理"),
            ("zh-CN", "重新加载"),
            ("ja", "再読み込み"),
        ] {
            assert_eq!(labels(language).reload, expected, "{language}");
        }
    }

    #[test]
    fn launcher_loading_label_is_localized_for_every_supported_language() {
        for language in ["en", "zh-TW", "zh-CN", "ja"] {
            assert!(!labels(language).loading.is_empty(), "{language}");
        }
    }

    #[test]
    fn save_window_label_is_localized_for_every_supported_language() {
        for (language, expected) in [
            ("en", "Save as New Game Window"),
            ("zh-TW", "儲存為新遊戲視窗"),
            ("zh-CN", "保存为新游戏窗口"),
            ("ja", "新しいゲームウインドウとして保存"),
        ] {
            assert_eq!(labels(language).save_window, expected, "{language}");
        }
    }

    #[test]
    fn runtime_menu_events_are_recognized_before_app_state_resolution() {
        for id in [
            "runtime-tab-activate:tab-1",
            "runtime-tab-hide:tab-1",
            "runtime-tab-launch-role:window-1:role-1",
            "runtime-tab-launch-workspace:window-1:workspace-1",
            "runtime-tab-move:tab-1:window-2",
            "runtime-tab-move-new:tab-1",
            "runtime-tab-mute:tab-1",
            "runtime-tab-reload:tab-1",
            "runtime-window-save:window-1",
            "runtime-tab-stop:tab-1",
        ] {
            assert!(is_runtime_menu_event(id), "{id}");
        }
        assert!(!is_runtime_menu_event("open-app"));
    }

    #[test]
    fn launcher_menu_item_ids_preserve_their_source_window() {
        let first = launcher_menu_item_id(LAUNCH_ROLE_PREFIX, "window-1", "role-1");
        let second = launcher_menu_item_id(LAUNCH_ROLE_PREFIX, "window-2", "role-1");
        let workspace =
            launcher_menu_item_id(LAUNCH_WORKSPACE_PREFIX, "window-1", "workspace:daily");

        assert_eq!(first, "runtime-tab-launch-role:window-1:role-1".to_owned());
        assert_ne!(first, second);
        assert_eq!(
            parse_launcher_menu_target(first.strip_prefix(LAUNCH_ROLE_PREFIX).unwrap()),
            Ok(("window-1", "role-1"))
        );
        assert_eq!(
            parse_launcher_menu_target(workspace.strip_prefix(LAUNCH_WORKSPACE_PREFIX).unwrap()),
            Ok(("window-1", "workspace:daily"))
        );
    }

    #[test]
    fn launcher_menu_targets_reject_missing_window_or_source_ids() {
        for value in ["window-only", ":role-1", "window-1:"] {
            assert_eq!(
                parse_launcher_menu_target(value),
                Err("runtime launcher menu target is invalid".to_owned()),
                "{value}"
            );
        }
    }

    #[test]
    fn launcher_presence_marks_workspaces_and_their_actual_roles() {
        let presence = crate::system_runtime::RuntimeLauncherPresence {
            tabs: vec![crate::system_runtime::RuntimeLauncherPresenceTab {
                role_ids: vec!["role-a".to_owned(), "role-b".to_owned()],
                source_id: "workspace-a".to_owned(),
                tab_id: "tab-a".to_owned(),
                tab_type: "workspace".to_owned(),
            }],
            windows: Vec::new(),
        };

        assert_eq!(
            launcher_presence_tab(&presence, "workspace-a", true).map(|tab| tab.tab_id.as_str()),
            Some("tab-a")
        );
        assert_eq!(
            launcher_presence_tab(&presence, "role-b", false).map(|tab| tab.tab_id.as_str()),
            Some("tab-a")
        );
        assert!(launcher_presence_tab(&presence, "role-c", false).is_none());
        assert_eq!(launcher_item_label("Role B", true), "✓ Role B");
        assert_eq!(launcher_item_label("Role C", false), "Role C");
    }

    #[test]
    fn launcher_catalog_and_presence_revisions_advance_independently() {
        let mut state = RefreshState {
            catalog: Some(LauncherCatalog {
                game_windows: serde_json::json!([]),
                language: "en".to_owned(),
                roles: serde_json::json!([]),
                workspaces: serde_json::json!([]),
            }),
            catalog_applied_revision: 7,
            presence_revision: 2,
            ..RefreshState::default()
        };

        assert_eq!(
            desired_launcher_revision(&state),
            Some(LauncherMenuRevision {
                catalog: 7,
                presence: 2,
            })
        );
        state.presence_revision = 3;
        assert_eq!(
            desired_launcher_revision(&state),
            Some(LauncherMenuRevision {
                catalog: 7,
                presence: 3,
            })
        );
        state.catalog_applied_revision = 8;
        assert_eq!(
            desired_launcher_revision(&state),
            Some(LauncherMenuRevision {
                catalog: 8,
                presence: 3,
            })
        );
    }
