//! Bounded stopped-profile WebView2 reader.
//!
//! Production first-upgrade snapshots the exact role store before parsing it.
//! LocalStorage stays lossless; cookie rows are independently best-effort and
//! every unsupported record contributes only a non-sensitive reason code.
use super::{Result, paths, snapshot};
use crate::session_transfer::{
    RoleSessionTransferBytesRecord as Bytes, RoleSessionTransferCookieExpiry as Expiry,
    RoleSessionTransferCookiePartitionEvidence as Partition,
    RoleSessionTransferCookieRecord as Cookie, RoleSessionTransferCookieSameSite as SameSite,
    RoleSessionTransferLocalStorageOriginRecord as Origin,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, types::ValueRef};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const CHROME_EPOCH_OFFSET_MILLISECONDS: i64 = 11_644_473_600_000;
const MAX_COOKIE_EXPIRY_UNIX_MS: i64 = 253_402_300_799_999;
const MAX_SNAPSHOT_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) struct WindowsCapture {
    pub origins: Vec<Origin>,
    pub cookies: Vec<Cookie>,
    pub local_storage_reasons: Vec<String>,
    pub cookie_reasons: Vec<String>,
    pub source_sha256: String,
}

pub(crate) fn capture(
    root: &Path,
    output: &Path,
    role: &str,
    platform: rion_platform::Platform,
) -> Result<WindowsCapture> {
    if platform != rion_platform::Platform::Windows {
        return Err("NATIVE_PLATFORM_MISMATCH");
    }
    let profile = profile_path(root)?;
    let relative_profile = profile
        .strip_prefix(root)
        .map_err(|_| "SOURCE_PATH_ESCAPE")?
        .to_path_buf();
    let files = relevant_files(root, &profile)?;
    if files.is_empty() {
        return Err("SOURCE_EMPTY_UNPROVEN");
    }
    let mut held = Vec::with_capacity(files.len());
    let mut entries = Vec::with_capacity(files.len());
    let mut total = 0_u64;
    for path in &files {
        let mut file = snapshot::open_file(path)?;
        let metadata = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        total = total
            .checked_add(metadata.len())
            .ok_or("SNAPSHOT_SIZE_LIMIT")?;
        if total > MAX_SNAPSHOT_BYTES {
            return Err("SNAPSHOT_SIZE_LIMIT");
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(metadata.len() + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "SOURCE_READ_FAILED")?;
        if bytes.len() as u64 != metadata.len() {
            return Err("SOURCE_CHANGED_DURING_CAPTURE");
        }
        entries.push((
            path.strip_prefix(root)
                .map_err(|_| "SOURCE_PATH_ESCAPE")?
                .to_path_buf(),
            bytes,
        ));
        held.push((path, file, metadata));
    }
    if files != relevant_files(root, &profile)? {
        return Err("SOURCE_CHANGED_DURING_CAPTURE");
    }
    verify_held(&held)?;

    let mut digest = Sha256::new();
    for (path, bytes) in &entries {
        let path = path.to_string_lossy();
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    let source_sha256 = hex::encode(digest.finalize());
    let context = format!(
        "rion-webview2-session-snapshot-v1:{role}:{}",
        uuid::Uuid::new_v4()
    );
    let plaintext = serde_json::to_vec(&serde_json::json!({
        "context": context,
        "files": entries.iter().map(|(path, bytes)| serde_json::json!({
            "path": path,
            "base64": STANDARD.encode(bytes)
        })).collect::<Vec<_>>()
    }))
    .map_err(|_| "SNAPSHOT_ENCODING_FAILED")?;
    let protected =
        rion_platform::protect_session_transfer_v2(platform, context.as_bytes(), &plaintext)
            .map_err(|_| "SNAPSHOT_PROTECTION_FAILED")?;
    let archive = output.join("source.enc");
    let mut archive_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&archive)
        .map_err(|_| "SNAPSHOT_WRITE_FAILED")?;
    archive_file
        .write_all(&protected)
        .and_then(|()| archive_file.sync_all())
        .map_err(|_| "SNAPSHOT_WRITE_FAILED")?;
    let persisted = fs::read(&archive).map_err(|_| "SNAPSHOT_READ_FAILED")?;
    if rion_platform::unprotect_session_transfer_v2(platform, context.as_bytes(), &persisted)
        .map_err(|_| "SNAPSHOT_AUTHENTICATION_FAILED")?
        != plaintext
    {
        return Err("SNAPSHOT_READBACK_FAILED");
    }
    fs::write(
        output.join("source-context.json"),
        serde_json::to_vec(&serde_json::json!({"context": context}))
            .map_err(|_| "SNAPSHOT_ENCODING_FAILED")?,
    )
    .map_err(|_| "SNAPSHOT_WRITE_FAILED")?;

    let temp = tempfile::Builder::new()
        .prefix("source-plaintext-")
        .tempdir_in(output)
        .map_err(|_| "TEMP_CREATE_FAILED")?;
    rion_platform::restrict_directory_to_current_user(temp.path())
        .map_err(|_| "TEMP_PROTECTION_FAILED")?;
    for (path, bytes) in entries {
        let target = temp.path().join(path);
        fs::create_dir_all(target.parent().ok_or("SNAPSHOT_PATH_INVALID")?)
            .map_err(|_| "TEMP_WRITE_FAILED")?;
        fs::write(target, bytes).map_err(|_| "TEMP_WRITE_FAILED")?;
    }
    let cloned_profile = temp.path().join(relative_profile);
    let origins =
        crate::session_transfer::read_webview2_local_storage_source_internal(&cloned_profile)
            .map_err(|_| "WEBVIEW2_LOCAL_STORAGE_READ_FAILED")?;
    let local_storage_reasons = if origins.is_empty() {
        vec!["LOCAL_STORAGE_SOURCE_MISSING_UNPROVEN".to_owned()]
    } else {
        Vec::new()
    };
    let cookie_capture = read_cookies(temp.path(), &cloned_profile)?;
    verify_held(&held)?;
    if files != relevant_files(root, &profile)? {
        return Err("SOURCE_CHANGED_DURING_CAPTURE");
    }
    temp.close().map_err(|_| "TEMP_CLEANUP_FAILED")?;
    Ok(WindowsCapture {
        origins,
        cookies: cookie_capture.cookies,
        local_storage_reasons,
        cookie_reasons: cookie_capture.reasons.into_iter().collect(),
        source_sha256,
    })
}

fn profile_path(root: &Path) -> Result<PathBuf> {
    let candidates = [
        root.to_path_buf(),
        root.join("EBWebView/Default"),
        root.join("Default"),
    ];
    let matches = candidates
        .into_iter()
        .filter(|candidate| {
            candidate.join("Local Storage/leveldb").is_dir()
                || candidate.join("Network/Cookies").is_file()
                || candidate.join("Cookies").is_file()
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [profile] => paths::existing(profile),
        [] => Err("WEBVIEW2_PROFILE_MISSING_UNPROVEN"),
        _ => Err("WEBVIEW2_PROFILE_AMBIGUOUS"),
    }
}

fn relevant_files(root: &Path, profile: &Path) -> Result<Vec<PathBuf>> {
    let mut selected = BTreeSet::new();
    let leveldb = profile.join("Local Storage/leveldb");
    if leveldb.is_dir() {
        selected.extend(paths::files(&leveldb)?);
    }
    let cookie_paths = [profile.join("Network/Cookies"), profile.join("Cookies")];
    let existing = cookie_paths
        .into_iter()
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    if existing.len() > 1 {
        return Err("WEBVIEW2_COOKIE_SOURCE_AMBIGUOUS");
    }
    if let Some(cookie) = existing.first() {
        selected.insert(paths::existing(cookie)?);
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut companion = cookie.as_os_str().to_owned();
            companion.push(suffix);
            let companion = PathBuf::from(companion);
            if companion.is_file() {
                selected.insert(paths::existing(&companion)?);
            }
        }
    }
    let local_states = [
        root.join("Local State"),
        root.join("EBWebView/Local State"),
        profile.parent().map_or_else(
            || root.join("Local State"),
            |parent| parent.join("Local State"),
        ),
    ];
    for state in local_states {
        if state.is_file() {
            selected.insert(paths::existing(&state)?);
        }
    }
    Ok(selected.into_iter().collect())
}

fn verify_held(held: &[(&PathBuf, fs::File, fs::Metadata)]) -> Result<()> {
    for (path, file, before) in held {
        rion_platform::verify_open_file_identity(path, file)
            .map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
        let after = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("SOURCE_CHANGED_DURING_CAPTURE");
        }
    }
    Ok(())
}

struct CookieCapture {
    cookies: Vec<Cookie>,
    reasons: BTreeSet<String>,
}

fn read_cookies(snapshot_root: &Path, profile: &Path) -> Result<CookieCapture> {
    let paths = [profile.join("Network/Cookies"), profile.join("Cookies")]
        .into_iter()
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    let Some(path) = paths.first() else {
        return Ok(CookieCapture {
            cookies: Vec::new(),
            reasons: BTreeSet::from(["COOKIE_INVENTORY_MISSING_UNPROVEN".to_owned()]),
        });
    };
    if paths.len() != 1 {
        return Err("WEBVIEW2_COOKIE_SOURCE_AMBIGUOUS");
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "WEBVIEW2_COOKIE_DATABASE_UNREADABLE")?;
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
    let columns = cookie_columns(&connection)?;
    let partition = if columns.contains("top_frame_site_key") {
        "COALESCE(top_frame_site_key, '')"
    } else {
        "''"
    };
    let has_expires = if columns.contains("has_expires") {
        "has_expires"
    } else {
        "CASE WHEN expires_utc > 0 THEN 1 ELSE 0 END"
    };
    let creation = if columns.contains("creation_utc") {
        "creation_utc"
    } else {
        "rowid"
    };
    let query = format!(
        "SELECT host_key,name,value,path,expires_utc,is_secure,is_httponly,samesite,\
         encrypted_value,{partition},{has_expires},{creation} FROM cookies"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| "WEBVIEW2_COOKIE_SCHEMA_UNSUPPORTED")?;
    let rows = statement
        .query_map([], |row| {
            Ok(CookieRow {
                domain: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                path: row.get(3)?,
                expires_utc: row.get(4)?,
                secure: row.get::<_, i64>(5)? != 0,
                http_only: row.get::<_, i64>(6)? != 0,
                same_site: row.get(7)?,
                encrypted_value: read_blob_or_text(row, 8)?,
                partition_key: row.get(9)?,
                has_expires: row.get::<_, i64>(10)? != 0,
                creation: row.get(11)?,
            })
        })
        .map_err(|_| "WEBVIEW2_COOKIE_READ_FAILED")?;
    let local_state = [
        snapshot_root.join("Local State"),
        snapshot_root.join("EBWebView/Local State"),
        profile.parent().map_or_else(
            || snapshot_root.join("Local State"),
            |parent| parent.join("Local State"),
        ),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .map(fs::read)
    .transpose()
    .map_err(|_| "WEBVIEW2_LOCAL_STATE_UNREADABLE")?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut reasons = BTreeSet::from(["COOKIE_RAW_SOURCE_BEST_EFFORT".to_owned()]);
    if !columns.contains("top_frame_site_key") {
        reasons.insert("COOKIE_PARTITION_EVIDENCE_UNPROVEN".to_owned());
    }
    let mut cookies = BTreeMap::<(String, String, Vec<u8>), (Cookie, i64)>::new();
    let mut seen = 0usize;
    for row in rows {
        seen = seen.checked_add(1).ok_or("COOKIE_COUNT_LIMIT")?;
        if seen > 10_000 {
            return Err("COOKIE_COUNT_LIMIT");
        }
        let row = match row {
            Ok(row) => row,
            Err(_) => {
                reasons.insert("COOKIE_ROW_INVALID".to_owned());
                continue;
            }
        };
        let parsed = parse_cookie_row(row, schema_version, local_state.as_deref(), now);
        let cookie = match parsed {
            Ok(cookie) => cookie,
            Err(reason) => {
                reasons.insert(reason.to_owned());
                continue;
            }
        };
        let name = cookie
            .0
            .name
            .decoded_bytes()
            .map_err(|_| "COOKIE_VALUE_UNREPRESENTABLE")?;
        let key = (cookie.0.domain.clone(), cookie.0.path.clone(), name);
        match cookies.get(&key) {
            Some((_, previous)) if *previous >= cookie.1 => {
                reasons.insert("COOKIE_DUPLICATE_SKIPPED".to_owned());
            }
            previous => {
                if previous.is_some() {
                    reasons.insert("COOKIE_DUPLICATE_SKIPPED".to_owned());
                }
                cookies.insert(key, cookie);
            }
        }
    }
    if seen == 0 {
        reasons.insert("COOKIE_INVENTORY_EMPTY_UNPROVEN".to_owned());
    }
    Ok(CookieCapture {
        cookies: cookies.into_values().map(|(cookie, _)| cookie).collect(),
        reasons,
    })
}

struct CookieRow {
    domain: String,
    name: String,
    value: String,
    path: String,
    expires_utc: i64,
    secure: bool,
    http_only: bool,
    same_site: i64,
    encrypted_value: Vec<u8>,
    partition_key: String,
    has_expires: bool,
    creation: i64,
}

fn parse_cookie_row(
    row: CookieRow,
    schema_version: u32,
    local_state: Option<&[u8]>,
    now_unix_ms: i64,
) -> Result<(Cookie, i64)> {
    if !row.partition_key.is_empty() {
        return Err("COOKIE_PARTITIONED_UNSUPPORTED");
    }
    if !cookie_name_supported(row.name.as_bytes())
        || row.path.is_empty()
        || !row.path.starts_with('/')
        || contains_control(&row.path)
    {
        return Err("COOKIE_VALUE_UNREPRESENTABLE");
    }
    let host_only = !row.domain.starts_with('.');
    let domain = row.domain.trim_start_matches('.').to_ascii_lowercase();
    let host = url::Host::parse(&domain).map_err(|_| "COOKIE_DOMAIN_UNREPRESENTABLE")?;
    if host.to_string() != domain || (!host_only && !matches!(host, url::Host::Domain(_))) {
        return Err("COOKIE_DOMAIN_UNREPRESENTABLE");
    }
    let encrypted = !row.encrypted_value.is_empty();
    let mut value = if encrypted {
        if row.encrypted_value.starts_with(b"v20") {
            return Err("COOKIE_APP_BOUND_UNSUPPORTED");
        }
        rion_platform::CookieDecryptor::chrome_from_local_state(
            rion_platform::Platform::Windows,
            local_state,
            &row.encrypted_value,
        )
        .and_then(|decryptor| decryptor.decrypt(&row.encrypted_value))
        .map_err(|_| "COOKIE_DECRYPT_FAILED")?
    } else {
        row.value.into_bytes()
    };
    if encrypted && schema_version >= 24 {
        let expected = Sha256::digest(row.domain.as_bytes());
        if value.len() < expected.len() || value[..expected.len()] != expected[..] {
            return Err("COOKIE_DOMAIN_INTEGRITY_FAILED");
        }
        value.drain(..expected.len());
    }
    if std::str::from_utf8(&value).is_err()
        || value.iter().any(|byte| matches!(*byte, 0 | b'\r' | b'\n'))
    {
        return Err("COOKIE_VALUE_UNREPRESENTABLE");
    }
    let same_site = match row.same_site {
        -1 => SameSite::Unspecified,
        0 => SameSite::None,
        1 => SameSite::Lax,
        2 => SameSite::Strict,
        _ => return Err("COOKIE_SAMESITE_UNKNOWN"),
    };
    let expiry = if row.has_expires {
        let unix_ms = row
            .expires_utc
            .checked_div(1_000)
            .and_then(|value| value.checked_sub(CHROME_EPOCH_OFFSET_MILLISECONDS))
            .ok_or("COOKIE_EXPIRY_UNREPRESENTABLE")?;
        if unix_ms <= now_unix_ms {
            return Err("COOKIE_EXPIRED_BEFORE_VERIFICATION");
        }
        if unix_ms > MAX_COOKIE_EXPIRY_UNIX_MS {
            return Err("COOKIE_EXPIRY_UNREPRESENTABLE");
        }
        Expiry::Absolute { unix_ms }
    } else {
        Expiry::Session
    };
    Ok((
        Cookie {
            name: Bytes::from_bytes(row.name.as_bytes()),
            value: Bytes::from_bytes(&value),
            domain,
            path: row.path,
            host_only,
            secure: row.secure,
            http_only: row.http_only,
            expiry,
            same_site,
            partition: Partition::Unpartitioned,
            unsupported_attribute_codes: Vec::new(),
        },
        row.creation,
    ))
}

fn cookie_columns(connection: &Connection) -> Result<HashSet<String>> {
    let mut statement = connection
        .prepare("PRAGMA table_info(cookies)")
        .map_err(|_| "WEBVIEW2_COOKIE_SCHEMA_UNSUPPORTED")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "WEBVIEW2_COOKIE_SCHEMA_UNSUPPORTED")?;
    rows.map(|row| row.map_err(|_| "WEBVIEW2_COOKIE_SCHEMA_UNSUPPORTED"))
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

fn cookie_name_supported(value: &[u8]) -> bool {
    !value.is_empty()
        && value.iter().all(|byte| {
            byte.is_ascii()
                && !byte.is_ascii_control()
                && !byte.is_ascii_whitespace()
                && !b"()<>@,;:\\\"/[]?={}".contains(byte)
        })
}

fn contains_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= '\u{1f}' || character == '\u{7f}')
}
#[cfg(feature = "session-migration-diagnostics")]
use serde_json::{Value, json};

#[cfg(feature = "session-migration-diagnostics")]
pub(crate) fn assess(root: &Path) -> Result<Value> {
    if !root.join("Local Storage/leveldb").is_dir() {
        return Err("WEBVIEW2_LOCAL_STORAGE_MISSING_UNPROVEN");
    }
    let local_storage = crate::session_transfer::read_webview2_local_storage_source_internal(root)
        .map_err(|_| "WEBVIEW2_LOCAL_STORAGE_READ_FAILED")?;
    let cookie_paths = [root.join("Network/Cookies"), root.join("Cookies")];
    let existing = cookie_paths
        .iter()
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    if existing.len() != 1 {
        return Err("WEBVIEW2_COOKIE_SOURCE_AMBIGUOUS_OR_MISSING");
    }
    let connection = rusqlite::Connection::open_with_flags(
        existing[0],
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "WEBVIEW2_COOKIE_DATABASE_UNREADABLE")?;
    let mut statement = connection
        .prepare("SELECT host_key, name, value, encrypted_value FROM cookies")
        .map_err(|_| "WEBVIEW2_COOKIE_SCHEMA_UNSUPPORTED")?;
    let records = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|_| "WEBVIEW2_COOKIE_READ_FAILED")?;
    let state = fs::read(root.join("Local State")).ok();
    let mut count = 0;
    let mut decryptable = 0;
    let mut errors = std::collections::BTreeSet::new();
    for record in records {
        let (_, _, value, encrypted) = record.map_err(|_| "WEBVIEW2_COOKIE_READ_FAILED")?;
        count += 1;
        if count > 10_000 {
            return Err("COOKIE_COUNT_LIMIT");
        }
        if encrypted.is_empty() {
            let _ = value;
            decryptable += 1;
        } else if encrypted.starts_with(b"v20") {
            errors.insert("APP_BOUND_COOKIE_UNSUPPORTED");
        } else {
            let result = rion_platform::CookieDecryptor::chrome_from_local_state(
                rion_platform::Platform::Windows,
                state.as_deref(),
                &encrypted,
            )
            .and_then(|reader| reader.decrypt(&encrypted));
            match result {
                Ok(_) => decryptable += 1,
                Err(_) => {
                    errors.insert("COOKIE_DECRYPTION_FAILED");
                }
            }
        }
    }
    // Raw file decoding cannot manufacture the v1 transfer contract's native
    // WebView2 partition-capability proof, even when every encrypted value opens.
    errors.insert("WEBVIEW2_SOURCE_PARTITION_EVIDENCE_UNAVAILABLE");
    Ok(
        json!({"status": "unsupported", "localStorageOriginsReadable": local_storage.len(),
        "localStorageEntriesReadable": local_storage.iter().map(|o| o.entries.len()).sum::<usize>(),
        "cookieRows": count, "cookieValuesDecryptable": decryptable, "errors": errors,
        "canonicalExportEligible": false}),
    )
}

/// Structural inspection of the legacy binarycookies page table. No invented
/// default attributes: callers must still report attribute evidence as unknown.
#[cfg(any(test, feature = "session-migration-diagnostics"))]
pub(crate) fn binary_cookie_count(bytes: &[u8]) -> Result<usize> {
    fn read(bytes: &[u8], offset: usize, be: bool) -> Result<usize> {
        let v: [u8; 4] = bytes
            .get(offset..offset.checked_add(4).ok_or("COOKIE_LENGTH_OVERFLOW")?)
            .ok_or("COOKIE_FILE_TRUNCATED")?
            .try_into()
            .map_err(|_| "COOKIE_FILE_TRUNCATED")?;
        Ok(if be {
            u32::from_be_bytes(v)
        } else {
            u32::from_le_bytes(v)
        } as usize)
    }
    if bytes.get(..4) != Some(b"cook") {
        return Err("COOKIE_FORMAT_UNKNOWN");
    }
    let pages = read(bytes, 4, true)?;
    if pages > 4096 {
        return Err("COOKIE_PAGE_LIMIT");
    }
    let mut offset = 8 + pages * 4;
    let mut count = 0;
    for index in 0..pages {
        let length = read(bytes, 8 + index * 4, true)?;
        let page = bytes
            .get(offset..offset.checked_add(length).ok_or("COOKIE_LENGTH_OVERFLOW")?)
            .ok_or("COOKIE_FILE_TRUNCATED")?;
        if page.get(..4) != Some(&[0, 0, 1, 0]) {
            return Err("COOKIE_PAGE_FORMAT_UNKNOWN");
        }
        let entries = read(page, 4, false)?;
        count += entries;
        if count > 10_000 {
            return Err("COOKIE_COUNT_LIMIT");
        }
        let header_end = 12 + entries * 4;
        let mut spans = Vec::new();
        for entry in 0..entries {
            let start = read(page, 8 + entry * 4, false)?;
            let size = read(page, start, false)?;
            if start < header_end || size < 56 {
                return Err("COOKIE_RECORD_INVALID");
            }
            let end = start.checked_add(size).ok_or("COOKIE_LENGTH_OVERFLOW")?;
            let record = page.get(start..end).ok_or("COOKIE_RECORD_INVALID")?;
            for field in [16, 20, 24, 28] {
                let at = read(record, field, false)?;
                if at < 56 || !record.get(at..).is_some_and(|v| v.contains(&0)) {
                    return Err("COOKIE_STRING_INVALID");
                }
            }
            spans.push((start, end));
        }
        spans.sort_unstable();
        if spans.windows(2).any(|pair| pair[0].1 > pair[1].0) {
            return Err("COOKIE_RECORD_OVERLAP");
        }
        offset += length;
    }
    // Footer/attribute extensions are intentionally not treated as migrated.
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie_database(root: &Path) -> PathBuf {
        let network = root.join("Network");
        fs::create_dir_all(&network).unwrap();
        let path = network.join("Cookies");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY,value INTEGER);\
                 INSERT INTO meta VALUES('version',23);\
                 CREATE TABLE cookies(\
                   host_key TEXT,name TEXT,value TEXT,path TEXT,expires_utc INTEGER,\
                   is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,\
                   encrypted_value BLOB,top_frame_site_key TEXT,has_expires INTEGER,\
                   creation_utc INTEGER);",
            )
            .unwrap();
        let expiry = (2_100_000_000_000_i64 + CHROME_EPOCH_OFFSET_MILLISECONDS) * 1_000;
        let rows = [
            (
                ".example.test",
                "sid",
                "older",
                "/",
                expiry,
                1,
                1,
                1,
                "",
                1,
                10,
            ),
            (
                ".example.test",
                "sid",
                "newer",
                "/",
                expiry,
                1,
                1,
                1,
                "",
                1,
                20,
            ),
            (
                "host.test",
                "session",
                "value",
                "/play",
                0,
                0,
                0,
                -1,
                "",
                0,
                30,
            ),
            ("expired.test", "old", "value", "/", 1, 0, 0, 0, "", 1, 40),
            (
                "unknown.test",
                "unknown",
                "value",
                "/",
                expiry,
                0,
                0,
                99,
                "",
                1,
                50,
            ),
            (
                "partitioned.test",
                "partitioned",
                "value",
                "/",
                expiry,
                0,
                0,
                0,
                "https://top.test",
                1,
                60,
            ),
        ];
        for row in rows {
            connection
                .execute(
                    "INSERT INTO cookies VALUES(?1,?2,?3,?4,?5,?6,?7,?8,X'',?9,?10,?11)",
                    rusqlite::params![
                        row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9,
                        row.10
                    ],
                )
                .unwrap();
        }
        drop(connection);
        path
    }

    #[test]
    fn raw_webview2_cookies_preserve_supported_fields_and_skip_rows_independently() {
        let root = tempfile::tempdir().unwrap();
        cookie_database(root.path());
        let capture = read_cookies(root.path(), root.path()).unwrap();
        assert_eq!(capture.cookies.len(), 2);
        let persistent = capture
            .cookies
            .iter()
            .find(|cookie| cookie.domain == "example.test")
            .unwrap();
        assert_eq!(persistent.value.decoded_bytes().unwrap(), b"newer");
        assert!(!persistent.host_only);
        assert!(persistent.secure);
        assert!(persistent.http_only);
        assert_eq!(persistent.same_site, SameSite::Lax);
        assert!(matches!(persistent.expiry, Expiry::Absolute { .. }));
        let session = capture
            .cookies
            .iter()
            .find(|cookie| cookie.domain == "host.test")
            .unwrap();
        assert!(session.host_only);
        assert_eq!(session.same_site, SameSite::Unspecified);
        assert_eq!(session.expiry, Expiry::Session);
        for reason in [
            "COOKIE_RAW_SOURCE_BEST_EFFORT",
            "COOKIE_DUPLICATE_SKIPPED",
            "COOKIE_EXPIRED_BEFORE_VERIFICATION",
            "COOKIE_SAMESITE_UNKNOWN",
            "COOKIE_PARTITIONED_UNSUPPORTED",
        ] {
            assert!(capture.reasons.contains(reason));
        }
    }

    #[test]
    fn webview2_profile_layout_is_deterministic_and_rejects_competing_profiles() {
        let root = tempfile::tempdir().unwrap();
        cookie_database(root.path());
        let nested = root.path().join("EBWebView/Default/Local Storage/leveldb");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            profile_path(root.path()).unwrap_err(),
            "WEBVIEW2_PROFILE_AMBIGUOUS"
        );
    }
}
