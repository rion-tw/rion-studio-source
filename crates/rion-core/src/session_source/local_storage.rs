//! A protected, stopped-source snapshot for partial macOS LocalStorage upgrade.
//! Cookies are deliberately assessed separately; unknown cookie semantics never
//! prevent a verified LocalStorage subset from reaching a new Chromium session.
use super::{Result, paths, snapshot};
use crate::session_transfer::RoleSessionTransferCookieRecord as Cookie;
use crate::session_transfer::RoleSessionTransferLocalStorageOriginRecord as Origin;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

pub(crate) struct LocalStorageCapture {
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
) -> Result<LocalStorageCapture> {
    snapshot::released(root, platform)?;
    let files = relevant_files(root)?;
    let mut held = Vec::new();
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for path in &files {
        let mut file = snapshot::open_file(path)?;
        let metadata = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        total = total
            .checked_add(metadata.len())
            .ok_or("SNAPSHOT_SIZE_LIMIT")?;
        if total > 40 * 1024 * 1024 {
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
    if files != relevant_files(root)? {
        return Err("SOURCE_CHANGED_DURING_CAPTURE");
    }
    for (path, file, before) in &held {
        rion_platform::verify_open_file_identity(path, file)
            .map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
        let after = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("SOURCE_CHANGED_DURING_CAPTURE");
        }
    }
    let context = format!(
        "rion-partial-session-snapshot-v1:{role}:{}",
        uuid::Uuid::new_v4()
    );
    let mut source_digest = Sha256::new();
    for (path, bytes) in &entries {
        let path = path.to_string_lossy();
        source_digest.update((path.len() as u64).to_le_bytes());
        source_digest.update(path.as_bytes());
        source_digest.update((bytes.len() as u64).to_le_bytes());
        source_digest.update(bytes);
    }
    let source_sha256 = hex::encode(source_digest.finalize());
    let plaintext = serde_json::to_vec(&serde_json::json!({"context":context,"files":entries.iter().map(|(path,bytes)|serde_json::json!({"path":path,"base64":STANDARD.encode(bytes)})).collect::<Vec<_>>()})).map_err(|_| "SNAPSHOT_ENCODING_FAILED")?;
    let protected =
        rion_platform::protect_session_transfer_v2(platform, context.as_bytes(), &plaintext)
            .map_err(|_| "SNAPSHOT_PROTECTION_FAILED")?;
    let archive = output.join("source.enc");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&archive)
        .map_err(|_| "SNAPSHOT_WRITE_FAILED")?;
    file.write_all(&protected)
        .and_then(|()| file.sync_all())
        .map_err(|_| "SNAPSHOT_WRITE_FAILED")?;
    let read = fs::read(&archive).map_err(|_| "SNAPSHOT_READ_FAILED")?;
    if rion_platform::unprotect_session_transfer_v2(platform, context.as_bytes(), &read)
        .map_err(|_| "SNAPSHOT_AUTHENTICATION_FAILED")?
        != plaintext
    {
        return Err("SNAPSHOT_READBACK_FAILED");
    }
    fs::write(
        output.join("source-context.json"),
        serde_json::to_vec(&serde_json::json!({"context":context}))
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
    let result = read_snapshot(temp.path());
    let cookie_result = read_cookies(temp.path());
    for (path, file, before) in &held {
        rion_platform::verify_open_file_identity(path, file)
            .map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
        let after = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("SOURCE_CHANGED_DURING_CAPTURE");
        }
    }
    temp.close().map_err(|_| "TEMP_CLEANUP_FAILED")?;
    let (origins, local_storage_errors) = result?;
    let mut cookie_errors = Vec::new();
    let cookies = match cookie_result {
        Ok(capture) => {
            cookie_errors.extend(capture.reasons.into_iter().map(str::to_owned));
            if capture.skipped > 0 {
                cookie_errors.push("COOKIE_RECORDS_SKIPPED".to_owned());
            }
            capture.cookies
        }
        Err(code) => {
            cookie_errors.push(code.to_owned());
            Vec::new()
        }
    };
    cookie_errors.sort();
    cookie_errors.dedup();
    Ok(LocalStorageCapture {
        origins,
        cookies,
        local_storage_reasons: local_storage_errors,
        cookie_reasons: cookie_errors,
        source_sha256,
    })
}

fn relevant_files(root: &Path) -> Result<Vec<std::path::PathBuf>> {
    let all = paths::files(root)?;
    let mut selected = std::collections::BTreeSet::new();
    for file in &all {
        if file
            .file_name()
            .is_some_and(|name| name == "Cookies.binarycookies")
        {
            selected.insert(file.clone());
        }
        if file
            .file_name()
            .is_some_and(|name| name == "localstorage.sqlite3")
        {
            selected.insert(file.clone());
            let parent = file.parent().ok_or("WEBKIT_LAYOUT_UNKNOWN")?;
            for suffix in ["-wal", "-shm", "-journal"] {
                let companion = parent.join(format!("localstorage.sqlite3{suffix}"));
                if all.contains(&companion) {
                    selected.insert(companion);
                }
            }
            let origin = parent
                .parent()
                .ok_or("WEBKIT_LAYOUT_UNKNOWN")?
                .join("origin");
            if all.contains(&origin) {
                selected.insert(origin);
            }
        }
    }
    if selected.is_empty() {
        return Err("SOURCE_EMPTY_UNPROVEN");
    }
    Ok(selected.into_iter().collect())
}

fn read_cookies(root: &Path) -> Result<super::cookies::CookieCapture> {
    let matches = paths::files(root)?
        .into_iter()
        .filter(|file| {
            file.file_name()
                .is_some_and(|name| name == "Cookies.binarycookies")
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Err("COOKIE_INVENTORY_MISSING_UNPROVEN"),
        [file] => super::cookies::capture(
            &fs::read(file).map_err(|_| "COOKIE_READ_FAILED")?,
            chrono::Utc::now().timestamp_millis(),
        ),
        _ => Err("COOKIE_SOURCE_AMBIGUOUS"),
    }
}

pub(crate) fn read_snapshot(root: &Path) -> Result<(Vec<Origin>, Vec<String>)> {
    let mut origins = std::collections::BTreeMap::new();
    let mut errors = std::collections::BTreeSet::new();
    for file in paths::files(root)? {
        if file
            .file_name()
            .is_none_or(|name| name != "localstorage.sqlite3")
        {
            continue;
        }
        let result = (|| {
            let origin_file = file
                .parent()
                .and_then(Path::parent)
                .ok_or("WEBKIT_LAYOUT_UNKNOWN")?
                .join("origin");
            let origin = super::webkit::decode_origin(
                &fs::read(origin_file).map_err(|_| "WEBKIT_ORIGIN_MISSING")?,
            )?;
            Ok::<_, &'static str>(Origin {
                origin,
                entries: super::webkit_sqlite::read(&file)?,
            })
        })();
        match result {
            Ok(origin) => {
                if origins.insert(origin.origin.clone(), origin).is_some() {
                    return Err("WEBKIT_DUPLICATE_ORIGIN");
                }
            }
            Err(code) => {
                errors.insert(code.to_owned());
            }
        }
    }
    if origins.is_empty() {
        errors.insert("LOCAL_STORAGE_SOURCE_MISSING_UNPROVEN".to_owned());
    }
    Ok((
        origins.into_values().collect(),
        errors.into_iter().collect(),
    ))
}
