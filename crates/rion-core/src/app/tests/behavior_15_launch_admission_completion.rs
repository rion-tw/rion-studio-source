#[test]
fn already_running_role_returns_completed_launch_admission() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform(platform);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let target = EmbeddedLaunchTargetRecord {
            window_id: "window-2".to_owned(),
            display_id: 1,
            scale_factor: 1.0,
            work_area: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 1440,
                height: 900,
            },
            bounds: StatePixelBoundsRecord {
                x: 0,
                y: 0,
                width: 960,
                height: 640,
            },
            presentation: "normal".to_owned(),
        };
        drive_accepted_launch_to_completion(
            Arc::clone(&core),
            CoreCommand::BrowserRoleLaunch {
                role_id: role_id.clone(),
                target: target.clone(),
                launch_preview_id: None,
                zoom_factor: None,
                restore_role_slots: None,
            },
        );
        let admission = drive_async_command(
            Arc::clone(&core),
            CoreCommand::BrowserRoleLaunch {
                role_id: role_id.clone(),
                target,
                launch_preview_id: Some("unused-preview".to_owned()),
                zoom_factor: None,
                restore_role_slots: None,
            },
            None,
        )
        .0
        .unwrap();

        assert_eq!(admission["completion"], "completed", "{platform}");
        assert_eq!(admission["statuses"][0]["roleId"], role_id, "{platform}");
        assert_eq!(admission["statuses"][0]["state"], "running", "{platform}");
        core.shutdown();
    }
}
