use std::{
    ffi::{CString, OsStr, OsString},
    fs::{self, File},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

use chrono::Utc;
use plist::Value;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    InstallHandoffEvidence, InstallPrepareEvidence, PlatformInstallRequest,
    UpdatePlatformInstallError, UpdatePlatformInstaller,
};
use crate::{
    INSTALL_JOURNAL_FILE, InstallAttemptRecord, InstallPhase, UpdatePlatform,
    persistence::read_install_attempt,
};

#[path = "macos/archive.rs"]
mod archive;
use archive::unpack_archive;

const RELAUNCH_HELPER_SWITCH: &str = "--rion-internal-update-relaunch-helper";
const PARENT_PID_SWITCH: &str = "--rion-update-parent-pid";
const ATTEMPT_ID_SWITCH: &str = "--rion-update-attempt-id";
const INTERNAL_USER_DATA_DIR_SWITCH: &str = "--rion-update-user-data-dir";
const USER_DATA_DIR_SWITCH: &str = "--user-data-dir";
const RECOVERY_SWITCH: &str = "--rion-internal-update-recovery";
const RECOVERY_ATTEMPT_ID_SWITCH: &str = "--rion-update-recovery-attempt-id";
const RECOVERY_USER_DATA_DIR_SWITCH: &str = "--rion-update-recovery-user-data-dir";
#[cfg(test)]
const PROBE_CHILD_SANDBOX_ENV: &str = "RION_UPDATER_PROBE_CHILD_SANDBOX";
#[cfg(test)]
const PROBE_CHILD_SANDBOX_KIND: &str = "seatbelt-v1";
#[cfg(test)]
const PROBE_INVENTORY_ROOT_ENV: &str = "RION_UPDATER_PROBE_INVENTORY_ROOT";
#[cfg(test)]
const PROBE_RESULT_ENV: &str = "RION_UPDATER_PROBE_RESULT";
#[cfg(test)]
const PROBE_ADMISSION_ACK_ENV: &str = "RION_UPDATER_PROBE_ADMISSION_ACK";
#[cfg(test)]
const PROBE_RESULT_NAME: &str = "macos-helper-handoff.json";
#[cfg(test)]
const PROBE_ADMISSION_ACK_NAME: &str = "macos-helper-admission.ack";
#[cfg(test)]
const PROBE_CONTROL_DIRECTORY_NAME: &str = "probe-control";

#[derive(Default)]
pub(super) struct MacosUpdateInstaller {
    prepared: Mutex<Option<PreparedMacosInstall>>,
    current_executable_override: Option<PathBuf>,
}

#[derive(Clone)]
struct PreparedMacosInstall {
    attempt_id: String,
    target_version: String,
    current_bundle: PathBuf,
    backup_bundle: PathBuf,
    staging_root: PathBuf,
    current_executable: PathBuf,
    user_data_dir: PathBuf,
}

const RELAUNCH_HANDOFF_FILE: &str = "app-update-relaunch-handoff.json";
const RELAUNCH_HANDOFF_SCHEMA_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelaunchHandoffRecord {
    schema_version: u32,
    attempt_id: String,
    target_version: String,
    parent_process_id: u32,
    helper_device: u64,
    helper_inode: u64,
    created_at: String,
}

impl UpdatePlatformInstaller for MacosUpdateInstaller {
    fn prepare(
        &self,
        request: &PlatformInstallRequest,
    ) -> Result<InstallPrepareEvidence, UpdatePlatformInstallError> {
        if request.platform != UpdatePlatform::MacosAarch64 {
            return Err(UpdatePlatformInstallError::PlatformMismatch);
        }
        verify_regular_file(&request.artifact_path)?;
        let current_executable = self.current_executable()?;
        let current_bundle = containing_app_bundle(&current_executable)
            .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
        let parent = current_bundle
            .parent()
            .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
        let identity = attempt_path_identity(&request.attempt.attempt_id);
        let staging_root = parent.join(format!(".rion-update-stage-{identity}"));
        let backup_bundle = parent.join(format!(".rion-update-backup-{identity}.app"));
        if staging_root.exists() || backup_bundle.exists() {
            return Err(UpdatePlatformInstallError::UnsafeArtifact);
        }
        fs::create_dir(&staging_root).map_err(UpdatePlatformInstallError::Io)?;
        let candidate_bundle = match unpack_archive(&request.artifact_path, &staging_root)
            .and_then(|()| exact_staged_bundle(&staging_root))
        {
            Ok(bundle) => bundle,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_root);
                return Err(error);
            }
        };
        if let Err(error) = validate_bundle(&candidate_bundle, &request.attempt.target_version) {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(error);
        }
        let candidate_executable_relative =
            match bundle_executable_relative(&candidate_bundle, &request.attempt.target_version) {
                Ok(relative) => relative,
                Err(error) => {
                    let _ = fs::remove_dir_all(&staging_root);
                    return Err(error);
                }
            };

        if atomic_swap_paths(&current_bundle, &candidate_bundle).is_err() {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(UpdatePlatformInstallError::ReplacementFailed);
        }
        if fs::rename(&candidate_bundle, &backup_bundle).is_err() {
            let _ = atomic_swap_paths(&current_bundle, &candidate_bundle);
            let _ = fs::remove_dir_all(&staging_root);
            return Err(UpdatePlatformInstallError::ReplacementFailed);
        }
        sync_directory(parent)?;
        let replacement_validation =
            validate_bundle(&current_bundle, &request.attempt.target_version);
        let new_executable = current_bundle.join(candidate_executable_relative);
        if replacement_validation.is_err() || verify_regular_file(&new_executable).is_err() {
            rollback_paths(&current_bundle, &backup_bundle, &staging_root)?;
            return Err(replacement_validation
                .err()
                .unwrap_or(UpdatePlatformInstallError::InvalidBundle));
        }
        let prepared = PreparedMacosInstall {
            attempt_id: request.attempt.attempt_id.clone(),
            target_version: request.attempt.target_version.clone(),
            current_bundle,
            backup_bundle,
            staging_root,
            current_executable: new_executable,
            user_data_dir: request.user_data_dir.clone(),
        };
        *self
            .prepared
            .lock()
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)? = Some(prepared);
        Ok(InstallPrepareEvidence {
            attempt_id: request.attempt.attempt_id.clone(),
            target_version: request.attempt.target_version.clone(),
            platform: request.platform.to_string(),
            replacement_applied: true,
        })
    }

    fn rollback(&self, attempt_id: &str) -> Result<(), UpdatePlatformInstallError> {
        let prepared = self
            .prepared
            .lock()
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?
            .take()
            .filter(|prepared| prepared.attempt_id == attempt_id)
            .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
        rollback_paths(
            &prepared.current_bundle,
            &prepared.backup_bundle,
            &prepared.staging_root,
        )
    }

    fn handoff_after_drain(
        &self,
        attempt_id: &str,
        parent_process_id: u32,
    ) -> Result<InstallHandoffEvidence, UpdatePlatformInstallError> {
        let prepared = self
            .prepared
            .lock()
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?
            .as_ref()
            .filter(|prepared| prepared.attempt_id == attempt_id)
            .cloned()
            .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
        let handoff_path = prepared.user_data_dir.join(RELAUNCH_HANDOFF_FILE);
        let (helper_device, helper_inode) = file_identity(&prepared.current_executable)?;
        let handoff = RelaunchHandoffRecord {
            schema_version: RELAUNCH_HANDOFF_SCHEMA_VERSION,
            attempt_id: prepared.attempt_id.clone(),
            target_version: prepared.target_version.clone(),
            parent_process_id,
            helper_device,
            helper_inode,
            created_at: Utc::now().to_rfc3339(),
        };
        let handoff_bytes = serde_json::to_vec(&handoff)
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?;
        crate::persistence::write_private_bytes_atomic(&handoff_path, &handoff_bytes)
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?;
        let helper_arguments = [
            OsString::from(RELAUNCH_HELPER_SWITCH),
            OsString::from(format!("{PARENT_PID_SWITCH}={parent_process_id}")),
            OsString::from(format!("{ATTEMPT_ID_SWITCH}={attempt_id}")),
            path_switch(INTERNAL_USER_DATA_DIR_SWITCH, &prepared.user_data_dir),
            path_switch(USER_DATA_DIR_SWITCH, &prepared.user_data_dir),
        ];
        let child_process_id = match launch_bundle(
            &prepared.current_bundle,
            &prepared.target_version,
            &helper_arguments,
        ) {
            Ok(process_id) => process_id,
            Err(error) => {
                let _ = fs::remove_file(&handoff_path);
                return Err(error);
            }
        };
        Ok(InstallHandoffEvidence {
            attempt_id: prepared.attempt_id,
            target_version: prepared.target_version,
            platform: UpdatePlatform::MacosAarch64.to_string(),
            child_process_id,
        })
    }

    fn finalize_applied(
        &self,
        attempt: &InstallAttemptRecord,
        user_data_dir: &Path,
    ) -> Result<(), UpdatePlatformInstallError> {
        let current_executable = self.current_executable()?;
        let current_bundle = containing_app_bundle(&current_executable)
            .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
        let handoff_path = user_data_dir.join(RELAUNCH_HANDOFF_FILE);
        if handoff_path.exists() {
            let handoff = read_relaunch_handoff(&handoff_path)?;
            validate_relaunch_identity(&handoff, attempt, &current_executable, None)?;
            fs::remove_file(&handoff_path).map_err(UpdatePlatformInstallError::Io)?;
            sync_directory(user_data_dir)?;
        }
        let parent = current_bundle
            .parent()
            .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
        let identity = attempt_path_identity(&attempt.attempt_id);
        let backup = parent.join(format!(".rion-update-backup-{identity}.app"));
        let staging = parent.join(format!(".rion-update-stage-{identity}"));
        if backup.exists() {
            fs::remove_dir_all(&backup).map_err(UpdatePlatformInstallError::Io)?;
        }
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(UpdatePlatformInstallError::Io)?;
        }
        sync_directory(parent)
    }
}

impl MacosUpdateInstaller {
    fn current_executable(&self) -> Result<PathBuf, UpdatePlatformInstallError> {
        self.current_executable_override
            .clone()
            .map_or_else(std::env::current_exe, Ok)
            .map_err(UpdatePlatformInstallError::Io)
    }

    #[cfg(test)]
    fn for_test(current_executable: PathBuf) -> Self {
        Self {
            prepared: Mutex::new(None),
            current_executable_override: Some(current_executable),
        }
    }
}

pub(super) fn run_relaunch_helper(
    user_data_dir: &Path,
    attempt_id: &str,
    current_version: &str,
    parent_process_id: u32,
) -> Result<u32, UpdatePlatformInstallError> {
    if parent_process_id == 0 || parent_process_id == std::process::id() {
        return Err(UpdatePlatformInstallError::HelperParentWaitFailed);
    }
    let journal = read_install_attempt(&user_data_dir.join(INSTALL_JOURNAL_FILE))
        .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?;
    if journal.attempt_id != attempt_id
        || journal.target_version != current_version
        || journal.phase != InstallPhase::RestartPending
    {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    let handoff_path = user_data_dir.join(RELAUNCH_HANDOFF_FILE);
    let handoff = read_relaunch_handoff(&handoff_path)?;
    let executable = std::env::current_exe().map_err(UpdatePlatformInstallError::Io)?;
    validate_relaunch_identity(&handoff, &journal, &executable, Some(parent_process_id))?;
    wait_for_process_exit(parent_process_id)?;
    verify_regular_file(&executable)?;
    let bundle =
        containing_app_bundle(&executable).ok_or(UpdatePlatformInstallError::InvalidBundle)?;
    let child_process_id = launch_bundle(
        &bundle,
        current_version,
        &[
            OsString::from(RECOVERY_SWITCH),
            OsString::from(format!("{RECOVERY_ATTEMPT_ID_SWITCH}={attempt_id}")),
            path_switch(RECOVERY_USER_DATA_DIR_SWITCH, user_data_dir),
            path_switch(USER_DATA_DIR_SWITCH, user_data_dir),
        ],
    )?;
    Ok(child_process_id)
}

pub(super) fn verify_relaunch_target(
    user_data_dir: &Path,
    attempt_id: &str,
    current_version: &str,
) -> Result<(), UpdatePlatformInstallError> {
    let executable = std::env::current_exe().map_err(UpdatePlatformInstallError::Io)?;
    verify_relaunch_target_at(user_data_dir, attempt_id, current_version, &executable)
}

fn verify_relaunch_target_at(
    user_data_dir: &Path,
    attempt_id: &str,
    current_version: &str,
    executable: &Path,
) -> Result<(), UpdatePlatformInstallError> {
    let canonical_user_data =
        fs::canonicalize(user_data_dir).map_err(UpdatePlatformInstallError::Io)?;
    if canonical_user_data != user_data_dir {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    let journal = read_install_attempt(&user_data_dir.join(INSTALL_JOURNAL_FILE))
        .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?;
    if journal.attempt_id != attempt_id
        || journal.target_version != current_version
        || journal.phase != InstallPhase::RestartPending
    {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    let handoff = read_relaunch_handoff(&user_data_dir.join(RELAUNCH_HANDOFF_FILE))?;
    validate_relaunch_identity(&handoff, &journal, executable, None)?;
    let bundle =
        containing_app_bundle(executable).ok_or(UpdatePlatformInstallError::InvalidBundle)?;
    validate_bundle(&bundle, current_version)
}

fn validate_relaunch_identity(
    handoff: &RelaunchHandoffRecord,
    attempt: &InstallAttemptRecord,
    executable: &Path,
    parent_process_id: Option<u32>,
) -> Result<(), UpdatePlatformInstallError> {
    let (helper_device, helper_inode) = file_identity(executable)?;
    if handoff.schema_version != RELAUNCH_HANDOFF_SCHEMA_VERSION
        || handoff.attempt_id != attempt.attempt_id
        || handoff.target_version != attempt.target_version
        || parent_process_id.is_some_and(|expected| handoff.parent_process_id != expected)
        || handoff.helper_device != helper_device
        || handoff.helper_inode != helper_inode
        || chrono::DateTime::parse_from_rfc3339(&handoff.created_at).is_err()
    {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    Ok(())
}

fn path_switch(name: &str, path: &Path) -> OsString {
    let mut value = OsString::from(name);
    value.push("=");
    value.push(path);
    value
}

fn launch_bundle(
    bundle: &Path,
    target_version: &str,
    arguments: &[OsString],
) -> Result<u32, UpdatePlatformInstallError> {
    let executable = bundle.join(bundle_executable_relative(bundle, target_version)?);
    #[cfg(test)]
    let mut command = match std::env::var_os(PROBE_CHILD_SANDBOX_ENV) {
        Some(value) if value == OsStr::new(PROBE_CHILD_SANDBOX_KIND) => {
            let inventory_root = std::env::var_os(PROBE_INVENTORY_ROOT_ENV)
                .map(PathBuf::from)
                .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
            let result_path = std::env::var_os(PROBE_RESULT_ENV)
                .map(PathBuf::from)
                .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
            let admission_ack_path = std::env::var_os(PROBE_ADMISSION_ACK_ENV)
                .map(PathBuf::from)
                .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command
                .arg("-p")
                .arg(updater_probe_child_sandbox_profile(
                    bundle,
                    &inventory_root,
                    &result_path,
                    &admission_ack_path,
                )?)
                .arg(&executable);
            command
        }
        Some(_) => return Err(UpdatePlatformInstallError::StateUnavailable),
        None => Command::new(&executable),
    };
    #[cfg(not(test))]
    let mut command = Command::new(&executable);
    #[cfg(test)]
    command
        .env_remove(PROBE_CHILD_SANDBOX_ENV)
        .env_remove(PROBE_INVENTORY_ROOT_ENV)
        .env_remove(PROBE_RESULT_ENV)
        .env_remove(PROBE_ADMISSION_ACK_ENV);
    let child = command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| UpdatePlatformInstallError::HelperSpawnFailed)?;
    Ok(child.id())
}

#[cfg(test)]
fn updater_probe_child_sandbox_profile(
    bundle: &Path,
    inventory_root: &Path,
    result_path: &Path,
    admission_ack_path: &Path,
) -> Result<String, UpdatePlatformInstallError> {
    let bundle = fs::canonicalize(bundle).map_err(UpdatePlatformInstallError::Io)?;
    let canonical_inventory_root =
        fs::canonicalize(inventory_root).map_err(UpdatePlatformInstallError::Io)?;
    let inventory_metadata =
        fs::symlink_metadata(&canonical_inventory_root).map_err(UpdatePlatformInstallError::Io)?;
    if inventory_root != canonical_inventory_root || !inventory_metadata.is_dir() {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    let result_parent = result_path
        .parent()
        .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
    let canonical_result_parent =
        fs::canonicalize(result_parent).map_err(UpdatePlatformInstallError::Io)?;
    let inventory_fixture_root = canonical_inventory_root
        .parent()
        .and_then(Path::parent)
        .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
    if canonical_inventory_root.file_name() != Some(OsStr::new("process-supervisor"))
        || canonical_inventory_root.parent().and_then(Path::file_name)
            != Some(OsStr::new("native-tools"))
        || result_parent != canonical_result_parent
        || canonical_result_parent != inventory_fixture_root.join(PROBE_CONTROL_DIRECTORY_NAME)
        || result_path != canonical_result_parent.join(PROBE_RESULT_NAME)
        || admission_ack_path != canonical_result_parent.join(PROBE_ADMISSION_ACK_NAME)
        || result_path.exists()
        || admission_ack_path.exists()
    {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    let executable_directory = sandbox_path_literal(&bundle.join("Contents/MacOS"))?;
    let framework_directory = sandbox_path_literal(&bundle.join("Contents/Frameworks"))?;
    let inventory_root = sandbox_path_literal(&canonical_inventory_root)?;
    let control_root = sandbox_path_literal(&canonical_result_parent)?;
    let bundle = sandbox_path_literal(&bundle)?;
    Ok(format!(
        "(version 1)\n\
         (allow default)\n\
         (deny file-write* (subpath {bundle}))\n\
         (deny file-write* (literal {inventory_root}) (subpath {inventory_root}))\n\
         (deny file-write* (literal {control_root}) (subpath {control_root}))\n\
         (deny process-exec*)\n\
         (allow process-exec\n\
           (subpath {executable_directory})\n\
           (subpath {framework_directory}))\n"
    ))
}

#[cfg(test)]
fn sandbox_path_literal(path: &Path) -> Result<String, UpdatePlatformInstallError> {
    let source = path
        .to_str()
        .filter(|value| !value.chars().any(char::is_control))
        .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
    Ok(format!(
        "\"{}\"",
        source.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn exact_staged_bundle(staging_root: &Path) -> Result<PathBuf, UpdatePlatformInstallError> {
    let bundles = fs::read_dir(staging_root)
        .map_err(UpdatePlatformInstallError::Io)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension() == Some(OsStr::new("app")))
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_dir() && !kind.is_symlink())
                .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    match bundles.as_slice() {
        [bundle] => Ok(bundle.clone()),
        _ => Err(UpdatePlatformInstallError::InvalidBundle),
    }
}

fn validate_bundle(bundle: &Path, target_version: &str) -> Result<(), UpdatePlatformInstallError> {
    validate_bundle_layout(bundle, target_version)?;
    let status = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(UpdatePlatformInstallError::Io)?;
    if !status.success() {
        return Err(UpdatePlatformInstallError::InvalidBundleSignature);
    }
    let signature = Command::new("/usr/bin/codesign")
        .args(["--display", "--verbose=4"])
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .map_err(UpdatePlatformInstallError::Io)?;
    if !signature.status.success()
        || !String::from_utf8_lossy(&signature.stderr)
            .lines()
            .any(|line| line == "Signature=adhoc")
    {
        return Err(UpdatePlatformInstallError::InvalidBundleSignature);
    }
    Ok(())
}

fn validate_bundle_layout(
    bundle: &Path,
    target_version: &str,
) -> Result<(), UpdatePlatformInstallError> {
    bundle_executable_relative(bundle, target_version).map(|_| ())
}

fn bundle_executable_relative(
    bundle: &Path,
    target_version: &str,
) -> Result<PathBuf, UpdatePlatformInstallError> {
    let metadata = fs::symlink_metadata(bundle).map_err(UpdatePlatformInstallError::Io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(UpdatePlatformInstallError::InvalidBundle);
    }
    let plist = Value::from_file(bundle.join("Contents/Info.plist"))
        .map_err(|_| UpdatePlatformInstallError::InvalidBundle)?;
    let dictionary = plist
        .as_dictionary()
        .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
    let version = dictionary
        .get("CFBundleShortVersionString")
        .and_then(Value::as_string)
        .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
    let executable = dictionary
        .get("CFBundleExecutable")
        .and_then(Value::as_string)
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .ok_or(UpdatePlatformInstallError::InvalidBundle)?;
    if version != target_version {
        return Err(UpdatePlatformInstallError::InvalidBundle);
    }
    let relative = PathBuf::from("Contents/MacOS").join(executable);
    verify_regular_file(&bundle.join(&relative))?;
    Ok(relative)
}

fn verify_regular_file(path: &Path) -> Result<(), UpdatePlatformInstallError> {
    let metadata = fs::symlink_metadata(path).map_err(UpdatePlatformInstallError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(UpdatePlatformInstallError::UnsafeArtifact);
    }
    Ok(())
}

fn file_identity(path: &Path) -> Result<(u64, u64), UpdatePlatformInstallError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path).map_err(UpdatePlatformInstallError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(UpdatePlatformInstallError::UnsafeArtifact);
    }
    Ok((metadata.dev(), metadata.ino()))
}

fn read_relaunch_handoff(path: &Path) -> Result<RelaunchHandoffRecord, UpdatePlatformInstallError> {
    let metadata = fs::symlink_metadata(path).map_err(UpdatePlatformInstallError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return Err(UpdatePlatformInstallError::StateUnavailable);
    }
    let input = File::open(path).map_err(UpdatePlatformInstallError::Io)?;
    rion_platform::verify_open_file_identity(path, &input)
        .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?;
    serde_json::from_reader(input).map_err(|_| UpdatePlatformInstallError::StateUnavailable)
}

fn containing_app_bundle(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|ancestor| ancestor.extension() == Some(OsStr::new("app")))
        .map(Path::to_path_buf)
}

fn attempt_path_identity(attempt_id: &str) -> String {
    use std::fmt::Write;

    Sha256::digest(attempt_id.as_bytes())[..12].iter().fold(
        String::with_capacity(24),
        |mut output, byte| {
            let _ = write!(output, "{byte:02x}");
            output
        },
    )
}

fn rollback_paths(
    current_bundle: &Path,
    backup_bundle: &Path,
    staging_root: &Path,
) -> Result<(), UpdatePlatformInstallError> {
    if !current_bundle.exists() || !backup_bundle.exists() {
        return Err(UpdatePlatformInstallError::RollbackFailed);
    }
    atomic_swap_paths(current_bundle, backup_bundle)
        .map_err(|_| UpdatePlatformInstallError::RollbackFailed)?;
    sync_directory(
        current_bundle
            .parent()
            .ok_or(UpdatePlatformInstallError::RollbackFailed)?,
    )
    .map_err(|_| UpdatePlatformInstallError::RollbackFailed)?;
    fs::remove_dir_all(backup_bundle).map_err(|_| UpdatePlatformInstallError::RollbackFailed)?;
    if fs::remove_dir_all(staging_root).is_err() {
        return Err(UpdatePlatformInstallError::RollbackFailed);
    }
    sync_directory(
        current_bundle
            .parent()
            .ok_or(UpdatePlatformInstallError::RollbackFailed)?,
    )
    .map_err(|_| UpdatePlatformInstallError::RollbackFailed)
}

fn atomic_swap_paths(first: &Path, second: &Path) -> Result<(), UpdatePlatformInstallError> {
    let first = CString::new(first.as_os_str().as_bytes())
        .map_err(|_| UpdatePlatformInstallError::ReplacementFailed)?;
    let second = CString::new(second.as_os_str().as_bytes())
        .map_err(|_| UpdatePlatformInstallError::ReplacementFailed)?;
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            first.as_ptr(),
            libc::AT_FDCWD,
            second.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(UpdatePlatformInstallError::Io(
            std::io::Error::last_os_error(),
        ))
    }
}

fn sync_directory(path: &Path) -> Result<(), UpdatePlatformInstallError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(UpdatePlatformInstallError::Io)
}

fn wait_for_process_exit(process_id: u32) -> Result<(), UpdatePlatformInstallError> {
    let descriptor = unsafe { libc::kqueue() };
    if descriptor < 0 {
        return Err(UpdatePlatformInstallError::HelperParentWaitFailed);
    }
    let mut event = libc::kevent {
        ident: process_id as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    let registration = unsafe {
        libc::kevent(
            descriptor,
            &raw const event,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    if registration < 0 {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(descriptor) };
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(UpdatePlatformInstallError::HelperParentWaitFailed);
    }
    let observed = unsafe {
        libc::kevent(
            descriptor,
            std::ptr::null(),
            0,
            &raw mut event,
            1,
            std::ptr::null(),
        )
    };
    unsafe { libc::close(descriptor) };
    if observed == 1 && event.fflags & libc::NOTE_EXIT != 0 {
        Ok(())
    } else {
        Err(UpdatePlatformInstallError::HelperParentWaitFailed)
    }
}

#[cfg(test)]
#[path = "macos/tests.rs"]
mod tests;
