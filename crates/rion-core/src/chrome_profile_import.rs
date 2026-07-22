use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::Serialize;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        ChromeProfileEntryRecord, ChromeProfileImportCommitRecord,
        ChromeProfileImportPrepareRecord, ChromeProfileImportPreviewRecord,
        ChromeProfileImportWarningRecord, ChromeProfileImportedSessionRecord, StateGameRecord,
        StateRoleRecord,
    },
};

const IMPORT_DIRECTORY: &str = ".chrome-profile-import";
const IMPORT_JOURNAL: &str = "chrome-profile-import-transaction.json";
const IMPORT_COMMITTED_MARKER: &str = "chrome-profile-import-transaction.committed";
const LOCK_FILES: &[&str] = &["SingletonCookie", "SingletonLock", "SingletonSocket"];
const MAX_PENDING_IMPORTS: usize = 8;
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
struct PendingImport {
    created_at: Instant,
    import_id: String,
    profiles: Vec<ChromeProfileEntryRecord>,
    source_user_data_dir: PathBuf,
    prepared: Option<PreparedImport>,
}

#[derive(Debug, Clone)]
struct PreparedImport {
    assignments: Vec<ProfileAssignment>,
    original_roles: Vec<StateRoleRecord>,
    overwritten_role_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct ProfileAssignment {
    profile: ChromeProfileEntryRecord,
    role: StateRoleRecord,
    overwrites_existing: bool,
}

#[derive(Debug)]
pub(crate) struct PreparedChromeProfileCommit {
    pub result: ChromeProfileImportCommitRecord,
    pub roles: Vec<StateRoleRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportJournal<'a> {
    created_role_ids: Vec<&'a str>,
    import_id: &'a str,
    original_roles: &'a [StateRoleRecord],
    overwritten_role_ids: &'a [String],
    phase: &'static str,
}

#[derive(Debug)]
pub(crate) struct ChromeProfileImportRuntime {
    pending: VecDeque<PendingImport>,
    user_data_dir: PathBuf,
}

impl ChromeProfileImportRuntime {
    pub fn new(user_data_dir: PathBuf) -> Self {
        Self {
            pending: VecDeque::new(),
            user_data_dir,
        }
    }

    pub fn preview(
        &mut self,
        source_user_data_dir: &str,
    ) -> CoreResult<ChromeProfileImportPreviewRecord> {
        self.prune_expired();
        let source = PathBuf::from(source_user_data_dir.trim());
        if !source.is_absolute() {
            return Err(domain(
                "SOURCE_INVALID",
                "Selected Chrome data folder does not exist.",
            ));
        }
        if LOCK_FILES.iter().any(|name| source.join(name).exists()) {
            return Err(domain(
                "CHROME_RUNNING",
                "Chrome is still using the selected profile. Quit Chrome and try again.",
            ));
        }
        let profiles = rion_platform::discover_chrome_profiles(&source)
            .map_err(|_| {
                domain(
                    "PROFILE_INVALID",
                    "No usable Chrome profiles were found in the selected folder.",
                )
            })?
            .into_iter()
            .map(|profile| ChromeProfileEntryRecord {
                id: profile.id,
                directory_name: profile.directory_name,
                name: profile.name,
            })
            .collect::<Vec<_>>();
        let import_id = Uuid::new_v4().to_string();
        while self.pending.len() >= MAX_PENDING_IMPORTS {
            self.pending.pop_front();
        }
        self.pending.push_back(PendingImport {
            created_at: Instant::now(),
            import_id: import_id.clone(),
            profiles: profiles.clone(),
            source_user_data_dir: source.clone(),
            prepared: None,
        });
        Ok(ChromeProfileImportPreviewRecord {
            import_id,
            source_label: source
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("Chrome User Data")
                .to_owned(),
            profiles,
            warnings: vec![ChromeProfileImportWarningRecord {
                code: "passwords_excluded".to_owned(),
                profile_id: None,
                profile_name: None,
                replacement_name: None,
            }],
        })
    }

    pub fn prepare(
        &mut self,
        import_id: &str,
        profile_ids: Vec<String>,
        game_id: &str,
        consent_accepted: bool,
        games: &[StateGameRecord],
        roles: &[StateRoleRecord],
    ) -> CoreResult<ChromeProfileImportPrepareRecord> {
        if !consent_accepted {
            return Err(domain(
                "CONSENT_REQUIRED",
                "Consent is required before importing Chrome profile data.",
            ));
        }
        self.prune_expired();
        let pending = self.pending_mut(import_id)?;
        let game = games
            .iter()
            .find(|game| game.id == game_id)
            .ok_or_else(|| domain("GAME_NOT_FOUND", "Game not found."))?;
        let profiles_by_id = pending
            .profiles
            .iter()
            .map(|profile| (profile.id.as_str(), profile))
            .collect::<HashMap<_, _>>();
        let mut selected_ids = HashSet::new();
        let profiles = profile_ids
            .iter()
            .filter(|profile_id| selected_ids.insert(profile_id.as_str()))
            .filter_map(|profile_id| profiles_by_id.get(profile_id.as_str()).copied())
            .cloned()
            .collect::<Vec<_>>();
        if profiles.is_empty() {
            return Err(domain(
                "PROFILE_SELECTION_EMPTY",
                "Select at least one Chrome profile to import.",
            ));
        }

        let existing_by_identity = roles.iter().fold(
            HashMap::<String, Vec<&StateRoleRecord>>::new(),
            |mut result, role| {
                result
                    .entry(role_identity(&role.game_id, &role.name))
                    .or_default()
                    .push(role);
                result
            },
        );
        let mut seen = HashSet::new();
        let timestamp = chrono::Utc::now().to_rfc3339();
        let assignments = profiles
            .iter()
            .map(|profile| {
                let role_name = normalized_role_name(profile);
                let identity = role_identity(&game.id, &role_name);
                if !seen.insert(identity.clone()) {
                    return Err(role_name_conflict());
                }
                let matches = existing_by_identity
                    .get(&identity)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                if matches.len() > 1 {
                    return Err(role_name_conflict());
                }
                let existing = matches.first().copied();
                let role = StateRoleRecord {
                    id: existing
                        .map(|role| role.id.clone())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    game_id: game.id.clone(),
                    name: role_name,
                    launch_url: game.default_launch_url.clone(),
                    notes: "Imported from a local Chrome profile.".to_owned(),
                    browser_session_source: Some("chrome-profile".to_owned()),
                    cover_image_data_url: existing
                        .and_then(|role| role.cover_image_data_url.clone()),
                    cover_image_dominant_color: existing
                        .and_then(|role| role.cover_image_dominant_color.clone()),
                    created_at: existing
                        .map(|role| role.created_at.clone())
                        .unwrap_or_else(|| timestamp.clone()),
                    updated_at: timestamp.clone(),
                };
                ensure_safe_component(&role.id)?;
                Ok(ProfileAssignment {
                    profile: profile.clone(),
                    role,
                    overwrites_existing: existing.is_some(),
                })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let overwritten_role_ids = assignments
            .iter()
            .filter(|assignment| assignment.overwrites_existing)
            .map(|assignment| assignment.role.id.clone())
            .collect::<Vec<_>>();
        pending.prepared = Some(PreparedImport {
            assignments,
            original_roles: roles.to_vec(),
            overwritten_role_ids: overwritten_role_ids.clone(),
        });
        Ok(ChromeProfileImportPrepareRecord {
            overwritten_role_ids,
            profiles,
        })
    }

    pub fn commit_files(
        &mut self,
        import_id: &str,
        current_roles: Vec<StateRoleRecord>,
    ) -> CoreResult<PreparedChromeProfileCommit> {
        self.prune_expired();
        let user_data_dir = self.user_data_dir.clone();
        let pending = self.pending_mut(import_id)?;
        let prepared = pending.prepared.clone().ok_or_else(|| {
            domain(
                "IMPORT_NOT_PREPARED",
                "Chrome profile import must be prepared before it is committed.",
            )
        })?;
        let stage_root = stage_root(&user_data_dir, import_id)?;
        remove_directory_if_present(&stage_root)?;
        fs::create_dir_all(&stage_root).map_err(|error| io_error(&stage_root, error))?;

        let operation = (|| {
            for assignment in &prepared.assignments {
                let staged = stage_root.join("profiles").join(&assignment.role.id);
                rion_platform::copy_chrome_profile(
                    &pending.source_user_data_dir,
                    &assignment.profile.directory_name,
                    &staged,
                )
                .map_err(|error| CoreError::Platform(error.to_string()))?;
            }
            for role_id in &prepared.overwritten_role_ids {
                let source = browser_directory(&user_data_dir, role_id)?;
                let backup = stage_root.join("backups").join(role_id);
                if source.is_dir() {
                    copy_directory(&source, &backup)?;
                } else {
                    fs::create_dir_all(&backup).map_err(|error| io_error(&backup, error))?;
                }
            }
            write_journal(&user_data_dir, import_id, &prepared)?;
            for assignment in &prepared.assignments {
                let staged = stage_root.join("profiles").join(&assignment.role.id);
                let target = browser_directory(&user_data_dir, &assignment.role.id)?;
                remove_directory_if_present(&target)?;
                copy_directory(&staged, &target)?;
            }
            Ok(())
        })();
        if let Err(error) = operation {
            let _ = restore_files(&user_data_dir, import_id, &prepared);
            let _ = cleanup_transaction(&user_data_dir, import_id);
            pending.prepared = None;
            return Err(error);
        }

        let replacement_by_id = prepared
            .assignments
            .iter()
            .map(|assignment| (assignment.role.id.as_str(), &assignment.role))
            .collect::<HashMap<_, _>>();
        let roles = current_roles
            .into_iter()
            .map(|role| {
                replacement_by_id
                    .get(role.id.as_str())
                    .map(|replacement| (*replacement).clone())
                    .unwrap_or(role)
            })
            .chain(
                prepared
                    .assignments
                    .iter()
                    .filter(|assignment| !assignment.overwrites_existing)
                    .map(|assignment| assignment.role.clone()),
            )
            .collect();
        let sessions = prepared
            .assignments
            .iter()
            .map(|assignment| {
                Ok(ChromeProfileImportedSessionRecord {
                    profile_id: assignment.profile.id.clone(),
                    profile_name: assignment.profile.name.clone(),
                    browser_user_data_dir: browser_directory(&user_data_dir, &assignment.role.id)?
                        .to_string_lossy()
                        .into_owned(),
                    role: assignment.role.clone(),
                })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        Ok(PreparedChromeProfileCommit {
            result: ChromeProfileImportCommitRecord {
                roles: prepared
                    .assignments
                    .iter()
                    .map(|assignment| assignment.role.clone())
                    .collect(),
                sessions,
            },
            roles,
        })
    }

    pub fn rollback_roles(&mut self, import_id: &str) -> CoreResult<Vec<StateRoleRecord>> {
        self.prune_expired();
        let prepared = self
            .pending_mut(import_id)?
            .prepared
            .as_ref()
            .ok_or_else(|| {
                domain(
                    "IMPORT_NOT_PREPARED",
                    "Chrome profile import is not active.",
                )
            })?;
        Ok(prepared.original_roles.clone())
    }

    pub fn finish_rollback(&mut self, import_id: &str) -> CoreResult<()> {
        self.prune_expired();
        let user_data_dir = self.user_data_dir.clone();
        let pending = self.pending_mut(import_id)?;
        let prepared = pending.prepared.as_ref().ok_or_else(|| {
            domain(
                "IMPORT_NOT_PREPARED",
                "Chrome profile import is not active.",
            )
        })?;
        restore_files(&user_data_dir, import_id, prepared)?;
        cleanup_transaction(&user_data_dir, import_id)?;
        pending.prepared = None;
        Ok(())
    }

    pub fn finalize(&mut self, import_id: &str) -> CoreResult<()> {
        self.prune_expired();
        let position = self.position(import_id)?;
        if self.pending[position].prepared.is_none() {
            return Err(domain(
                "IMPORT_NOT_PREPARED",
                "Chrome profile import is not active.",
            ));
        }
        write_committed_marker(&self.user_data_dir, import_id)?;
        // Once the marker is durable, startup recovery will only finish cleanup.
        // Cleanup errors are therefore non-fatal to the committed import.
        let _ = cleanup_transaction(&self.user_data_dir, import_id);
        self.pending.remove(position);
        Ok(())
    }

    pub fn discard(&mut self, import_id: &str) -> CoreResult<()> {
        self.prune_expired();
        let position = self.position(import_id)?;
        if self.pending[position].prepared.is_some() {
            return Err(domain(
                "IMPORT_ACTIVE",
                "An active Chrome profile import must be rolled back before it is discarded.",
            ));
        }
        cleanup_transaction(&self.user_data_dir, import_id)?;
        self.pending.remove(position);
        Ok(())
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        self.pending.retain(|pending| {
            pending.prepared.is_some()
                || now.saturating_duration_since(pending.created_at) <= PENDING_TTL
        });
    }

    fn pending_mut(&mut self, import_id: &str) -> CoreResult<&mut PendingImport> {
        let position = self.position(import_id)?;
        Ok(&mut self.pending[position])
    }

    fn position(&self, import_id: &str) -> CoreResult<usize> {
        ensure_safe_component(import_id)?;
        self.pending
            .iter()
            .position(|pending| pending.import_id == import_id)
            .ok_or_else(|| {
                domain(
                    "IMPORT_EXPIRED",
                    "Chrome profile import preview expired. Choose the folder again.",
                )
            })
    }
}

fn normalized_role_name(profile: &ChromeProfileEntryRecord) -> String {
    let source = if profile.name.trim().is_empty() {
        if profile.directory_name.trim().is_empty() {
            "Chrome Profile"
        } else {
            profile.directory_name.trim()
        }
    } else {
        profile.name.trim()
    };
    source.chars().take(80).collect()
}

fn role_identity(game_id: &str, name: &str) -> String {
    format!("{game_id}\0{}", name.trim().to_lowercase())
}

fn role_name_conflict() -> CoreError {
    domain(
        "ROLE_NAME_CONFLICT",
        "Multiple Chrome profiles or roles share a name in the selected game. Rename or remove duplicates before importing.",
    )
}

fn stage_root(user_data_dir: &Path, import_id: &str) -> CoreResult<PathBuf> {
    ensure_safe_component(import_id)?;
    Ok(user_data_dir.join(IMPORT_DIRECTORY).join(import_id))
}

fn browser_directory(user_data_dir: &Path, role_id: &str) -> CoreResult<PathBuf> {
    ensure_safe_component(role_id)?;
    Ok(user_data_dir.join("roles").join(role_id).join("browser"))
}

fn write_journal(
    user_data_dir: &Path,
    import_id: &str,
    prepared: &PreparedImport,
) -> CoreResult<()> {
    let created_role_ids = prepared
        .assignments
        .iter()
        .filter(|assignment| !assignment.overwrites_existing)
        .map(|assignment| assignment.role.id.as_str())
        .collect();
    write_json_new(
        &user_data_dir.join(IMPORT_JOURNAL),
        &ImportJournal {
            created_role_ids,
            import_id,
            original_roles: &prepared.original_roles,
            overwritten_role_ids: &prepared.overwritten_role_ids,
            phase: "prepared",
        },
    )
}

fn write_json_new(path: &Path, value: &impl Serialize) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(|error| io_error(&temporary, error))?;
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        file.write_all(&bytes)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| io_error(&temporary, error))?;
        fs::rename(&temporary, path).map_err(|error| io_error(path, error))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn write_committed_marker(user_data_dir: &Path, import_id: &str) -> CoreResult<()> {
    let path = user_data_dir.join(IMPORT_COMMITTED_MARKER);
    let mut file = fs::File::create(&path).map_err(|error| io_error(&path, error))?;
    file.write_all(import_id.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| io_error(&path, error))
}

fn restore_files(
    user_data_dir: &Path,
    import_id: &str,
    prepared: &PreparedImport,
) -> CoreResult<()> {
    let stage = stage_root(user_data_dir, import_id)?;
    for assignment in &prepared.assignments {
        let target = browser_directory(user_data_dir, &assignment.role.id)?;
        remove_directory_if_present(&target)?;
        if assignment.overwrites_existing {
            let backup = stage.join("backups").join(&assignment.role.id);
            if backup.is_dir() {
                copy_directory(&backup, &target)?;
            } else {
                fs::create_dir_all(&target).map_err(|error| io_error(&target, error))?;
            }
        } else if let Some(role_directory) = target.parent() {
            remove_directory_if_present(role_directory)?;
        }
    }
    Ok(())
}

fn cleanup_transaction(user_data_dir: &Path, import_id: &str) -> CoreResult<()> {
    remove_directory_if_present(&stage_root(user_data_dir, import_id)?)?;
    let import_root = user_data_dir.join(IMPORT_DIRECTORY);
    if import_root.is_dir()
        && fs::read_dir(&import_root)
            .map_err(|error| io_error(&import_root, error))?
            .next()
            .is_none()
    {
        remove_directory_if_present(&import_root)?;
    }
    remove_file_if_present(&user_data_dir.join(IMPORT_JOURNAL))?;
    remove_file_if_present(&user_data_dir.join(IMPORT_COMMITTED_MARKER))
}

fn copy_directory(source: &Path, destination: &Path) -> CoreResult<()> {
    let metadata = fs::symlink_metadata(source).map_err(|error| io_error(source, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(domain(
            "PROFILE_INVALID",
            "Chrome profile contains an unsupported symbolic link.",
        ));
    }
    fs::create_dir_all(destination).map_err(|error| io_error(destination, error))?;
    for entry in fs::read_dir(source).map_err(|error| io_error(source, error))? {
        let entry = entry.map_err(|error| io_error(source, error))?;
        let file_type = entry
            .file_type()
            .map_err(|error| io_error(&entry.path(), error))?;
        if file_type.is_symlink() {
            return Err(domain(
                "PROFILE_INVALID",
                "Chrome profile contains an unsupported symbolic link.",
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|error| io_error(&target, error))?;
        }
    }
    Ok(())
}

fn remove_directory_if_present(path: &Path) -> CoreResult<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(path, error)),
    }
}

fn remove_file_if_present(path: &Path) -> CoreResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(path, error)),
    }
}

fn ensure_safe_component(value: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(domain(
            "IMPORT_INVALID",
            "Chrome profile import id is invalid.",
        ))
    } else {
        Ok(())
    }
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn io_error(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Platform(format!(
        "Chrome profile import failed for {}: {error}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CoreStateSnapshotRecord;
    use serde_json::json;
    use tempfile::tempdir;

    fn source_fixture(root: &Path) -> PathBuf {
        let source = root.join("Chrome User Data");
        fs::create_dir_all(source.join("Default/Network")).unwrap();
        fs::write(source.join("Default/Network/Cookies"), b"cookie-db").unwrap();
        fs::write(
            source.join("Local State"),
            json!({"profile":{"info_cache":{"Default":{"name":"Aron"}}}}).to_string(),
        )
        .unwrap();
        source
    }

    fn snapshot() -> CoreStateSnapshotRecord {
        serde_json::from_value(json!({
            "games":[{"id":"g1","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}],
            "roles":[],"launchWorkspaces":[],"macros":[],"compatibilityReports":[]
        }))
        .unwrap()
    }

    #[test]
    fn preview_prepare_commit_and_rollback_are_a_reentrant_rust_saga() {
        let directory = tempdir().unwrap();
        let source = source_fixture(directory.path());
        let user_data = directory.path().join("app");
        fs::create_dir_all(&user_data).unwrap();
        let mut runtime = ChromeProfileImportRuntime::new(user_data.clone());
        let preview = runtime.preview(source.to_str().unwrap()).unwrap();
        assert_eq!(preview.profiles[0].name, "Aron");
        let state = snapshot();
        let prepared = runtime
            .prepare(
                &preview.import_id,
                vec!["Default".to_owned()],
                "g1",
                true,
                &state.games,
                &state.roles,
            )
            .unwrap();
        assert!(prepared.overwritten_role_ids.is_empty());
        let committed = runtime
            .commit_files(&preview.import_id, state.roles)
            .unwrap();
        assert_eq!(committed.roles.len(), 1);
        assert!(
            Path::new(&committed.result.sessions[0].browser_user_data_dir)
                .join("Default/Network/Cookies")
                .is_file()
        );
        let rolled_back = runtime.rollback_roles(&preview.import_id).unwrap();
        assert!(rolled_back.is_empty());
        runtime.finish_rollback(&preview.import_id).unwrap();
        assert!(!user_data.join(IMPORT_JOURNAL).exists());
        assert!(
            fs::read_dir(user_data.join("roles"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn preview_rejects_active_chrome_lock_markers() {
        let directory = tempdir().unwrap();
        let source = source_fixture(directory.path());
        fs::write(source.join("SingletonLock"), b"locked").unwrap();
        let mut runtime = ChromeProfileImportRuntime::new(directory.path().join("app"));
        let error = runtime.preview(source.to_str().unwrap()).unwrap_err();
        assert!(matches!(
            error,
            CoreError::Domain {
                code: "CHROME_RUNNING",
                ..
            }
        ));
    }
}
