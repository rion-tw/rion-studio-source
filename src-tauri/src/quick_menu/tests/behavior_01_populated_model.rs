use super::*;

    fn populated_model(language: &str, legal_accepted: bool) -> MenuModel {
        MenuModel {
            game_windows: serde_json::json!([{
                "id": "active-window",
                "name": "Running Saved Window",
            }, {
                "id": "saved-window",
                "name": "Dormant Saved Window",
            }]),
            language: language.to_owned(),
            legal_accepted,
            role_statuses: serde_json::json!([
                {"roleId":"role-running","state":"running"},
                {"roleId":"role-busy","state":"launching"}
            ]),
            roles: serde_json::json!([
                {"id":"role-running","name":"Running Role"},
                {"id":"role-busy","name":"Busy Role"}
            ]),
            running_window_ids: vec!["active-window".to_owned(), "unsaved-window".to_owned()],
            transient_windows: vec![(
                "unsaved-window".to_owned(),
                "Unsaved Role".to_owned(),
            )],
            open_workspace_ids: vec!["workspace-running".to_owned()],
            workspace_statuses: serde_json::json!([
                {"workspaceId":"workspace-running","state":"running"},
                {"workspaceId":"workspace-busy","state":"launching"}
            ]),
            workspaces: serde_json::json!([
                {
                    "id":"workspace-running",
                    "name":"Running Workspace",
                    "slots":[{"roleId":"role-running"}]
                }, {
                    "id":"workspace-ready",
                    "name":"Ready Workspace",
                    "slots":[{"roleId":"role-running"}]
                }, {
                    "id":"workspace-busy",
                    "name":"Busy Workspace",
                    "slots":[{"roleId":"role-running"}]
                }, {
                    "id":"workspace-missing",
                    "name":"Missing Workspace",
                    "slots":[{"roleId":"missing-role"}]
                }
            ]),
        }
    }

    fn root_item<'a>(entries: &'a [MenuEntry], id: &str) -> Option<&'a MenuEntry> {
        entries.iter().find(|entry| match entry {
            MenuEntry::Item { id: entry_id, .. }
            | MenuEntry::CheckItem { id: entry_id, .. } => entry_id == id,
            _ => false,
        })
    }

    fn submenu<'a>(entries: &'a [MenuEntry], text: &str) -> &'a [MenuEntry] {
        entries
            .iter()
            .find_map(|entry| match entry {
                MenuEntry::Submenu {
                    text: entry_text,
                    items,
                } if entry_text == text => Some(items.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing submenu {text}"))
    }

    fn assert_item(entry: &MenuEntry, expected_text: &str, expected_enabled: bool) {
        let MenuEntry::Item { text, enabled, .. } = entry else {
            panic!("expected menu item, got {entry:?}");
        };
        assert_eq!(text, expected_text);
        assert_eq!(*enabled, expected_enabled);
    }

    fn assert_check_item(entry: &MenuEntry, expected_text: &str, expected_enabled: bool) {
        let MenuEntry::CheckItem { text, enabled, .. } = entry else {
            panic!("expected checked menu item, got {entry:?}");
        };
        assert_eq!(text, expected_text);
        assert_eq!(*enabled, expected_enabled);
    }

    #[test]
    fn quick_menu_ids_keep_domain_ids_as_opaque_suffixes() {
        let role_id = "0f15d171-2380-4bd8-aa0c-b17fe07746ad";
        let encoded = format!("{ROLE_PREFIX}{role_id}");
        assert_eq!(encoded.strip_prefix(ROLE_PREFIX), Some(role_id));
        assert!(!encoded.starts_with(WORKSPACE_PREFIX));
    }

    #[test]
    fn status_state_distinguishes_running_busy_and_missing_items() {
        let statuses = serde_json::json!([
            {"roleId":"role-running","state":"running"},
            {"roleId":"role-loading","state":"launching"}
        ]);
        assert_eq!(
            status_state(&statuses, "roleId", "role-running"),
            Some("running")
        );
        assert_eq!(
            status_state(&statuses, "roleId", "role-loading"),
            Some("launching")
        );
        assert_eq!(status_state(&statuses, "roleId", "role-missing"), None);
    }

    #[test]
    fn quick_menu_fingerprint_tracks_menu_inputs() {
        let ready = populated_model("en", true);
        let mut busy = populated_model("en", true);
        busy.role_statuses = serde_json::json!([{"roleId":"role-running","state":"launching"}]);

        assert_ne!(ready.fingerprint(), busy.fingerprint());
    }

    #[test]
    fn starter_specs_expose_open_before_the_first_model_refresh() {
        let macos = starter_spec("en", QuickMenuPlatform::Macos);
        let windows = starter_spec("en", QuickMenuPlatform::Windows);

        assert_item(macos.first().unwrap(), "Open Rion Studio", true);
        assert_eq!(macos.len(), 1);
        assert_item(windows.first().unwrap(), "Open Rion Studio", true);
        assert!(matches!(windows.get(1), Some(MenuEntry::Separator)));
        assert!(root_item(&windows, "quit-app").is_some());
    }

    #[test]
    fn platform_specs_keep_open_everywhere_and_quit_windows_only() {
        let model = populated_model("en", true);
        let windows = menu_spec(&model, QuickMenuPlatform::Windows);
        let macos = menu_spec(&model, QuickMenuPlatform::Macos);

        for entries in [&windows, &macos] {
            assert!(matches!(
                entries.first(),
                Some(MenuEntry::Item { id, .. }) if id == "open-app"
            ));
            assert!(matches!(entries.get(1), Some(MenuEntry::Separator)));
        }
        assert!(root_item(&windows, "quit-app").is_some());
        assert!(root_item(&macos, "quit-app").is_none());
    }

    #[test]
    fn platform_specs_list_saved_and_transient_live_windows() {
        let model = populated_model("en", true);
        for platform in [QuickMenuPlatform::Macos, QuickMenuPlatform::Windows] {
            let entries = menu_spec(&model, platform);
            let windows = submenu(&entries, "Windows");
            for id in ["show-display:active-window", "restore-window:saved-window"] {
                assert!(
                    root_item(&entries, id).is_none(),
                    "window action must not remain at the menu root: {id}"
                );
            }
            assert_check_item(
                root_item(windows, "show-display:active-window").unwrap(),
                "Running Saved Window",
                true,
            );
            assert_item(
                root_item(windows, "restore-window:saved-window").unwrap(),
                "Dormant Saved Window",
                true,
            );
            assert_check_item(
                root_item(windows, "show-display:unsaved-window").unwrap(),
                "Unsaved Role · Temporary Window",
                true,
            );
            assert!(root_item(windows, "show-games").is_none());
            assert_eq!(windows.len(), 3);
            assert_eq!(submenu(&entries, "Roles").len(), 2);
            assert_eq!(submenu(&entries, "Workspaces").len(), 4);
        }
    }

    #[test]
    fn role_and_workspace_submenus_keep_open_actions_for_running_items() {
        let entries = menu_spec(&populated_model("en", true), QuickMenuPlatform::Windows);
        let roles = submenu(&entries, "Roles");
        let workspaces = submenu(&entries, "Workspaces");

        assert_check_item(
            root_item(roles, "launch-role:role-running").unwrap(),
            "Running Role",
            true,
        );
        assert_item(
            root_item(roles, "launch-role:role-busy").unwrap(),
            "… Busy Role",
            false,
        );
        assert_check_item(
            root_item(workspaces, "launch-workspace:workspace-running").unwrap(),
            "Running Workspace",
            true,
        );
        assert_item(
            root_item(workspaces, "launch-workspace:workspace-ready").unwrap(),
            "Ready Workspace",
            true,
        );
        assert_item(
            root_item(workspaces, "launch-workspace:workspace-busy").unwrap(),
            "… Busy Workspace",
            false,
        );
        assert_item(
            root_item(workspaces, "launch-workspace:workspace-missing").unwrap(),
            "Missing Workspace",
            false,
        );
    }

    #[test]
    fn live_presence_keeps_a_checked_workspace_focusable_when_core_status_lags_at_stopping() {
        let mut model = populated_model("en", true);
        model.workspace_statuses =
            serde_json::json!([{"workspaceId":"workspace-running","state":"stopping"}]);

        let entries = menu_spec(&model, QuickMenuPlatform::Macos);
        assert_check_item(
            root_item(
                submenu(&entries, "Workspaces"),
                "launch-workspace:workspace-running",
            )
            .unwrap(),
            "Running Workspace",
            true,
        );
    }

    #[test]
    fn legal_gate_disables_launch_and_restore_actions_but_keeps_running_saved_windows_visible() {
        let entries = menu_spec(&populated_model("en", false), QuickMenuPlatform::Macos);

        assert!(root_item(&entries, "review-terms").is_some());
        assert_check_item(
            root_item(submenu(&entries, "Roles"), "launch-role:role-running").unwrap(),
            "Running Role",
            false,
        );
        assert_check_item(
            root_item(
                submenu(&entries, "Workspaces"),
                "launch-workspace:workspace-running",
            )
            .unwrap(),
            "Running Workspace",
            false,
        );
        assert!(matches!(
            root_item(submenu(&entries, "Windows"), "show-display:active-window"),
            Some(MenuEntry::CheckItem { enabled: true, .. })
        ));
        assert!(matches!(
            root_item(submenu(&entries, "Windows"), "restore-window:saved-window"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
    }

    #[test]
    fn empty_role_workspace_and_window_states_are_disabled() {
        let model = MenuModel {
            game_windows: serde_json::json!([]),
            language: "en".to_owned(),
            legal_accepted: true,
            role_statuses: serde_json::json!([]),
            roles: serde_json::json!([]),
            running_window_ids: vec![],
            transient_windows: vec![],
            open_workspace_ids: vec![],
            workspace_statuses: serde_json::json!([]),
            workspaces: serde_json::json!([]),
        };
        let entries = menu_spec(&model, QuickMenuPlatform::Windows);

        assert!(matches!(
            root_item(submenu(&entries, "Roles"), "no-roles"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
        assert!(matches!(
            root_item(submenu(&entries, "Workspaces"), "no-workspaces"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
        assert!(matches!(
            root_item(submenu(&entries, "Windows"), "no-windows"),
            Some(MenuEntry::Item { enabled: false, .. })
        ));
    }

    #[test]
    fn four_supported_languages_keep_open_and_submenu_labels() {
        let cases = [
            (
                "en",
                "Open Rion Studio",
                "Roles",
                "Workspaces",
                "Windows",
                "Temporary Window",
            ),
            (
                "zh-TW",
                "開啟 Rion Studio",
                "角色",
                "工作區",
                "視窗",
                "臨時視窗",
            ),
            (
                "zh-CN",
                "打开 Rion Studio",
                "角色",
                "工作区",
                "窗口",
                "临时窗口",
            ),
            (
                "ja",
                "Rion Studio を開く",
                "ロール",
                "ワークスペース",
                "ウインドウ",
                "一時ウインドウ",
            ),
        ];

        for (language, open, roles, workspaces, windows, temporary_window) in cases {
            let labels = labels(language);
            assert_eq!(labels.open, open);
            assert_eq!(labels.roles, roles);
            assert_eq!(labels.workspaces, workspaces);
            assert_eq!(labels.windows, windows);
            assert_eq!(labels.temporary_window, temporary_window);
        }
    }

    #[test]
    fn quick_menu_routing_claims_only_its_own_global_menu_events() {
        for id in [
            "open-app",
            "quit-app",
            "launch-role:role:with:colons",
            "launch-workspace:workspace/opaque",
            "show-display:window/opaque",
            "restore-window:window/opaque",
        ] {
            assert!(is_quick_menu_action(id), "quick-menu event {id}");
        }
        for id in [
            "show-games",
            "rion-new-game-window",
            "rion-browser-zoom-in",
            "rion-show-game-window:window/opaque",
            "unknown-menu-item",
        ] {
            assert!(!is_quick_menu_action(id), "application menu event {id}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_dock_adapter_passes_its_selector_self_test() {
        assert!(crate::quick_menu_macos::native_adapter_self_test());
    }
