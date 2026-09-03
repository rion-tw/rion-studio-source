use std::{fs::File, io::Read, path::Path};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::UpdateCandidate;

pub const MAX_UPDATE_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateArtifactReceipt {
    pub version: Version,
    pub bytes: u64,
    pub artifact_sha256: String,
    pub signature_sha256: String,
}

#[derive(Debug, Error)]
pub enum UpdateVerificationError {
    #[error("UPDATE_ARTIFACT_UNREADABLE")]
    Unreadable(#[source] std::io::Error),
    #[error("UPDATE_ARTIFACT_NOT_REGULAR")]
    NotRegular,
    #[error("UPDATE_ARTIFACT_TOO_LARGE")]
    TooLarge,
    #[error("UPDATE_ARTIFACT_SIZE_MISMATCH")]
    SizeMismatch,
    #[error("UPDATE_ARTIFACT_SHA256_MISMATCH")]
    Sha256Mismatch,
    #[error("UPDATE_SIGNATURE_KEY_INVALID")]
    InvalidPublicKey,
    #[error("UPDATE_SIGNATURE_INVALID")]
    InvalidSignature,
}

pub fn verify_update_artifact(
    path: &Path,
    candidate: &UpdateCandidate,
    expected_bytes: Option<u64>,
    public_key_base64: &str,
) -> Result<UpdateArtifactReceipt, UpdateVerificationError> {
    let metadata = path
        .symlink_metadata()
        .map_err(UpdateVerificationError::Unreadable)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(UpdateVerificationError::NotRegular);
    }
    let bytes = metadata.len();
    if bytes == 0 || bytes > MAX_UPDATE_ARTIFACT_BYTES {
        return Err(UpdateVerificationError::TooLarge);
    }
    if expected_bytes.is_some_and(|expected| expected != bytes) {
        return Err(UpdateVerificationError::SizeMismatch);
    }

    let signature = parse_signature(&candidate.signature)?;
    let public_key = parse_public_key(public_key_base64)?;
    let mut signature_verifier = public_key
        .verify_stream(&signature)
        .map_err(|_| UpdateVerificationError::InvalidSignature)?;
    let mut digest = Sha256::new();
    let mut input = File::open(path).map_err(UpdateVerificationError::Unreadable)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(UpdateVerificationError::Unreadable)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        signature_verifier.update(&buffer[..read]);
    }
    let actual_sha256: [u8; 32] = digest.finalize().into();
    if actual_sha256 != candidate.artifact_sha256 {
        return Err(UpdateVerificationError::Sha256Mismatch);
    }
    signature_verifier
        .finalize()
        .map_err(|_| UpdateVerificationError::InvalidSignature)?;
    Ok(UpdateArtifactReceipt {
        version: candidate.version.clone(),
        bytes,
        artifact_sha256: hex_lower(&actual_sha256),
        signature_sha256: candidate.signature_sha256.clone(),
    })
}

fn parse_public_key(value: &str) -> Result<PublicKey, UpdateVerificationError> {
    if let Ok(key) = PublicKey::from_base64(value) {
        return Ok(key);
    }
    if let Ok(key) = PublicKey::decode(value) {
        return Ok(key);
    }
    let decoded = STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|key_file| PublicKey::decode(&key_file).ok());
    decoded.ok_or(UpdateVerificationError::InvalidPublicKey)
}

fn parse_signature(value: &str) -> Result<Signature, UpdateVerificationError> {
    if let Ok(signature) = Signature::decode(value) {
        return Ok(signature);
    }
    let decoded = STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|signature_file| Signature::decode(&signature_file).ok());
    decoded.ok_or(UpdateVerificationError::InvalidSignature)
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;

    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            let _ = write!(output, "{byte:02x}");
            output
        },
    )
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::DateTime;
    use sha2::Digest;
    use tempfile::tempdir;
    use url::Url;

    use crate::UpdatePlatform;

    use super::*;

    const PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    fn candidate(content: &[u8]) -> UpdateCandidate {
        UpdateCandidate {
            version: Version::new(2, 3, 4),
            notes: None,
            published_at: DateTime::parse_from_rfc3339("2026-07-26T00:00:00Z")
                .unwrap()
                .to_utc(),
            platform: UpdatePlatform::MacosAarch64,
            url: Url::parse("https://downloads.example.test/update").unwrap(),
            signature: SIGNATURE.to_owned(),
            signature_sha256: hex_lower(Sha256::digest(SIGNATURE.as_bytes()).as_slice()),
            artifact_sha256: Sha256::digest(content).into(),
        }
    }

    #[test]
    fn requires_both_sha256_and_minisign_for_the_exact_regular_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("artifact");
        fs::write(&path, b"test").unwrap();
        let receipt =
            verify_update_artifact(&path, &candidate(b"test"), Some(4), PUBLIC_KEY).unwrap();
        assert_eq!(receipt.bytes, 4);
        assert_eq!(receipt.version, Version::new(2, 3, 4));

        let wrong_hash = candidate(b"different");
        assert!(matches!(
            verify_update_artifact(&path, &wrong_hash, Some(4), PUBLIC_KEY),
            Err(UpdateVerificationError::Sha256Mismatch)
        ));

        let mut wrong_signature = candidate(b"test");
        wrong_signature.signature = wrong_signature.signature.replace("RUQf", "RUQg");
        assert!(matches!(
            verify_update_artifact(&path, &wrong_signature, Some(4), PUBLIC_KEY),
            Err(UpdateVerificationError::InvalidSignature)
        ));
    }

    #[test]
    fn rejects_size_mismatch_empty_files_and_symlinks() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("artifact");
        fs::write(&path, b"test").unwrap();
        assert!(matches!(
            verify_update_artifact(&path, &candidate(b"test"), Some(5), PUBLIC_KEY),
            Err(UpdateVerificationError::SizeMismatch)
        ));
        let empty = directory.path().join("empty");
        fs::write(&empty, []).unwrap();
        assert!(matches!(
            verify_update_artifact(&empty, &candidate(b"test"), Some(0), PUBLIC_KEY),
            Err(UpdateVerificationError::TooLarge)
        ));

        #[cfg(unix)]
        {
            let link = directory.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(matches!(
                verify_update_artifact(&link, &candidate(b"test"), Some(4), PUBLIC_KEY),
                Err(UpdateVerificationError::NotRegular)
            ));
        }
    }

    #[test]
    fn accepts_raw_minisign_and_tauri_encoded_public_key_files() {
        let key_file = format!("untrusted comment: fixture\n{PUBLIC_KEY}\n");
        let tauri_public_key = STANDARD.encode(key_file.as_bytes());
        assert!(parse_public_key(PUBLIC_KEY).is_ok());
        assert!(parse_public_key(&key_file).is_ok());
        assert!(parse_public_key(&tauri_public_key).is_ok());
        assert!(parse_public_key("not-a-key").is_err());
    }

    #[test]
    fn accepts_raw_minisign_and_tauri_encoded_signature_files() {
        let tauri_signature = STANDARD.encode(SIGNATURE.as_bytes());
        assert!(parse_signature(SIGNATURE).is_ok());
        assert!(parse_signature(&tauri_signature).is_ok());
        assert!(parse_signature("not-a-signature").is_err());
    }
}
