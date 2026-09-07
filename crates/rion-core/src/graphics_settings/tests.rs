use super::*;
use crate::{
    AppCore, AppCoreOptions,
    model::{CoreCommand, CoreEvent, GraphicsSettingsRecord},
};

#[test]
fn graphics_settings_persist_and_bootstrap_read_without_writes_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_graphics_settings_at_startup(dir.path()).unwrap(),
            GraphicsSettingsSnapshotRecord::default()
        );
        assert!(!dir.path().join("rion-studio.sqlite3").exists());
        let core = AppCore::create(AppCoreOptions {
            user_data_dir: dir.path().to_string_lossy().into_owned(),
            platform: platform.to_owned(),
            app_version: "test".to_owned(),
            build_commit: None,
            packaged: false,
            runtime_contract_version: Some(23),
        })
        .unwrap();
        let events = core.subscribe().unwrap();
        let settings = GraphicsSettingsRecord {
            hardware_acceleration: false,
            ..Default::default()
        };
        let saved = core
            .invoke(CoreCommand::GraphicsSettingsReplace {
                settings: settings.clone(),
            })
            .unwrap();
        assert_eq!(saved["revision"], 1);
        assert_eq!(
            core.invoke(CoreCommand::GraphicsSettingsReplace { settings })
                .unwrap(),
            saved
        );
        let updates: Vec<_> = events
            .try_iter()
            .flatten()
            .filter_map(|event| match event {
                CoreEvent::GraphicsSettingsChanged { snapshot } => Some(snapshot),
                _ => None,
            })
            .collect();
        assert_eq!(updates.len(), 1);
        assert_eq!(
            serde_json::to_value(read_graphics_settings_at_startup(dir.path()).unwrap()).unwrap(),
            saved
        );
        core.shutdown();
    }
}

#[test]
fn graphics_settings_reject_invalid_values_and_corrupt_database() {
    assert!(
        serde_json::from_str::<GraphicsSettingsRecord>(
            r#"{"hardwareAcceleration":true,"rasterization":"force","videoDecode":"auto"}"#
        )
        .is_err()
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rion-studio.sqlite3");
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(read_graphics_settings_at_startup(dir.path()).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"corrupt");
}

#[test]
fn graphics_settings_missing_key_defaults_and_invalid_payload_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("rion-studio.sqlite3")).unwrap();
    db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, payload_json TEXT)")
        .unwrap();
    assert_eq!(
        read_graphics_settings_at_startup(dir.path())
            .unwrap()
            .revision,
        0
    );
    db.execute(
        "INSERT INTO settings VALUES ('graphicsSettings', 'invalid')",
        [],
    )
    .unwrap();
    assert!(read_graphics_settings_at_startup(dir.path()).is_err());
    assert_eq!(
        db.query_row("SELECT payload_json FROM settings", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "invalid"
    );
}

#[test]
fn graphics_settings_survive_snapshot_replacement_and_are_not_exported() {
    use crate::database::StateDatabaseWorker;
    let dir = tempfile::tempdir().unwrap();
    let worker = StateDatabaseWorker::start(dir.path().join("rion-studio.sqlite3")).unwrap();
    let record = serde_json::json!({"revision": 2, "settings": {"hardwareAcceleration": false, "rasterization": "enabled", "videoDecode": "disabled"}});
    worker
        .replace_scalar("graphicsSettings".to_owned(), record.clone())
        .unwrap();
    let mut snapshot = worker.snapshot().unwrap();
    assert!(snapshot.get("graphicsSettings").is_none());
    snapshot["graphicsSettings"] = serde_json::json!({"revision": 100});
    snapshot["gameBrowserSettings"]["fonts"]["fontSmoothingEnabled"] = serde_json::json!(false);
    worker.replace_snapshot(snapshot).unwrap();
    assert_eq!(
        worker.read_scalar("graphicsSettings".to_owned()).unwrap(),
        Some(record)
    );
}
