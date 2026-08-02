#[test]
    fn portable_validation_boundaries() {
        {
            let mut source = fixture_value(11);
            source["games"][0]["coverImageDataUrl"] = json!("https://example.test/cover.png");
            assert_eq!(
                normalize(&source.to_string()).unwrap_err().code(),
                "CORE_INPUT_INVALID"
            );
        };

        {
            assert_eq!(
                normalize(r#"{"app":"Rion Studio","schemaVersion":999}"#)
                    .unwrap_err()
                    .code(),
                "CORE_DATA_VERSION_UNSUPPORTED"
            );
            assert_eq!(normalize("{").unwrap_err().code(), "CORE_INPUT_INVALID");
        };

        {
            let mut source = fixture_value(11);
            for macro_value in [
                json!({
                    "id":"bad","enabled":true,"activationMode":"invalid","name":"Bad",
                    "roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"}]
                }),
                json!({
                    "id":"bad","enabled":true,"activationMode":"toggle","name":"Bad",
                    "roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"key_down"}]
                }),
                json!({
                    "id":"bad","enabled":true,"activationMode":"while_held","name":"Bad",
                    "roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"}]
                }),
            ] {
                source["macros"] = json!([macro_value]);
                assert_eq!(
                    normalize(&source.to_string()).unwrap_err().code(),
                    "CORE_INPUT_INVALID"
                );
            }
            source["schemaVersion"] = json!("4");
            assert_eq!(
                normalize(&source.to_string()).unwrap_err().code(),
                "CORE_DATA_VERSION_UNSUPPORTED"
            );
        };

        {
            let mut source = fixture_value(11);
            source["macros"][0]["repeat"] = json!({"type":"loop","intervalMs":86_400_000_u64});
            source["macros"][0]["steps"] =
                json!([{"id":"delay","type":"delay","ms":86_400_000_u64}]);
            assert!(normalize(&source.to_string()).is_ok());
            source["macros"][0]["steps"][0]["ms"] = json!(86_400_001_u64);
            assert!(normalize(&source.to_string()).is_err());
            source["macros"][0]["steps"][0]["ms"] = json!(86_400_000_u64);
            source["macros"][0]["repeat"]["intervalMs"] = json!(86_400_001_u64);
            assert!(normalize(&source.to_string()).is_err());
        };
    }

    #[test]
    fn portable_browser_preferences_are_normalized_before_preview() {
        {
            let mut source = fixture_value(11);
            let mut settings =
                serde_json::to_value(crate::domain::default_game_browser_settings()).unwrap();
            settings["graphics"] = json!({
                "mode":"experimental",
                "backend":{"windows":"vulkan"},
                "windowsEcoQosEnabled":false
            });
            settings["fonts"]["mode"] = json!("custom");
            settings["fonts"]["slots"] = json!({
                "cjk":{"source":"system","family":"  Missing   But   Valid  Font  "},
                "latin":{"source":"system","family":"  Missing   But   Valid  Font  "},
                "math":{"source":"system","family":"Noto Sans Math"},
                "monospace":{"source":"system","family":"Bad\u{0000}Font"}
            });
            settings["fonts"]
                .as_object_mut()
                .unwrap()
                .remove("fontSmoothingEnabled");
            settings["fonts"]
                .as_object_mut()
                .unwrap()
                .remove("presetId");
            settings["performance"]["macosHighRefreshRate"] = json!(true);
            source["preferences"] = json!({
                "gameBrowserSettings": settings,
                "browserProxySettings": {
                    "mode": "custom",
                    "custom": { "protocol": "http", "host": "127.0.0.1", "port": 8080 }
                }
            });
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/font-normalization.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let preferences = preview.preferences.unwrap();
            assert!(
                serde_json::to_value(&preferences)
                    .unwrap()
                    .get("browserProxySettings")
                    .is_none()
            );
            let browser_settings = preferences.game_browser_settings.unwrap();
            assert!(
                serde_json::to_value(&browser_settings)
                    .unwrap()
                    .get("graphics")
                    .is_none()
            );
            let fonts = &browser_settings.fonts;
            let serialized_fonts = serde_json::to_value(fonts).unwrap();
            assert_eq!(
                serialized_fonts["slots"]["cjk"],
                json!({"source":"system","family":"Missing But Valid Font"})
            );
            assert_eq!(
                serialized_fonts["slots"]["latin"],
                json!({"source":"system","family":"Missing But Valid Font"})
            );
            assert_eq!(
                serialized_fonts["slots"]["math"],
                json!({"source":"system","family":"Noto Sans Math"})
            );
            assert!(serialized_fonts["slots"].get("monospace").is_none());
            assert!(fonts.font_smoothing_enabled);
            assert!(browser_settings.performance.macos_high_refresh_rate);
        };
    }

    #[test]
    fn portable_browser_preferences_do_not_export_retired_graphics_settings() {
        let mut browser_settings = crate::domain::default_game_browser_settings();
        browser_settings.fonts.mode = "custom".to_owned();
        browser_settings.fonts.font_smoothing_enabled = false;
        browser_settings.fonts.slots.insert(
            "latin".to_owned(),
            serde_json::from_value(json!({"source":"system","family":"Inter"})).unwrap(),
        );
        browser_settings.performance.macos_high_refresh_rate = true;
        let exported = export(
            state_fixture(),
            Some(PortablePreferencesRecord {
                game_browser_settings: Some(browser_settings),
                language: None,
                macro_settings: None,
                theme_mode: None,
            }),
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
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &serde_json::to_string(&exported).unwrap(),
                "/tmp/eco-qos-opt-out.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();

        let settings = preview.preferences.unwrap().game_browser_settings.unwrap();
        let serialized = serde_json::to_value(settings).unwrap();
        assert!(serialized.get("graphics").is_none());
        assert_eq!(
            serialized["fonts"]["slots"]["latin"],
            json!({"source":"system","family":"Inter"})
        );
        assert_eq!(serialized["fonts"]["fontSmoothingEnabled"], false);
        assert_eq!(serialized["performance"]["macosHighRefreshRate"], true);
    }

    #[test]
    fn portable_role_mapping_and_shortcut_resolution() {
        {
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &fixture(11),
                    "/tmp/remapped-role.json".to_owned(),
                    state_fixture(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    state_fixture(),
                )
                .unwrap();
            assert_eq!(prepared.snapshot.roles.len(), 1);
            assert_eq!(prepared.snapshot.roles[0].id, "r");
            assert_eq!(
                prepared.snapshot.launch_workspaces[0].slots[0]
                    .role_id
                    .as_deref(),
                Some("r")
            );
            assert_eq!(prepared.snapshot.macros.len(), 1);
            assert_eq!(prepared.snapshot.macros[0].role_ids, vec!["r"]);
        };

        {
            let mut source = fixture_value(11);
            let duplicate = json!({
                "id":"r2","gameId":"g1","name":"Role",
                "launchUrl":"https://example.test/play","notes":""
            });
            source["roles"].as_array_mut().unwrap().push(duplicate);
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([]);
            let mut runtime = PortableRuntime::default();
            assert_eq!(
                runtime
                    .preview(
                        &source.to_string(),
                        "/tmp/duplicate-source-role.json".to_owned(),
                        empty_snapshot(),
                    )
                    .unwrap_err()
                    .code(),
                "PORTABLE_ROLE_NAME_CONFLICT"
            );
        };

        {
            let mut snapshot = state_fixture();
            let mut duplicate = snapshot.roles[0].clone();
            duplicate.id = "r-duplicate".to_owned();
            snapshot.roles.push(duplicate);
            let before = snapshot.clone();
            let mut runtime = PortableRuntime::default();
            assert_eq!(
                runtime
                    .preview(
                        &fixture(11),
                        "/tmp/duplicate-existing-role.json".to_owned(),
                        snapshot,
                    )
                    .unwrap_err()
                    .code(),
                "PORTABLE_ROLE_NAME_CONFLICT"
            );
            assert_eq!(
                serde_json::to_value(before.clone()).unwrap(),
                serde_json::to_value(before).unwrap()
            );
        };

        {
            let mut source = fixture_value(11);
            source["macros"] = json!([
                {
                    "id":"first","name":"First","roleIds":["r1"],
                    "trigger":{"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "repeat":{"type":"once"},"steps":[{"id":"one","type":"key","code":"F1"}]
                },
                {
                    "id":"conflict","name":"Conflict","roleIds":["r1"],
                    "trigger":{"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "repeat":{"type":"once"},"steps":[{"id":"two","type":"key","code":"F2"}]
                },
                {
                    "id":"reserved","name":"Reserved","roleIds":["r1"],
                    "trigger":{"code":"KeyM","ctrl":true,"alt":false,"shift":true,"meta":false},
                    "repeat":{"type":"once"},"steps":[{"id":"three","type":"key","code":"F3"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/shortcut-conflicts.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(preview.warnings.iter().any(|warning| {
                warning.code == "MACRO_SHORTCUT_CLEARED_CONFLICT"
                    && warning.item_name.as_deref() == Some("Conflict")
            }));
            assert!(preview.warnings.iter().any(|warning| {
                warning.code == "MACRO_SHORTCUT_CLEARED_RESERVED"
                    && warning.item_name.as_deref() == Some("Reserved")
            }));
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(
                prepared
                    .snapshot
                    .macros
                    .iter()
                    .find(|item| item.name == "First")
                    .unwrap()
                    .trigger
                    .is_some()
            );
            assert!(
                prepared
                    .snapshot
                    .macros
                    .iter()
                    .filter(|item| matches!(item.name.as_str(), "Conflict" | "Reserved"))
                    .all(|item| item.trigger.is_none())
            );
        };
    }

    #[test]
    fn pending_imports_are_bounded_and_discarded_by_id() {
        let mut runtime = PortableRuntime::default();
        let mut ids = Vec::new();
        for index in 0..=MAX_PENDING_IMPORTS {
            let preview = runtime
                .preview(
                    &fixture(11),
                    format!("/tmp/import-{index}.json"),
                    empty_snapshot(),
                )
                .unwrap();
            ids.push(preview.import_id);
        }
        let first = runtime.prepare_apply(&ids[0], all_selection(), Vec::new(), empty_snapshot());
        assert!(matches!(
            first,
            Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_EXPIRED",
                ..
            })
        ));
        assert!(runtime.discard(ids.last().unwrap()));
        assert!(!runtime.discard(ids.last().unwrap()));
    }

    #[test]
    fn unresolved_macro_ambiguity_requires_a_typed_resolution() {
        let snapshot = serde_json::from_value::<CoreStateSnapshotRecord>(json!({
            "games": [{
                "id":"existing-game","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles": [{
                "id":"existing-role","gameId":"existing-game","name":"Role",
                "launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "launchWorkspaces": [],
            "macros": [
                {"id":"existing-1","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["existing-role"],"repeat":{"type":"once"},"steps":[{"id":"a","type":"delay","ms":1}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
                {"id":"existing-2","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["existing-role"],"repeat":{"type":"once"},"steps":[{"id":"b","type":"delay","ms":2}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
            ],
            "compatibilityReports": []
        }))
        .unwrap();
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &fixture(11),
                "/tmp/import.json".to_owned(),
                snapshot.clone(),
            )
            .unwrap();
        assert_eq!(preview.conflicts.len(), 1);
        let unresolved = runtime.prepare_apply(
            &preview.import_id,
            all_selection(),
            Vec::new(),
            snapshot.clone(),
        );
        {
            assert!(matches!(
                unresolved,
                Err(CoreError::Domain {
                    code: "PORTABLE_IMPORT_CONFLICT_UNRESOLVED",
                    ..
                })
            ));
            assert_eq!(preview.conflicts.len(), 1);
            assert_eq!(preview.conflicts[0].candidates.len(), 2);
        };

        let resolved = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                vec![PortableMacroConflictResolutionRecord::Update {
                    conflict_id: "macro:m1".to_owned(),
                    target_macro_id: "existing-2".to_owned(),
                }],
                snapshot,
            )
            .unwrap();
        assert_eq!(resolved.snapshot.macros.len(), 2);
        assert!(
            resolved
                .affected_macro_ids
                .contains(&"existing-2".to_owned())
        );
    }

    #[test]
    fn exported_macro_round_trip_is_semantically_idempotent() {
        let snapshot = serde_json::from_value::<CoreStateSnapshotRecord>(json!({
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
                "id":"target","enabled":true,"activationMode":"toggle","name":"Target","roleIds":["r"],
                "repeat":{"type":"once"},
                "steps":[{"id":"target-delay","type":"delay","ms":1}],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }, {
                "id":"source","enabled":true,"activationMode":"toggle","name":"Source","roleIds":["r"],
                "repeat":{"type":"once"},
                "steps":[
                    {"id":"key-label","type":"key","code":"Digit1","action":"tap","label":"1"},
                    {"id":"key-empty","type":"key","code":"Digit2","modifiers":[]},
                    {"id":"percent-default","type":"click","xPercent":12.5,"yPercent":-4.0},
                    {"id":"percent-explicit","type":"click","unit":"percent","anchor":"top-left","xPercent":1.0,"yPercent":2.0},
                    {"id":"pixels","type":"click","unit":"px","anchor":"center","xPx":3.0,"yPx":4.0},
                    {"id":"call-default","type":"macro","macroId":"target"},
                    {"id":"call-explicit","type":"macro","macroId":"target","callMode":"wait"}
                ],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "compatibilityReports": []
        }))
        .unwrap();
        let exported = export(snapshot.clone(), None, all_selection(), "2.0.0").unwrap();
        let raw = serde_json::to_string(&exported).unwrap();
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(&raw, "/tmp/round-trip.json".to_owned(), snapshot.clone())
            .unwrap();

        assert_eq!(preview.operations.macros.unchanged, 2);
        assert_eq!(preview.operations.macros.update, 0);
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                snapshot.clone(),
            )
            .unwrap();
        assert!(prepared.affected_macro_ids.is_empty());
        assert_eq!(prepared.result.operations.macros.unchanged, 2);
        assert_eq!(
            serde_json::to_value(prepared.snapshot.clone()).unwrap(),
            serde_json::to_value(snapshot).unwrap()
        );
        {
            let source = prepared
                .snapshot
                .macros
                .iter()
                .find(|macro_record| macro_record.id == "source")
                .unwrap();
            assert!(source.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == "target"
            )));
            let target = prepared
                .snapshot
                .macros
                .iter()
                .find(|macro_record| macro_record.id == "target")
                .unwrap();
            assert!(matches!(target.repeat, crate::model::MacroRepeat::Once));
        };
        {
            let source = prepared
                .snapshot
                .macros
                .iter()
                .find(|macro_record| macro_record.id == "source")
                .unwrap();
            assert!(source.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Click {
                    anchor: Some(anchor),
                    position: crate::model::MacroClickDefinition::Percent {
                        unit: Some(unit),
                        x_percent: x,
                        y_percent: y,
                    },
                    ..
                } if unit == "percent" && anchor == "top-left" && *x == 1.0 && *y == 2.0
            )));
            assert!(source.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Click {
                    anchor: Some(anchor),
                    position: crate::model::MacroClickDefinition::Pixels {
                        unit,
                        x_px: x,
                        y_px: y,
                    },
                    ..
                } if unit == "px" && anchor == "center" && *x == 3.0 && *y == 4.0
            )));
        };
    }

    #[test]
    fn export_is_v13_and_never_emits_internal_timestamps_or_browser_session_source() {
        let snapshot = serde_json::from_value::<CoreStateSnapshotRecord>(json!({
            "games": [{"id":"g","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}],
            "roles": [{"id":"r","gameId":"g","name":"Role","launchUrl":"https://example.test/play","notes":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}],
            "launchWorkspaces": [{
                "id":"w","name":"Workspace","template":"single","browserLaunchMode":"inherit",
                "browserZoomMode":"adaptive","browserZoomPercent":100,
                "slots":[{"id":"s","roleId":"r","rect":{"x":0,"y":0,"width":1,"height":1}}],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "macros": [], "compatibilityReports": []
        }))
        .unwrap();
        let exported = export(snapshot, None, all_selection(), "2.0.0").unwrap();
        let value = serde_json::to_value(exported).unwrap();
        {
            assert_eq!(value["schemaVersion"], 13);
            assert!(
                value["launchWorkspaces"][0]
                    .get("browserZoomMode")
                    .is_none()
            );
            assert!(
                value["launchWorkspaces"][0]
                    .get("browserZoomPercent")
                    .is_none()
            );
            assert_eq!(value["appVersion"], "2.0.0");
            for field in [
                "authState",
                "browserSessionSource",
                "browserUserDataDir",
                "createdAt",
                "lastAuthCheckAt",
                "lastSuccessfulLoginAt",
                "launchPreset",
                "updatedAt",
                "windowHeight",
                "windowWidth",
            ] {
                assert!(value["roles"][0].get(field).is_none());
            }
            assert!(value.get("gameCompatibilityReports").is_none());
        };
        assert!(value["launchWorkspaces"][0].get("resourcePolicy").is_none());
    }

    #[test]
    fn portable_files_are_atomically_replaced_and_streamed_back_into_preview() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("rion.json");
        fs::write(&path, b"old").unwrap();
        let data =
            serde_json::from_value::<PortableDataRecord>(normalize(&fixture(11)).unwrap()).unwrap();
        let selection = all_selection();

        let result = write_export(path.to_str().unwrap(), &data, &selection).unwrap();
        assert_eq!(result.file_path, path.to_string_lossy());
        assert!(!fs::read(&path).unwrap().starts_with(b"old"));
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));

        let preview = PortableRuntime::default()
            .preview_file(
                path.to_string_lossy().into_owned(),
                CoreStateSnapshotRecord::default(),
            )
            .unwrap();
        assert_eq!(preview.game_count, 1);
        assert_eq!(preview.role_count, 1);
    }

    #[test]
    fn portable_file_preview_rejects_oversized_inputs_before_reading() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("oversized.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_PORTABLE_BYTES + 1).unwrap();

        let error = PortableRuntime::default()
            .preview_file(
                path.to_string_lossy().into_owned(),
                CoreStateSnapshotRecord::default(),
            )
            .unwrap_err();
        assert_eq!(error.code(), "CORE_INPUT_INVALID");
    }
