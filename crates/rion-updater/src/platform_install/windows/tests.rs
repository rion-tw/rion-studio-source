use super::*;
use std::io::Write;
use std::sync::Arc;

use semver::Version;
use url::Url;

use crate::{
    ChromiumUpdateManager, ChromiumUpdateManagerConfig, UpdateManagerError,
    package_probe::FixtureTransport,
};

#[test]
fn accepts_only_structurally_valid_windows_pe_executables() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("installer.exe");
    let mut image = vec![0_u8; 256];
    image[..2].copy_from_slice(b"MZ");
    image[0x3c..0x40].copy_from_slice(&128_u32.to_le_bytes());
    image[128..132].copy_from_slice(b"PE\0\0");
    image[132..134].copy_from_slice(&0x8664_u16.to_le_bytes());
    image[150..152].copy_from_slice(&0x0002_u16.to_le_bytes());
    image[152..154].copy_from_slice(&0x020b_u16.to_le_bytes());
    File::create(&path).unwrap().write_all(&image).unwrap();
    assert!(validate_windows_pe_installer(&path, image.len() as u64).is_ok());

    image[132..134].copy_from_slice(&0x014c_u16.to_le_bytes());
    image[152..154].copy_from_slice(&0x010b_u16.to_le_bytes());
    File::create(&path).unwrap().write_all(&image).unwrap();
    assert!(validate_windows_pe_installer(&path, image.len() as u64).is_ok());

    File::create(&path).unwrap().write_all(b"not-a-pe").unwrap();
    assert!(validate_windows_pe_installer(&path, 8).is_err());
}

#[test]
#[ignore = "requires real packaged NSIS and a CI-generated Minisign fixture"]
fn packaged_windows_updater_transaction_probe() {
    let artifact = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_ARTIFACT"));
    let companion = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_COMPANION"));
    let manifest = fs::read(required_probe_value("RION_UPDATER_PROBE_MANIFEST")).unwrap();
    let public_key = required_probe_value("RION_UPDATER_PROBE_PUBLIC_KEY");
    let current_version = required_probe_value("RION_UPDATER_PROBE_CURRENT_VERSION");
    let user_data = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_USER_DATA"));
    let result_path = PathBuf::from(required_probe_value("RION_UPDATER_PROBE_RESULT"));

    reject_signed_wrong_platform_payload(
        &companion,
        &manifest,
        &public_key,
        &current_version,
        &user_data,
    );

    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: user_data,
            current_version: Version::parse(&current_version).unwrap(),
            platform: UpdatePlatform::WindowsX86_64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key,
        },
        Arc::new(FixtureTransport::new(manifest, artifact)),
        Arc::new(WindowsUpdateInstaller::default()),
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
    fs::write(result_path, handoff.evidence.child_process_id.to_string()).unwrap();
}

fn reject_signed_wrong_platform_payload(
    companion: &std::path::Path,
    manifest: &[u8],
    public_key: &str,
    current_version: &str,
    user_data: &std::path::Path,
) {
    let wrong_manifest = swap_manifest_platforms(manifest);
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: user_data.join("wrong-platform"),
            current_version: Version::parse(current_version).unwrap(),
            platform: UpdatePlatform::WindowsX86_64,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key.to_owned(),
        },
        Arc::new(FixtureTransport::new(
            wrong_manifest,
            companion.to_path_buf(),
        )),
        Arc::new(WindowsUpdateInstaller::default()),
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
        UpdateManagerError::PlatformInstall(UpdatePlatformInstallError::UnsafeArtifact)
    ));
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
