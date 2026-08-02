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
