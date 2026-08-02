    #[test]
    fn new_roles_inherit_the_selected_game_url_unless_explicitly_overridden() {
        for platform in ["darwin", "win32"] {
            let games = vec![game_record(json!({
                "id":"custom-game","source":"custom","name":"Custom",
                "defaultLaunchUrl":"https://custom.test/launch","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }))];
            let input = |name: &str, launch_url: Option<&str>| RoleCreateInputRecord {
                game_id: "custom-game".to_owned(),
                name: name.to_owned(),
                launch_url: launch_url.map(str::to_owned),
                notes: None,
                cover_image_data_url: None,
                cover_image_dominant_color: None,
                local_storage_source_role_id: None,
            };
            let mut roles = Vec::new();

            let inherited = create_role(&games, &mut roles, input("Inherited", None)).unwrap();
            let overridden = create_role(
                &games,
                &mut roles,
                input("Override", Some("https://override.test/play")),
            )
            .unwrap();

            assert_eq!(
                inherited.launch_url, "https://custom.test/launch",
                "{platform}"
            );
            assert_eq!(
                overridden.launch_url, "https://override.test/play",
                "{platform}"
            );
        }
    }

    #[test]
    fn local_storage_sync_keys_are_bounded_normalized_and_reset_for_flyff() {
        assert_eq!(
            normalize_local_storage_sync_keys(vec![
                "  game_client_settings  ".to_owned(),
                "audio".to_owned(),
                "game_client_settings".to_owned(),
            ])
            .unwrap(),
            ["game_client_settings", "audio"]
        );
        assert!(
            normalize_local_storage_sync_keys(
                (0..=MAX_LOCAL_STORAGE_SYNC_KEYS)
                    .map(|index| format!("key-{index}"))
                    .collect()
            )
            .is_err()
        );
        assert!(normalize_local_storage_sync_keys(vec!["界".repeat(86)]).is_err());
        assert_eq!(
            normalize_game_local_storage_sync_keys(
                Some("flyff-universe"),
                vec!["game_client_settings".to_owned()],
            )
            .unwrap_err()
            .code(),
            "GAME_LOCAL_STORAGE_SYNC_KEY_UNSAFE"
        );
        assert_eq!(
            normalize_game_local_storage_sync_keys(
                Some("feifei-infinite-universe"),
                vec!["game_client_settings".to_owned()],
            )
            .unwrap_err()
            .code(),
            "GAME_LOCAL_STORAGE_SYNC_KEY_UNSAFE"
        );
        assert_eq!(
            normalize_local_storage_sync_selectors(
                Some("feifei-infinite-universe"),
                FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS
                    .iter()
                    .map(|selector| (*selector).to_owned())
                    .collect(),
            )
            .unwrap(),
            FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS
        );
        assert_eq!(
            normalize_game_local_storage_sync_keys(
                Some("flyff-universe"),
                vec!["game_client_sessions".to_owned()],
            )
            .unwrap_err()
            .code(),
            "GAME_LOCAL_STORAGE_SYNC_KEY_UNSAFE"
        );

        let mut games = vec![game_record(json!({
            "id":"builtin-flyff-universe","source":"builtin",
            "builtinKey":"flyff-universe","name":"Flyff Universe",
            "defaultLaunchUrl":"https://override.test/play",
            "localStorageSyncKeys":["custom"],
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
        }))];
        let reset = reset_builtin_game(&mut games, "builtin-flyff-universe").unwrap();
        assert!(reset.local_storage_sync_keys.is_empty());
        assert_eq!(
            reset.local_storage_sync_selectors,
            FLYFF_LOCAL_STORAGE_SYNC_SELECTORS
        );

        games.push(game_record(json!({
            "id":"builtin-feifei-infinite-universe","source":"builtin",
            "builtinKey":"feifei-infinite-universe","name":"飞飞：无限宇宙",
            "defaultLaunchUrl":"https://override.test/play",
            "localStorageSyncKeys":["custom"],
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
        })));
        let reset = reset_builtin_game(&mut games, "builtin-feifei-infinite-universe").unwrap();
        assert!(reset.local_storage_sync_keys.is_empty());
        assert_eq!(
            reset.local_storage_sync_selectors,
            FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS
        );
    }

    #[test]
    fn local_storage_role_binding_rejects_self_cross_scope_and_chains() {
        let games = [
            game_record(json!({
                "id":"g1","source":"custom","name":"One",
                "defaultLaunchUrl":"https://one.test/play","localStorageSyncKeys":["sync"],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            })),
            game_record(json!({
                "id":"g2","source":"custom","name":"Two",
                "defaultLaunchUrl":"https://two.test/play","localStorageSyncKeys":["sync"],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            })),
        ];
        let role = |id: &str, game_id: &str, url: &str, source: Option<&str>| {
            role_record(json!({
                "id":id,"gameId":game_id,"name":id,"launchUrl":url,"notes":"",
                "localStorageSourceRoleId":source,
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }))
        };
        let master = role("master", "g1", "https://one.test/play", None);

        let self_bound = role("self", "g1", "https://one.test/play", Some("self"));
        assert_eq!(
            validate_role_local_storage_binding(&self_bound, std::slice::from_ref(&self_bound))
                .unwrap_err()
                .code(),
            "ROLE_LOCAL_STORAGE_SOURCE_SELF"
        );

        let cross_game = role("cross", "g2", "https://two.test/play", Some("master"));
        assert_eq!(
            validate_role_local_storage_binding(&cross_game, &[master.clone(), cross_game.clone()])
                .unwrap_err()
                .code(),
            "ROLE_LOCAL_STORAGE_SOURCE_GAME_MISMATCH"
        );

        let cross_origin = role("origin", "g1", "https://other.test/play", Some("master"));
        assert_eq!(
            validate_role_local_storage_binding(
                &cross_origin,
                &[master.clone(), cross_origin.clone()]
            )
            .unwrap_err()
            .code(),
            "ROLE_LOCAL_STORAGE_SOURCE_ORIGIN_MISMATCH"
        );

        let follower = role("follower", "g1", "https://one.test/play", Some("master"));
        let chained = role("chained", "g1", "https://one.test/play", Some("follower"));
        assert_eq!(
            validate_role_local_storage_binding(&chained, &[master, follower, chained.clone()],)
                .unwrap_err()
                .code(),
            "ROLE_LOCAL_STORAGE_SOURCE_CHAIN"
        );
        assert_eq!(games.len(), 2);
    }
