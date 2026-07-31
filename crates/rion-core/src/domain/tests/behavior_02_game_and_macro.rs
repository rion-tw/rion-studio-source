#[test]
    fn property_generated_game_names_are_trimmed_and_bounded() {
        let mut seed = 0x5eed_u64;
        for length in 1..=160 {
            let generated = (0..length)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    char::from(b'a' + ((seed >> 32) % 26) as u8)
                })
                .collect::<String>();
            let input = GameCreateInputRecord {
                name: format!("  {generated}  "),
                default_launch_url: "https://example.test/play".to_owned(),
                icon_image_data_url: None,
                cover_image_data_url: None,
                local_storage_sync_keys: Vec::new(),
            };
            let mut games = Vec::new();
            let result = create_game(&mut games, input);
            if length <= 80 {
                let game = result.unwrap();
                assert_eq!(game.name, generated);
                assert_eq!(games.len(), 1);
            } else {
                assert!(result.is_err());
                assert!(games.is_empty());
            }
        }
    }

    #[test]
    fn macro_store_domain_contracts_match_v1() {
        crate::v1_case!("state-migration-24fee99df77d", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Copy","roleIds":["r1"],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let mut isolated = macros.clone();
            isolated[0].name = "Changed".to_owned();
            assert_eq!(macros[0].name, "Copy");
            assert_eq!(created.name, "Copy");
        });

        crate::v1_case!("state-migration-a59f6e22aea7", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Party","roleIds":["r1","r2"],
                    "steps":[{"type":"key","code":"F1"}]
                })),
            )
            .unwrap();
            assert_eq!(created.role_ids, vec!["r1", "r2"]);
            let updated = update_macro(
                &mut macros,
                &created.id,
                macro_update(json!({"name":"Party updated"})),
            )
            .unwrap();
            assert_eq!(updated.name, "Party updated");
            delete_macro(&mut macros, &created.id).unwrap();
            assert!(macros.is_empty());
        });

        crate::v1_case!("state-migration-7dd0a543761c", {
            let mut macros = Vec::new();
            let disabled = create_macro(
                &mut macros,
                macro_input(json!({
                    "enabled":false,"name":"Disabled","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let enabled = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Legacy default","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(!disabled.enabled);
            assert!(enabled.enabled);
        });

        crate::v1_case!("state-migration-18973c29ec15", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[
                        {"type":"macro","macroId":target.id},
                        {"type":"macro","macroId":target.id,"callMode":"trigger"}
                    ]
                })),
            )
            .unwrap();
            assert!(matches!(
                &parent.steps[0],
                MacroStepDefinition::Macro { call_mode: Some(mode), .. } if mode == "wait"
            ));
            assert!(matches!(
                &parent.steps[1],
                MacroStepDefinition::Macro { call_mode: Some(mode), .. } if mode == "trigger"
            ));
        });

        crate::v1_case!("state-migration-f5d8acae045e", {
            let mut macros = Vec::new();
            let held = create_macro(
                &mut macros,
                macro_input(json!({
                    "activationMode":"while_held",
                    "name":"Held","roleIds":["r1"],
                    "trigger":{"code":"F6","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "steps":[{"type":"key","code":"KeyW","action":"hold_until_stop"}]
                })),
            )
            .unwrap();
            assert_eq!(held.activation_mode.as_deref(), Some("while_held"));
            assert!(matches!(
                &held.steps[0],
                MacroStepDefinition::Key { action: Some(action), .. } if action == "hold_until_stop"
            ));
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "activationMode":"while_held","name":"Invalid","roleIds":["r2"],
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-25770bd4824c", {
            let mut macros = Vec::new();
            let normalized = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Modifiers","roleIds":[],
                    "steps":[{
                        "type":"key","code":"KeyK",
                        "modifiers":["shift","primary","shift","alt"]
                    }]
                })),
            )
            .unwrap();
            assert!(matches!(
                &normalized.steps[0],
                MacroStepDefinition::Key { modifiers: Some(values), .. }
                    if values == &vec!["primary".to_owned(), "alt".to_owned(), "shift".to_owned()]
            ));
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Ambiguous","roleIds":[],
                        "steps":[{"type":"key","code":"KeyK","modifiers":["primary","ctrl"]}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-44163e85a900", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Held target","roleIds":[],
                    "steps":[{"type":"key","code":"KeyW","action":"hold_until_stop"}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Nested","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            assert!(matches!(
                &target.steps[0],
                MacroStepDefinition::Key { action: Some(action), .. }
                    if action == "hold_until_stop"
            ));
            assert!(matches!(
                &parent.steps[0],
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == &target.id
            ));
        });

        crate::v1_case!("state-migration-905d5e9f3e52", {
            let mut macros = Vec::new();
            for name in ["Duplicate", "Duplicate"] {
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":name,"roleIds":[],
                        "repeat":{"type":"loop","intervalMs":86_400_000_u64},
                        "steps":[{"type":"delay","ms":86_400_000_u64}]
                    })),
                )
                .unwrap();
            }
            assert_eq!(macros.len(), 2);
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Too long","roleIds":[],
                        "repeat":{"type":"loop","intervalMs":86_400_001_u64},
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-4c9648c9e15d", {
            let invalid = serde_json::from_value::<MacroCreateInputRecord>(json!({
                "name":"Missing roles","steps":[{"type":"delay","ms":1}]
            }));
            assert!(invalid.is_err());
            let mut macros = Vec::new();
            let unassigned = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Unassigned","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(unassigned.role_ids.is_empty());
        });

        crate::v1_case!("state-migration-f03e9cfce6a3", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Roles","roleIds":[" r1 ","r1"," r2 "],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert_eq!(created.role_ids, vec!["r1", "r2"]);
        });

        crate::v1_case!("state-migration-a4407a2e1282", {
            let mut macros = Vec::new();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Empty","roleIds":[],"steps":[]
                    }))
                )
                .is_err()
            );
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Click","roleIds":[],
                        "steps":[{"type":"click","xPercent":101,"yPercent":0}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-238ae0807744", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Pixels","roleIds":[],
                    "steps":[{"type":"click","unit":"px","xPx":12.4,"yPx":34.6}]
                })),
            )
            .unwrap();
            assert!(matches!(
                &created.steps[0],
                MacroStepDefinition::Click {
                    position: crate::model::MacroClickDefinition::Pixels {
                        x_px, y_px, ..
                    },
                    ..
                } if *x_px == 12.0 && *y_px == 35.0
            ));
        });

        crate::v1_case!("state-migration-e8dafd40d2f5", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Anchored","roleIds":[],
                    "steps":[{
                        "type":"click","unit":"px","anchor":"bottom-right",
                        "xPx":-24,"yPx":-32
                    }]
                })),
            )
            .unwrap();
            assert!(matches!(
                &created.steps[0],
                MacroStepDefinition::Click {
                    anchor: Some(anchor),
                    position: crate::model::MacroClickDefinition::Pixels {
                        x_px, y_px, ..
                    },
                    ..
                } if anchor == "bottom-right" && *x_px == -24.0 && *y_px == -32.0
            ));
        });

        crate::v1_case!("state-migration-f7980c6af8d2", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":["r1","r2"],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":["r1"],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            clear_macro_role(&mut macros, "r1");
            assert_eq!(macros.len(), 2);
            assert_eq!(macros[0].role_ids, vec!["r2"]);
            assert!(macros[1].role_ids.is_empty());
            assert!(matches!(
                &macros[1].steps[0],
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == &target.id
            ));
        });

        crate::v1_case!("state-migration-a3755087145d", {
            let mut macros = Vec::new();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Concurrent cleanup","roleIds":["r1","r2","r3"],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            clear_macro_role(&mut macros, "r1");
            clear_macro_role(&mut macros, "r2");
            assert_eq!(macros[0].role_ids, vec!["r3"]);
        });

        crate::v1_case!("state-migration-ee5e6e6e550a", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Zero wait","roleIds":[],
                    "repeat":{"type":"loop","intervalMs":0},
                    "steps":[{"type":"delay","ms":0}]
                })),
            )
            .unwrap();
            assert!(matches!(
                created.repeat,
                MacroRepeat::Loop { interval_ms: 0 }
            ));
            assert!(matches!(
                created.steps[0],
                MacroStepDefinition::Delay { ms: 0, .. }
            ));
        });

        crate::v1_case!("state-migration-11854785813c", {
            let trigger = json!({"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false});
            let mut macros = Vec::new();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"First","roleIds":["r1"],"trigger":trigger,
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Overlap","roleIds":["r1"],"trigger":trigger,
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Separate","roleIds":["r2"],"trigger":trigger,
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_ok()
            );
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Reserved","roleIds":["r3"],
                        "trigger":{"code":"KeyM","ctrl":true,"alt":false,"shift":true,"meta":false},
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-08dee212a406", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"id":"target-step","type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"id":"call-step","type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            update_macro(
                &mut macros,
                &target.id,
                macro_update(json!({"name":"Renamed target"})),
            )
            .unwrap();
            assert!(matches!(
                &macros.iter().find(|item| item.id == parent.id).unwrap().steps[0],
                MacroStepDefinition::Macro { id, macro_id, .. }
                    if id == "call-step" && macro_id == &target.id
            ));
        });

        crate::v1_case!("state-migration-5ec8118b2de8", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Loop","roleIds":[],
                    "repeat":{"type":"loop","intervalMs":1000},
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Caller","roleIds":[],
                        "steps":[{"type":"macro","macroId":target.id}]
                    }))
                )
                .is_ok()
            );
        });

        crate::v1_case!("state-migration-e1b19c8acafb", {
            let mut macros = Vec::new();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Missing","roleIds":[],
                        "steps":[{"type":"macro","macroId":"missing"}]
                    }))
                )
                .is_err()
            );
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(
                update_macro(
                    &mut macros,
                    &target.id,
                    macro_update(json!({
                        "steps":[{"type":"macro","macroId":target.id}]
                    }))
                )
                .is_err()
            );
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            assert!(
                update_macro(
                    &mut macros,
                    &target.id,
                    macro_update(json!({
                        "steps":[{"type":"macro","macroId":parent.id}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-eaeea61f42ff", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            let updated = update_macro(
                &mut macros,
                &target.id,
                macro_update(json!({"repeat":{"type":"loop","intervalMs":500}})),
            )
            .unwrap();
            assert!(matches!(
                updated.repeat,
                MacroRepeat::Loop { interval_ms: 500 }
            ));
        });

        crate::v1_case!("state-migration-a995f2021932", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            let updated = update_macro(
                &mut macros,
                &target.id,
                macro_update(json!({
                    "steps":[{"type":"key","code":"KeyW","action":"hold_until_stop"}]
                })),
            )
            .unwrap();
            assert!(matches!(
                updated.steps[0],
                MacroStepDefinition::Key { action: Some(ref action), .. }
                    if action == "hold_until_stop"
            ));
        });

        crate::v1_case!("state-migration-b436d48eb42a", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            for name in ["First referrer", "Second referrer"] {
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":name,"roleIds":[],
                        "steps":[{"type":"macro","macroId":target.id}]
                    })),
                )
                .unwrap();
            }
            let error = delete_macro(&mut macros, &target.id).unwrap_err();
            assert_eq!(error.code(), "MACRO_IN_USE");
            assert!(error.to_string().contains("First referrer"));
            assert!(error.to_string().contains("Second referrer"));
        });

        crate::v1_case!("state-migration-eb10d0654aa7", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            let unrelated = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Unrelated","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let (deleted, skipped) =
                delete_macros(&mut macros, &[target.id.clone(), parent.id.clone()]);
            assert_eq!(deleted.len(), 2);
            assert!(skipped.is_empty());
            let (deleted, skipped) =
                delete_macros(&mut macros, &[unrelated.id.clone(), "missing".to_owned()]);
            assert_eq!(deleted, vec![unrelated.id]);
            assert_eq!(skipped[0].1, "not_found");
            assert!(macros.is_empty());
        });
    }
