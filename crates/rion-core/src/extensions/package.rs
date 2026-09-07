use super::{Result, crx, failure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(crate) const MAX_PACKAGE: u64 = 64 * 1024 * 1024;
const MAX_UNPACKED: u64 = 256 * 1024 * 1024;

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| (b'a'..=b'p').contains(&c))
}

pub(crate) fn display_name(manifest: &serde_json::Value, directory: &Path, id: &str) -> String {
    let name = manifest["name"].as_str().unwrap_or(id);
    let Some(key) = name
        .strip_prefix("__MSG_")
        .and_then(|s| s.strip_suffix("__"))
    else {
        return name.chars().take(400).collect();
    };
    let locale = manifest["default_locale"].as_str().unwrap_or("en");
    if !locale
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return id.to_owned();
    }
    let path = directory
        .join("_locales")
        .join(locale)
        .join("messages.json");
    if !fs::metadata(&path).is_ok_and(|m| m.len() <= 1024 * 1024) {
        return id.to_owned();
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|messages| {
            messages
                .as_object()?
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))?
                .1["message"]
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| id.to_owned())
        .chars()
        .take(400)
        .collect()
}

pub(crate) fn download(id: &str, cancelled: &AtomicBool) -> Result<Vec<u8>> {
    if !valid_id(id) {
        return Err(failure("Invalid extension ID"));
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
        .map_err(|_| failure("Cannot create store client"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|_| failure("Store download failed"))?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > MAX_PACKAGE)
    {
        return Err(failure("Store package unavailable or too large"));
    }
    let mut data = Vec::new();
    let mut buffer = [0; 65536];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(failure("Installation cancelled"));
        }
        let count = response
            .read(&mut buffer)
            .map_err(|_| failure("Store download interrupted"))?;
        if count == 0 {
            break;
        }
        if data.len() as u64 + count as u64 > MAX_PACKAGE {
            return Err(failure("Package too large"));
        }
        data.extend_from_slice(&buffer[..count]);
    }
    Ok(data)
}

pub(crate) fn unpack(
    bytes: &[u8],
    id: &str,
    destination: &Path,
) -> Result<(serde_json::Value, String)> {
    let verified = crx::verify(bytes, id)?;
    let mut zip =
        zip::ZipArchive::new(Cursor::new(verified.archive)).map_err(|_| failure("Invalid ZIP"))?;
    if zip.len() > 20000 {
        return Err(failure("Too many package files"));
    }
    let mut total = 0_u64;
    let mut names = HashSet::new();
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|_| failure("Invalid ZIP entry"))?;
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
            return Err(failure("Unsafe package path"));
        }
        if !names.insert(name.to_lowercase())
            || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err(failure("Duplicate path or symbolic link"));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| failure("Package size overflow"))?;
        if total > MAX_UNPACKED {
            return Err(failure("Unpacked package too large"));
        }
        let relative = file
            .enclosed_name()
            .ok_or_else(|| failure("Unsafe package path"))?;
        let target = destination.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| failure("Invalid package path"))?,
        )?;
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        let expected = file.size();
        let copied = std::io::copy(&mut file.by_ref().take(expected + 1), &mut out)?;
        if copied != expected {
            return Err(failure("ZIP size mismatch"));
        }
        out.flush()?;
    }
    let manifest_path = destination.join("manifest.json");
    if fs::metadata(&manifest_path)?.len() > 1024 * 1024 {
        return Err(failure("Manifest too large"));
    }
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path)?)
        .map_err(|_| failure("Invalid extension manifest"))?;
    if manifest["manifest_version"] != 3
        || manifest["name"].as_str().is_none()
        || manifest["version"].as_str().is_none()
    {
        return Err(failure("A Manifest V3 extension is required"));
    }
    if let Some(key) = manifest.get("key") {
        let key = STANDARD
            .decode(
                key.as_str()
                    .ok_or_else(|| failure("Invalid manifest key"))?,
            )
            .map_err(|_| failure("Invalid manifest key"))?;
        if crx::extension_id(&key) != id {
            return Err(failure("Manifest key differs from signed ID"));
        }
    }
    // Preserve the publisher key so unpacked loading keeps the store identity across versions/paths.
    manifest["key"] = STANDARD.encode(verified.key).into();
    fs::write(
        manifest_path,
        serde_json::to_vec(&manifest).map_err(|_| failure("Invalid manifest"))?,
    )?;
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((manifest, digest))
}
