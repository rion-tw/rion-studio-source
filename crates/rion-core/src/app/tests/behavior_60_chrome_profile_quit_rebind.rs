/// Models Chrome's graceful exit: it releases the profile lock and always
/// writes Local State and the cookie database back before the process ends.
fn simulate_graceful_chrome_exit_write_back(source: &std::path::Path) {
    std::fs::remove_file(source.join("SingletonLock")).unwrap();
    std::fs::write(
        source.join("Local State"),
        br#"{"profile":{"info_cache":{"Default":{"name":"Main"}},"last_used":"Default"}}"#,
    )
    .unwrap();
    rusqlite::Connection::open(source.join("Default/Network/Cookies"))
        .unwrap()
        .execute_batch("INSERT INTO meta(key, value) VALUES ('last_compatible_version', '23');")
        .unwrap();
}

#[test]
fn chrome_quit_rebinds_the_preview_so_written_back_profiles_still_import() {
    let (directory, core) = core_for_platform_contract("darwin", 23);
    let source = directory.path().join("chrome-source");
    create_chrome_import_fixture(&source);
    std::fs::write(source.join("SingletonLock"), b"chrome-host-4242").unwrap();
    let game_id = flyff_game_id(&core);
    let preview = core
        .invoke(CoreCommand::ChromeProfilePreview {
            source_user_data_dir: source.to_string_lossy().into_owned(),
        })
        .unwrap();
    assert_eq!(preview["sourceInUse"], true);
    let import_id = preview["importId"].as_str().unwrap().to_owned();
    let profile_id = preview["profiles"][0]["id"].as_str().unwrap().to_owned();

    simulate_graceful_chrome_exit_write_back(&source);
    let (refreshed, quit_actions, _) = drive_async_command(
        std::sync::Arc::clone(&core),
        CoreCommand::ChromeProfileRequestQuit {
            import_id: import_id.clone(),
        },
        None,
    );
    let refreshed = refreshed.unwrap();
    assert!(quit_actions.is_empty());
    // The renderer keeps the user's selections because the import identity
    // and profile list are stable across the quit refresh.
    assert_eq!(refreshed["importId"], import_id.as_str());
    assert_eq!(refreshed["sourceInUse"], false);
    assert_eq!(refreshed["profiles"], preview["profiles"]);

    let (result, actions, _) = drive_async_command_with(
        std::sync::Arc::clone(&core),
        CoreCommand::ChromeProfileApply {
            import_id,
            game_id,
            consent_accepted: true,
            resolutions: vec![ChromeProfileImportResolutionRecord::Create { profile_id }],
        },
        v23_chrome_import_effect_driver(std::sync::Arc::clone(&core)),
    );
    let result = result.unwrap();
    assert_eq!(
        result["items"][0]["status"], "imported",
        "result={result:?}; actions={actions:?}"
    );
    assert!(result["items"][0].get("errorCode").is_none());
    assert_eq!(actions.len(), 4);
    core.shutdown();
}
