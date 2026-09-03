use std::fmt;

use chrono::{DateTime, Utc};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

pub const MAX_UPDATE_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_RELEASE_NOTES_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdatePlatform {
    MacosAarch64,
    WindowsX86_64,
}

impl UpdatePlatform {
    pub const fn manifest_key(self) -> &'static str {
        match self {
            Self::MacosAarch64 => "darwin-aarch64",
            Self::WindowsX86_64 => "windows-x86_64",
        }
    }

    pub const fn staged_file_name(self) -> &'static str {
        match self {
            Self::MacosAarch64 => "Rion-Studio-macos-aarch64.app.tar.gz",
            Self::WindowsX86_64 => "Rion-Studio-windows-x86_64-setup.exe",
        }
    }
}

impl fmt::Display for UpdatePlatform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.manifest_key())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateCandidate {
    pub version: Version,
    pub notes: Option<String>,
    pub published_at: DateTime<Utc>,
    pub platform: UpdatePlatform,
    pub url: Url,
    pub signature: String,
    pub signature_sha256: String,
    pub artifact_sha256: [u8; 32],
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum UpdateManifestError {
    #[error("UPDATE_MANIFEST_TOO_LARGE")]
    TooLarge,
    #[error("UPDATE_MANIFEST_INVALID_JSON")]
    InvalidJson,
    #[error("UPDATE_MANIFEST_VERSION_INVALID")]
    InvalidVersion,
    #[error("UPDATE_MANIFEST_PUBLISHED_AT_INVALID")]
    InvalidPublishedAt,
    #[error("UPDATE_MANIFEST_NOTES_INVALID")]
    InvalidNotes,
    #[error("UPDATE_MANIFEST_ARTIFACT_URL_INVALID")]
    InvalidArtifactUrl,
    #[error("UPDATE_MANIFEST_SIGNATURE_INVALID")]
    InvalidSignature,
    #[error("UPDATE_MANIFEST_SHA256_INVALID")]
    InvalidSha256,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    pub_date: String,
    platforms: RawPlatforms,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlatforms {
    #[serde(rename = "darwin-aarch64")]
    macos_aarch64: RawArtifact,
    #[serde(rename = "windows-x86_64")]
    windows_x86_64: RawArtifact,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawArtifact {
    url: String,
    signature: String,
    sha256: String,
}

pub fn select_update_candidate(
    manifest_bytes: &[u8],
    current_version: &str,
    platform: UpdatePlatform,
) -> Result<Option<UpdateCandidate>, UpdateManifestError> {
    if manifest_bytes.is_empty() || manifest_bytes.len() > MAX_UPDATE_MANIFEST_BYTES {
        return Err(UpdateManifestError::TooLarge);
    }
    let manifest = serde_json::from_slice::<RawManifest>(manifest_bytes)
        .map_err(|_| UpdateManifestError::InvalidJson)?;
    let current =
        Version::parse(current_version).map_err(|_| UpdateManifestError::InvalidVersion)?;
    let version =
        Version::parse(&manifest.version).map_err(|_| UpdateManifestError::InvalidVersion)?;
    let published_at = DateTime::parse_from_rfc3339(&manifest.pub_date)
        .map_err(|_| UpdateManifestError::InvalidPublishedAt)?
        .with_timezone(&Utc);
    let notes = validate_notes(manifest.notes)?;
    let artifact = match platform {
        UpdatePlatform::MacosAarch64 => manifest.platforms.macos_aarch64,
        UpdatePlatform::WindowsX86_64 => manifest.platforms.windows_x86_64,
    };
    let url = validate_artifact_url(&artifact.url)?;
    let signature = validate_signature(artifact.signature)?;
    let signature_sha256 = hex_lower(Sha256::digest(signature.as_bytes()).as_slice());
    let artifact_sha256 = parse_sha256(&artifact.sha256)?;
    if version <= current {
        return Ok(None);
    }
    Ok(Some(UpdateCandidate {
        version,
        notes,
        published_at,
        platform,
        url,
        signature,
        signature_sha256,
        artifact_sha256,
    }))
}

pub fn validate_update_endpoint(value: &str) -> Result<Url, UpdateManifestError> {
    let url = Url::parse(value).map_err(|_| UpdateManifestError::InvalidArtifactUrl)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url
            .path_segments()
            .and_then(Iterator::last)
            .is_none_or(str::is_empty)
    {
        return Err(UpdateManifestError::InvalidArtifactUrl);
    }
    Ok(url)
}

fn validate_notes(notes: Option<String>) -> Result<Option<String>, UpdateManifestError> {
    let Some(notes) = notes else {
        return Ok(None);
    };
    if notes.is_empty()
        || notes.len() > MAX_RELEASE_NOTES_BYTES
        || notes.contains('\0')
        || notes
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(UpdateManifestError::InvalidNotes);
    }
    Ok(Some(notes))
}

fn validate_artifact_url(value: &str) -> Result<Url, UpdateManifestError> {
    validate_update_endpoint(value)
}

fn validate_signature(signature: String) -> Result<String, UpdateManifestError> {
    if signature.is_empty()
        || signature.len() > MAX_SIGNATURE_BYTES
        || signature.trim() != signature
        || signature.contains('\0')
    {
        return Err(UpdateManifestError::InvalidSignature);
    }
    Ok(signature)
}

fn parse_sha256(value: &str) -> Result<[u8; 32], UpdateManifestError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdateManifestError::InvalidSha256);
    }
    let mut output = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).map_err(|_| UpdateManifestError::InvalidSha256)?;
        output[index] =
            u8::from_str_radix(pair, 16).map_err(|_| UpdateManifestError::InvalidSha256)?;
    }
    Ok(output)
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
    use super::*;

    const VALID: &str = r#"{
      "version":"2.3.4",
      "notes":"Verified release",
      "pub_date":"2026-07-26T00:00:00Z",
      "platforms":{
        "darwin-aarch64":{
          "url":"https://downloads.example.test/Rion.Studio.app.tar.gz",
          "signature":"mac-signature",
          "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "windows-x86_64":{
          "url":"https://downloads.example.test/Rion.Studio.exe",
          "signature":"windows-signature",
          "sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      }
    }"#;

    #[test]
    fn selects_only_a_strictly_newer_exact_platform_artifact() {
        let candidate =
            select_update_candidate(VALID.as_bytes(), "2.3.3", UpdatePlatform::MacosAarch64)
                .unwrap()
                .unwrap();
        assert_eq!(candidate.version, Version::new(2, 3, 4));
        assert_eq!(candidate.platform, UpdatePlatform::MacosAarch64);
        assert_eq!(
            candidate.url.as_str(),
            "https://downloads.example.test/Rion.Studio.app.tar.gz"
        );
        assert_eq!(candidate.artifact_sha256, [0xaa; 32]);
        assert!(
            select_update_candidate(VALID.as_bytes(), "2.3.4", UpdatePlatform::WindowsX86_64,)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_unknown_or_duplicate_security_fields() {
        let unknown = VALID.replace(
            "\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
            "\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sha512\":\"no\"",
        );
        assert_eq!(
            select_update_candidate(unknown.as_bytes(), "2.3.3", UpdatePlatform::MacosAarch64,),
            Err(UpdateManifestError::InvalidJson)
        );
        let duplicate = VALID.replace(
            "\"version\":\"2.3.4\"",
            "\"version\":\"2.3.4\",\"version\":\"9.9.9\"",
        );
        assert_eq!(
            select_update_candidate(duplicate.as_bytes(), "2.3.3", UpdatePlatform::MacosAarch64,),
            Err(UpdateManifestError::InvalidJson)
        );
    }

    #[test]
    fn rejects_credentialed_or_mutable_artifact_urls() {
        for url in [
            "http://downloads.example.test/update",
            "https://user@downloads.example.test/update",
            "https://downloads.example.test/update?token=secret",
            "https://downloads.example.test/update#fragment",
        ] {
            let manifest =
                VALID.replace("https://downloads.example.test/Rion.Studio.app.tar.gz", url);
            assert_eq!(
                select_update_candidate(manifest.as_bytes(), "2.3.3", UpdatePlatform::MacosAarch64,),
                Err(UpdateManifestError::InvalidArtifactUrl),
                "{url}"
            );
        }
    }

    #[test]
    fn enforces_manifest_and_release_metadata_bounds() {
        assert_eq!(
            select_update_candidate(&[], "2.3.3", UpdatePlatform::MacosAarch64),
            Err(UpdateManifestError::TooLarge)
        );
        assert_eq!(
            select_update_candidate(
                &vec![b' '; MAX_UPDATE_MANIFEST_BYTES + 1],
                "2.3.3",
                UpdatePlatform::MacosAarch64,
            ),
            Err(UpdateManifestError::TooLarge)
        );
        let notes = VALID.replace("Verified release", &"x".repeat(MAX_RELEASE_NOTES_BYTES + 1));
        assert_eq!(
            select_update_candidate(notes.as_bytes(), "2.3.3", UpdatePlatform::MacosAarch64,),
            Err(UpdateManifestError::InvalidNotes)
        );
    }
}
