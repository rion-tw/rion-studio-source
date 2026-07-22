use std::path::{Path, PathBuf};

use rion_platform::Platform;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, types::ValueRef};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};

const CHROME_EPOCH_OFFSET_SECONDS: f64 = 11_644_473_600.0;
const DOMAIN_HASH_SCHEMA_VERSION: u32 = 24;
const SHA256_LENGTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedChromeCookie {
    pub url: String,
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
}

pub fn read_imported_cookies(
    browser_user_data_dir: &Path,
    platform: Platform,
) -> CoreResult<Vec<ImportedChromeCookie>> {
    if !browser_user_data_dir.is_absolute() {
        return Err(CoreError::InvalidInput(
            "Chrome profile path must be absolute".to_owned(),
        ));
    }
    let Some(cookies_path) = find_cookie_database(browser_user_data_dir) else {
        return Ok(Vec::new());
    };
    let connection = Connection::open_with_flags(
        &cookies_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| CoreError::Platform(format!("Chrome Cookies database: {error}")))?;
    let schema_version = connection
        .query_row("SELECT value FROM meta WHERE key='version'", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()
        .unwrap_or(None)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let mut statement = connection
        .prepare(
            "SELECT host_key, name, value, path, expires_utc, is_secure,\
             is_httponly, samesite, encrypted_value FROM cookies",
        )
        .map_err(|error| CoreError::Platform(format!("Chrome Cookies schema: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok(CookieRow {
                host_key: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                path: row.get(3)?,
                expires_utc: row.get(4)?,
                is_secure: row.get::<_, i64>(5)? != 0,
                is_http_only: row.get::<_, i64>(6)? != 0,
                same_site: row.get(7)?,
                encrypted_value: read_blob_or_text(row, 8)?,
            })
        })
        .map_err(|error| CoreError::Platform(format!("Chrome Cookies query: {error}")))?;
    let now = chrono::Utc::now().timestamp() as f64;
    rows.map(|row| {
        row.map_err(|error| CoreError::Platform(format!("Chrome Cookies row: {error}")))
            .and_then(|row| normalize_cookie(row, schema_version, platform, now))
    })
    .filter_map(|result| match result {
        Ok(Some(cookie)) => Some(Ok(cookie)),
        Ok(None) => None,
        Err(error) => Some(Err(error)),
    })
    .collect()
}

struct CookieRow {
    host_key: String,
    name: String,
    value: String,
    path: String,
    expires_utc: i64,
    is_secure: bool,
    is_http_only: bool,
    same_site: i64,
    encrypted_value: Vec<u8>,
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

fn normalize_cookie(
    row: CookieRow,
    schema_version: u32,
    platform: Platform,
    now: f64,
) -> CoreResult<Option<ImportedChromeCookie>> {
    let is_domain_cookie = row.host_key.starts_with('.');
    let host = row.host_key.trim_start_matches('.');
    if host.is_empty()
        || row.name.is_empty()
        || contains_disallowed_cookie_character(host)
        || contains_disallowed_cookie_character(&row.name)
        || contains_disallowed_cookie_character(&row.path)
    {
        return Ok(None);
    }
    let mut value = if row.encrypted_value.is_empty() {
        row.value.into_bytes()
    } else {
        rion_platform::decrypt_chrome_cookie(platform, &row.encrypted_value)
            .map_err(|error| CoreError::Platform(error.to_string()))?
    };
    if schema_version >= DOMAIN_HASH_SCHEMA_VERSION {
        remove_and_verify_domain_hash(&mut value, &row.host_key)?;
    }
    let Some(value) = decode_cookie_value(value) else {
        return Ok(None);
    };
    let expiration_date = (row.expires_utc > 0)
        .then(|| row.expires_utc as f64 / 1_000_000.0 - CHROME_EPOCH_OFFSET_SECONDS);
    if expiration_date.is_some_and(|expiration| expiration <= now) {
        return Ok(None);
    }
    let path = if row.path.is_empty() {
        "/".to_owned()
    } else {
        row.path
    };
    Ok(Some(ImportedChromeCookie {
        url: format!(
            "{}://{host}{path}",
            if row.is_secure { "https" } else { "http" }
        ),
        name: row.name,
        value,
        domain: is_domain_cookie.then_some(row.host_key),
        path,
        secure: row.is_secure,
        http_only: row.is_http_only,
        same_site: match row.same_site {
            0 => "no_restriction",
            1 => "lax",
            2 => "strict",
            _ => "unspecified",
        }
        .to_owned(),
        expiration_date,
    }))
}

fn decode_cookie_value(value: Vec<u8>) -> Option<String> {
    // Chromium's cookie store can contain legacy byte strings that are not
    // valid UTF-8. Electron's former TypeScript importer decoded those values
    // with Buffer.toString("utf8"), so preserve that replacement behavior at
    // the Rust boundary instead of failing the entire profile transaction.
    let value = String::from_utf8_lossy(&value).into_owned();
    if contains_disallowed_cookie_character(&value) {
        return None;
    }
    Some(value)
}

fn contains_disallowed_cookie_character(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= '\u{1f}' || character == '\u{7f}')
}

fn remove_and_verify_domain_hash(value: &mut Vec<u8>, host_key: &str) -> CoreResult<()> {
    let expected = Sha256::digest(host_key.as_bytes());
    if value.len() < SHA256_LENGTH || value[..SHA256_LENGTH] != expected[..] {
        return Err(CoreError::Platform(
            "Chrome cookie domain integrity check failed".to_owned(),
        ));
    }
    value.drain(..SHA256_LENGTH);
    Ok(())
}

fn find_cookie_database(browser_user_data_dir: &Path) -> Option<PathBuf> {
    [
        browser_user_data_dir.join("Default/Network/Cookies"),
        browser_user_data_dir.join("Default/Cookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn reads_plain_unexpired_cookies_and_skips_expired_rows() {
        let directory = tempdir().unwrap();
        let profile = directory.path().join("profile");
        std::fs::create_dir_all(profile.join("Default/Network")).unwrap();
        let database = Connection::open(profile.join("Default/Network/Cookies")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER);\
                 INSERT INTO meta VALUES ('version', 23);\
                 CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, path TEXT,\
                   expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,\
                   samesite INTEGER, encrypted_value BLOB);",
            )
            .unwrap();
        let future =
            ((chrono::Utc::now().timestamp() as f64 + CHROME_EPOCH_OFFSET_SECONDS + 3_600.0)
                * 1_000_000.0) as i64;
        database
            .execute(
                "INSERT INTO cookies VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    ".example.test",
                    "session",
                    "value",
                    "/",
                    future,
                    1,
                    1,
                    1,
                    Vec::<u8>::new()
                ],
            )
            .unwrap();
        drop(database);

        let cookies = read_imported_cookies(&profile, Platform::Macos).unwrap();

        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].url, "https://example.test/");
        assert_eq!(cookies[0].domain.as_deref(), Some(".example.test"));
        assert_eq!(cookies[0].same_site, "lax");
    }

    #[test]
    fn verifies_the_schema_24_domain_hash_for_plain_test_rows() {
        let host = ".example.test";
        let mut value = Sha256::digest(host.as_bytes()).to_vec();
        value.extend(b"verified");
        remove_and_verify_domain_hash(&mut value, host).unwrap();
        assert_eq!(value, b"verified");
        assert!(remove_and_verify_domain_hash(&mut b"invalid".to_vec(), host).is_err());
    }

    #[test]
    fn reads_text_encoded_encrypted_cookie_bytes() {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE cookies(encrypted_value TEXT);\
                 INSERT INTO cookies VALUES ('v10ciphertext');",
            )
            .unwrap();

        let bytes = database
            .query_row("SELECT encrypted_value FROM cookies", [], |row| {
                read_blob_or_text(row, 0)
            })
            .unwrap();

        assert_eq!(bytes, b"v10ciphertext");
    }

    #[test]
    fn decodes_legacy_non_utf8_cookie_bytes_lossily() {
        let value = decode_cookie_value(b"value\xff".to_vec()).unwrap();

        assert_eq!(value, "value\u{fffd}");
        assert!(decode_cookie_value(b"value\0".to_vec()).is_none());
    }

    #[test]
    fn rejects_control_characters_in_cookie_metadata() {
        assert!(contains_disallowed_cookie_character("bad\npath"));
        assert!(contains_disallowed_cookie_character("bad\u{7f}name"));
        assert!(!contains_disallowed_cookie_character(".example.test/path"));
    }
}
