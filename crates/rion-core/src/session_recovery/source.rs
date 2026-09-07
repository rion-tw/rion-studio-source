use super::{error, types::*};
use crate::{
    RoleSessionMigrationRecord,
    error::CoreResult,
    session_source::{paths, snapshot},
    session_transfer::RoleSessionTransferEnvelopeRecord,
};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) struct Candidate {
    pub view: RoleSessionRecoveryCandidate,
    pub path: PathBuf,
    pub envelope: Option<RoleSessionTransferEnvelopeRecord>,
}

pub(crate) fn digest(path: &Path) -> CoreResult<String> {
    let mut hash = Sha256::new();
    let paths = if path.is_dir() {
        paths::files(path).map_err(error)?
    } else {
        vec![paths::existing(path).map_err(error)?]
    };
    let mut total = 0;
    for item in &paths {
        let mut file = snapshot::open_file(item).map_err(error)?;
        let before = file
            .metadata()
            .map_err(|_| error("SOURCE_METADATA_FAILED"))?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(40 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("SOURCE_READ_FAILED"))?;
        total += bytes.len();
        if total > 40 * 1024 * 1024 {
            return Err(error("SNAPSHOT_SIZE_LIMIT"));
        }
        let after = file
            .metadata()
            .map_err(|_| error("SOURCE_METADATA_FAILED"))?;
        if before.len() != bytes.len() as u64
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
        {
            return Err(error("SOURCE_CHANGED_DURING_READ"));
        }
        rion_platform::verify_open_file_identity(item, &file)
            .map_err(|_| error("SOURCE_IDENTITY_CHANGED"))?;
        let relative = item
            .strip_prefix(path)
            .unwrap_or(Path::new("inventory.enc"));
        hash.update((relative.as_os_str().len() as u64).to_le_bytes());
        hash.update(relative.to_string_lossy().as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    if path.is_dir() && paths != paths::files(path).map_err(error)? {
        return Err(error("SOURCE_CHANGED_DURING_READ"));
    }
    Ok(hex::encode(hash.finalize()))
}

fn token(role: &str, app: &str, path: &Path, digest: &str) -> String {
    let fields = serde_json::json!(["rion-session-recovery-source-v1", role, app, path, digest]);
    hex::encode(Sha256::digest(fields.to_string()))
}

pub(crate) fn native_support(platform: rion_platform::Platform) -> bool {
    match platform {
        rion_platform::Platform::Macos => cfg!(target_os = "macos"),
        rion_platform::Platform::Windows => cfg!(windows),
    }
}

fn authenticated(
    data: &Path,
    platform: rion_platform::Platform,
    role: &str,
    journal: Option<&RoleSessionMigrationRecord>,
) -> CoreResult<Option<Candidate>> {
    let Some(journal) = journal.filter(|journal| journal.envelope_sha256.is_some()) else {
        return Ok(None);
    };
    let path = data
        .join(".session-migrations")
        .join(role)
        .join(&journal.transfer_id)
        .join("inventory.enc");
    if !path
        .try_exists()
        .map_err(|_| error("SOURCE_PATH_UNAVAILABLE"))?
    {
        return Ok(None);
    }
    let digest = digest(&path)?;
    let result = crate::session_transfer::read_session_transfer_vault(data, platform, journal);
    if self::digest(&path)? != digest {
        return Err(error("RECOVERY_SOURCE_CHANGED_DURING_READ"));
    }
    let mut blockers = Vec::new();
    if result.is_err() {
        blockers.push("EXPORTED_PACKAGE_AUTHENTICATION_OR_COMPLETENESS_FAILED".to_owned());
    }
    if !native_support(platform) {
        blockers.push("NATIVE_PLATFORM_VALIDATION_PENDING".to_owned());
    }
    let envelope = result.ok();
    if envelope.as_ref().is_some_and(|envelope| {
        envelope.inventory.cookies.iter().any(|cookie| {
            matches!(
                cookie.expiry,
                crate::session_transfer::RoleSessionTransferCookieExpiry::Absolute { unix_ms }
                    if unix_ms <= chrono::Utc::now().timestamp_millis()
            )
        })
    }) {
        blockers.push("COOKIE_EXPIRED_BEFORE_VERIFICATION".to_owned());
    }
    let evidence = envelope
        .as_ref()
        .and_then(|envelope| envelope.journal_evidence().ok());
    Ok(Some(Candidate {
        path: path.clone(),
        view: RoleSessionRecoveryCandidate {
            token: token(role, "authenticatedExport", &path, &digest),
            application: "authenticatedExport".to_owned(),
            kind: "authenticatedExport".to_owned(),
            supported: blockers.is_empty(),
            blockers,
            cookie_count: evidence
                .as_ref()
                .map(|evidence| evidence.cookie_count as usize),
            local_storage_origin_count: evidence
                .as_ref()
                .map_or(0, |evidence| evidence.local_storage_origin_count as usize),
            local_storage_entry_count: evidence
                .as_ref()
                .map(|evidence| evidence.local_storage_entry_count as usize),
            other_website_data_present: false,
        },
        envelope,
    }))
}

fn automatic_raw_path(
    data: &Path,
    platform: rion_platform::Platform,
    role: &str,
) -> CoreResult<(String, PathBuf)> {
    let paths = crate::role_browser_data::paths(data, role)?;
    match platform {
        rion_platform::Platform::Macos => {
            let home = std::env::var_os("HOME").ok_or_else(|| error("SOURCE_ROOT_UNAVAILABLE"))?;
            Ok((
                "com.rionstudio.launcher".to_owned(),
                macos_v84_role_store(Path::new(&home), &paths.webkit_data_store_identifier),
            ))
        }
        rion_platform::Platform::Windows => Ok((
            "webview2".to_owned(),
            PathBuf::from(paths.webview2_user_data_dir),
        )),
    }
}

fn macos_v84_role_store(home: &Path, store: &str) -> PathBuf {
    home.join("Library/WebKit/com.rionstudio.launcher/WebsiteDataStore")
        .join(store)
}

/// Production first-upgrade policy. Unlike the interactive inspector, this
/// never enumerates historical app identities or unrelated website data.
pub(crate) fn automatic(
    data: &Path,
    platform: rion_platform::Platform,
    role: &str,
    journal: Option<&RoleSessionMigrationRecord>,
) -> CoreResult<Option<Candidate>> {
    super::uuid(role)?;
    if let Some(candidate) = authenticated(data, platform, role, journal)?
        && candidate.envelope.is_some()
    {
        return Ok(Some(candidate));
    }
    let (application, path) = automatic_raw_path(data, platform, role)?;
    if !path
        .try_exists()
        .map_err(|_| error("SOURCE_PATH_UNAVAILABLE"))?
    {
        return Ok(None);
    }
    paths::existing(&path).map_err(error)?;
    Ok(Some(Candidate {
        view: RoleSessionRecoveryCandidate {
            token: String::new(),
            application,
            kind: "retainedStore".to_owned(),
            supported: true,
            blockers: Vec::new(),
            cookie_count: None,
            local_storage_origin_count: 0,
            local_storage_entry_count: None,
            other_website_data_present: false,
        },
        path,
        envelope: None,
    }))
}

pub(crate) fn inspect(
    data: &Path,
    platform: rion_platform::Platform,
    role: &str,
    journal: Option<&RoleSessionMigrationRecord>,
) -> CoreResult<Vec<Candidate>> {
    super::uuid(role)?;
    let mut candidates = Vec::new();
    if let Some(candidate) = authenticated(data, platform, role, journal)? {
        candidates.push(candidate);
    }
    let roots = if platform == rion_platform::Platform::Macos {
        let home = std::env::var_os("HOME").ok_or_else(|| error("SOURCE_ROOT_UNAVAILABLE"))?;
        let store = crate::role_browser_data::paths(data, role)?.webkit_data_store_identifier;
        [
            "com.rionstudio.launcher",
            "com.rionstudio.launcher.dev",
            "rion-tauri",
        ]
        .into_iter()
        .map(|app| {
            (
                app.to_owned(),
                PathBuf::from(&home)
                    .join("Library/WebKit")
                    .join(app)
                    .join("WebsiteDataStore")
                    .join(&store),
            )
        })
        .collect::<Vec<_>>()
    } else {
        vec![(
            "webview2".to_owned(),
            PathBuf::from(crate::role_browser_data::paths(data, role)?.webview2_user_data_dir),
        )]
    };
    for (application, path) in roots {
        if !path
            .try_exists()
            .map_err(|_| error("SOURCE_PATH_UNAVAILABLE"))?
        {
            continue;
        }
        paths::existing(&path).map_err(error)?;
        let mut blockers = Vec::new();
        let released = snapshot::released(&path, platform).map_err(error);
        let digest = released.and_then(|()| digest(&path));
        if let Err(e) = &digest {
            blockers.push(e.code().to_owned());
        }
        let files = paths::files(&path).map_err(error)?;
        let other = files.iter().any(|f| {
            let name = f.to_string_lossy().to_lowercase();
            name.contains("indexeddb")
                || name.contains("serviceworker")
                || name.contains("service worker")
        });
        // The production inspector never decodes live raw stores. Complete
        // attribute assessment belongs to the protected offline snapshot tool.
        if platform == rion_platform::Platform::Macos {
            blockers.push("WEBKIT_COOKIE_ATTRIBUTES_UNPROVEN".to_owned());
            if !files
                .iter()
                .any(|f| f.file_name().is_some_and(|n| n == "Cookies.binarycookies"))
            {
                blockers.push("COOKIE_INVENTORY_MISSING_UNPROVEN".to_owned());
            }
        } else {
            blockers.push("NATIVE_PLATFORM_VALIDATION_PENDING".to_owned());
        }
        blockers.sort();
        blockers.dedup();
        candidates.push(Candidate {
            view: RoleSessionRecoveryCandidate {
                token: token(role, &application, &path, &digest.unwrap_or_default()),
                application,
                kind: "retainedStore".to_owned(),
                supported: false,
                blockers,
                cookie_count: None,
                local_storage_origin_count: files
                    .iter()
                    .filter(|f| f.file_name().is_some_and(|n| n == "localstorage.sqlite3"))
                    .count(),
                local_storage_entry_count: None,
                other_website_data_present: other,
            },
            path,
            envelope: None,
        });
    }
    Ok(candidates)
}

pub(crate) fn assert_current(candidate: &Candidate) -> CoreResult<String> {
    let fingerprint = digest(&candidate.path)?;
    if token(
        &candidate
            .envelope
            .as_ref()
            .ok_or_else(|| error("RECOVERY_SOURCE_COMPLETENESS_UNPROVEN"))?
            .metadata
            .role_id,
        &candidate.view.application,
        &candidate.path,
        &fingerprint,
    ) != candidate.view.token
    {
        return Err(error("RECOVERY_SOURCE_TOKEN_STALE"));
    }
    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_macos_source_is_only_the_v84_application_and_role_store() {
        let home = Path::new("/fixture/home");
        let store = "bfd26c5d-090d-8320-af67-8b3baec92ef3";
        let selected = macos_v84_role_store(home, store);
        assert_eq!(
            selected,
            home.join("Library/WebKit/com.rionstudio.launcher/WebsiteDataStore")
                .join(store)
        );
        assert!(!selected.to_string_lossy().contains("launcher.dev"));
        assert!(!selected.to_string_lossy().contains("rion-tauri"));
    }
}
