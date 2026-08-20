    #[test]
    fn quick_access_preferences_round_trip_filter_and_prune_with_entity_deletes() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role 1","launchUrl":"https://example.test/play",
                    "notes":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                },{
                    "id":"r2","gameId":"g1","name":"Role 2","launchUrl":"https://example.test/play",
                    "notes":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[{
                    "id":"w1","name":"Workspace 1","template":"single",
                    "slots":[{"id":"slot-1","roleId":"r1","rect":{"x":0,"y":0,"width":1,"height":1}}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                },{
                    "id":"w2","name":"Workspace 2","template":"single",
                    "slots":[{"id":"slot-2","roleId":"r2","rect":{"x":0,"y":0,"width":1,"height":1}}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "gameWindows":[{
                    "id":"00000000-0000-4000-8000-000000000001","name":"Window 1","targetDisplay":{"id":1},
                    "placement":{
                        "normalBounds":{"x":0,"y":0,"width":1280,"height":720},
                        "savedWorkArea":{"x":0,"y":0,"width":1440,"height":900},
                        "presentation":"normal"
                    },
                    "tabs":[],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "macros":[{
                    "id":"m1","enabled":true,"activationMode":"toggle","name":"Macro 1","roleIds":["r1"],
                    "repeat":{"type":"once"},"steps":[{"type":"delay","id":"s1","ms":1}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                },{
                    "id":"m2","enabled":true,"activationMode":"toggle","name":"Macro 2","roleIds":["r2"],
                    "repeat":{"type":"once"},"steps":[{"type":"delay","id":"s2","ms":1}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "quickAccessPreferences":{
                    "pinnedItems":[
                        {"kind":"role","id":"r1"},{"kind":"workspace","id":"w1"},
                        {"kind":"role","id":"r1"},{"kind":"role","id":"missing"},
                        {"kind":"route","id":"dashboard"}
                    ],
                    "recentItems":[
                        {"kind":"gameWindow","id":"00000000-0000-4000-8000-000000000001"},{"kind":"macro","id":"m1"},
                        {"kind":"workspace","id":"w2"},{"kind":"role","id":"r2"}
                    ]
                }
            }),
        )
        .unwrap();

        let item = |kind: &str, id: &str| QuickAccessItemRefRecord {
            kind: kind.to_owned(),
            id: id.to_owned(),
        };
        let loaded = read_quick_access_preferences(&connection).unwrap();
        assert_eq!(
            loaded.pinned_items,
            vec![item("role", "r1"), item("workspace", "w1")]
        );

        let recorded = apply_domain_mutation(
            &mut connection,
            StateMutation::QuickAccessRecentRecord {
                item: item("role", "r2"),
            },
        )
        .unwrap();
        assert_eq!(recorded["value"]["recentItems"][0]["id"], "r2");
        let pinned = apply_domain_mutation(
            &mut connection,
            StateMutation::QuickAccessPinSet {
                item: item("macro", "m2"),
                pinned: true,
            },
        )
        .unwrap();
        assert_eq!(pinned["value"]["pinnedItems"].as_array().unwrap().len(), 3);
        let pinned_again = apply_domain_mutation(
            &mut connection,
            StateMutation::QuickAccessPinSet {
                item: item("role", "r1"),
                pinned: true,
            },
        )
        .unwrap();
        assert_eq!(pinned_again["value"]["pinnedItems"], pinned["value"]["pinnedItems"]);
        assert_eq!(
            read_scalar(&connection, "quickAccessPreferences").unwrap().unwrap(),
            pinned_again["value"]
        );
        assert!(apply_domain_mutation(
            &mut connection,
            StateMutation::QuickAccessRecentRecord {
                item: item("macro", "missing"),
            },
        )
        .is_err());

        apply_domain_mutation(
            &mut connection,
            StateMutation::WorkspaceDelete { id: "w1".to_owned() },
        )
        .unwrap();
        apply_domain_mutation(
            &mut connection,
            StateMutation::WorkspacesDelete { ids: vec!["w2".to_owned()] },
        )
        .unwrap();
        apply_domain_mutation(
            &mut connection,
            StateMutation::GameWindowDelete {
                id: "00000000-0000-4000-8000-000000000001".to_owned(),
            },
        )
        .unwrap();
        apply_domain_mutation(
            &mut connection,
            StateMutation::MacrosDelete { ids: vec!["m1".to_owned(), "m2".to_owned()] },
        )
        .unwrap();
        apply_domain_mutation(
            &mut connection,
            StateMutation::RolesDelete {
                ids: vec!["r1".to_owned(), "r2".to_owned()],
                operation_ids: HashMap::new(),
            },
        )
        .unwrap();

        let pruned = read_quick_access_preferences(&connection).unwrap();
        assert!(pruned.pinned_items.is_empty());
        assert!(pruned.recent_items.is_empty());
        assert_eq!(
            read_snapshot(&connection).unwrap()["quickAccessPreferences"],
            serde_json::to_value(pruned).unwrap()
        );
    }

    #[test]
    fn quick_access_preferences_default_and_repair_legacy_payloads() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        connection
            .execute("DELETE FROM settings WHERE key='quickAccessPreferences'", [])
            .unwrap();
        assert_eq!(
            read_quick_access_preferences(&connection).unwrap(),
            default_quick_access_preferences()
        );
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES ('quickAccessPreferences', 'legacy')",
                [],
            )
            .unwrap();
        repair_required_settings(&connection).unwrap();
        assert_eq!(
            read_quick_access_preferences(&connection).unwrap(),
            default_quick_access_preferences()
        );
    }
