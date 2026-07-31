    #[test]
    fn game_and_role_store_domain_contracts_match_v1() {
        crate::v1_case!("state-migration-ece15253f5ea", {
            let mut games = Vec::new();
            create_game(
                &mut games,
                GameCreateInputRecord {
                    name: "Game".to_owned(),
                    default_launch_url: "https://example.test/play".to_owned(),
                    icon_image_data_url: Some("data:image/png;base64,AQ==".to_owned()),
                    cover_image_data_url: Some("data:image/png;base64,Ag==".to_owned()),
                    local_storage_sync_keys: Vec::new(),
                },
            )
            .unwrap();
            assert_eq!(
                create_game(
                    &mut games,
                    GameCreateInputRecord {
                        name: " game ".to_owned(),
                        default_launch_url: "https://other.test/play".to_owned(),
                        icon_image_data_url: None,
                        cover_image_data_url: None,
                        local_storage_sync_keys: Vec::new(),
                    }
                )
                .unwrap_err()
                .code(),
                "GAME_NAME_DUPLICATE"
            );
            assert!(
                create_game(
                    &mut games,
                    GameCreateInputRecord {
                        name: "Bad URL".to_owned(),
                        default_launch_url: "file:///tmp/game".to_owned(),
                        icon_image_data_url: None,
                        cover_image_data_url: None,
                        local_storage_sync_keys: Vec::new(),
                    }
                )
                .is_err()
            );
            assert!(
                create_game(
                    &mut games,
                    GameCreateInputRecord {
                        name: "Bad image".to_owned(),
                        default_launch_url: "https://image.test/play".to_owned(),
                        icon_image_data_url: Some("https://image.test/icon.png".to_owned()),
                        cover_image_data_url: None,
                        local_storage_sync_keys: Vec::new(),
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-d0148c9da12a", {
            let mut games = vec![game_record(json!({
                "id":"builtin-flyff-universe","source":"builtin",
                "builtinKey":"flyff-universe","name":"Flyff Universe",
                "defaultLaunchUrl":"https://override.test/play",
                "browserLaunchMode":"external",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }))];
            let protected = update_game(
                &mut games,
                "builtin-flyff-universe",
                GameUpdateInputRecord {
                    name: Some("Renamed".to_owned()),
                    ..GameUpdateInputRecord::default()
                },
            )
            .unwrap_err();
            assert_eq!(protected.code(), "GAME_BUILTIN_FIELD_PROTECTED");
            let reset = reset_builtin_game(&mut games, "builtin-flyff-universe").unwrap();
            assert_eq!(reset.name, "Flyff Universe");
            assert_eq!(reset.default_launch_url, "https://universe.flyff.com/play");
            assert!(delete_game(&mut games, &[], "builtin-flyff-universe").is_err());
        });

        crate::v1_case!("state-migration-12eeac5ebdd5", {
            let game = game_record(json!({
                "id":"g1","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            let role = role_record(json!({
                "id":"r1","gameId":"g1","name":"Role",
                "launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            let mut games = vec![game];
            let error = delete_game(&mut games, &[role], "g1").unwrap_err();
            assert_eq!(error.code(), "GAME_IN_USE");
            assert_eq!(games.len(), 1);
        });

        let games = vec![
            game_record(json!({
                "id":"g1","source":"custom","name":"One",
                "defaultLaunchUrl":"https://one.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            })),
            game_record(json!({
                "id":"g2","source":"custom","name":"Two",
                "defaultLaunchUrl":"https://two.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            })),
        ];

        crate::v1_case!("state-migration-a22e317b5201", {
            let mut roles = Vec::new();
            create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Role".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            let mut copy = roles.clone();
            copy[0].name = "Changed".to_owned();
            assert_eq!(roles[0].name, "Role");
        });

        crate::v1_case!("state-migration-dd656a1ce95e", {
            let mut roles = Vec::new();
            let first = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "First".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            let second = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Second".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            reorder_roles(&mut roles, &[second.id.clone(), first.id.clone()]).unwrap();
            assert_eq!(roles[0].id, second.id);
            assert_eq!(roles[1].id, first.id);
            assert_eq!(roles[0].updated_at, second.updated_at);
            let third = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Third".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            assert_eq!(roles.last().unwrap().id, third.id);
        });

        crate::v1_case!("state-migration-ebab678949df", {
            let role = role_record(json!({
                "id":"r1","gameId":"g1","name":"Role",
                "launchUrl":"https://one.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            for order in [
                vec![],
                vec!["r1".to_owned(), "r1".to_owned()],
                vec!["missing".to_owned()],
            ] {
                let mut roles = vec![role.clone()];
                assert!(reorder_roles(&mut roles, &order).is_err());
                assert_eq!(roles[0].id, "r1");
            }
        });

        crate::v1_case!("state-migration-d4a525975422", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "URL".to_owned(),
                    launch_url: Some("https://one.test/custom".to_owned()),
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            assert_eq!(role.launch_url, "https://one.test/custom");
            let updated = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    launch_url: Some("https://one.test/updated".to_owned()),
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert_eq!(updated.launch_url, "https://one.test/updated");
        });

        crate::v1_case!("state-migration-8436b92a9a3c", {
            let mut roles = Vec::new();
            create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Main".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: " main ".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: None,
                        cover_image_dominant_color: None,
                        local_storage_source_role_id: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-fcc108ce785b", {
            let mut roles = Vec::new();
            for game_id in ["g1", "g2"] {
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: game_id.to_owned(),
                        name: "Main".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: None,
                        cover_image_dominant_color: None,
                        local_storage_source_role_id: None,
                    },
                )
                .unwrap();
            }
            assert_eq!(roles.len(), 2);
        });

        crate::v1_case!("state-migration-b3cbb430c785", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Before".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            let created_at = role.created_at.clone();
            let updated = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    name: Some("After".to_owned()),
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert_eq!(updated.name, "After");
            assert_eq!(updated.created_at, created_at);
        });

        crate::v1_case!("state-migration-91c76a57ca59", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Covered".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: Some("data:image/png;base64,AQ==".to_owned()),
                    cover_image_dominant_color: Some("#123456".to_owned()),
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            assert_eq!(
                role.cover_image_data_url.as_deref(),
                Some("data:image/png;base64,AQ==")
            );
            assert_eq!(role.cover_image_dominant_color.as_deref(), Some("#123456"));
        });

        crate::v1_case!("state-migration-18c6d70a1950", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Cover update".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            let updated = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    cover_image_data_url: Some("data:image/png;base64,Ag==".to_owned()),
                    set_cover_image_data_url: true,
                    cover_image_dominant_color: Some("#abcdef".to_owned()),
                    set_cover_image_dominant_color: true,
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert!(updated.cover_image_data_url.is_some());
            let cleared = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    set_cover_image_data_url: true,
                    set_cover_image_dominant_color: true,
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert!(cleared.cover_image_data_url.is_none());
            assert!(cleared.cover_image_dominant_color.is_none());
        });

        crate::v1_case!("state-migration-32f9dd5be142", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "No cover".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            )
            .unwrap();
            assert!(role.cover_image_data_url.is_none());
            assert!(role.cover_image_dominant_color.is_none());
        });

        crate::v1_case!("state-migration-a25bac4e9534", {
            let mut roles = Vec::new();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Invalid cover".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: Some("https://example.test/cover.png".to_owned()),
                        cover_image_dominant_color: None,
                        local_storage_source_role_id: None,
                    }
                )
                .is_err()
            );
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Oversized cover".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: Some(format!(
                            "data:image/png;base64,{}",
                            "A".repeat(MAX_ROLE_COVER_DATA_URL_LENGTH)
                        )),
                        cover_image_dominant_color: None,
                        local_storage_source_role_id: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-bf976dd9efa1", {
            let mut roles = Vec::new();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Bad URL".to_owned(),
                        launch_url: Some("file:///tmp/game".to_owned()),
                        notes: None,
                        cover_image_data_url: None,
                        cover_image_dominant_color: None,
                        local_storage_source_role_id: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-6f61d05c2101", {
            let mut roles = Vec::new();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Bad color".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: Some("data:image/png;base64,AQ==".to_owned()),
                        cover_image_dominant_color: Some("red".to_owned()),
                        local_storage_source_role_id: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-c78fcecd60d3", {
            let legacy = role_record(json!({
                "id":"legacy","gameId":"g1","name":"Legacy",
                "launchUrl":"https://one.test/play","notes":"",
                "coverImageDataUrl":"data:image/png;base64,AQ==",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            assert!(legacy.cover_image_data_url.is_some());
            assert!(legacy.cover_image_dominant_color.is_none());
        });
    }
