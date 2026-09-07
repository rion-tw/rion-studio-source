use super::local_storage::*;
use std::fs;
fn origin(host: &str) -> Vec<u8> {
    let mut one = Vec::new();
    for value in ["https", host] {
        let units = value.encode_utf16().collect::<Vec<_>>();
        one.extend((units.len() as u32).to_le_bytes());
        one.push(0);
        for unit in units {
            one.extend(unit.to_le_bytes());
        }
    }
    one.push(0);
    [one.clone(), one].concat()
}
#[test]
fn partial_local_storage_snapshot_keeps_wal_unicode_and_healthy_origins_despite_unknown_cookies() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let source = tempfile::tempdir().unwrap();
    let connection =
        rusqlite::Connection::open(source.path().join("localstorage.sqlite3")).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);").unwrap();
    let bytes = [0x89d2_u16, 0, 0xd800, 0xdfff]
        .iter()
        .flat_map(|n| n.to_le_bytes())
        .collect::<Vec<_>>();
    connection
        .execute(
            "INSERT INTO ItemTable VALUES(?1,?2)",
            rusqlite::params!["鍵", bytes],
        )
        .unwrap();
    let target = root.path().join("a/LocalStorage");
    fs::create_dir_all(&target).unwrap();
    fs::write(root.path().join("a/origin"), origin("a.invalid")).unwrap();
    for file in ["localstorage.sqlite3", "localstorage.sqlite3-wal"] {
        fs::copy(source.path().join(file), target.join(file)).unwrap();
    }
    fs::write(
        root.path().join("Cookies.binarycookies"),
        b"unrecognized-cookie-format",
    )
    .unwrap();
    let bad = root.path().join("b/LocalStorage");
    fs::create_dir_all(&bad).unwrap();
    fs::write(root.path().join("b/origin"), origin("b.invalid")).unwrap();
    fs::write(bad.join("localstorage.sqlite3"), b"corrupt").unwrap();
    let (origins, errors) = read_snapshot(root.path()).unwrap();
    assert_eq!(origins.len(), 1);
    assert_eq!(origins[0].origin, "https://a.invalid");
    assert_eq!(
        origins[0].entries[0].key.decoded_bytes().unwrap(),
        "鍵"
            .encode_utf16()
            .flat_map(|n| n.to_le_bytes())
            .collect::<Vec<_>>()
    );
    assert_eq!(origins[0].entries[0].value.decoded_bytes().unwrap(), bytes);
    assert_eq!(errors, vec!["WEBKIT_SQLITE_INVALID"]);
}
#[test]
fn partial_local_storage_missing_source_is_not_an_empty_inventory() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let (origins, errors) = read_snapshot(root.path()).unwrap();
    assert!(origins.is_empty());
    assert_eq!(errors, vec!["LOCAL_STORAGE_SOURCE_MISSING_UNPROVEN"]);
}
