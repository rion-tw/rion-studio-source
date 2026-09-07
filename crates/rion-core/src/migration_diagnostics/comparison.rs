//! Compare supported records only on protected, stopped-source copies.
use super::{Result, native_platform, paths, snapshot};
use crate::{session_recovery::source, session_transfer::*};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub(super) fn compare(
    data: &Path,
    role: &str,
    output: &Path,
    old: &[RoleSessionTransferLocalStorageOriginRecord],
) -> Result<Value> {
    let data = paths::existing(data)?;
    let _lock = snapshot::source_lock(&data)?;
    let role_paths =
        crate::role_browser_data::paths(&data, role).map_err(|_| "ROLE_PATH_INVALID")?;
    let current =
        paths::existing(&Path::new(&role_paths.chromium_user_data_dir).join("Local Storage"))?;
    let before = source::digest(&current).map_err(|_| "SOURCE_DIGEST_FAILED")?;
    let output = paths::create_output(
        &output.join("current-local-storage"),
        std::slice::from_ref(&current),
    )?;
    let platform = native_platform()?;
    let archive = snapshot::capture(&current, &output, role, platform)?;
    let context = archive["context"]
        .as_str()
        .ok_or("SNAPSHOT_CONTEXT_MISSING")?;
    let bytes = fs::read(
        output.join(
            archive["encryptedSnapshot"]
                .as_str()
                .ok_or("SNAPSHOT_NAME_MISSING")?,
        ),
    )
    .map_err(|_| "SNAPSHOT_READ_FAILED")?;
    let raw = rion_platform::unprotect_session_transfer_v2(platform, context.as_bytes(), &bytes)
        .map_err(|_| "SNAPSHOT_AUTHENTICATION_FAILED")?;
    let decoded: Value = serde_json::from_slice(&raw).map_err(|_| "SNAPSHOT_ENCODING_FAILED")?;
    let temp = tempfile::Builder::new()
        .prefix("plaintext-comparison-")
        .tempdir_in(&output)
        .map_err(|_| "TEMP_CREATE_FAILED")?;
    for file in decoded["files"]
        .as_array()
        .ok_or("SNAPSHOT_ENCODING_FAILED")?
    {
        let relative = file["path"].as_str().ok_or("SNAPSHOT_ENCODING_FAILED")?;
        if Path::new(relative)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("SNAPSHOT_PATH_INVALID");
        }
        let target = temp.path().join("Local Storage").join(relative);
        fs::create_dir_all(target.parent().ok_or("SNAPSHOT_PATH_INVALID")?)
            .map_err(|_| "TEMP_WRITE_FAILED")?;
        fs::write(
            target,
            STANDARD
                .decode(file["base64"].as_str().ok_or("SNAPSHOT_ENCODING_FAILED")?)
                .map_err(|_| "SNAPSHOT_ENCODING_FAILED")?,
        )
        .map_err(|_| "TEMP_WRITE_FAILED")?;
    }
    let records = read_webview2_local_storage_source_internal(temp.path());
    let clone_root = output.join("chromium-copy");
    fs::create_dir(&clone_root).map_err(|_| "TEMP_CREATE_FAILED")?;
    fs::rename(
        temp.path().join("Local Storage"),
        clone_root.join("Local Storage"),
    )
    .map_err(|_| "TEMP_WRITE_FAILED")?;
    temp.close().map_err(|_| "TEMP_CLEANUP_FAILED")?;
    if source::digest(&current).map_err(|_| "SOURCE_DIGEST_FAILED")? != before {
        return Err("SOURCE_CHANGED_DURING_DIAGNOSTIC");
    }
    let mut equal = 0;
    let mut missing = 0;
    let mut conflicts = 0;
    if let Ok(records) = &records {
        for origin in old {
            for entry in &origin.entries {
                let found = records
                    .iter()
                    .find(|r| r.origin == origin.origin)
                    .and_then(|r| r.entries.iter().find(|e| e.key == entry.key));
                match found {
                    None => missing += 1,
                    Some(e) if e.value == entry.value => equal += 1,
                    Some(_) => conflicts += 1,
                }
            }
        }
    }
    Ok(json!({"currentSourceSha256":before,"sourceUnchanged":true,
        "offlineDecoder":if records.is_ok() { "decoded" } else { "unsupported" },
        
        "currentEntries":records.as_ref().ok().map(|r|r.iter().map(|o|o.entries.len()).sum::<usize>()),"oldEntriesIdentical":records.as_ref().ok().map(|_|equal),
        "oldEntriesMissing":records.as_ref().ok().map(|_|missing),"oldEntriesConflicting":records.as_ref().ok().map(|_|conflicts),"currentProtectedSnapshot":archive,
        "clonePath":clone_root,"productionMutationPerformed":false}))
}
