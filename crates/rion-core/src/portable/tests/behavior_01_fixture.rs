use super::*;
    use tempfile::tempdir;

    fn fixture(schema: u64) -> String {
        json!({
            "app":"Rion Studio","schemaVersion":schema,"exportedAt":"2026-01-01T00:00:00Z","appVersion":"1.37.0",
            "games": if schema >= 2 { json!([{"id":"g1","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit"}]) } else { json!([]) },
            "roles":[{"id":"r1","gameId": if schema >= 2 { "g1" } else { "" },"name":"Role","launchUrl":"https://example.test/play","notes":""}],
            "launchWorkspaces":[{"id":"w1","name":"Workspace","template":"single","browserZoomPercent":100,"slots":[{"id":"s1","roleId":"r1","rect":{"x":0,"y":0,"width":1,"height":1}}]}],
            "gameWindows":[],
            "macros":[{"id":"m1","name":"Macro","roleIds":["r1"],"repeat":{"type":"once"},"steps":[{"id":"step","type":"delay","ms":1}]}]
        }).to_string()
    }

    fn fixture_value(schema: u64) -> Value {
        serde_json::from_str(&fixture(schema)).unwrap()
    }

    #[test]
    fn runtime_authority_fixture_uses_the_current_portable_contract() {
        let source = include_str!(
            "../../../../../tests/fixtures/runtime-authority/portable.json"
        );
        let normalized = normalize(source).unwrap();
        let data = serde_json::from_value::<PortableDataRecord>(normalized).unwrap();
        assert_eq!(data.schema_version, PORTABLE_SCHEMA_VERSION as u32);
        assert_eq!(data.games.len(), 1);
        assert_eq!(data.roles.len(), 6);
        assert_eq!(data.launch_workspaces.len(), 3);
        assert_eq!(data.game_windows.len(), 3);
        assert_eq!(data.macros.len(), 3);
        assert!(data.roles.iter().all(|role| {
            role.name.starts_with("[Runtime QA]")
                && role.launch_url.starts_with("http://127.0.0.1:41739/")
        }));
        let dormant_workspace = data
            .launch_workspaces
            .iter()
            .find(|workspace| workspace.name == "[Runtime QA] Dormant Admission")
            .unwrap();
        assert!(data.game_windows.iter().all(|window| window
            .tabs
            .iter()
            .all(|tab| tab.source_id != dormant_workspace.id)));
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                source,
                "/tmp/runtime-authority-portable.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();
        let mut repeat = PortableRuntime::default();
        let repeat_preview = repeat
            .preview(
                source,
                "/tmp/runtime-authority-portable.json".to_owned(),
                prepared.snapshot,
            )
            .unwrap();
        assert_eq!(repeat_preview.operations.games.unchanged, 1);
        assert_eq!(repeat_preview.operations.roles.unchanged, 6);
        assert_eq!(repeat_preview.operations.launch_workspaces.unchanged, 3);
        assert_eq!(repeat_preview.operations.game_windows.unchanged, 3);
        assert_eq!(repeat_preview.operations.macros.unchanged, 3);
    }

    fn state_fixture() -> CoreStateSnapshotRecord {
        serde_json::from_value(json!({
            "games": [{
                "id":"g","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles": [{
                "id":"r","gameId":"g","name":"Role","launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "launchWorkspaces": [],
            "macros": [{
                "id":"m","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["r"],
                "repeat":{"type":"once"},"steps":[{"id":"delay","type":"delay","ms":1}],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "compatibilityReports": []
        }))
        .unwrap()
    }

    #[test]
    fn portable_target_validation_precedes_persistence_and_checks_relationships() {
        let valid = state_fixture();
        validate_portable_target_snapshot(&valid).unwrap();

        let mut invalid = valid;
        invalid.roles[0].game_id = "missing-game".to_owned();
        let error = validate_portable_target_snapshot(&invalid).unwrap_err();

        assert_eq!(error.code(), "CORE_INPUT_INVALID");
        assert!(error.to_string().contains("missing game"));
    }

    #[test]
    fn portable_game_windows_remap_dependencies_and_preserve_cross_window_role_claims() {
        let mut source = fixture_value(15);
        let first_window_id = uuid::Uuid::new_v4().to_string();
        let second_window_id = uuid::Uuid::new_v4().to_string();
        source["gameWindows"] = json!([
            {
                "id": first_window_id,
                "name": "Imported Window",
                "targetDisplay": { "id": 7 },
                "placement": {
                    "normalBounds": { "x": 20, "y": 20, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "maximized"
                },
                "tabs": [{
                    "id": uuid::Uuid::new_v4().to_string(),
                    "tabType": "workspace",
                    "sourceId": "w1",
                    "name": "Workspace",
                    "roleIds": ["r1"],
                    "hidden": true,
                    "audioMuted": true,
                    "roleViews": [{
                        "roleId": "r1",
                        "rect": { "x": 0, "y": 0, "width": 1, "height": 1 },
                        "browserZoomPercent": 90
                    }]
                }],
                "activeTabId": null
            },
            {
                "id": second_window_id,
                "name": "Second Window",
                "targetDisplay": { "id": 7 },
                "placement": {
                    "normalBounds": { "x": 40, "y": 40, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                },
                "tabs": [{
                    "id": uuid::Uuid::new_v4().to_string(),
                    "tabType": "role",
                    "sourceId": "r1",
                    "name": "Duplicate role",
                    "roleIds": ["r1"],
                    "hidden": false,
                    "audioMuted": false,
                    "roleViews": []
                }],
                "activeTabId": null
            }
        ]);
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &source.to_string(),
                "/tmp/game-windows.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();

        assert_eq!(prepared.snapshot.game_windows.len(), 2);
        assert_eq!(prepared.snapshot.game_windows[0].tabs.len(), 1);
        assert!(prepared.snapshot.game_windows[0].tabs[0].hidden);
        assert!(prepared.snapshot.game_windows[0].tabs[0].audio_muted);
        assert_eq!(
            prepared.snapshot.game_windows[0].placement.presentation,
            "maximized"
        );
        assert_eq!(prepared.snapshot.game_windows[1].tabs.len(), 1);
        assert_eq!(
            prepared.snapshot.game_windows[1].tabs[0].source_id,
            prepared.snapshot.game_windows[0].tabs[0].role_slots[0].role_id
        );
        assert!(
            prepared
                .result
                .warnings
                .iter()
                .all(|warning| warning.code != "GAME_WINDOW_TAB_ROLE_CONFLICT")
        );
    }

    #[test]
    fn rejects_cycles_and_unsupported_versions() {
        let mut cycle: Value = serde_json::from_str(&fixture(11)).unwrap();
        cycle["macros"] = json!([
            {
                "id":"a","name":"A","roleIds":["r1"],"repeat":{"type":"once"},
                "steps":[{"id":"call-b","type":"macro","macroId":"b"}]
            },
            {
                "id":"b","name":"B","roleIds":["r1"],"repeat":{"type":"once"},
                "steps":[{"id":"call-a","type":"macro","macroId":"a"}]
            }
        ]);
        {
            let error = normalize(&cycle.to_string()).unwrap_err();
            assert_eq!(error.code(), "PORTABLE_MACRO_DEPENDENCY_INVALID");
        };
        let future = fixture(11).replace("\"schemaVersion\":11", "\"schemaVersion\":20");
        assert!(normalize(&future).is_err());
    }

    #[test]
    fn schemas_eleven_through_thirteen_discard_retired_sync_data_with_warning() {
        for schema in 11..=13 {
            let mut source = fixture_value(schema);
            source["games"][0]["localStorageSyncKeys"] = json!(["game_client_settings"]);
            source["games"][0]["localStorageSyncSelectors"] = json!(["audio"]);
            source["roles"][0]["localStorageSourceRoleId"] = json!("source-role");

            let normalized = normalize(&source.to_string()).unwrap();

            assert_eq!(normalized["schemaVersion"], 19);
            assert!(normalized["games"][0].get("localStorageSyncKeys").is_none());
            assert!(normalized["games"][0].get("localStorageSyncSelectors").is_none());
            assert!(normalized["roles"][0].get("localStorageSourceRoleId").is_none());

            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "legacy.rion.json".to_owned(),
                    CoreStateSnapshotRecord::default(),
                )
                .unwrap();
            assert!(preview
                .warnings
                .iter()
                .any(|warning| warning.code == "LOCAL_STORAGE_SYNC_IGNORED"));
        }
    }

    fn empty_snapshot() -> CoreStateSnapshotRecord {
        CoreStateSnapshotRecord::default()
    }

    #[test]
    fn rust_runtime_owns_preview_selection_and_single_apply_snapshot() {
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &fixture(11),
                "/tmp/import.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();
        assert_eq!(preview.operations.games.create, 1);
        assert_eq!(preview.operations.roles.create, 1);
        assert_eq!(preview.operations.launch_workspaces.create, 1);
        assert_eq!(preview.operations.macros.create, 1);

        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: true,
                    preferences: false,
                },
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();
        assert_eq!(prepared.snapshot.games.len(), 1);
        assert_eq!(prepared.snapshot.roles.len(), 1);
        assert_eq!(prepared.snapshot.macros.len(), 1);
        assert!(prepared.snapshot.launch_workspaces.is_empty());
        assert!(prepared.result.selection.games);
        assert!(prepared.result.selection.roles);
        assert!(prepared.result.selection.macros);
        assert!(!prepared.result.selection.launch_workspaces);
    }

    #[test]
    fn portable_macro_schema_and_dependency_contracts() {
        {
            let mut source = fixture_value(11);
            source["roles"] = json!([]);
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([
                {
                    "id":"child","name":"Child","roleIds":[],"repeat":{"type":"once"},
                    "steps":[{"id":"child-delay","type":"delay","ms":1}]
                },
                {
                    "id":"parent","name":"Parent","roleIds":[],"repeat":{"type":"once"},
                    "steps":[{"id":"call-child","type":"macro","macroId":"child"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/unassigned.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(prepared.snapshot.macros.len(), 2);
            let child_id = &prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Child")
                .unwrap()
                .id;
            let parent = prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Parent")
                .unwrap();
            assert!(parent.role_ids.is_empty());
            assert!(parent.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == child_id
            )));
        };

        {
            let mut current = fixture_value(11);
            current["macros"][0]["steps"] = json!([{
                "id":"key","type":"key","code":"KeyK","modifiers":["primary","shift"]
            }]);
            let normalized = normalize(&current.to_string()).unwrap();
            assert_eq!(
                normalized["macros"][0]["steps"][0]["modifiers"],
                json!(["primary", "shift"])
            );
        };

        {
            let mut source = fixture_value(11);
            source["macros"][0]["activationMode"] = json!("while_held");
            source["macros"][0]["trigger"] =
                json!({"code":"F6","ctrl":false,"alt":false,"shift":false,"meta":false});
            source["macros"][0]["steps"] = json!([{
                "id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"
            }]);
            let normalized = normalize(&source.to_string()).unwrap();
            assert_eq!(normalized["macros"][0]["activationMode"], "while_held");
            assert_eq!(
                normalized["macros"][0]["steps"][0]["action"],
                "hold_until_stop"
            );
        };

        {
            let mut source = fixture_value(11);
            source["macros"] = json!([
                {
                    "id":"parent","name":"Parent","roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"call","type":"macro","macroId":"child"}]
                },
                {
                    "id":"child","name":"Child","roleIds":["r1"],
                    "activationMode":"while_held",
                    "trigger":{"code":"F7","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/two-pass.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            let child = prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Child")
                .unwrap();
            let parent = prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Parent")
                .unwrap();
            assert_ne!(child.id, "child");
            assert!(parent.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == &child.id
            )));
            assert_eq!(child.activation_mode.as_deref(), Some("while_held"));
        };

        {
            let mut source = fixture_value(11);
            source["macros"] = json!([
                {
                    "id":"target","name":"Unavailable target","roleIds":["missing"],
                    "repeat":{"type":"once"},"steps":[{"id":"delay","type":"delay","ms":1}]
                },
                {
                    "id":"parent","name":"Dependent parent","roleIds":["r1"],
                    "repeat":{"type":"once"},
                    "steps":[{"id":"call","type":"macro","macroId":"target"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/missing-dependency.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(preview.operations.macros.skip, 2);
            assert_eq!(
                preview
                    .warnings
                    .iter()
                    .filter(|warning| {
                        matches!(
                            warning.code.as_str(),
                            "MACRO_SKIPPED_NO_ROLES" | "MACRO_SKIPPED_MISSING_DEPENDENCY"
                        )
                    })
                    .count(),
                2
            );
        };
    }

    #[test]
    fn portable_export_selection_and_preferences() {
        {
            let exported = export(
                state_fixture(),
                None,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: true,
                    preferences: false,
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(exported.games.len(), 1);
            assert_eq!(exported.roles.len(), 1);
            assert_eq!(exported.macros.len(), 1);
            assert!(exported.launch_workspaces.is_empty());
            assert!(exported.preferences.is_none());
        };

        {
            let mut snapshot = state_fixture();
            snapshot.roles.clear();
            snapshot.macros.clear();
            let exported = export(
                snapshot,
                None,
                PortableDataSelectionRecord {
                    games: true,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: false,
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(exported.games.len(), 1);
            assert!(exported.roles.is_empty());
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &serde_json::to_string(&exported).unwrap(),
                    "/tmp/games-only.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(preview.game_count, 1);
            assert_eq!(preview.role_count, 0);
        };

        {
            let error = export(
                empty_snapshot(),
                None,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: false,
                },
                "2.0.0",
            )
            .unwrap_err();
            assert_eq!(error.code(), "PORTABLE_SELECTION_EMPTY");
        };

        {
            let preferences = PortablePreferencesRecord {
                game_browser_settings: None,
                language: None,
                macro_settings: Some(crate::domain::default_macro_settings()),
                theme_mode: None,
            };
            let exported = export(
                state_fixture(),
                Some(preferences),
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: true,
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(exported.schema_version, 19);
            let settings = exported.preferences.unwrap().macro_settings.unwrap();
            assert_eq!(settings.startup_delay_ms, 100);
            assert_eq!(settings.default_loop_delay_ms, 1_000);
        };

        {
            let mut source = fixture_value(11);
            source["preferences"] = json!({"language":"ja","themeMode":"light"});
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/preferences-only.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    PortableDataSelectionRecord {
                        games: false,
                        roles: false,
                        launch_workspaces: false,
                        game_windows: false,
                        macros: false,
                        preferences: true,
                    },
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(prepared.result.game_count, 0);
            assert_eq!(prepared.result.role_count, 0);
            assert_eq!(prepared.result.macro_count, 0);
            assert!(prepared.result.preferences_included);
            assert_eq!(
                prepared
                    .result
                    .preferences
                    .as_ref()
                    .and_then(|preferences| preferences.language.as_deref()),
                Some("ja")
            );
        };

        {
            let mut source = fixture_value(11);
            source["preferences"] = json!({"language":"en"});
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/retry-selection.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let empty = runtime.prepare_apply(
                &preview.import_id,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: false,
                },
                Vec::new(),
                empty_snapshot(),
            );
            assert!(matches!(
                empty,
                Err(CoreError::Domain {
                    code: "PORTABLE_SELECTION_EMPTY",
                    ..
                })
            ));
            let retry = runtime
                .prepare_apply(
                    &preview.import_id,
                    PortableDataSelectionRecord {
                        games: false,
                        roles: false,
                        launch_workspaces: false,
                        game_windows: false,
                        macros: false,
                        preferences: true,
                    },
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(retry.result.preferences_included);
        };
    }

    #[test]
    fn portable_export_never_contains_device_local_runtime_restore_state() {
        let mut snapshot = state_fixture();
        snapshot.runtime_restore_session = Some(
            serde_json::from_value(json!({
                "schemaVersion": 1,
                "updatedAt": "2026-07-25T00:00:00Z",
                "cleanExit": true,
                "windows": [{
                    "id": "window-1",
                    "targetDisplay": {"id": 7},
                    "wasVisible": true,
                    "tabs": [{
                        "tabType": "role",
                        "sourceId": "r",
                        "name": "Role",
                        "roleIds": ["r"],
                        "hidden": false,
                        "audioMuted": false
                    }]
                }]
            }))
            .unwrap(),
        );

        let exported = export(
            snapshot,
            None,
            PortableDataSelectionRecord {
                games: true,
                roles: true,
                launch_workspaces: false,
                game_windows: false,
                macros: true,
                preferences: false,
            },
            "2.0.0",
        )
        .unwrap();
        let exported = serde_json::to_value(exported).unwrap();

        assert!(exported.get("runtimeRestoreSession").is_none());
        assert!(exported.get("runtimeWindowPreferences").is_none());
        assert!(exported.get("quickAccessPreferences").is_none());
    }

    #[test]
    fn portable_preferences_do_not_export_or_overwrite_device_log_level() {
        let mut snapshot = state_fixture();
        snapshot.log_level = Some(crate::model::LogLevel::Debug);
        let preferences = PortablePreferencesRecord {
            game_browser_settings: None,
            language: Some("en".to_owned()),
            macro_settings: None,
            theme_mode: None,
        };
        let exported = export(
            snapshot.clone(),
            Some(preferences),
            PortableDataSelectionRecord {
                games: false,
                roles: false,
                launch_workspaces: false,
                game_windows: false,
                macros: false,
                preferences: true,
            },
            "2.0.0",
        )
        .unwrap();
        assert!(
            serde_json::to_value(&exported)
                .unwrap()
                .get("logLevel")
                .is_none()
        );

        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &serde_json::to_string(&exported).unwrap(),
                "/tmp/preferences-with-local-log-level.json".to_owned(),
                snapshot.clone(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: true,
                },
                Vec::new(),
                snapshot,
            )
            .unwrap();
        assert_eq!(
            prepared.snapshot.log_level,
            Some(crate::model::LogLevel::Debug)
        );
    }
