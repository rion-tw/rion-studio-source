use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::Version;
use url::Url;

use crate::{
    ChromiumUpdateManager, ChromiumUpdateManagerConfig, InstallHandoffEvidence,
    InstallPrepareEvidence, PlatformInstallRequest, UpdateManagerError, UpdatePlatform,
    UpdatePlatformInstallError, UpdatePlatformInstaller, UpdateTransport, UpdateTransportError,
};

#[derive(Default)]
struct RejectingInstaller;

impl UpdatePlatformInstaller for RejectingInstaller {
    fn prepare(
        &self,
        _request: &PlatformInstallRequest,
    ) -> Result<InstallPrepareEvidence, UpdatePlatformInstallError> {
        Err(UpdatePlatformInstallError::Unsupported)
    }

    fn rollback(&self, _attempt_id: &str) -> Result<(), UpdatePlatformInstallError> {
        Err(UpdatePlatformInstallError::Unsupported)
    }

    fn handoff_after_drain(
        &self,
        _attempt_id: &str,
        _parent_process_id: u32,
    ) -> Result<InstallHandoffEvidence, UpdatePlatformInstallError> {
        Err(UpdatePlatformInstallError::Unsupported)
    }
}

pub(crate) struct FixtureTransport {
    manifest: Vec<u8>,
    artifact: PathBuf,
    downloads: AtomicUsize,
}

impl FixtureTransport {
    pub(crate) fn new(manifest: Vec<u8>, artifact: PathBuf) -> Self {
        Self {
            manifest,
            artifact,
            downloads: AtomicUsize::new(0),
        }
    }
}

impl UpdateTransport for FixtureTransport {
    fn fetch_manifest(&self, _endpoint: &Url) -> Result<Vec<u8>, UpdateTransportError> {
        Ok(self.manifest.clone())
    }

    fn download_artifact(
        &self,
        _url: &Url,
        destination: &Path,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<u64, UpdateTransportError> {
        self.downloads.fetch_add(1, Ordering::AcqRel);
        let expected = fs::metadata(&self.artifact)
            .map_err(UpdateTransportError::Io)?
            .len();
        let mut input = fs::File::open(&self.artifact).map_err(UpdateTransportError::Io)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(UpdateTransportError::Io)?;
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input.read(&mut buffer).map_err(UpdateTransportError::Io)?;
            if read == 0 {
                break;
            }
            copied = copied.saturating_add(read as u64);
            output
                .write_all(&buffer[..read])
                .map_err(UpdateTransportError::Io)?;
            progress(copied, Some(expected));
        }
        output.sync_all().map_err(UpdateTransportError::Io)?;
        Ok(copied)
    }
}

#[test]
#[ignore = "requires a CI-generated ephemeral Minisign key and a real packaged artifact"]
fn packaged_artifact_manifest_fail_closed_probe() {
    let manifest_path = required_path("RION_UPDATER_PROBE_MANIFEST");
    let artifact_path = required_path("RION_UPDATER_PROBE_ARTIFACT");
    let public_key = required_value("RION_UPDATER_PROBE_PUBLIC_KEY");
    let target_version = required_value("RION_UPDATER_PROBE_VERSION");
    let prior_version = probe_prior_version(&target_version);
    let platform = probe_platform();
    let manifest = fs::read(&manifest_path).unwrap();

    let valid = run_check(
        manifest.clone(),
        artifact_path.clone(),
        &public_key,
        platform,
        &prior_version,
    );
    assert_eq!(valid.status.state, "downloaded");
    assert_eq!(
        valid.status.available_version.as_deref(),
        Some(target_version.as_str())
    );

    let wrong_hash = mutate_platform_field(&manifest, platform, "sha256", |value| {
        if value.starts_with('0') {
            value.replace_range(..1, "1");
        } else {
            value.replace_range(..1, "0");
        }
    });
    let rejected_hash = run_check(
        wrong_hash,
        artifact_path.clone(),
        &public_key,
        platform,
        &prior_version,
    );
    assert_eq!(
        rejected_hash.status.error_code.as_deref(),
        Some("UPDATE_ARTIFACT_SHA256_MISMATCH")
    );

    let bad_signature = mutate_platform_field(&manifest, platform, "signature", |value| {
        let encoded = !value.contains('\n');
        let mut signature_file = if encoded {
            String::from_utf8(STANDARD.decode(value.as_bytes()).unwrap()).unwrap()
        } else {
            value.clone()
        };
        let signed_packet = signature_file.find('\n').unwrap() + 1;
        let replacement = if signature_file.as_bytes().get(signed_packet) == Some(&b'A') {
            "B"
        } else {
            "A"
        };
        signature_file.replace_range(signed_packet..signed_packet + 1, replacement);
        *value = if encoded {
            STANDARD.encode(signature_file.as_bytes())
        } else {
            signature_file
        };
    });
    let rejected_signature = run_check(
        bad_signature,
        artifact_path.clone(),
        &public_key,
        platform,
        &prior_version,
    );
    assert_eq!(
        rejected_signature.status.error_code.as_deref(),
        Some("UPDATE_SIGNATURE_INVALID")
    );

    let replay = run_check(
        manifest,
        artifact_path,
        &public_key,
        platform,
        &target_version,
    );
    assert_eq!(replay.status.state, "not_available");
    assert!(replay.status.available_version.is_none());
}

fn probe_prior_version(target_version: &str) -> String {
    let target = Version::parse(target_version).unwrap();
    for candidate in ["0.0.0", "0.0.0-0"] {
        if Version::parse(candidate).unwrap() < target {
            return candidate.to_owned();
        }
    }
    panic!("the updater probe target version has no supported predecessor")
}

fn run_check(
    manifest: Vec<u8>,
    artifact: PathBuf,
    public_key: &str,
    platform: UpdatePlatform,
    current_version: &str,
) -> crate::UpdateStatusEnvelope {
    let directory = tempfile::tempdir().unwrap();
    let transport = Arc::new(FixtureTransport::new(manifest, artifact));
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().join("user-data"),
            current_version: Version::parse(current_version).unwrap(),
            platform,
            packaged: true,
            endpoint: Url::parse("https://updates.invalid/fixture/latest.json").unwrap(),
            public_key_base64: public_key.to_owned(),
        },
        transport.clone(),
        Arc::new(RejectingInstaller),
    )
    .unwrap();
    let status = manager.check_for_updates().unwrap();
    if current_version == status.status.current_version && status.status.state == "not_available" {
        assert_eq!(transport.downloads.load(Ordering::Acquire), 0);
        assert!(matches!(
            manager.accept_install(),
            Err(UpdateManagerError::NoPendingUpdate)
        ));
    }
    status
}

fn mutate_platform_field(
    manifest: &[u8],
    platform: UpdatePlatform,
    field: &str,
    mutate: impl FnOnce(&mut String),
) -> Vec<u8> {
    let mut manifest: serde_json::Value = serde_json::from_slice(manifest).unwrap();
    let value = manifest["platforms"][platform.manifest_key()][field]
        .as_str()
        .unwrap()
        .to_owned();
    let mut value = value;
    mutate(&mut value);
    manifest["platforms"][platform.manifest_key()][field] = serde_json::Value::String(value);
    serde_json::to_vec(&manifest).unwrap()
}

fn probe_platform() -> UpdatePlatform {
    match required_value("RION_UPDATER_PROBE_PLATFORM").as_str() {
        "darwin-aarch64" => UpdatePlatform::MacosAarch64,
        "windows-x86_64" => UpdatePlatform::WindowsX86_64,
        value => panic!("unsupported updater probe platform: {value}"),
    }
}

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(required_value(name))
}

fn required_value(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}
