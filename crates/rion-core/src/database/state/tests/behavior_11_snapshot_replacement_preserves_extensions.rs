#[test]
fn snapshot_replacement_keeps_installed_extensions() {
    let mut connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    let extensions = json!({"revision": 3, "installed": [{"id": "abc"}], "roles": []});
    replace_scalar(&mut connection, "extensions", extensions.clone()).unwrap();

    // Portable apply replaces state from the typed snapshot, which has no
    // extensions field; startup recovery replays the raw stored snapshot.
    let typed: crate::model::CoreStateSnapshotRecord =
        serde_json::from_value(read_snapshot(&connection).unwrap()).unwrap();
    replace_snapshot(&mut connection, &serde_json::to_value(&typed).unwrap()).unwrap();
    assert_eq!(read_scalar(&connection, "extensions").unwrap(), Some(extensions.clone()));

    let raw = read_snapshot(&connection).unwrap();
    replace_snapshot(&mut connection, &raw).unwrap();
    assert_eq!(read_scalar(&connection, "extensions").unwrap(), Some(extensions));
}
