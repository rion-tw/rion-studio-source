use super::*;
use flate2::{Compression, write::GzEncoder};
use std::io::Write;
use std::os::unix::fs::symlink;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::sync::Arc;
use std::time::{Duration, Instant};

use semver::Version;
use url::Url;

use crate::{
    ChromiumUpdateManager, ChromiumUpdateManagerConfig, UpdateManagerError,
    package_probe::FixtureTransport,
    persistence::{write_install_journal, write_private_bytes_atomic},
};

fn install_attempt(version: &str) -> InstallAttemptRecord {
    InstallAttemptRecord {
        attempt_id: format!("update-install-real-app-{}", uuid::Uuid::new_v4()),
        target_version: version.to_owned(),
        phase: InstallPhase::Accepted,
        started_at: "2026-08-30T00:00:00Z".to_owned(),
        updated_at: "2026-08-30T00:00:00Z".to_owned(),
        failure_code: None,
    }
}

fn create_ad_hoc_test_bundle(bundle: &Path, version: &str) -> PathBuf {
    create_ad_hoc_test_bundle_named(bundle, version, "Rion Studio")
}

fn create_ad_hoc_test_bundle_named(bundle: &Path, version: &str, name: &str) -> PathBuf {
    let executable = bundle.join("Contents/MacOS").join(name);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::copy("/usr/bin/true", &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let mut dictionary = plist::Dictionary::new();
    dictionary.insert(
        "CFBundleIdentifier".to_owned(),
        Value::String("studio.rion.updater-test".to_owned()),
    );
    dictionary.insert(
        "CFBundleShortVersionString".to_owned(),
        Value::String(version.to_owned()),
    );
    dictionary.insert(
        "CFBundleVersion".to_owned(),
        Value::String(version.to_owned()),
    );
    dictionary.insert(
        "CFBundleExecutable".to_owned(),
        Value::String(name.to_owned()),
    );
    Value::Dictionary(dictionary)
        .to_file_xml(bundle.join("Contents/Info.plist"))
        .unwrap();
    let status = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-", "--timestamp=none"])
        .arg(bundle)
        .status()
        .unwrap();
    assert!(status.success());
    validate_bundle(bundle, version).unwrap();
    executable
}

fn archive_test_bundle(bundle: &Path, archive_path: &Path) {
    let output = File::create(archive_path).unwrap();
    let encoder = GzEncoder::new(output, Compression::default());
    let mut archive = tar::Builder::new(encoder);
    archive
        .append_dir_all(bundle.file_name().unwrap(), bundle)
        .unwrap();
    archive
        .into_inner()
        .unwrap()
        .finish()
        .unwrap()
        .sync_all()
        .unwrap();
}

fn real_install_fixture() -> (
    tempfile::TempDir,
    MacosUpdateInstaller,
    PlatformInstallRequest,
    PathBuf,
) {
    let directory = tempfile::tempdir().unwrap();
    let current_bundle = directory.path().join("Rion Studio.app");
    let current_executable = create_ad_hoc_test_bundle(&current_bundle, "22.9.0");
    let candidate_bundle = directory.path().join("candidate/Rion Studio.app");
    create_ad_hoc_test_bundle(&candidate_bundle, "23.0.0");
    let archive_path = directory.path().join("Rion-Studio.app.tar.gz");
    archive_test_bundle(&candidate_bundle, &archive_path);
    let attempt = install_attempt("23.0.0");
    let request = PlatformInstallRequest {
        attempt,
        platform: UpdatePlatform::MacosAarch64,
        artifact_path: archive_path,
        user_data_dir: directory.path().join("user-data"),
    };
    (
        directory,
        MacosUpdateInstaller::for_test(current_executable),
        request,
        current_bundle,
    )
}

#[test]
fn validates_the_exact_bundle_version_and_executable_identity() {
    let directory = tempfile::tempdir().unwrap();
    let bundle = directory.path().join("Rion Studio.app");
    fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
    fs::write(bundle.join("Contents/MacOS/Rion Studio"), b"binary").unwrap();
    let mut dictionary = plist::Dictionary::new();
    dictionary.insert(
        "CFBundleShortVersionString".to_owned(),
        Value::String("23.0.0".to_owned()),
    );
    dictionary.insert(
        "CFBundleExecutable".to_owned(),
        Value::String("Rion Studio".to_owned()),
    );
    Value::Dictionary(dictionary)
        .to_file_xml(bundle.join("Contents/Info.plist"))
        .unwrap();
    assert!(validate_bundle_layout(&bundle, "23.0.0").is_ok());
    assert!(validate_bundle_layout(&bundle, "23.0.1").is_err());
}

#[test]
fn launches_the_verified_bundle_executable_and_returns_its_live_process_id() {
    let directory = tempfile::tempdir().unwrap();
    let bundle = directory.path().join("Rion Studio.app");
    let executable = create_ad_hoc_test_bundle(&bundle, "23.0.0");
    fs::copy("/bin/sleep", &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let status = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-", "--timestamp=none"])
        .arg(&bundle)
        .status()
        .unwrap();
    assert!(status.success());
    validate_bundle(&bundle, "23.0.0").unwrap();

    let process_id = launch_bundle(&bundle, "23.0.0", &[OsString::from("30")]).unwrap();
    assert_ne!(process_id, std::process::id());
    let process_id = i32::try_from(process_id).unwrap();
    assert_eq!(unsafe { libc::kill(process_id, 0) }, 0);
    assert_eq!(unsafe { libc::kill(process_id, libc::SIGTERM) }, 0);
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(process_id, &mut status, 0) },
        process_id
    );
}

#[test]
fn updater_probe_child_sandbox_allows_only_bundle_execution_and_denies_bundle_writes() {
    let directory = tempfile::tempdir().unwrap();
    let bundle = directory.path().join("Rion Studio.app");
    let executable = create_ad_hoc_test_bundle(&bundle, "23.0.0");
    let inventory_root = directory.path().join("native-tools/process-supervisor");
    fs::create_dir_all(&inventory_root).unwrap();
    let inventory_root = fs::canonicalize(inventory_root).unwrap();
    let fixture_root = fs::canonicalize(directory.path()).unwrap();
    assert!(
        updater_probe_child_sandbox_profile(
            &bundle,
            &inventory_root,
            &fixture_root.join(PROBE_RESULT_NAME),
            &fixture_root.join(PROBE_ADMISSION_ACK_NAME),
        )
        .is_err()
    );
    let control_root = fixture_root.join(PROBE_CONTROL_DIRECTORY_NAME);
    fs::create_dir(&control_root).unwrap();
    let result_path = control_root.join(PROBE_RESULT_NAME);
    let admission_ack_path = control_root.join(PROBE_ADMISSION_ACK_NAME);
    let profile = updater_probe_child_sandbox_profile(
        &bundle,
        &inventory_root,
        &result_path,
        &admission_ack_path,
    )
    .unwrap();
    assert!(profile.contains("(deny process-exec*)"));
    assert!(profile.contains("(deny file-write*"));
    assert!(profile.contains(inventory_root.to_str().unwrap()));

    let allowed = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile])
        .arg(&executable)
        .status()
        .unwrap();
    assert!(allowed.success());
    let external = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile, "/usr/bin/true"])
        .status()
        .unwrap();
    assert!(!external.success());

    fs::copy("/usr/bin/touch", &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let forbidden_write = bundle.join("forbidden-write");
    let write_attempt = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile])
        .arg(&executable)
        .arg(&forbidden_write)
        .status()
        .unwrap();
    assert!(!write_attempt.success());
    assert!(!forbidden_write.exists());

    let forbidden_inventory_write = inventory_root.join("mutated-after-admission");
    let inventory_write_attempt = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile])
        .arg(&executable)
        .arg(&forbidden_inventory_write)
        .status()
        .unwrap();
    assert!(!inventory_write_attempt.success());
    assert!(!forbidden_inventory_write.exists());
    for protected_publication in [&result_path, &admission_ack_path] {
        let publication_write_attempt = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile])
            .arg(&executable)
            .arg(protected_publication)
            .status()
            .unwrap();
        assert!(!publication_write_attempt.success());
        assert!(!protected_publication.exists());
    }
}

#[test]
fn nested_sandbox_exec_preserves_the_verified_bundle_process_id() {
    let directory = tempfile::tempdir().unwrap();
    let bundle = directory.path().join("Rion Studio.app");
    let executable = create_ad_hoc_test_bundle(&bundle, "23.0.0");
    fs::copy("/bin/sleep", &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let status = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-", "--timestamp=none"])
        .arg(&bundle)
        .status()
        .unwrap();
    assert!(status.success());
    let inventory_root = directory.path().join("native-tools/process-supervisor");
    fs::create_dir_all(&inventory_root).unwrap();
    let inventory_root = fs::canonicalize(inventory_root).unwrap();
    let fixture_root = fs::canonicalize(directory.path()).unwrap();
    let control_root = fixture_root.join(PROBE_CONTROL_DIRECTORY_NAME);
    fs::create_dir(&control_root).unwrap();
    let profile = updater_probe_child_sandbox_profile(
        &bundle,
        &inventory_root,
        &control_root.join(PROBE_RESULT_NAME),
        &control_root.join(PROBE_ADMISSION_ACK_NAME),
    )
    .unwrap();
    let mut child = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile])
        .arg(&executable)
        .arg("30")
        .spawn()
        .unwrap();
    let process_id = child.id().to_string();
    let deadline = Instant::now() + Duration::from_secs(5);
    let observed_command = loop {
        let output = Command::new("/bin/ps")
            .args(["-p", &process_id, "-o", "command="])
            .output()
            .unwrap();
        let command = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if command.starts_with(executable.to_str().unwrap()) {
            break command;
        }
        assert!(
            Instant::now() < deadline,
            "sandbox-exec did not exec the bundle target"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(observed_command.starts_with(executable.to_str().unwrap()));
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn attempt_paths_use_a_fixed_non_secret_digest() {
    let first = attempt_path_identity("update-install-one");
    assert_eq!(first.len(), 24);
    assert_eq!(first, attempt_path_identity("update-install-one"));
    assert_ne!(first, attempt_path_identity("update-install-two"));
}

#[test]
fn atomically_replaces_a_real_ad_hoc_bundle_and_rolls_back() {
    let (_directory, installer, request, current_bundle) = real_install_fixture();
    installer.prepare(&request).unwrap();
    validate_bundle(&current_bundle, "23.0.0").unwrap();
    installer.rollback(&request.attempt.attempt_id).unwrap();
    validate_bundle(&current_bundle, "22.9.0").unwrap();
    assert_transaction_paths_removed(&current_bundle, &request.attempt.attempt_id);
}

#[test]
fn replacement_allows_the_verified_target_to_change_runtime_executable_name() {
    let directory = tempfile::tempdir().unwrap();
    let current_bundle = directory.path().join("Rion Studio.app");
    let current_executable =
        create_ad_hoc_test_bundle_named(&current_bundle, "22.9.0", "rion-tauri");
    let candidate_bundle = directory.path().join("candidate/Rion Studio.app");
    create_ad_hoc_test_bundle(&candidate_bundle, "23.0.0");
    let artifact_path = directory.path().join("Rion-Studio.app.tar.gz");
    archive_test_bundle(&candidate_bundle, &artifact_path);
    let request = PlatformInstallRequest {
        attempt: install_attempt("23.0.0"),
        platform: UpdatePlatform::MacosAarch64,
        artifact_path,
        user_data_dir: directory.path().join("user-data"),
    };
    let installer = MacosUpdateInstaller::for_test(current_executable);

    installer.prepare(&request).unwrap();
    validate_bundle(&current_bundle, "23.0.0").unwrap();
    assert!(current_bundle.join("Contents/MacOS/Rion Studio").is_file());
    assert!(!current_bundle.join("Contents/MacOS/rion-tauri").exists());
    installer.rollback(&request.attempt.attempt_id).unwrap();
    assert!(current_bundle.join("Contents/MacOS/rion-tauri").is_file());
}

#[test]
fn first_target_boot_finalizes_a_crash_resumable_real_replacement() {
    let (_directory, installer, request, current_bundle) = real_install_fixture();
    installer.prepare(&request).unwrap();
    validate_bundle(&current_bundle, "23.0.0").unwrap();
    let recovery_installer =
        MacosUpdateInstaller::for_test(current_bundle.join("Contents/MacOS/Rion Studio"));
    let mut applied = request.attempt.clone();
    applied.phase = InstallPhase::Applied;
    recovery_installer
        .finalize_applied(&applied, &request.user_data_dir)
        .unwrap();
    validate_bundle(&current_bundle, "23.0.0").unwrap();
    assert_transaction_paths_removed(&current_bundle, &request.attempt.attempt_id);
}

#[test]
fn recovery_locator_requires_the_exact_canonical_journal_and_handoff() {
    let directory = tempfile::tempdir().unwrap();
    let canonical_root = fs::canonicalize(directory.path()).unwrap();
    let current_bundle = canonical_root.join("Rion Studio.app");
    let executable = create_ad_hoc_test_bundle(&current_bundle, "23.0.0");
    let user_data = canonical_root.join("user-data");
    fs::create_dir(&user_data).unwrap();
    let mut attempt = install_attempt("23.0.0");
    attempt.phase = InstallPhase::RestartPending;
    write_install_journal(&user_data.join(crate::INSTALL_JOURNAL_FILE), &attempt).unwrap();
    let (helper_device, helper_inode) = file_identity(&executable).unwrap();
    let handoff = RelaunchHandoffRecord {
        schema_version: RELAUNCH_HANDOFF_SCHEMA_VERSION,
        attempt_id: attempt.attempt_id.clone(),
        target_version: attempt.target_version.clone(),
        parent_process_id: 42,
        helper_device,
        helper_inode,
        created_at: "2026-08-30T00:00:00Z".to_owned(),
    };
    write_private_bytes_atomic(
        &user_data.join(RELAUNCH_HANDOFF_FILE),
        &serde_json::to_vec(&handoff).unwrap(),
    )
    .unwrap();

    verify_relaunch_target_at(
        &user_data,
        &attempt.attempt_id,
        &attempt.target_version,
        &executable,
    )
    .unwrap();
    assert!(
        verify_relaunch_target_at(
            &user_data,
            "update-install-00000000-0000-0000-0000-000000000000",
            &attempt.target_version,
            &executable,
        )
        .is_err()
    );
    let alias = canonical_root.join("user-data-alias");
    symlink(&user_data, &alias).unwrap();
    assert!(
        verify_relaunch_target_at(
            &alias,
            &attempt.attempt_id,
            &attempt.target_version,
            &executable,
        )
        .is_err()
    );

    MacosUpdateInstaller::for_test(executable)
        .finalize_applied(&attempt, &user_data)
        .unwrap();
    assert!(!user_data.join(RELAUNCH_HANDOFF_FILE).exists());
}

fn assert_transaction_paths_removed(current_bundle: &Path, attempt_id: &str) {
    let identity = attempt_path_identity(attempt_id);
    assert!(
        !current_bundle
            .parent()
            .unwrap()
            .join(format!(".rion-update-backup-{identity}.app"))
            .exists()
    );
    assert!(
        !current_bundle
            .parent()
            .unwrap()
            .join(format!(".rion-update-stage-{identity}"))
            .exists()
    );
}

#[test]
#[ignore = "requires a real packaged Electron .app and CI-generated Minisign fixture"]
fn packaged_macos_updater_transaction_probe() {
    let source_app = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_APP"));
    let artifact = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_ARTIFACT"));
    let companion = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_COMPANION"));
    let manifest = fs::read(required_probe_value("RION_UPDATER_PROBE_MANIFEST")).unwrap();
    let public_key = required_probe_value("RION_UPDATER_PROBE_PUBLIC_KEY");
    let result_path = PathBuf::from(required_probe_value(
        "RION_UPDATER_PROBE_TRANSACTION_RESULT",
    ));
    let target_version = required_probe_value("RION_UPDATER_PROBE_VERSION");
    let previous_versions = previous_probe_versions(&target_version);

    for current_version in &previous_versions {
        run_packaged_crash_recovery(
            &source_app,
            &artifact,
            &manifest,
            &public_key,
            current_version,
            &target_version,
        );
    }
    run_packaged_rollback(
        &source_app,
        &artifact,
        &manifest,
        &public_key,
        previous_versions.last().unwrap(),
        &target_version,
    );
    reject_signed_wrong_platform_payload(
        &source_app,
        &companion,
        &manifest,
        &public_key,
        previous_versions.first().unwrap(),
        &target_version,
    );
    let cases = previous_versions
        .iter()
        .map(|source_version| {
            serde_json::json!({
                "outcome": "applied",
                "probe": "macos-bundle-replacement",
                "sourceRuntime": "electron-v23",
                "sourceVersion": source_version,
                "targetVersion": target_version
            })
        })
        .collect::<Vec<_>>();
    let result_bytes = serde_json::to_vec(&serde_json::json!({ "cases": cases })).unwrap();
    write_probe_result_create_new(&result_path, &result_bytes);
}

#[test]
#[ignore = "requires a real packaged Electron .app and CI-generated Minisign fixture"]
fn packaged_macos_helper_handoff_probe() {
    let previous_app = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_PREVIOUS_APP"));
    let artifact = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_ARTIFACT"));
    let manifest = fs::read(required_probe_value("RION_UPDATER_PROBE_MANIFEST")).unwrap();
    let public_key = required_probe_value("RION_UPDATER_PROBE_PUBLIC_KEY");
    let result_path = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_RESULT"));
    let admission_ack_path =
        PathBuf::from(required_probe_value("RION_UPDATER_PROBE_ADMISSION_ACK"));
    assert_eq!(admission_ack_path.parent(), result_path.parent());
    assert!(!admission_ack_path.exists());
    let control_root = result_path.parent().unwrap();
    assert_eq!(
        control_root.file_name(),
        Some(OsStr::new(PROBE_CONTROL_DIRECTORY_NAME))
    );
    let fixture_root = control_root.parent().unwrap();
    let target_version = required_probe_value("RION_UPDATER_PROBE_VERSION");
    let current_version = previous_probe_versions(&target_version).remove(0);
    let directory = tempfile::Builder::new()
        .prefix("rion-packaged-updater-handoff-")
        .tempdir_in(fixture_root)
        .unwrap()
        .keep();
    let current_app = directory.join("installed/Rion Studio.app");
    copy_exact_packaged_app(&previous_app, &current_app, &current_version);
    let current_executable =
        current_app.join(bundle_executable_relative(&current_app, &current_version).unwrap());
    assert_eq!(
        current_executable.file_name(),
        Some(OsStr::new("rion-tauri")),
        "the helper source must be the exact published Tauri v22 executable"
    );
    assert!(
        !current_app.join("Contents/Resources/app.asar").exists(),
        "the helper source must not be a relabelled Electron bundle"
    );
    let user_data = directory.join("user-data");
    fs::create_dir_all(&user_data).unwrap();
    fs::write(user_data.join("preserved-user-data-marker"), b"preserve").unwrap();
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: user_data.clone(),
            current_version: Version::parse(&current_version).unwrap(),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key,
        },
        Arc::new(FixtureTransport::new(manifest, artifact)),
        Arc::new(MacosUpdateInstaller::for_test(current_executable)),
    )
    .unwrap();
    assert_eq!(
        manager.check_for_updates().unwrap().status.state,
        "downloaded"
    );
    let accepted = manager.accept_install().unwrap();
    manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap();
    manager
        .begin_install_drain(&accepted.attempt.attempt_id)
        .unwrap();
    let handoff = manager
        .handoff_install_after_drain(&accepted.attempt.attempt_id, std::process::id())
        .unwrap();
    let result_bytes = serde_json::to_vec(&serde_json::json!({
        "attemptId": accepted.attempt.attempt_id,
        "currentApp": current_app,
        "helperProcessId": handoff.evidence.child_process_id,
        "journal": user_data.join(crate::INSTALL_JOURNAL_FILE),
        "marker": user_data.join("preserved-user-data-marker"),
        "sourceRuntime": "tauri-v22",
        "sourceVersion": current_version,
        "targetVersion": target_version,
        "userData": user_data
    }))
    .unwrap();
    write_probe_result_create_new(&result_path, &result_bytes);
    wait_for_probe_admission_ack(
        &admission_ack_path,
        &format!("{}\n", accepted.attempt.attempt_id),
    );
}

fn write_probe_result_create_new(path: &Path, source: &[u8]) {
    let parent = path.parent().unwrap();
    let temporary = parent.join(format!(
        ".macos-helper-handoff.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        output.write_all(source)?;
        output.sync_all()?;
        drop(output);
        fs::hard_link(&temporary, path)?;
        fs::remove_file(&temporary)?;
        sync_directory(parent).map_err(|error| match error {
            UpdatePlatformInstallError::Io(error) => error,
            _ => std::io::Error::other("failed to sync updater probe result directory"),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.unwrap();
}

fn wait_for_probe_admission_ack(path: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match fs::read(path) {
            Ok(source) => {
                assert_eq!(source, expected.as_bytes());
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for exact updater probe admission acknowledgement"
                );
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!("failed to read updater probe admission acknowledgement: {error}"),
        }
    }
}

fn run_packaged_rollback(
    source_app: &Path,
    artifact: &Path,
    manifest: &[u8],
    public_key: &str,
    current_version: &str,
    target_version: &str,
) {
    let directory = tempfile::tempdir().unwrap();
    let current_app = directory.path().join("installed/Rion Studio.app");
    copy_and_resign_packaged_app(source_app, &current_app, current_version);
    let installer = Arc::new(MacosUpdateInstaller::for_test(
        current_app.join("Contents/MacOS/Rion Studio"),
    ));
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().join("user-data"),
            current_version: Version::parse(current_version).unwrap(),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key.to_owned(),
        },
        Arc::new(FixtureTransport::new(
            manifest.to_vec(),
            artifact.to_path_buf(),
        )),
        installer.clone(),
    )
    .unwrap();
    assert_eq!(
        manager.check_for_updates().unwrap().status.state,
        "downloaded"
    );
    let accepted = manager.accept_install().unwrap();
    manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap();
    validate_bundle(&current_app, target_version).unwrap();
    installer.rollback(&accepted.attempt.attempt_id).unwrap();
    validate_bundle(&current_app, current_version).unwrap();
    assert_transaction_paths_removed(&current_app, &accepted.attempt.attempt_id);
}

fn run_packaged_crash_recovery(
    source_app: &Path,
    artifact: &Path,
    manifest: &[u8],
    public_key: &str,
    current_version: &str,
    target_version: &str,
) {
    let directory = tempfile::tempdir().unwrap();
    let current_app = directory.path().join("installed/Rion Studio.app");
    copy_and_resign_packaged_app(source_app, &current_app, current_version);
    let executable = current_app.join("Contents/MacOS/Rion Studio");
    let user_data = directory.path().join("user-data");
    let installer = Arc::new(MacosUpdateInstaller::for_test(executable));
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: user_data.clone(),
            current_version: Version::parse(current_version).unwrap(),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key.to_owned(),
        },
        Arc::new(FixtureTransport::new(
            manifest.to_vec(),
            artifact.to_path_buf(),
        )),
        installer.clone(),
    )
    .unwrap();
    assert_eq!(
        manager.check_for_updates().unwrap().status.state,
        "downloaded"
    );
    let accepted = manager.accept_install().unwrap();
    manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap();
    validate_bundle(&current_app, target_version).unwrap();
    manager
        .begin_install_drain(&accepted.attempt.attempt_id)
        .unwrap();
    drop(manager);

    let recovery = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: user_data.clone(),
            current_version: Version::parse(target_version).unwrap(),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key.to_owned(),
        },
        Arc::new(FixtureTransport::new(
            manifest.to_vec(),
            artifact.to_path_buf(),
        )),
        Arc::new(MacosUpdateInstaller::for_test(
            current_app.join("Contents/MacOS/Rion Studio"),
        )),
    )
    .unwrap();
    let status = recovery.status().unwrap();
    assert_eq!(status.status.state, "idle");
    assert_eq!(
        status
            .status
            .install_attempt
            .as_ref()
            .map(|attempt| attempt.phase),
        Some(InstallPhase::Applied)
    );
    assert!(!user_data.join("app-updates/pending").exists());
    assert_transaction_paths_removed(&current_app, &accepted.attempt.attempt_id);
}

fn reject_signed_wrong_platform_payload(
    source_app: &Path,
    companion: &Path,
    manifest: &[u8],
    public_key: &str,
    current_version: &str,
    target_version: &str,
) {
    let directory = tempfile::tempdir().unwrap();
    let current_app = directory.path().join("installed/Rion Studio.app");
    copy_and_resign_packaged_app(source_app, &current_app, current_version);
    let user_data = directory.path().join("user-data");
    let wrong_manifest = swap_manifest_platforms(manifest);
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: user_data,
            current_version: Version::parse(current_version).unwrap(),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key.to_owned(),
        },
        Arc::new(FixtureTransport::new(
            wrong_manifest,
            companion.to_path_buf(),
        )),
        Arc::new(MacosUpdateInstaller::for_test(
            current_app.join("Contents/MacOS/Rion Studio"),
        )),
    )
    .unwrap();
    assert_eq!(
        manager.check_for_updates().unwrap().status.state,
        "downloaded"
    );
    let accepted = manager.accept_install().unwrap();
    let error = manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap_err();
    assert!(matches!(
        error,
        UpdateManagerError::PlatformInstall(UpdatePlatformInstallError::InvalidArchive)
    ));
    assert_eq!(accepted.attempt.target_version, target_version);
    validate_bundle(&current_app, current_version).unwrap();
}

fn copy_and_resign_packaged_app(source: &Path, destination: &Path, version: &str) {
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    let status = Command::new("/usr/bin/ditto")
        .arg(source)
        .arg(destination)
        .status()
        .unwrap();
    assert!(status.success());
    let plist_path = destination.join("Contents/Info.plist");
    let mut plist = Value::from_file(&plist_path).unwrap();
    let dictionary = plist.as_dictionary_mut().unwrap();
    dictionary.insert(
        "CFBundleShortVersionString".to_owned(),
        Value::String(version.to_owned()),
    );
    dictionary.insert(
        "CFBundleVersion".to_owned(),
        Value::String(version.to_owned()),
    );
    plist.to_file_xml(&plist_path).unwrap();
    let status = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-", "--timestamp=none"])
        .arg(destination)
        .status()
        .unwrap();
    assert!(status.success());
    validate_bundle(destination, version).unwrap();
}

fn copy_exact_packaged_app(source: &Path, destination: &Path, version: &str) {
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    let status = Command::new("/usr/bin/ditto")
        .arg(source)
        .arg(destination)
        .status()
        .unwrap();
    assert!(status.success());
    validate_bundle(destination, version).unwrap();
}

fn swap_manifest_platforms(manifest: &[u8]) -> Vec<u8> {
    let mut manifest: serde_json::Value = serde_json::from_slice(manifest).unwrap();
    let mac = manifest["platforms"]["darwin-aarch64"].take();
    let windows = manifest["platforms"]["windows-x86_64"].take();
    manifest["platforms"]["darwin-aarch64"] = windows;
    manifest["platforms"]["windows-x86_64"] = mac;
    serde_json::to_vec(&manifest).unwrap()
}

fn required_probe_value(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn previous_probe_versions(target_version: &str) -> Vec<String> {
    let values = std::env::var("RION_UPDATER_PROBE_PREVIOUS_VERSIONS")
        .unwrap_or_else(|_| "22.9.0,23.0.0".to_owned())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let target = Version::parse(target_version).unwrap();
    assert!(!values.is_empty());
    assert!(
        values
            .iter()
            .all(|value| Version::parse(value).is_ok_and(|version| version < target))
    );
    values
}
