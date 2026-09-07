use super::{Result, paths};
#[cfg(feature = "session-migration-diagnostics")]
use super::{webkit, windows};
#[cfg(feature = "session-migration-diagnostics")]
use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(feature = "session-migration-diagnostics")]
use fs2::FileExt;
#[cfg(feature = "session-migration-diagnostics")]
use serde_json::{Value, json};
#[cfg(feature = "session-migration-diagnostics")]
use sha2::{Digest, Sha256};
#[cfg(feature = "session-migration-diagnostics")]
use std::{fs, io::Read};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

#[cfg(feature = "session-migration-diagnostics")]
pub(crate) fn source_lock(user_data: &Path) -> Result<File> {
    let path = paths::existing(&user_data.join("rion-studio.instance.lock"))?;
    // Existing lock only; do not create/truncate a production file or rewrite its PID.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "SOURCE_LOCK_UNAVAILABLE")?;
    file.try_lock_exclusive().map_err(|_| "SOURCE_IN_USE")?;
    Ok(file)
}

pub(crate) fn open_file(path: &Path) -> Result<File> {
    paths::existing(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(path).map_err(|_| "SOURCE_FILE_IN_USE")?;
    rion_platform::verify_open_file_identity(path, &file).map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
    Ok(file)
}

pub(crate) fn released(root: &Path, platform: rion_platform::Platform) -> Result<()> {
    if platform == rion_platform::Platform::Macos {
        #[cfg(target_os = "macos")]
        {
            // One native handle inventory under the held Core instance lock.
            // Remaining WebKit processes can outlive the shell and must not own the source.
            let output = rion_platform::background_command("/usr/sbin/lsof")
                .args(["-n", "-P", "-F", "n"])
                .output()
                .map_err(|_| "SOURCE_RELEASE_UNPROVEN")?;
            if !output.status.success() || !output.stderr.is_empty() {
                return Err("SOURCE_RELEASE_UNPROVEN");
            }
            let text = String::from_utf8(output.stdout).map_err(|_| "SOURCE_RELEASE_UNPROVEN")?;
            for line in text.lines().filter_map(|line| line.strip_prefix('n')) {
                if Path::new(line).starts_with(root) {
                    return Err("SOURCE_NATIVE_HANDLES_OPEN");
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = root;
            return Err("NATIVE_PLATFORM_MISMATCH");
        }
    }
    Ok(())
}

#[cfg(feature = "session-migration-diagnostics")]
pub(crate) fn capture(
    root: &Path,
    output: &Path,
    role: &str,
    platform: rion_platform::Platform,
) -> Result<Value> {
    released(root, platform)?;
    let files = paths::files(root)?;
    if files.is_empty() {
        return Err("SOURCE_EMPTY_UNPROVEN");
    }
    let mut held = Vec::new();
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for path in &files {
        let mut file = open_file(path)?;
        let info = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        total = total.checked_add(info.len()).ok_or("SNAPSHOT_SIZE_LIMIT")?;
        if total > 40 * 1024 * 1024 {
            return Err("SNAPSHOT_SIZE_LIMIT");
        }
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(info.len() + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "SOURCE_READ_FAILED")?;
        if bytes.len() as u64 != info.len() {
            return Err("SOURCE_CHANGED_DURING_CAPTURE");
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "SOURCE_PATH_ESCAPE")?
            .to_str()
            .ok_or("SOURCE_PATH_ENCODING")?;
        entries.push((relative.to_owned(), bytes));
        held.push((path, file, info));
    }
    // Point-in-time snapshot integrity checks, not a retry/convergence loop.
    if files != paths::files(root)? {
        return Err("SOURCE_CHANGED_DURING_CAPTURE");
    }
    for (path, file, info) in &held {
        rion_platform::verify_open_file_identity(path, file)
            .map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
        let after = file.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
        if info.len() != after.len() || info.modified().ok() != after.modified().ok() {
            return Err("SOURCE_CHANGED_DURING_CAPTURE");
        }
    }
    let transfer = uuid::Uuid::new_v4().to_string();
    let context = format!("rion-session-source-snapshot-v1:{role}:{transfer}");
    let archive = json!({"roleId": role, "transferId": transfer, "files": entries.iter().map(|(path, data)| json!({"path": path,"base64": STANDARD.encode(data)})).collect::<Vec<_>>()});
    let plaintext = serde_json::to_vec(&archive).map_err(|_| "SNAPSHOT_ENCODING_FAILED")?;
    let protected =
        rion_platform::protect_session_transfer_v2(platform, context.as_bytes(), &plaintext)
            .map_err(|_| "SNAPSHOT_PROTECTION_FAILED")?;
    let snapshot_path = output.join(format!("{role}-{transfer}.enc"));
    fs::write(&snapshot_path, &protected).map_err(|_| "SNAPSHOT_WRITE_FAILED")?;
    File::open(&snapshot_path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "SNAPSHOT_FLUSH_FAILED")?;
    let decrypted = rion_platform::unprotect_session_transfer_v2(
        platform,
        context.as_bytes(),
        &fs::read(&snapshot_path).map_err(|_| "SNAPSHOT_READ_FAILED")?,
    )
    .map_err(|_| "SNAPSHOT_AUTHENTICATION_FAILED")?;
    if decrypted != plaintext {
        return Err("SNAPSHOT_READBACK_FAILED");
    }
    let temporary = tempfile::Builder::new()
        .prefix("plaintext-source-")
        .tempdir_in(output)
        .map_err(|_| "TEMP_CREATE_FAILED")?;
    rion_platform::restrict_directory_to_current_user(temporary.path())
        .map_err(|_| "TEMP_PROTECTION_FAILED")?;
    for (relative, bytes) in &entries {
        let path = temporary.path().join(relative);
        fs::create_dir_all(path.parent().ok_or("SNAPSHOT_PATH_INVALID")?)
            .map_err(|_| "TEMP_WRITE_FAILED")?;
        fs::write(path, bytes).map_err(|_| "TEMP_WRITE_FAILED")?;
    }
    let assessment = match platform {
        rion_platform::Platform::Macos => assess_webkit(temporary.path()),
        rion_platform::Platform::Windows => windows::assess(temporary.path()),
    };
    temporary.close().map_err(|_| "TEMP_CLEANUP_FAILED")?;
    Ok(
        json!({"encryptedSnapshot": snapshot_path.file_name().and_then(|s| s.to_str()), "context": context,
        "snapshotSha256": hex::encode(Sha256::digest(protected)), "sourceFiles": files.len(),
        "sourceBytes": total, "plaintextTemporaryRemoved": true, "data": assessment.unwrap_or_else(|code| json!({"status":"unsupported", "code":code}))}),
    )
}

#[cfg(feature = "session-migration-diagnostics")]
fn assess_webkit(root: &Path) -> Result<Value> {
    let files = paths::files(root)?;
    let mut origins = 0;
    let mut entries = 0;
    let mut errors = std::collections::BTreeSet::new();
    let mut cookies = 0;
    let mut expired_cookie_structures = 0;
    let mut cookie_flags = std::collections::BTreeSet::new();
    for path in &files {
        if path
            .file_name()
            .is_some_and(|n| n == "localstorage.sqlite3")
        {
            let origin = path
                .parent()
                .and_then(Path::parent)
                .ok_or("WEBKIT_LAYOUT_UNKNOWN")?
                .join("origin");
            let result = (|| {
                webkit::decode_origin(&fs::read(origin).map_err(|_| "WEBKIT_ORIGIN_MISSING")?)?;
                super::webkit_sqlite::read(path).map(|entries| entries.len())
            })();
            match result {
                Ok(count) => {
                    origins += 1;
                    entries += count;
                }
                Err(code) => {
                    errors.insert(code);
                }
            }
        }
        if path
            .file_name()
            .is_some_and(|n| n == "Cookies.binarycookies")
        {
            let bytes = fs::read(path).map_err(|_| "COOKIE_READ_FAILED")?;
            match super::cookies::inspect(&bytes, chrono::Utc::now().timestamp_millis()) {
                Ok(value) => {
                    cookies += value.count;
                    expired_cookie_structures += value.expired;
                    cookie_flags.extend(value.flags);
                    errors.extend(value.errors);
                }
                Err(code) => {
                    errors.insert(code);
                }
            }
            // The binary file alone does not prove SameSite, partition or session-cookie completeness.
            errors.insert("WEBKIT_COOKIE_ATTRIBUTES_UNPROVEN");
        }
    }
    if cookies == 0 {
        errors.insert("COOKIE_INVENTORY_EMPTY_UNPROVEN");
    }
    Ok(
        json!({"status": "unsupported", "localStorageOriginsReadable": origins, "localStorageEntriesReadable": entries,
        "cookieRecordsStructurallyReadable": cookies, "cookieStructuresWithElapsedExpiry": expired_cookie_structures,
        "cookieRawFlagsObserved": cookie_flags, "errors": errors, "canonicalExportEligible": false}),
    )
}
