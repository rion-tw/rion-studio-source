use super::*;
    use tempfile::tempdir;

    fn write_local_storage_fixture(profile: &Path, entries: Vec<(Vec<u8>, Vec<u8>)>) {
        let path = profile.join("Default/Local Storage/leveldb");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let options = Options {
            create_if_missing: true,
            ..Options::default()
        };
        let mut database = DB::open(&path, options).unwrap();
        for (key, value) in entries {
            database.put(&key, &value).unwrap();
        }
        database.flush().unwrap();
    }

    #[test]
    fn decodes_chromium_latin1_and_utf16_strings() {
        assert_eq!(decode_chromium_string(&[1, b'a', 0xe9]).unwrap(), "aé");
        assert_eq!(
            decode_chromium_string(&[0, b'A', 0, 0x60, 0x4f]).unwrap(),
            "A你"
        );
        assert!(decode_chromium_string(&[2, 1]).is_none());
    }

    #[test]
    fn filters_cookie_domain_path_expiry_and_secure_semantics() {
        let launch = Url::parse("https://game.example.test/play").unwrap();
        let row = CookieRow {
            host_key: ".example.test".to_owned(),
            name: "session".to_owned(),
            value: String::new(),
            path: "/play".to_owned(),
            expires_utc: 0,
            secure: true,
            http_only: true,
            same_site: 1,
            encrypted_value: Vec::new(),
            partition_key: String::new(),
        };
        assert!(cookie_matches_launch(
            &row,
            &launch,
            chrono::Utc::now().timestamp(),
            false,
        ));
        let mut wrong_boundary = row;
        wrong_boundary.path = "/pla".to_owned();
        assert!(!cookie_matches_launch(
            &wrong_boundary,
            &launch,
            chrono::Utc::now().timestamp(),
            false,
        ));
        assert!(cookie_matches_launch(
            &wrong_boundary,
            &launch,
            chrono::Utc::now().timestamp(),
            true,
        ));
    }

    #[test]
    fn validates_schema_twenty_four_domain_hash_only_for_encrypted_values() {
        let host = ".example.test";
        let mut encrypted = Sha256::digest(host.as_bytes()).to_vec();
        encrypted.extend_from_slice(b"session-value");
        assert!(strip_valid_cookie_domain_hash(
            &mut encrypted,
            host,
            24,
            true
        ));
        assert_eq!(encrypted, b"session-value");

        let mut wrong = [vec![0_u8; 32], b"session-value".to_vec()].concat();
        assert!(!strip_valid_cookie_domain_hash(&mut wrong, host, 24, true));
        let mut plaintext = b"session-value".to_vec();
        assert!(strip_valid_cookie_domain_hash(
            &mut plaintext,
            host,
            24,
            false
        ));
    }

    #[test]
    fn chrome_cookie_fixture_filters_scope_expiry_and_partitioned_rows() {
        let profile = tempdir().unwrap();
        let cookie_path = profile.path().join("Default/Cookies");
        std::fs::create_dir_all(cookie_path.parent().unwrap()).unwrap();
        let connection = Connection::open(&cookie_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO meta(key, value) VALUES ('version', '24');
                 CREATE TABLE cookies(
                   host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER,
                   is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
                   encrypted_value BLOB, top_frame_site_key TEXT
                 );
                 INSERT INTO cookies VALUES
                   ('.example.test','valid','kept','/play',0,1,1,1,X'',''),
                   ('.example.test','wrong-path','no','/other',0,1,0,0,X'',''),
                   ('other.test','wrong-domain','no','/',0,1,0,0,X'',''),
                   ('.example.test','partitioned','no','/',0,1,0,0,X'','https://top.test'),
                   ('.example.test','expired','no','/',1,1,0,0,X'','');",
            )
            .unwrap();
        drop(connection);

        let parsed = read_chrome_session_transfer(
            profile.path(),
            "Default",
            rion_platform::Platform::Macos,
            "https://game.example.test/play",
            false,
        )
        .unwrap();
        assert_eq!(parsed.payload.cookies.len(), 1);
        assert_eq!(parsed.payload.cookies[0].name, "valid");
        assert_eq!(parsed.payload.cookies[0].value, "kept");
        assert_eq!(parsed.warnings, vec!["COOKIE_PARTITIONED_UNSUPPORTED"]);
        assert_eq!(parsed.unsupported.partitioned_cookie_count, 1);
    }

    #[test]
    fn chrome_profile_first_party_policy_includes_all_paths_and_counts_unsupported_rows() {
        let source = tempdir().unwrap();
        let cookie_path = source.path().join("Default/Network/Cookies");
        std::fs::create_dir_all(cookie_path.parent().unwrap()).unwrap();
        std::fs::write(source.path().join("Local State"), b"{}").unwrap();
        let connection = Connection::open(&cookie_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO meta(key, value) VALUES ('version', '23');
                 CREATE TABLE cookies(
                   host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER,
                   is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
                   encrypted_value BLOB, top_frame_site_key TEXT
                 );
                 INSERT INTO cookies VALUES
                   ('.example.test','profile-session','kept','/profile',0,1,1,1,X'',''),
                   ('.example.test','partitioned','no','/auth',0,1,1,1,X'','https://top.test'),
                   ('.example.test','app-bound','','/auth',0,1,1,1,X'7632307061796c6f6164',''),
                   ('other.test','unrelated-partitioned','no','/',0,1,1,1,X'','https://top.test');",
            )
            .unwrap();
        drop(connection);

        let bounded = read_chrome_session_transfer(
            source.path(),
            "Default",
            rion_platform::Platform::Macos,
            "https://game.example.test/play",
            false,
        )
        .unwrap();
        assert!(bounded.payload.cookies.is_empty());
        assert_eq!(bounded.unsupported.partitioned_cookie_count, 0);
        assert_eq!(bounded.unsupported.app_bound_cookie_count, 0);

        for platform in [
            rion_platform::Platform::Macos,
            rion_platform::Platform::Windows,
        ] {
            let first_party = read_chrome_session_transfer(
                source.path(),
                "Default",
                platform,
                "https://game.example.test/play",
                true,
            )
            .unwrap();
            assert_eq!(first_party.payload.cookies.len(), 1);
            assert_eq!(first_party.payload.cookies[0].name, "profile-session");
            assert_eq!(first_party.unsupported.partitioned_cookie_count, 1);
            assert_eq!(first_party.unsupported.app_bound_cookie_count, 1);
            assert_eq!(
                first_party.warnings,
                vec![
                    "COOKIE_APP_BOUND_UNSUPPORTED",
                    "COOKIE_PARTITIONED_UNSUPPORTED"
                ]
            );
        }
    }

    #[test]
    fn chrome_profile_is_snapshotted_in_memory_without_raw_staging_files() {
        let source = tempdir().unwrap();
        let cookie_path = source.path().join("Default/Network/Cookies");
        std::fs::create_dir_all(cookie_path.parent().unwrap()).unwrap();
        std::fs::write(source.path().join("Local State"), b"{}").unwrap();
        let connection = Connection::open(&cookie_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO meta(key, value) VALUES ('version', '23');
                 CREATE TABLE cookies(
                   host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER,
                   is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
                   encrypted_value BLOB, top_frame_site_key TEXT
                 );
                 INSERT INTO cookies VALUES
                   ('.example.test','session','kept','/',0,1,1,1,X'','');",
            )
            .unwrap();
        drop(connection);
        write_local_storage_fixture(
            source.path(),
            vec![(
                [b"_https://game.example.test\0".as_slice(), &[1], b"token"].concat(),
                [b"\x01".as_slice(), b"exact"].concat(),
            )],
        );
        let before =
            rion_platform::chrome_profile_source_fingerprint(source.path(), "Default").unwrap();

        let parsed = read_chrome_session_transfer(
            source.path(),
            "Default",
            rion_platform::Platform::Macos,
            "https://game.example.test/play",
            false,
        )
        .unwrap();

        assert_eq!(parsed.payload.cookies[0].value, "kept");
        assert_eq!(parsed.payload.local_storage[0].key, "token");
        assert_eq!(parsed.payload.local_storage[0].value, "exact");
        assert_eq!(parsed.source_fingerprint, before);
        assert_eq!(
            rion_platform::chrome_profile_source_fingerprint(source.path(), "Default").unwrap(),
            before
        );
        assert!(!source.path().join(".chrome-profile-import-work").exists());
        assert!(!source.path().join(".session-transfers").exists());
    }

    #[test]
    fn local_storage_accepts_only_the_exact_launch_origin() {
        let profile = tempdir().unwrap();
        let exact_prefix = b"_https://game.example.test\0";
        let other_prefix = b"_https://other.example.test\0";
        let slash_prefix = b"_https://game.example.test/\0";
        write_local_storage_fixture(
            profile.path(),
            vec![
                (
                    [exact_prefix.as_slice(), &[1], b"token"].concat(),
                    [b"\x01".as_slice(), b"exact"].concat(),
                ),
                (
                    [other_prefix.as_slice(), &[1], b"token"].concat(),
                    [b"\x01".as_slice(), b"other"].concat(),
                ),
                (
                    [slash_prefix.as_slice(), &[1], b"token"].concat(),
                    [b"\x01".as_slice(), b"slash"].concat(),
                ),
            ],
        );
        let mut warnings = Vec::new();
        let entries = read_local_storage(
            profile.path(),
            &Url::parse("https://game.example.test/play").unwrap(),
            &mut warnings,
        )
        .unwrap();
        assert_eq!(
            entries,
            vec![LocalStorageEntryRecord {
                key: "token".to_owned(),
                value: "exact".to_owned(),
            }]
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn local_storage_rejects_corruption_and_enforces_the_byte_limit() {
        let corrupt = tempdir().unwrap();
        let corrupt_path = corrupt.path().join("Default/Local Storage/leveldb");
        std::fs::create_dir_all(&corrupt_path).unwrap();
        std::fs::write(corrupt_path.join("CURRENT"), b"not-a-manifest\n").unwrap();
        assert!(
            read_local_storage(
                corrupt.path(),
                &Url::parse("https://game.example.test/play").unwrap(),
                &mut Vec::new(),
            )
            .is_err()
        );
        let parsed = read_chrome_session_transfer(
            corrupt.path(),
            "Default",
            rion_platform::Platform::Macos,
            "https://game.example.test/play",
            false,
        )
        .unwrap();
        assert!(parsed.payload.local_storage.is_empty());
        assert_eq!(parsed.warnings, vec!["LOCAL_STORAGE_READ_FAILED"]);

        let oversized = tempdir().unwrap();
        write_local_storage_fixture(
            oversized.path(),
            vec![(
                [b"_https://game.example.test\0".as_slice(), &[1], b"large"].concat(),
                [vec![1], vec![b'x'; MAX_LOCAL_STORAGE_BYTES + 1]].concat(),
            )],
        );
        let mut warnings = Vec::new();
        let entries = read_local_storage(
            oversized.path(),
            &Url::parse("https://game.example.test/play").unwrap(),
            &mut warnings,
        )
        .unwrap();
        assert!(entries.is_empty());
        assert_eq!(warnings, vec!["LOCAL_STORAGE_LIMIT_EXCEEDED"]);

        let too_many = tempdir().unwrap();
        let entries = (0..=MAX_LOCAL_STORAGE_ENTRIES)
            .map(|index| {
                (
                    [
                        b"_https://game.example.test\0".as_slice(),
                        &[1],
                        format!("key-{index:05}").as_bytes(),
                    ]
                    .concat(),
                    [b"\x01".as_slice(), b"v"].concat(),
                )
            })
            .collect();
        write_local_storage_fixture(too_many.path(), entries);
        let mut warnings = Vec::new();
        let entries = read_local_storage(
            too_many.path(),
            &Url::parse("https://game.example.test/play").unwrap(),
            &mut warnings,
        )
        .unwrap();
        assert_eq!(entries.len(), MAX_LOCAL_STORAGE_ENTRIES);
        assert_eq!(warnings, vec!["LOCAL_STORAGE_LIMIT_EXCEEDED"]);
    }
