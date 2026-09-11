use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use fs2::FileExt;
use std::fs;

#[cfg(windows)]
fn migration_output_tempdir() -> tempfile::TempDir {
    // Windows' default temp directory is inside LOCALAPPDATA, which the
    // production migration boundary deliberately rejects as an output root.
    tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap()
}

#[cfg(not(windows))]
fn migration_output_tempdir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn encoded_string(text: &[u16]) -> Vec<u8> {
    let mut bytes = (text.len() as u32).to_le_bytes().to_vec();
    bytes.push(0);
    for unit in text {
        bytes.extend(unit.to_le_bytes());
    }
    bytes
}
fn origin(host: &str) -> Vec<u8> {
    let mut bytes = encoded_string(&"https".encode_utf16().collect::<Vec<_>>());
    bytes.extend(encoded_string(&host.encode_utf16().collect::<Vec<_>>()));
    bytes.push(0);
    bytes
}
fn exported(host: &str, client: &str, value: &[u16]) -> Vec<u8> {
    let mut bytes = 1_u32.to_le_bytes().to_vec();
    for value in [1_u64, 32, 1] {
        bytes.extend(value.to_le_bytes());
    }
    bytes.extend(origin(host));
    bytes.extend(origin(client));
    bytes.extend(1_u64.to_le_bytes());
    bytes.extend(encoded_string(&[107]));
    bytes.extend(encoded_string(value));
    bytes
}

#[test]
fn webkit_export_preserves_utf16_including_null_and_unpaired_surrogates() {
    let value = [0x89d2, 0x8272, 0, 0xd800, 0xdc00, 0xdfff];
    let decoded = webkit::decode_export(&exported("a.invalid", "a.invalid", &value)).unwrap();
    assert_eq!(decoded.len(), 1);
    assert_eq!(decoded[0].origin, "https://a.invalid");
    assert_eq!(
        decoded[0].entries[0].value.decoded_bytes().unwrap(),
        value
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>()
    );
}

#[test]
fn webkit_export_rejects_partition_loss_unknown_version_and_truncation() {
    assert_eq!(
        webkit::decode_export(&exported("a.invalid", "b.invalid", &[1])).unwrap_err(),
        "WEBKIT_PARTITIONED_LOCAL_STORAGE_UNSUPPORTED"
    );
    let valid = exported("a.invalid", "a.invalid", &[1]);
    for length in 0..valid.len() {
        assert!(webkit::decode_export(&valid[..length]).is_err());
    }
    let mut unknown = valid.clone();
    unknown[0] = 2;
    assert_eq!(
        webkit::decode_export(&unknown).unwrap_err(),
        "WEBKIT_EXPORT_FORMAT_UNSUPPORTED"
    );
    let mut trailing = valid;
    trailing.push(0);
    assert_eq!(
        webkit::decode_export(&trailing).unwrap_err(),
        "WEBKIT_TRAILING_DATA"
    );
}

#[test]
fn webkit_empty_inventory_is_parseable_but_not_evidence_of_an_empty_real_role() {
    let mut bytes = 1_u32.to_le_bytes().to_vec();
    for value in [1_u64, 32, 0] {
        bytes.extend(value.to_le_bytes());
    }
    assert!(webkit::decode_export(&bytes).unwrap().is_empty());
    bytes[20..28].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_eq!(
        webkit::decode_export(&bytes).unwrap_err(),
        "WEBKIT_ORIGIN_LIMIT"
    );
}

#[test]
fn macos26_native_serialization_fixture_matches_known_seed() {
    // Captured only from nonpersistent synthetic WebKit stores on macOS 26.6.2.
    let bytes = STANDARD.decode("AQAAAAEAAAAAAAAAIAAAAAAAAAACAAAAAAAAAAUAAAABaHR0cHMVAAAAAW1pZ3JhdGlvbi10d28uaW52YWxpZAAFAAAAAWh0dHBzFQAAAAFtaWdyYXRpb24tdHdvLmludmFsaWQAAQAAAAAAAAAJAAAAAWNoYXJhY3RlchAAAAABaW5kZXBlbmRlbnQtcm9sZQUAAAABaHR0cHMVAAAAAW1pZ3JhdGlvbi1vbmUuaW52YWxpZAAFAAAAAWh0dHBzFQAAAAFtaWdyYXRpb24tb25lLmludmFsaWQAAQAAAAAAAAAJAAAAAWNoYXJhY3RlcgUAAAAA0olyggAALG5mig==").unwrap();
    let records = webkit::decode_export(&bytes).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].origin, "https://migration-one.invalid");
    assert_eq!(
        records[0].entries[0].value.decoded_bytes().unwrap(),
        "角色\0測試"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    );
}

#[test]
fn webkit_origin_rejects_cross_site_partition_and_trailing_bytes() {
    let mut bytes = origin("a.invalid");
    bytes.extend(origin("a.invalid"));
    assert_eq!(webkit::decode_origin(&bytes).unwrap(), "https://a.invalid");
    bytes.push(0);
    assert_eq!(
        webkit::decode_origin(&bytes).unwrap_err(),
        "WEBKIT_TRAILING_DATA"
    );
}

#[test]
fn output_is_new_disjoint_and_cannot_overwrite_an_existing_run() {
    let temporary = migration_output_tempdir();
    let root = fs::canonicalize(temporary.path()).unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    assert_eq!(
        paths::create_output(&source.join("target"), std::slice::from_ref(&source)).unwrap_err(),
        "OUTPUT_OVERLAPS_SOURCE"
    );
    let output = root.join("output");
    paths::create_output(&output, &[source]).unwrap();
    fs::write(output.join("retained"), b"never delete").unwrap();
    assert_eq!(
        paths::create_output(&output, &[]).unwrap_err(),
        "NEW_ABSOLUTE_OUTPUT_REQUIRED"
    );
    assert_eq!(fs::read(output.join("retained")).unwrap(), b"never delete");
    // Keep the raw, non-verbatim user spelling for this assertion. Joining
    // onto the canonical Windows verbatim path normalizes `..` before the
    // migration boundary can inspect it.
    assert!(paths::existing(&temporary.path().join("output/../output")).is_err());
}

#[cfg(unix)]
#[test]
fn source_and_output_reject_symlinks_including_parent_components() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    fs::create_dir(root.join("real")).unwrap();
    symlink(root.join("real"), root.join("link")).unwrap();
    assert_eq!(
        paths::existing(&root.join("link")).unwrap_err(),
        "SYMLINK_FORBIDDEN"
    );
    assert_eq!(
        paths::create_output(&root.join("link/out"), &[]).unwrap_err(),
        "SYMLINK_FORBIDDEN"
    );
    assert_eq!(paths::files(&root).unwrap_err(), "SYMLINK_FORBIDDEN");
}

#[test]
fn core_instance_lock_blocks_capture_without_rewriting_pid_bytes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    let path = root.join("rion-studio.instance.lock");
    fs::write(&path, b"source PID evidence").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    held.try_lock_exclusive().unwrap();
    assert_eq!(snapshot::source_lock(&root).unwrap_err(), "SOURCE_IN_USE");
    drop(held);
    // Windows byte-range locks also prohibit reads through another handle.
    assert_eq!(fs::read(&path).unwrap(), b"source PID evidence");
    assert!(snapshot::source_lock(&root).is_ok());
    assert_eq!(fs::read(&path).unwrap(), b"source PID evidence");
}

#[test]
fn binary_cookie_structural_reader_does_not_accept_corrupt_page_tables() {
    assert_eq!(
        windows::binary_cookie_count(b"not cookies").unwrap_err(),
        "COOKIE_FORMAT_UNKNOWN"
    );
    let mut empty = b"cook".to_vec();
    empty.extend(0_u32.to_be_bytes());
    assert_eq!(windows::binary_cookie_count(&empty).unwrap(), 0);
    empty[4..8].copy_from_slice(&1_u32.to_be_bytes());
    assert_eq!(
        windows::binary_cookie_count(&empty).unwrap_err(),
        "COOKIE_FILE_TRUNCATED"
    );
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn real_inventory_never_promotes_missing_or_ambiguous_roles() {
    let temporary = migration_output_tempdir();
    let root = fs::canonicalize(temporary.path()).unwrap();
    let data = root.join("data");
    fs::create_dir(&data).unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    let db = data.join("rion-studio.sqlite3");
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(29); CREATE TABLE roles(id TEXT, name TEXT, ordinal INTEGER);").unwrap();
    connection
        .execute("INSERT INTO roles VALUES(?1,'synthetic',0)", [id])
        .unwrap();
    drop(connection);
    let before = fs::read(&db).unwrap();
    fs::write(data.join("rion-studio.instance.lock"), b"unchanged").unwrap();
    let mut roots = Vec::new();
    for name in ["com.rionstudio.launcher", "com.rionstudio.launcher.dev"] {
        let base = root.join(name);
        fs::create_dir(&base).unwrap();
        let store = if cfg!(target_os = "macos") {
            base.join(inventory::store_id(id))
        } else {
            base.join(id).join("browser/webview2")
        };
        fs::create_dir_all(&store).unwrap();
        roots.push(inventory::SourceRoot {
            app_id: name.to_owned(),
            path: base,
        });
    }
    let report = inventory::run(&data, &roots, &[], &root.join("run"), true).unwrap();
    assert_eq!(report["roles"][0]["sourceAssessment"], "SOURCE_AMBIGUOUS");
    assert_eq!(report["roles"][0]["loginEligible"], false);
    assert_eq!(report["roles"][0]["journalPhase"], "missing");
    assert_eq!(fs::read(db).unwrap(), before);
    assert_eq!(
        fs::read(data.join("rion-studio.instance.lock")).unwrap(),
        b"unchanged"
    );
    assert_eq!(report["sourceDatabaseAndWalUnchanged"], true);
}

#[test]
fn webkit_sqlite_reads_committed_wal_without_checkpointing_the_source() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("localstorage.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT UNIQUE, value BLOB);").unwrap();
    connection
        .execute(
            "INSERT INTO ItemTable VALUES(?1,?2)",
            rusqlite::params!["角色", vec![0_u8, 0, 0, 0xd8]],
        )
        .unwrap();
    let copy = tempfile::tempdir().unwrap();
    for name in ["localstorage.sqlite3", "localstorage.sqlite3-wal"] {
        fs::copy(temp.path().join(name), copy.path().join(name)).unwrap();
    }
    let before = fs::read(&path).unwrap();
    let wal_before = fs::read(temp.path().join("localstorage.sqlite3-wal")).unwrap();
    let entries = webkit_sqlite::read(&copy.path().join("localstorage.sqlite3")).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].value.decoded_bytes().unwrap(), [0, 0, 0, 0xd8]);
    assert_eq!(fs::read(path).unwrap(), before);
    assert_eq!(
        fs::read(temp.path().join("localstorage.sqlite3-wal")).unwrap(),
        wal_before
    );
}

#[test]
fn webkit_sqlite_refuses_unknown_schema_corruption_and_odd_utf16() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("localstorage.sqlite3");
    fs::write(&path, b"damaged SQLite").unwrap();
    assert!(webkit_sqlite::read(&path).is_err());
    fs::remove_file(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("CREATE TABLE ItemTable(key TEXT,value TEXT)")
        .unwrap();
    assert_eq!(
        webkit_sqlite::read(&path).unwrap_err(),
        "WEBKIT_SQLITE_SCHEMA_UNKNOWN"
    );
    connection.execute_batch("DROP TABLE ItemTable; CREATE TABLE ItemTable(key TEXT,value BLOB); INSERT INTO ItemTable VALUES('key',x'01')").unwrap();
    assert_eq!(
        webkit_sqlite::read(&path).unwrap_err(),
        "WEBKIT_UTF16_INVALID"
    );
}

#[test]
fn request_cannot_spoof_the_native_platform_or_use_another_role_path() {
    assert_eq!(
        run(br#"{"mode":"decodeWebkit","serialization":"","platform":"windows"}"#).unwrap_err(),
        "INVALID_REQUEST"
    );
    for invalid in [
        "../other-role",
        "A",
        "11111111-1111-4111-8111-111111111111/child",
    ] {
        assert_eq!(paths::role_id(invalid).unwrap_err(), "INVALID_ROLE_ID");
    }
}

#[cfg(unix)]
#[test]
fn replacing_an_open_source_file_invalidates_native_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let path = root.join("source");
    fs::write(&path, b"old").unwrap();
    let file = snapshot::open_file(&path).unwrap();
    fs::rename(&path, root.join("original")).unwrap();
    fs::write(&path, b"replacement").unwrap();
    assert!(rion_platform::verify_open_file_identity(&path, &file).is_err());
    assert_eq!(fs::read(root.join("original")).unwrap(), b"old");
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn exported_package_assessment_authenticates_identity_platform_and_ciphertext() {
    let temp = migration_output_tempdir();
    let root = fs::canonicalize(temp.path()).unwrap().join("fixture");
    let fixture = synthetic::prepare(&root, synthetic(None, false).unwrap()).unwrap();
    let role = fixture["journal"]["roleId"].as_str().unwrap();
    let transfer_id = fixture["journal"]["transferId"].as_str().unwrap();
    let database = root.join("rion-studio.sqlite3");
    let before = fs::read(&database).unwrap();
    let connection = rusqlite::Connection::open(&database).unwrap();
    let report = transfer::assess(&connection, &root, role).unwrap();
    assert_eq!(report["status"], "authenticated");
    assert_eq!(report["cookies"], 1);
    assert_eq!(report["loginEligible"], false);
    assert_eq!(fs::read(&database).unwrap(), before);
    assert_eq!(
        transfer::assess(&connection, &root, "11111111-1111-4111-8111-111111111111").unwrap_err(),
        "EXPORTED_JOURNAL_MISSING"
    );
    let native = if cfg!(windows) { "windows" } else { "macos" };
    let other = if cfg!(windows) { "macos" } else { "windows" };
    connection
        .execute(
            "UPDATE role_session_migrations SET platform=?1, source_engine=CASE ?1 WHEN 'macos' THEN 'wkwebview' ELSE 'webview2' END WHERE role_id=?2",
            [other, role],
        )
        .unwrap();
    assert!(transfer::assess(&connection, &root, role).is_err());
    connection
        .execute(
            "UPDATE role_session_migrations SET platform=?1, source_engine=CASE ?1 WHEN 'macos' THEN 'wkwebview' ELSE 'webview2' END WHERE role_id=?2",
            [native, role],
        )
        .unwrap();
    let vault = root
        .join(".session-migrations")
        .join(role)
        .join(transfer_id)
        .join("inventory.enc");
    let mut encrypted = fs::read(&vault).unwrap();
    let end = encrypted.len() - 1;
    encrypted[end] ^= 1;
    fs::write(&vault, encrypted).unwrap();
    assert_eq!(
        transfer::assess(&connection, &root, role).unwrap_err(),
        "EXPORTED_PACKAGE_AUTHENTICATION_OR_COMPLETENESS_FAILED"
    );
}
