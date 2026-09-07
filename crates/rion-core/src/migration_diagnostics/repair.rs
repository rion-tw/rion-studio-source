//! Internal macOS-only publication of a verified missing-key overlay.
//! Atomically swaps only Local Storage; Cookies, metadata and role identity stay put.
use super::{Result, native_platform, paths, snapshot, state_snapshot};
use crate::session_recovery::source;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    role: String,
    data: PathBuf,
    root: PathBuf,
    target: PathBuf,
    before: String,
    state: String,
    legacy_source: PathBuf,
    legacy_sha256: String,
}
fn context(root: &Path) -> Vec<u8> {
    format!("rion-local-storage-repair-v1:{}", root.display()).into_bytes()
}

pub(super) fn prepare(
    root: &Path,
    data: &Path,
    role: &str,
    before: &str,
    legacy_source: &Path,
    legacy_sha256: &str,
) -> Result<()> {
    let data = paths::existing(data)?;
    let _lock = snapshot::source_lock(&data)?;
    let (state_copy, original_state) = state_snapshot::copy(&data, root)?;
    let c = rusqlite::Connection::open_with_flags(
        state_copy.path().join("rion-studio.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "STATE_DATABASE_READ_FAILED")?;
    if !c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM roles WHERE id=?1)",
            [role],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|_| "ROLE_QUERY_FAILED")?
    {
        return Err("ROLE_IDENTITY_MISMATCH");
    }
    drop(c);
    state_copy.close().map_err(|_| "TEMP_CLEANUP_FAILED")?;
    if state_snapshot::digest(&data)? != original_state {
        return Err("REPAIR_STATE_CHANGED");
    }
    let p = crate::role_browser_data::paths(&data, role).map_err(|_| "ROLE_PATH_INVALID")?;
    let target = paths::existing(&Path::new(&p.chromium_user_data_dir).join("Local Storage"))?;
    if source::digest(&target).map_err(|_| "SOURCE_DIGEST_FAILED")? != before {
        return Err("CURRENT_STORAGE_CHANGED");
    }
    let plan = Plan {
        role: role.to_owned(),
        data: data.clone(),
        root: root.to_owned(),
        target,
        before: before.to_owned(),
        state: state_snapshot::digest(&data)?,
        legacy_source: paths::existing(legacy_source)?,
        legacy_sha256: legacy_sha256.to_owned(),
    };
    let bytes = serde_json::to_vec(&plan).map_err(|_| "PLAN_ENCODING_FAILED")?;
    let protected =
        rion_platform::protect_session_transfer_v2(native_platform()?, &context(root), &bytes)
            .map_err(|_| "PLAN_PROTECTION_FAILED")?;
    fs::write(root.join("repair-plan.enc"), protected).map_err(|_| "PLAN_WRITE_FAILED")
}

pub(super) fn publish(root: &Path, expected_clone_sha256: &str) -> Result<Value> {
    let platform = native_platform()?;
    if platform != rion_platform::Platform::Macos {
        return Err("REPAIR_NATIVE_PLATFORM_UNSUPPORTED");
    }
    let root = paths::existing(root)?;
    let raw = fs::read(paths::existing(&root.join("repair-plan.enc"))?)
        .map_err(|_| "PLAN_READ_FAILED")?;
    let plain = rion_platform::unprotect_session_transfer_v2(platform, &context(&root), &raw)
        .map_err(|_| "PLAN_AUTHENTICATION_FAILED")?;
    let plan: Plan = serde_json::from_slice(&plain).map_err(|_| "PLAN_ENCODING_FAILED")?;
    paths::role_id(&plan.role)?;
    if plan.root != root {
        return Err("PLAN_ROOT_MISMATCH");
    }
    let _lock = snapshot::source_lock(&plan.data)?;
    let p =
        crate::role_browser_data::paths(&plan.data, &plan.role).map_err(|_| "ROLE_PATH_INVALID")?;
    let current = paths::existing(&Path::new(&p.chromium_user_data_dir).join("Local Storage"))?;
    if current != plan.target || state_snapshot::digest(&plan.data)? != plan.state {
        return Err("REPAIR_STATE_CHANGED");
    }
    let cloned = paths::existing(&root.join("current-local-storage/chromium-copy/Local Storage"))?;
    snapshot::released(&plan.legacy_source, platform)?;
    if source::digest(&plan.legacy_source).map_err(|_| "SOURCE_DIGEST_FAILED")?
        != plan.legacy_sha256
    {
        return Err("RETAINED_SOURCE_CHANGED");
    }
    snapshot::released(&current, platform)?;
    snapshot::released(&cloned, platform)?;
    if source::digest(&current).map_err(|_| "SOURCE_DIGEST_FAILED")? != plan.before {
        return Err("CURRENT_STORAGE_CHANGED");
    }
    if expected_clone_sha256.len() != 64
        || source::digest(&cloned).map_err(|_| "SOURCE_DIGEST_FAILED")? != expected_clone_sha256
    {
        return Err("VERIFIED_CLONE_CHANGED");
    }
    for file in paths::files(&cloned)? {
        fs::File::open(file)
            .and_then(|file| file.sync_all())
            .map_err(|_| "CLONE_FLUSH_FAILED")?;
    }
    // Exact OS atomic exchange; a process crash cannot expose a missing directory.
    exchange(&current, &cloned)?;
    for directory in [
        &current,
        &cloned,
        current.parent().ok_or("PATH_PARENT_MISSING")?,
        cloned.parent().ok_or("PATH_PARENT_MISSING")?,
    ] {
        fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "REPAIR_PUBLICATION_INDETERMINATE")?;
    }
    if source::digest(&current).map_err(|_| "SOURCE_DIGEST_FAILED")? != expected_clone_sha256
        || source::digest(&cloned).map_err(|_| "SOURCE_DIGEST_FAILED")? != plan.before
    {
        return Err("REPAIR_PUBLICATION_INDETERMINATE");
    }
    Ok(
        json!({"roleId":plan.role,"mode":"missingKeysOnly","localStoragePublished":true,
        "beforeSha256":plan.before,"afterSha256":expected_clone_sha256,
        "metadataAndMigrationDatabaseUnchanged":state_snapshot::digest(&plan.data)?==plan.state,
        "cookiesTouched":false,"productionMutationPerformed":true}),
    )
}

#[cfg(target_os = "macos")]
fn exchange(a: &Path, b: &Path) -> Result<()> {
    use std::ffi::{CString, c_char, c_int, c_uint};
    unsafe extern "C" {
        fn renameatx_np(
            fromfd: c_int,
            from: *const c_char,
            tofd: c_int,
            to: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    let a = CString::new(a.as_os_str().as_encoded_bytes()).map_err(|_| "PATH_ENCODING_INVALID")?;
    let b = CString::new(b.as_os_str().as_encoded_bytes()).map_err(|_| "PATH_ENCODING_INVALID")?;
    // Darwin sys/fcntl.h AT_FDCWD=-2; sys/stdio.h RENAME_SWAP=2.
    // Both canonical directories are on the held, stopped role's local volume.
    if unsafe { renameatx_np(-2, a.as_ptr(), -2, b.as_ptr(), 2) } != 0 {
        return Err("ATOMIC_STORAGE_EXCHANGE_FAILED");
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn exchange(_a: &Path, _b: &Path) -> Result<()> {
    Err("REPAIR_NATIVE_PLATFORM_UNSUPPORTED")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn atomic_exchange_preserves_both_trees_and_other_role() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let other = dir.path().join("other");
        for p in [&a, &b, &other] {
            fs::create_dir(p).unwrap();
        }
        fs::write(a.join("old"), b"new-login").unwrap();
        fs::write(b.join("merged"), b"old-settings-and-new-login").unwrap();
        fs::write(other.join("keep"), b"role-b").unwrap();
        exchange(&a, &b).unwrap();
        assert_eq!(
            fs::read(a.join("merged")).unwrap(),
            b"old-settings-and-new-login"
        );
        assert_eq!(fs::read(b.join("old")).unwrap(), b"new-login");
        assert_eq!(fs::read(other.join("keep")).unwrap(), b"role-b");
        assert!(exchange(&a, &dir.path().join("missing")).is_err());
        assert!(a.join("merged").exists());
    }

    #[test]
    fn authenticated_plan_rejects_changed_state_target_tampering_and_replay() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let data = root.join("data");
        let output = root.join("run");
        fs::create_dir(&data).unwrap();
        fs::create_dir(&output).unwrap();
        let role = "11111111-1111-4111-8111-111111111111";
        fs::write(data.join("rion-studio.instance.lock"), b"stopped").unwrap();
        let connection = rusqlite::Connection::open(data.join("rion-studio.sqlite3")).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE roles(id TEXT PRIMARY KEY);")
            .unwrap();
        connection
            .execute("INSERT INTO roles VALUES(?1)", [role])
            .unwrap();
        drop(connection);
        let target = data
            .join("roles")
            .join(role)
            .join("browser/chromium/Local Storage");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("retained"), b"new-login").unwrap();
        let cookies = target.parent().unwrap().join("Cookies");
        fs::write(&cookies, b"new-cookies").unwrap();
        let clone = output.join("current-local-storage/chromium-copy/Local Storage");
        fs::create_dir_all(&clone).unwrap();
        fs::write(clone.join("merged"), b"merged").unwrap();
        let before = source::digest(&target).unwrap();
        let after = source::digest(&clone).unwrap();
        let legacy = root.join("legacy");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("old"), b"old-source").unwrap();
        let initial_state = state_snapshot::digest(&data).unwrap();
        prepare(
            &output,
            &data,
            role,
            &before,
            &legacy,
            &source::digest(&legacy).unwrap(),
        )
        .unwrap();
        assert_eq!(state_snapshot::digest(&data).unwrap(), initial_state);
        fs::write(legacy.join("changed"), b"changed").unwrap();
        assert_eq!(
            publish(&output, &after).unwrap_err(),
            "RETAINED_SOURCE_CHANGED"
        );
        fs::remove_file(legacy.join("changed")).unwrap();
        assert_eq!(
            publish(&output, &"0".repeat(64)).unwrap_err(),
            "VERIFIED_CLONE_CHANGED"
        );
        fs::write(target.join("changed"), b"changed").unwrap();
        assert_eq!(
            publish(&output, &after).unwrap_err(),
            "CURRENT_STORAGE_CHANGED"
        );
        fs::remove_file(target.join("changed")).unwrap();
        let encrypted = fs::read(output.join("repair-plan.enc")).unwrap();
        let mut tampered = encrypted.clone();
        *tampered.last_mut().unwrap() ^= 1;
        fs::write(output.join("repair-plan.enc"), tampered).unwrap();
        assert_eq!(
            publish(&output, &after).unwrap_err(),
            "PLAN_AUTHENTICATION_FAILED"
        );
        fs::write(output.join("repair-plan.enc"), encrypted).unwrap();
        let held = snapshot::source_lock(&data).unwrap();
        assert_eq!(publish(&output, &after).unwrap_err(), "SOURCE_IN_USE");
        drop(held);
        let result = publish(&output, &after).unwrap();
        assert_eq!(result["metadataAndMigrationDatabaseUnchanged"], true);
        assert_eq!(fs::read(cookies).unwrap(), b"new-cookies");
        assert_eq!(fs::read(clone.join("retained")).unwrap(), b"new-login");
        assert_eq!(
            publish(&output, &after).unwrap_err(),
            "CURRENT_STORAGE_CHANGED"
        );
    }
}
