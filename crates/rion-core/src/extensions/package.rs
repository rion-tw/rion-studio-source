use super::{ExtensionPackageError, crx, error::Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    path::{Component, Path},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(crate) const MAX_PACKAGE: u64 = 128 * 1024 * 1024;
pub(crate) const MAX_UNPACKED: u64 = 512 * 1024 * 1024;
const MAX_ICON_BYTES: u64 = 512 * 1024;
const MAX_DISPLAY_TEXT_CHARS: usize = 400;
const MANAGEMENT_ICON_SIZE: u32 = 48;

#[derive(Debug)]
pub(super) struct PackageDisplayMetadata {
    pub description: String,
    pub icon_data_url: Option<String>,
    pub size_bytes: u64,
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| (b'a'..=b'p').contains(&c))
}

pub(crate) fn display_name(manifest: &serde_json::Value, directory: &Path, id: &str) -> String {
    manifest_text(manifest, directory, "name").unwrap_or_else(|| id.to_owned())
}

fn manifest_text(manifest: &serde_json::Value, directory: &Path, field: &str) -> Option<String> {
    let value = manifest[field].as_str()?;
    let Some(key) = value
        .strip_prefix("__MSG_")
        .and_then(|s| s.strip_suffix("__"))
    else {
        return Some(value.chars().take(MAX_DISPLAY_TEXT_CHARS).collect());
    };
    localized_message(manifest, directory, key)?
        .chars()
        .take(MAX_DISPLAY_TEXT_CHARS)
        .collect::<String>()
        .into()
}

fn localized_message(manifest: &serde_json::Value, directory: &Path, key: &str) -> Option<String> {
    let locale = manifest["default_locale"].as_str().unwrap_or("en");
    if !locale
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    let path = directory
        .join("_locales")
        .join(locale)
        .join("messages.json");
    let relative = path.strip_prefix(directory).ok()?;
    read_contained_regular_file(directory, relative, 1024 * 1024)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|messages| {
            messages
                .as_object()?
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))?
                .1["message"]
                .as_str()
                .map(str::to_owned)
        })
}

pub(crate) fn download(id: &str, cancelled: &AtomicBool) -> Result<Vec<u8>> {
    if !valid_id(id) {
        return Err(ExtensionPackageError::PackageInvalid);
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(ExtensionPackageError::Cancelled);
    }
    let mut url = url::Url::parse("https://clients2.google.com/service/update2/crx").unwrap();
    url.query_pairs_mut()
        .append_pair("response", "redirect")
        .append_pair("prodversion", "150.0.7871.224")
        .append_pair("acceptformat", "crx3")
        .append_pair("x", &format!("id={id}&installsource=ondemand&uc"));
    // DeadlineBound: an unknown external HTTP acknowledgement is failure, never installation success.
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.url().scheme() == "https"
                && attempt.url().host_str().is_some_and(|host| {
                    host == "clients2.google.com"
                        || host == "clients2.googleusercontent.com"
                        || host.ends_with(".gvt1.com")
                });
            if allowed && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.error("Untrusted extension redirect")
            }
        }))
        .build()
        .map_err(|_| ExtensionPackageError::StoreUnavailable)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|_| ExtensionPackageError::StoreUnavailable)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(ExtensionPackageError::Cancelled);
    }
    if response.status() != reqwest::StatusCode::OK {
        return Err(ExtensionPackageError::StoreUnavailable);
    }
    let content_length = response.content_length();
    read_download(&mut response, content_length, cancelled, MAX_PACKAGE)
}

pub(super) fn read_download(
    reader: &mut impl Read,
    content_length: Option<u64>,
    cancelled: &AtomicBool,
    maximum: u64,
) -> Result<Vec<u8>> {
    if content_length.is_some_and(|length| length > maximum) {
        return Err(ExtensionPackageError::PackageTooLarge);
    }
    let mut data = Vec::new();
    let mut buffer = [0; 65536];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(ExtensionPackageError::Cancelled);
        }
        let count = reader
            .read(&mut buffer)
            .map_err(|_| ExtensionPackageError::StoreUnavailable)?;
        if count == 0 {
            break;
        }
        if data.len() as u64 + count as u64 > maximum {
            return Err(ExtensionPackageError::PackageTooLarge);
        }
        data.extend_from_slice(&buffer[..count]);
    }
    Ok(data)
}

pub(crate) fn unpack(
    bytes: &[u8],
    id: &str,
    destination: &Path,
    cancelled: &AtomicBool,
) -> Result<(serde_json::Value, String, PackageDisplayMetadata)> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ExtensionPackageError::Cancelled);
    }
    let verified = crx::verify(bytes, id)?;
    unpack_verified(bytes, id, destination, cancelled, verified, MAX_UNPACKED)
}

fn unpack_verified(
    bytes: &[u8],
    id: &str,
    destination: &Path,
    cancelled: &AtomicBool,
    verified: crx::VerifiedCrx<'_>,
    maximum_unpacked: u64,
) -> Result<(serde_json::Value, String, PackageDisplayMetadata)> {
    let mut zip = zip::ZipArchive::new(Cursor::new(verified.archive))
        .map_err(|_| ExtensionPackageError::PackageInvalid)?;
    if zip.len() > 20000 {
        return Err(ExtensionPackageError::PackageInvalid);
    }
    let mut total = 0_u64;
    for index in 0..zip.len() {
        if cancelled.load(Ordering::Acquire) {
            return Err(ExtensionPackageError::Cancelled);
        }
        let file = zip
            .by_index(index)
            .map_err(|_| ExtensionPackageError::PackageInvalid)?;
        total = total
            .checked_add(file.size())
            .ok_or(ExtensionPackageError::UnpackedTooLarge)?;
        if total > maximum_unpacked {
            return Err(ExtensionPackageError::UnpackedTooLarge);
        }
    }
    let mut names = HashSet::new();
    for index in 0..zip.len() {
        if cancelled.load(Ordering::Acquire) {
            return Err(ExtensionPackageError::Cancelled);
        }
        let mut file = zip
            .by_index(index)
            .map_err(|_| ExtensionPackageError::PackageInvalid)?;
        let name = file.name();
        let parts: Vec<_> = name.trim_end_matches('/').split('/').collect();
        if name.is_empty()
            || name.contains(['\\', ':', '\0'])
            || parts.iter().any(|p| {
                p.is_empty()
                    || *p == "."
                    || *p == ".."
                    || p.ends_with(['.', ' '])
                    || matches!(
                        p.split('.')
                            .next()
                            .unwrap_or("")
                            .to_ascii_uppercase()
                            .as_str(),
                        "CON"
                            | "PRN"
                            | "AUX"
                            | "NUL"
                            | "COM1"
                            | "COM2"
                            | "COM3"
                            | "COM4"
                            | "COM5"
                            | "COM6"
                            | "COM7"
                            | "COM8"
                            | "COM9"
                            | "LPT1"
                            | "LPT2"
                            | "LPT3"
                            | "LPT4"
                            | "LPT5"
                            | "LPT6"
                            | "LPT7"
                            | "LPT8"
                            | "LPT9"
                    )
            })
        {
            return Err(ExtensionPackageError::PackageInvalid);
        }
        if !names.insert(name.to_lowercase())
            || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err(ExtensionPackageError::PackageInvalid);
        }
        let relative = file
            .enclosed_name()
            .ok_or(ExtensionPackageError::PackageInvalid)?;
        let target = destination.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        fs::create_dir_all(
            target
                .parent()
                .ok_or(ExtensionPackageError::PackageInvalid)?,
        )?;
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        let expected = file.size();
        let copied = std::io::copy(&mut file.by_ref().take(expected + 1), &mut out)?;
        if copied != expected {
            return Err(ExtensionPackageError::PackageInvalid);
        }
        out.flush()?;
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(ExtensionPackageError::Cancelled);
    }
    let manifest_path = destination.join("manifest.json");
    let manifest_metadata =
        fs::metadata(&manifest_path).map_err(|_| ExtensionPackageError::ManifestUnsupported)?;
    if manifest_metadata.len() > 1024 * 1024 {
        return Err(ExtensionPackageError::ManifestUnsupported);
    }
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path)?)
        .map_err(|_| ExtensionPackageError::ManifestUnsupported)?;
    if manifest["manifest_version"] != 3
        || manifest["name"].as_str().is_none()
        || manifest["version"].as_str().is_none()
    {
        return Err(ExtensionPackageError::ManifestUnsupported);
    }
    if let Some(key) = manifest.get("key") {
        let key = STANDARD
            .decode(
                key.as_str()
                    .ok_or(ExtensionPackageError::SignatureInvalid)?,
            )
            .map_err(|_| ExtensionPackageError::SignatureInvalid)?;
        if crx::extension_id(&key) != id {
            return Err(ExtensionPackageError::SignatureInvalid);
        }
    }
    // Preserve the publisher key so unpacked loading keeps the store identity across versions/paths.
    manifest["key"] = STANDARD.encode(verified.key).into();
    fs::write(
        manifest_path,
        serde_json::to_vec(&manifest).map_err(|_| ExtensionPackageError::ManifestUnsupported)?,
    )?;
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let metadata = installed_metadata_from_manifest(&manifest, destination)?;
    Ok((manifest, digest, metadata))
}

pub(super) fn installed_metadata(directory: &Path) -> Result<PackageDisplayMetadata> {
    let bytes = read_contained_regular_file(directory, Path::new("manifest.json"), 1024 * 1024)
        .ok_or(ExtensionPackageError::ManifestUnsupported)?;
    let manifest = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| ExtensionPackageError::ManifestUnsupported)?;
    installed_metadata_from_manifest(&manifest, directory)
}

fn installed_metadata_from_manifest(
    manifest: &serde_json::Value,
    directory: &Path,
) -> Result<PackageDisplayMetadata> {
    Ok(PackageDisplayMetadata {
        description: manifest_text(manifest, directory, "description").unwrap_or_default(),
        icon_data_url: manifest_icon_data_url(manifest, directory),
        size_bytes: logical_installed_size(directory)?,
    })
}

fn manifest_icon_data_url(manifest: &serde_json::Value, directory: &Path) -> Option<String> {
    let mut candidates = manifest["icons"]
        .as_object()?
        .iter()
        .filter_map(|(size, path)| Some((size.parse::<u32>().ok()?, path.as_str()?)))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(size, _)| {
        if *size == MANAGEMENT_ICON_SIZE {
            (0, 0)
        } else if *size > MANAGEMENT_ICON_SIZE {
            (1, size - MANAGEMENT_ICON_SIZE)
        } else {
            (2, MANAGEMENT_ICON_SIZE - size)
        }
    });
    candidates
        .into_iter()
        .find_map(|(_, path)| icon_data_url(directory, path))
}

fn icon_data_url(directory: &Path, manifest_path: &str) -> Option<String> {
    let relative = Path::new(manifest_path);
    if relative.as_os_str().is_empty()
        || manifest_path.contains(['\\', ':', '\0'])
        || !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let mime = match relative
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    };
    let bytes = read_contained_regular_file(directory, relative, MAX_ICON_BYTES)?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn read_contained_regular_file(directory: &Path, relative: &Path, maximum: u64) -> Option<Vec<u8>> {
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let root = fs::canonicalize(directory).ok()?;
    let source_path = directory.join(relative);
    let metadata = fs::symlink_metadata(&source_path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > maximum {
        return None;
    }
    let source = fs::canonicalize(source_path).ok()?;
    if source == root || !source.starts_with(&root) {
        return None;
    }
    let bytes = fs::read(source).ok()?;
    (bytes.len() as u64 <= maximum).then_some(bytes)
}

fn logical_installed_size(directory: &Path) -> Result<u64> {
    let root = fs::canonicalize(directory)?;
    let mut pending = vec![root.clone()];
    let mut visited = HashSet::from([root.clone()]);
    let mut entry_count = 0_usize;
    let mut total = 0_u64;
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            entry_count += 1;
            if entry_count > 20000 {
                return Err(ExtensionPackageError::PackageInvalid);
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(ExtensionPackageError::PackageInvalid);
            }
            let canonical = fs::canonicalize(&path)?;
            if canonical == root || !canonical.starts_with(&root) {
                return Err(ExtensionPackageError::PackageInvalid);
            }
            if metadata.is_dir() {
                if visited.insert(canonical.clone()) {
                    pending.push(canonical);
                }
            } else if metadata.is_file() {
                total = total
                    .checked_add(metadata.len())
                    .ok_or(ExtensionPackageError::UnpackedTooLarge)?;
                if total > MAX_UNPACKED {
                    return Err(ExtensionPackageError::UnpackedTooLarge);
                }
            } else {
                return Err(ExtensionPackageError::PackageInvalid);
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
pub(super) fn unpack_with_test_publisher(
    bytes: &[u8],
    id: &str,
    destination: &Path,
    cancelled: &AtomicBool,
    publisher_key_hash: [u8; 32],
    maximum_unpacked: u64,
) -> Result<(serde_json::Value, String, PackageDisplayMetadata)> {
    let verified = crx::verify_with_publisher_key_hash(bytes, id, publisher_key_hash)?;
    unpack_verified(
        bytes,
        id,
        destination,
        cancelled,
        verified,
        maximum_unpacked,
    )
}
