use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{ChromeProfileEntryRecord, ChromeProfileImportPreviewRecord},
};

const MAX_PENDING_IMPORTS: usize = 8;
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub(crate) struct PendingChromeProfileImport {
    pub import_id: String,
    pub source_user_data_dir: PathBuf,
    pub profiles: Vec<ChromeProfileEntryRecord>,
    pub source_fingerprints: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct PendingEntry {
    created_at: Instant,
    value: PendingChromeProfileImport,
}

#[derive(Debug, Default)]
pub(crate) struct ChromeProfileImportRuntime {
    pending: VecDeque<PendingEntry>,
    active: HashSet<String>,
    cancel_requested: HashSet<String>,
}

impl ChromeProfileImportRuntime {
    pub fn preview(&mut self, source: &str) -> CoreResult<ChromeProfileImportPreviewRecord> {
        self.prune();
        let path = PathBuf::from(source.trim());
        if !path.is_absolute() {
            return Err(domain(
                "SOURCE_INVALID",
                "Selected Chrome data folder is invalid.",
            ));
        }
        let profiles = rion_platform::discover_chrome_profiles(&path)
            .map_err(|_| domain("PROFILE_INVALID", "No usable Chrome profiles were found."))?
            .into_iter()
            .map(|profile| ChromeProfileEntryRecord {
                id: profile.id,
                directory_name: profile.directory_name,
                name: profile.name,
                existing_role_id: None,
                existing_role_name: None,
            })
            .collect::<Vec<_>>();
        let source_fingerprints = profiles
            .iter()
            .map(|profile| {
                rion_platform::chrome_profile_source_fingerprint(&path, &profile.directory_name)
                    .map(|fingerprint| (profile.id.clone(), fingerprint))
                    .map_err(|_| {
                        domain("PROFILE_INVALID", "Chrome profile data could not be read.")
                    })
            })
            .collect::<CoreResult<HashMap<_, _>>>()?;
        let import_id = Uuid::new_v4().to_string();
        while self.pending.len() >= MAX_PENDING_IMPORTS {
            self.pending.pop_front();
        }
        let pending = PendingChromeProfileImport {
            import_id: import_id.clone(),
            source_user_data_dir: path.clone(),
            profiles: profiles.clone(),
            source_fingerprints,
        };
        self.pending.push_back(PendingEntry {
            created_at: Instant::now(),
            value: pending,
        });
        Ok(preview_record(&import_id, &path, profiles))
    }

    pub fn refresh(&mut self, import_id: &str) -> CoreResult<ChromeProfileImportPreviewRecord> {
        let pending = self.get(import_id)?;
        Ok(preview_record(
            &pending.import_id,
            &pending.source_user_data_dir,
            pending.profiles,
        ))
    }

    /// Rebinds a preview to the source exactly as Chrome left it at exit.
    /// Chrome rewrites Local State, its cookie database, and LocalStorage while
    /// quitting, so fingerprints taken while it ran can never match afterward.
    /// The import identity and profile list stay unchanged, which keeps the
    /// user's selections; only profiles that were fingerprinted are rebound.
    pub fn rebind_released_source(
        &mut self,
        import_id: &str,
        fingerprints: HashMap<String, String>,
    ) -> CoreResult<ChromeProfileImportPreviewRecord> {
        self.prune();
        let pending = self
            .pending
            .iter_mut()
            .find(|pending| pending.value.import_id == import_id)
            .map(|pending| &mut pending.value)
            .ok_or_else(|| domain("IMPORT_NOT_FOUND", "Chrome profile import preview expired."))?;
        for (profile_id, fingerprint) in fingerprints {
            if let Some(current) = pending.source_fingerprints.get_mut(&profile_id) {
                *current = fingerprint;
            }
        }
        Ok(preview_record(
            &pending.import_id,
            &pending.source_user_data_dir,
            pending.profiles.clone(),
        ))
    }

    pub fn get(&mut self, import_id: &str) -> CoreResult<PendingChromeProfileImport> {
        self.prune();
        self.pending
            .iter()
            .find(|pending| pending.value.import_id == import_id)
            .map(|pending| pending.value.clone())
            .ok_or_else(|| domain("IMPORT_NOT_FOUND", "Chrome profile import preview expired."))
    }

    pub fn begin(&mut self, import_id: &str) -> CoreResult<()> {
        self.prune();
        if !self
            .pending
            .iter()
            .any(|pending| pending.value.import_id == import_id)
        {
            return Err(domain(
                "IMPORT_NOT_FOUND",
                "Chrome profile import preview expired.",
            ));
        }
        if !self.active.insert(import_id.to_owned()) {
            return Err(domain(
                "IMPORT_ALREADY_ACTIVE",
                "This Chrome profile import is already running.",
            ));
        }
        self.cancel_requested.remove(import_id);
        Ok(())
    }

    pub fn is_cancel_requested(&self, import_id: &str) -> bool {
        self.cancel_requested.contains(import_id)
    }

    pub fn finish(&mut self, import_id: &str) {
        self.active.remove(import_id);
        self.cancel_requested.remove(import_id);
        self.pending
            .retain(|pending| pending.value.import_id != import_id);
    }

    pub fn discard(&mut self, import_id: &str) {
        if self.active.contains(import_id) {
            self.cancel_requested.insert(import_id.to_owned());
        } else {
            self.pending
                .retain(|pending| pending.value.import_id != import_id);
            self.cancel_requested.remove(import_id);
        }
    }

    fn prune(&mut self) {
        self.pending.retain(|pending| {
            self.active.contains(&pending.value.import_id)
                || pending.created_at.elapsed() <= PENDING_TTL
        });
    }
}

/// Fingerprints a preview's profiles once Chrome has released its user data.
/// Returns `None` while Chrome holds the source, including when it starts
/// again during hashing, so a torn read never rebinds a preview. A profile
/// that cannot be read keeps its preview fingerprint and fails at apply.
pub(crate) fn released_source_fingerprints(
    pending: &PendingChromeProfileImport,
) -> Option<HashMap<String, String>> {
    let source = &pending.source_user_data_dir;
    if rion_platform::chrome_user_data_in_use(source) {
        return None;
    }
    let fingerprints = pending
        .profiles
        .iter()
        .filter_map(|profile| {
            rion_platform::chrome_profile_source_fingerprint(source, &profile.directory_name)
                .ok()
                .map(|fingerprint| (profile.id.clone(), fingerprint))
        })
        .collect();
    (!rion_platform::chrome_user_data_in_use(source)).then_some(fingerprints)
}

pub(crate) fn session_transfer_directory(
    user_data_dir: &Path,
    transaction_id: &str,
) -> CoreResult<PathBuf> {
    ensure_component(transaction_id)?;
    Ok(user_data_dir
        .join(".session-transfers")
        .join(transaction_id))
}

pub(crate) fn persist_encrypted_staging(
    directory: &Path,
    protected_payload: &[u8],
) -> CoreResult<()> {
    fs::create_dir_all(directory).map_err(|error| CoreError::Platform(error.to_string()))?;
    restrict_directory_internal(directory)?;
    let path = directory.join("session-transfer.enc");
    let temporary = directory.join("session-transfer.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        file.write_all(protected_payload)
            .and_then(|()| file.sync_all())
            .map_err(|error| CoreError::Platform(error.to_string()))?;
    }
    #[cfg(windows)]
    {
        fs::write(&temporary, protected_payload)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
    }
    rion_platform::atomic_replace_file(&temporary, &path)
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    rion_platform::restrict_directory_to_current_user(directory)
        .map_err(|error| CoreError::Platform(error.to_string()))
}

pub(crate) fn restrict_directory_internal(path: &Path) -> CoreResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| CoreError::Platform(error.to_string()))?;
    }
    rion_platform::restrict_directory_to_current_user(path)
        .map_err(|error| CoreError::Platform(error.to_string()))
}

pub(crate) fn normalized_profile_name(name: &str, directory_name: &str) -> String {
    let value = name.trim();
    let value = if value.is_empty() {
        directory_name
    } else {
        value
    };
    value
        .chars()
        .take(MAX_ROLE_NAME_CHARS)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

const MAX_ROLE_NAME_CHARS: usize = 80;

pub(crate) fn copy_role_name(base: &str, used: &std::collections::HashSet<String>) -> String {
    let first = copy_role_candidate(base, " (Chrome)");
    if !used.contains(&first.to_lowercase()) {
        return first;
    }
    for index in 2..=9999 {
        let candidate = copy_role_candidate(base, &format!(" (Chrome {index})"));
        if !used.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    copy_role_candidate(base, &format!(" (Chrome {})", Uuid::new_v4().simple()))
}

// The copy suffix must fit the Role name limit, so a long base yields first.
fn copy_role_candidate(base: &str, suffix: &str) -> String {
    let max_base = MAX_ROLE_NAME_CHARS.saturating_sub(suffix.chars().count());
    let base = base.chars().take(max_base).collect::<String>();
    format!("{}{suffix}", base.trim_end())
}

fn preview_record(
    import_id: &str,
    path: &Path,
    profiles: Vec<ChromeProfileEntryRecord>,
) -> ChromeProfileImportPreviewRecord {
    ChromeProfileImportPreviewRecord {
        import_id: import_id.to_owned(),
        source_label: path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Chrome User Data")
            .to_owned(),
        source_in_use: rion_platform::chrome_user_data_in_use(path),
        profiles,
    }
}

fn ensure_component(value: &str) -> CoreResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(CoreError::InvalidInput(
            "Chrome profile import identifier is invalid.".to_owned(),
        ));
    }
    Ok(())
}

fn domain(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generates_deterministic_copy_names() {
        let mut used = HashSet::new();
        assert_eq!(copy_role_name("Player", &used), "Player (Chrome)");
        used.insert("player (chrome)".to_owned());
        assert_eq!(copy_role_name("Player", &used), "Player (Chrome 2)");
    }

    #[test]
    fn copy_names_fit_the_role_name_limit() {
        let base = normalized_profile_name(&"É".repeat(100), "Default");
        assert_eq!(base.chars().count(), 80);
        let mut used = HashSet::new();
        let first = copy_role_name(&base, &used);
        assert_eq!(first.chars().count(), 80);
        assert!(first.ends_with(" (Chrome)"));
        used.insert(first.to_lowercase());
        let second = copy_role_name(&base, &used);
        assert_eq!(second.chars().count(), 80);
        assert!(second.ends_with(" (Chrome 2)"));
        assert_eq!(
            normalized_profile_name(&format!("{} x", "a".repeat(79)), "Default"),
            "a".repeat(79)
        );
    }

    #[test]
    fn rejects_escaping_staging_components() {
        assert!(session_transfer_directory(Path::new("/tmp"), "../bad").is_err());
        assert!(session_transfer_directory(Path::new("/tmp"), "Profile/1").is_err());
    }

    #[test]
    fn active_discard_requests_cancellation_and_finish_removes_the_preview() {
        let mut runtime = ChromeProfileImportRuntime::default();
        runtime.pending.push_back(PendingEntry {
            created_at: Instant::now(),
            value: PendingChromeProfileImport {
                import_id: "import-1".to_owned(),
                source_user_data_dir: PathBuf::from("/tmp/chrome"),
                profiles: Vec::new(),
                source_fingerprints: HashMap::new(),
            },
        });
        runtime.begin("import-1").unwrap();
        runtime.discard("import-1");
        assert!(runtime.is_cancel_requested("import-1"));
        assert!(runtime.get("import-1").is_ok());
        runtime.finish("import-1");
        assert!(!runtime.is_cancel_requested("import-1"));
        assert!(runtime.get("import-1").is_err());
    }

    #[test]
    fn released_source_rebinds_fingerprints_without_changing_the_preview_identity() {
        let source = tempdir().unwrap();
        fs::create_dir_all(source.path().join("Default/Network")).unwrap();
        fs::create_dir_all(source.path().join("Profile 1/Network")).unwrap();
        fs::write(source.path().join("Local State"), "{}").unwrap();
        fs::write(source.path().join("Default/Network/Cookies"), b"running").unwrap();
        fs::write(source.path().join("Profile 1/Network/Cookies"), b"running").unwrap();
        fs::write(source.path().join("SingletonLock"), b"chrome-host-1").unwrap();
        let mut runtime = ChromeProfileImportRuntime::default();
        let preview = runtime.preview(source.path().to_str().unwrap()).unwrap();
        assert!(preview.source_in_use);
        let previewed = runtime.get(&preview.import_id).unwrap();

        // Chrome still holds the profile: nothing is rebound.
        fs::write(source.path().join("Default/Network/Cookies"), b"flushing").unwrap();
        assert!(released_source_fingerprints(&previewed).is_none());

        // Chrome exited and wrote its state back.
        fs::remove_file(source.path().join("SingletonLock")).unwrap();
        fs::write(
            source.path().join("Local State"),
            r#"{"written":"at exit"}"#,
        )
        .unwrap();
        fs::write(
            source.path().join("Default/Network/Cookies"),
            b"written at exit",
        )
        .unwrap();
        let released = released_source_fingerprints(&previewed).unwrap();
        let rebound = runtime
            .rebind_released_source(&preview.import_id, released.clone())
            .unwrap();
        assert_eq!(rebound.import_id, preview.import_id);
        assert_eq!(
            serde_json::to_value(&rebound.profiles).unwrap(),
            serde_json::to_value(&preview.profiles).unwrap()
        );
        assert!(!rebound.source_in_use);
        let current = runtime.get(&preview.import_id).unwrap();
        assert_eq!(current.source_fingerprints, released);
        for profile in &current.profiles {
            assert_eq!(
                current.source_fingerprints[&profile.id],
                rion_platform::chrome_profile_source_fingerprint(
                    source.path(),
                    &profile.directory_name
                )
                .unwrap()
            );
            assert_ne!(
                current.source_fingerprints[&profile.id],
                previewed.source_fingerprints[&profile.id]
            );
        }
        assert!(
            runtime
                .rebind_released_source("missing-import", HashMap::new())
                .is_err_and(|error| error.code() == "IMPORT_NOT_FOUND")
        );
    }

    #[test]
    fn encrypted_staging_never_creates_a_raw_profile_snapshot_root() {
        let root = tempdir().unwrap();
        let staging = session_transfer_directory(root.path(), "transaction-1").unwrap();
        persist_encrypted_staging(&staging, b"protected-payload").unwrap();
        assert_eq!(
            fs::read(staging.join("session-transfer.enc")).unwrap(),
            b"protected-payload"
        );
        let mut entries = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(entries, vec![".session-transfers"]);
    }
}
