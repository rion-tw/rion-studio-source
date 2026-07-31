use std::{
    io::Write,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, backup::Backup, types::ValueRef};
use rusty_leveldb::{DB, LdbIterator, MemEnv, Options, env::Env};
use sha2::{Digest, Sha256};
use url::Url;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        ChromeProfileImportUnsupportedCountsRecord, LocalStorageEntryRecord, SessionCookieRecord,
        SessionTransferPayloadRecord,
    },
};

const CHROME_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;
const DOMAIN_HASH_SCHEMA_VERSION: u32 = 24;
const MAX_LOCAL_STORAGE_ENTRIES: usize = 10_000;
const MAX_LOCAL_STORAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_LOCAL_STATE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_COOKIE_SNAPSHOT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_LEVELDB_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LEVELDB_SNAPSHOT_FILES: usize = 4_096;

#[derive(Debug, Clone)]
pub(crate) struct ParsedSessionTransfer {
    pub payload: SessionTransferPayloadRecord,
    pub unsupported: ChromeProfileImportUnsupportedCountsRecord,
    pub warnings: Vec<String>,
    pub source_fingerprint: String,
}

struct CookieReadContext<'a> {
    platform: rion_platform::Platform,
    launch: &'a Url,
    include_all_cookie_paths: bool,
    warnings: &'a mut Vec<String>,
    unsupported: &'a mut ChromeProfileImportUnsupportedCountsRecord,
}

pub(crate) fn read_chrome_session_transfer(
    source_user_data: &Path,
    profile_directory: &str,
    platform: rion_platform::Platform,
    launch_url: &str,
    include_all_cookie_paths: bool,
) -> CoreResult<ParsedSessionTransfer> {
    if !is_chrome_profile_directory(profile_directory) {
        return Err(CoreError::InvalidInput(
            "Chrome profile directory name is invalid.".to_owned(),
        ));
    }
    let launch = Url::parse(launch_url)
        .map_err(|_| CoreError::InvalidInput("Role launch URL is invalid.".to_owned()))?;
    let profile = source_user_data.join(profile_directory);
    ensure_real_directory(source_user_data)?;
    ensure_real_directory(&profile)?;
    let local_state = source_user_data.join("Local State");
    let mut warnings = Vec::new();
    let mut unsupported = ChromeProfileImportUnsupportedCountsRecord::default();
    let cookies = read_cookies_from_paths(
        &[profile.join("Network/Cookies"), profile.join("Cookies")],
        &local_state,
        CookieReadContext {
            platform,
            launch: &launch,
            include_all_cookie_paths,
            warnings: &mut warnings,
            unsupported: &mut unsupported,
        },
    )?;
    let local_storage = match read_local_storage_directory(
        &profile.join("Local Storage/leveldb"),
        &launch,
        &mut warnings,
    ) {
        Ok(entries) => entries,
        Err(_) => {
            unsupported.storage_read_failure_count += 1;
            warnings.push("LOCAL_STORAGE_READ_FAILED".to_owned());
            Vec::new()
        }
    };
    warnings.sort();
    warnings.dedup();
    let source_fingerprint =
        rion_platform::chrome_profile_source_fingerprint(source_user_data, profile_directory)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
    Ok(ParsedSessionTransfer {
        payload: SessionTransferPayloadRecord {
            cookies,
            local_storage,
        },
        unsupported,
        warnings,
        source_fingerprint,
    })
}

fn read_cookies_from_paths(
    paths: &[PathBuf],
    local_state_path: &Path,
    mut context: CookieReadContext<'_>,
) -> CoreResult<Vec<SessionCookieRecord>> {
    let Some(path) = paths.iter().find(|path| path.is_file()) else {
        return Ok(Vec::new());
    };
    ensure_sqlite_snapshot_size(path)?;
    let source_connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| CoreError::Platform(format!("Chrome Cookies database: {error}")))?;
    let mut connection = Connection::open_in_memory()
        .map_err(|error| CoreError::Platform(format!("Chrome Cookies snapshot: {error}")))?;
    {
        let backup = Backup::new(&source_connection, &mut connection)
            .map_err(|error| CoreError::Platform(format!("Chrome Cookies snapshot: {error}")))?;
        backup
            .run_to_completion(128, Duration::from_millis(1), None)
            .map_err(|error| CoreError::Platform(format!("Chrome Cookies snapshot: {error}")))?;
    }
    let local_state = read_bounded_optional_file(local_state_path, MAX_LOCAL_STATE_BYTES)?;
    read_cookie_rows(&connection, local_state.as_deref(), &mut context)
}

fn read_cookie_rows(
    connection: &Connection,
    local_state: Option<&[u8]>,
    context: &mut CookieReadContext<'_>,
) -> CoreResult<Vec<SessionCookieRecord>> {
    let schema_version = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key='version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .unwrap_or(None)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let columns = cookie_columns(connection)?;
    let partition_expression = if columns.contains("top_frame_site_key") {
        "COALESCE(top_frame_site_key, '')"
    } else {
        "''"
    };
    let query = format!(
        "SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, \
         samesite, encrypted_value, {partition_expression} FROM cookies"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| CoreError::Platform(format!("Chrome Cookies schema: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok(CookieRow {
                host_key: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                path: row.get(3)?,
                expires_utc: row.get(4)?,
                secure: row.get::<_, i64>(5)? != 0,
                http_only: row.get::<_, i64>(6)? != 0,
                same_site: row.get(7)?,
                encrypted_value: read_blob_or_text(row, 8)?,
                partition_key: row.get(9)?,
            })
        })
        .map_err(|error| CoreError::Platform(format!("Chrome Cookies query: {error}")))?;
    let mut decryptor: Option<Result<rion_platform::CookieDecryptor, String>> = None;
    let now = chrono::Utc::now().timestamp();
    let mut result = Vec::new();
    for row in rows {
        let row = match row {
            Ok(row) => row,
            Err(_) => {
                context.warnings.push("COOKIE_ROW_INVALID".to_owned());
                continue;
            }
        };
        if !cookie_matches_launch(&row, context.launch, now, context.include_all_cookie_paths) {
            continue;
        }
        if !row.partition_key.is_empty() {
            context.unsupported.partitioned_cookie_count += 1;
            context
                .warnings
                .push("COOKIE_PARTITIONED_UNSUPPORTED".to_owned());
            continue;
        }
        let encrypted = !row.encrypted_value.is_empty();
        let mut value = if encrypted {
            if row.encrypted_value.starts_with(b"v20") {
                context.unsupported.app_bound_cookie_count += 1;
                context
                    .warnings
                    .push("COOKIE_APP_BOUND_UNSUPPORTED".to_owned());
                continue;
            }
            let decryptor = decryptor.get_or_insert_with(|| {
                rion_platform::CookieDecryptor::chrome_from_local_state(
                    context.platform,
                    local_state,
                    &row.encrypted_value,
                )
                .map_err(|error| error.to_string())
            });
            let decrypted = match decryptor {
                Ok(decryptor) => decryptor
                    .decrypt(&row.encrypted_value)
                    .map_err(|error| error.to_string()),
                Err(error) => Err(error.clone()),
            };
            match decrypted {
                Ok(value) => value,
                Err(message) => {
                    let warning = if message.contains("app-bound") {
                        context.unsupported.app_bound_cookie_count += 1;
                        "COOKIE_APP_BOUND_UNSUPPORTED"
                    } else {
                        context.unsupported.decrypt_failure_count += 1;
                        "COOKIE_DECRYPT_FAILED"
                    };
                    context.warnings.push(warning.to_owned());
                    continue;
                }
            }
        } else {
            row.value.into_bytes()
        };
        if !strip_valid_cookie_domain_hash(&mut value, &row.host_key, schema_version, encrypted) {
            context
                .warnings
                .push("COOKIE_DOMAIN_INTEGRITY_FAILED".to_owned());
            continue;
        }
        let value = String::from_utf8_lossy(&value).into_owned();
        if contains_cookie_control(&value) {
            context.warnings.push("COOKIE_VALUE_INVALID".to_owned());
            continue;
        }
        result.push(SessionCookieRecord {
            name: row.name,
            value,
            domain: row.host_key.starts_with('.').then_some(row.host_key),
            path: if row.path.is_empty() {
                "/".to_owned()
            } else {
                row.path
            },
            secure: row.secure,
            http_only: row.http_only,
            same_site: match row.same_site {
                0 => "none",
                1 => "lax",
                2 => "strict",
                _ => "unspecified",
            }
            .to_owned(),
            expires_unix_ms: (row.expires_utc > 0)
                .then(|| (row.expires_utc / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS) * 1_000),
        });
    }
    result.sort_by(|left, right| {
        (&left.domain, &left.path, &left.name).cmp(&(&right.domain, &right.path, &right.name))
    });
    context.warnings.sort();
    context.warnings.dedup();
    Ok(result)
}

#[cfg(test)]
fn read_local_storage(
    profile: &Path,
    launch: &Url,
    warnings: &mut Vec<String>,
) -> CoreResult<Vec<LocalStorageEntryRecord>> {
    let path = profile.join("Default/Local Storage/leveldb");
    read_local_storage_directory(&path, launch, warnings)
}

fn read_local_storage_directory(
    path: &Path,
    launch: &Url,
    warnings: &mut Vec<String>,
) -> CoreResult<Vec<LocalStorageEntryRecord>> {
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    let origin = launch.origin().ascii_serialization();
    let mut prefix = Vec::with_capacity(origin.len() + 2);
    prefix.push(b'_');
    prefix.extend_from_slice(origin.as_bytes());
    prefix.push(0);
    let environment = snapshot_leveldb(path)?;
    let options = Options {
        env: Rc::new(Box::new(environment)),
        create_if_missing: false,
        paranoid_checks: true,
        ..Options::default()
    };
    let mut database = DB::open(Path::new("chrome-local-storage"), options)
        .map_err(|error| CoreError::Platform(format!("Chrome LocalStorage database: {error}")))?;
    let mut iterator = database
        .new_iter()
        .map_err(|error| CoreError::Platform(format!("Chrome LocalStorage iterator: {error}")))?;
    iterator.seek(&prefix);
    let mut result = Vec::new();
    let mut total_bytes = 0_usize;
    while iterator.valid() {
        let Some((key, value)) = iterator.current() else {
            break;
        };
        if !key.starts_with(&prefix) {
            break;
        }
        if result.len() >= MAX_LOCAL_STORAGE_ENTRIES {
            warnings.push("LOCAL_STORAGE_LIMIT_EXCEEDED".to_owned());
            break;
        }
        let Some(key) = decode_chromium_string(&key[prefix.len()..]) else {
            warnings.push("LOCAL_STORAGE_KEY_INVALID".to_owned());
            iterator.advance();
            continue;
        };
        let Some(value) = decode_chromium_string(&value) else {
            warnings.push("LOCAL_STORAGE_VALUE_INVALID".to_owned());
            iterator.advance();
            continue;
        };
        total_bytes = total_bytes
            .saturating_add(key.len())
            .saturating_add(value.len());
        if total_bytes > MAX_LOCAL_STORAGE_BYTES {
            warnings.push("LOCAL_STORAGE_LIMIT_EXCEEDED".to_owned());
            break;
        }
        result.push(LocalStorageEntryRecord { key, value });
        iterator.advance();
    }
    result.sort_by(|left, right| left.key.cmp(&right.key));
    warnings.sort();
    warnings.dedup();
    Ok(result)
}

fn snapshot_leveldb(path: &Path) -> CoreResult<MemEnv> {
    ensure_real_directory(path)?;
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| CoreError::Platform(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    if entries.len() > MAX_LEVELDB_SNAPSHOT_FILES {
        return Err(CoreError::Platform(
            "Chrome LocalStorage snapshot contains too many files.".to_owned(),
        ));
    }
    let environment = MemEnv::new();
    let mut total_bytes = 0_u64;
    for entry in entries {
        let source = entry.path();
        let metadata = std::fs::symlink_metadata(&source)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CoreError::Platform(
                "Chrome LocalStorage snapshot contains an unsupported path.".to_owned(),
            ));
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_LEVELDB_SNAPSHOT_BYTES {
            return Err(CoreError::Platform(
                "Chrome LocalStorage snapshot is too large.".to_owned(),
            ));
        }
        let bytes =
            std::fs::read(&source).map_err(|error| CoreError::Platform(error.to_string()))?;
        let destination = Path::new("chrome-local-storage").join(entry.file_name());
        let mut file = environment
            .open_writable_file(&destination)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        file.write_all(&bytes)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        file.flush()
            .map_err(|error| CoreError::Platform(error.to_string()))?;
    }
    Ok(environment)
}

fn read_bounded_optional_file(path: &Path, maximum: u64) -> CoreResult<Option<Vec<u8>>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CoreError::Platform(error.to_string())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > maximum {
        return Err(CoreError::Platform(
            "Chrome transfer source contains an unsupported or oversized file.".to_owned(),
        ));
    }
    std::fs::read(path)
        .map(Some)
        .map_err(|error| CoreError::Platform(error.to_string()))
}

fn ensure_sqlite_snapshot_size(path: &Path) -> CoreResult<()> {
    let mut total = 0_u64;
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        let metadata = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(CoreError::Platform(error.to_string())),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CoreError::Platform(
                "Chrome Cookies snapshot contains an unsupported path.".to_owned(),
            ));
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_COOKIE_SNAPSHOT_BYTES {
            return Err(CoreError::Platform(
                "Chrome Cookies snapshot is too large.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn ensure_real_directory(path: &Path) -> CoreResult<()> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| CoreError::Platform(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CoreError::Platform(
            "Chrome transfer source must be a real directory.".to_owned(),
        ));
    }
    Ok(())
}

fn is_chrome_profile_directory(value: &str) -> bool {
    value == "Default"
        || value.strip_prefix("Profile ").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn decode_chromium_string(value: &[u8]) -> Option<String> {
    match value.split_first()? {
        (1, bytes) => Some(bytes.iter().map(|byte| char::from(*byte)).collect()),
        (0, bytes) if bytes.len() % 2 == 0 => {
            let words = bytes
                .chunks_exact(2)
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]));
            String::from_utf16(&words.collect::<Vec<_>>()).ok()
        }
        _ => None,
    }
}

struct CookieRow {
    host_key: String,
    name: String,
    value: String,
    path: String,
    expires_utc: i64,
    secure: bool,
    http_only: bool,
    same_site: i64,
    encrypted_value: Vec<u8>,
    partition_key: String,
}

fn cookie_columns(connection: &Connection) -> CoreResult<std::collections::HashSet<String>> {
    let mut statement = connection
        .prepare("PRAGMA table_info(cookies)")
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    rows.map(|row| row.map_err(|error| CoreError::Platform(error.to_string())))
        .collect()
}

fn read_blob_or_text(row: &Row<'_>, index: usize) -> rusqlite::Result<Vec<u8>> {
    let value = row.get_ref(index)?;
    match value {
        ValueRef::Null => Ok(Vec::new()),
        ValueRef::Blob(bytes) | ValueRef::Text(bytes) => Ok(bytes.to_vec()),
        _ => Err(rusqlite::Error::InvalidColumnType(
            index,
            "encrypted_value".to_owned(),
            value.data_type(),
        )),
    }
}

fn cookie_matches_launch(
    row: &CookieRow,
    launch: &Url,
    now: i64,
    include_all_cookie_paths: bool,
) -> bool {
    let Some(host) = launch.host_str() else {
        return false;
    };
    let domain = row.host_key.trim_start_matches('.');
    let domain_matches = host.eq_ignore_ascii_case(domain)
        || (row.host_key.starts_with('.')
            && host
                .to_ascii_lowercase()
                .ends_with(&format!(".{}", domain.to_ascii_lowercase())));
    let cookie_path = if row.path.is_empty() { "/" } else { &row.path };
    let expires = row.expires_utc / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
    domain_matches
        && (include_all_cookie_paths || cookie_path_matches(launch.path(), cookie_path))
        && (!row.secure || launch.scheme() == "https")
        && (row.expires_utc <= 0 || expires > now)
        && !row.name.is_empty()
        && !contains_cookie_control(&row.name)
        && !contains_cookie_control(cookie_path)
}

fn cookie_path_matches(request_path: &str, cookie_path: &str) -> bool {
    request_path == cookie_path
        || (request_path.starts_with(cookie_path)
            && (cookie_path.ends_with('/')
                || request_path.as_bytes().get(cookie_path.len()) == Some(&b'/')))
}

fn strip_valid_cookie_domain_hash(
    value: &mut Vec<u8>,
    host_key: &str,
    schema_version: u32,
    encrypted: bool,
) -> bool {
    if !encrypted || schema_version < DOMAIN_HASH_SCHEMA_VERSION {
        return true;
    }
    let expected = Sha256::digest(host_key.as_bytes());
    if value.len() < expected.len() || value[..expected.len()] != expected[..] {
        return false;
    }
    value.drain(..expected.len());
    true
}

fn contains_cookie_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= '\u{1f}' || character == '\u{7f}')
}

#[cfg(test)]
mod tests {
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
}
