use std::{
    process::{Command, Stdio},
    sync::Mutex,
};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::native_shell;

const DEFAULT_RELEASE_REPOSITORY: &str = "rion-tw/rion-studio";
const UPDATE_STATUS_EVENT: &str = "rion://update-status";
const MAX_RELEASE_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub struct UpdateManager {
    app: AppHandle,
    current_version: String,
    packaged: bool,
    repository: String,
    status: Mutex<Value>,
}

impl UpdateManager {
    pub fn new(app: AppHandle, current_version: String) -> Self {
        let packaged = !cfg!(debug_assertions);
        let repository = normalized_repository(
            std::env::var("RION_STUDIO_RELEASE_REPOSITORY")
                .ok()
                .as_deref()
                .unwrap_or(DEFAULT_RELEASE_REPOSITORY),
        )
        .unwrap_or_else(|| DEFAULT_RELEASE_REPOSITORY.to_owned());
        Self {
            app,
            current_version: current_version.clone(),
            packaged,
            repository,
            status: Mutex::new(json!({
                "currentVersion": current_version,
                "installMode": "manual",
                "isPackaged": packaged,
                "state": if packaged { "idle" } else { "unsupported" }
            })),
        }
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| {
                json!({
                    "currentVersion": self.current_version,
                    "installMode": "manual",
                    "isPackaged": self.packaged,
                    "state": "error",
                    "error": "Update status is unavailable."
                })
            })
    }

    pub fn check(&self) -> Value {
        if !self.packaged {
            return self.set_status(json!({
                "currentVersion": self.current_version,
                "installMode": "manual",
                "isPackaged": false,
                "state": "unsupported"
            }));
        }
        self.set_status(json!({
            "currentVersion": self.current_version,
            "installMode": "manual",
            "isPackaged": true,
            "state": "checking",
            "checkedAt": chrono::Utc::now().to_rfc3339()
        }));
        match fetch_latest_release(&self.repository)
            .and_then(|release| resolve_status(&self.current_version, &self.repository, release))
        {
            Ok(status) => self.set_status(status),
            Err(error) => self.set_status(json!({
                "currentVersion": self.current_version,
                "installMode": "manual",
                "isPackaged": true,
                "state": "error",
                "error": error,
                "checkedAt": chrono::Utc::now().to_rfc3339()
            })),
        }
    }

    pub fn open_download(&self) -> Result<(), String> {
        let status = self.status();
        let url = status["downloadUrl"]
            .as_str()
            .or_else(|| status["releasePageUrl"].as_str())
            .ok_or_else(|| "No update download is available.".to_owned())?;
        native_shell::open_url(url)
    }

    fn set_status(&self, status: Value) -> Value {
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        let _ = self.app.emit(UPDATE_STATUS_EVENT, &status);
        status
    }
}

fn fetch_latest_release(repository: &str) -> Result<Value, String> {
    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let output = if cfg!(target_os = "macos") {
        Command::new("/usr/bin/curl")
            .args([
                "--fail",
                "--location",
                "--max-time",
                "20",
                "--silent",
                "--show-error",
                "--header",
                "Accept: application/vnd.github+json",
                "--header",
                "User-Agent: Rion-Studio-Tauri-Updater",
            ])
            .arg(url)
            .stdin(Stdio::null())
            .output()
    } else {
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                concat!(
                    "$headers=@{Accept='application/vnd.github+json';",
                    "'User-Agent'='Rion-Studio-Tauri-Updater'};",
                    "Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 ",
                    "-Headers $headers -Uri $env:RION_STUDIO_UPDATE_URL | ",
                    "ConvertTo-Json -Depth 8 -Compress"
                ),
            ])
            .env("RION_STUDIO_UPDATE_URL", url)
            .stdin(Stdio::null())
            .output()
    }
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    if output.stdout.len() > MAX_RELEASE_RESPONSE_BYTES {
        return Err("The update response exceeded the safety limit.".to_owned());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn resolve_status(
    current_version: &str,
    repository: &str,
    release: Value,
) -> Result<Value, String> {
    let tag = release["tag_name"]
        .as_str()
        .filter(|tag| !tag.is_empty() && tag.len() <= 128)
        .ok_or_else(|| "The latest release tag is invalid.".to_owned())?;
    let available_version = tag.strip_prefix('v').unwrap_or(tag);
    let release_page_url = release["html_url"]
        .as_str()
        .filter(|url| is_expected_github_url(url, repository))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("https://github.com/{repository}/releases/tag/{tag}"));
    if !version_is_newer(available_version, current_version) {
        return Ok(json!({
            "currentVersion": current_version,
            "installMode": "manual",
            "isPackaged": true,
            "state": "not_available",
            "checkedAt": chrono::Utc::now().to_rfc3339()
        }));
    }
    let expected_asset = if cfg!(target_os = "macos") {
        "Rion.Studio.Preview-mac.dmg"
    } else {
        "Rion.Studio.Preview-win.exe"
    };
    let download_url = release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset["name"].as_str() == Some(expected_asset)
                    && asset["browser_download_url"]
                        .as_str()
                        .is_some_and(|url| is_expected_github_url(url, repository))
            })
        })
        .and_then(|asset| asset["browser_download_url"].as_str())
        .map(str::to_owned);
    Ok(json!({
        "currentVersion": current_version,
        "installMode": "manual",
        "isPackaged": true,
        "state": "available",
        "availableVersion": available_version,
        "downloadUrl": download_url,
        "releasePageUrl": release_page_url,
        "installerName": expected_asset,
        "checkedAt": chrono::Utc::now().to_rfc3339()
    }))
}

fn normalized_repository(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let mut parts = trimmed.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some()
        || owner.is_empty()
        || repo.is_empty()
        || !owner
            .bytes()
            .chain(repo.bytes())
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn is_expected_github_url(value: &str, repository: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some("github.com") => url.path().starts_with(&format!("/{repository}/")),
        Some("objects.githubusercontent.com" | "github-releases.githubusercontent.com") => true,
        _ => false,
    }
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    let parse = |value: &str| {
        value
            .trim_start_matches('v')
            .split_once('-')
            .map(|(stable, _)| stable)
            .unwrap_or(value)
            .split('.')
            .take(3)
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let mut candidate = parse(candidate);
    let mut current = parse(current);
    candidate.resize(3, 0);
    current.resize(3, 0);
    candidate > current
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_and_release_urls_are_allowlisted() {
        assert_eq!(
            normalized_repository("rion-tw/rion-studio").as_deref(),
            Some("rion-tw/rion-studio")
        );
        assert!(normalized_repository("rion-tw/rion-studio/extra").is_none());
        assert!(is_expected_github_url(
            "https://github.com/rion-tw/rion-studio/releases/download/v1/a.dmg",
            "rion-tw/rion-studio"
        ));
        assert!(!is_expected_github_url(
            "https://example.com/rion-tw/rion-studio/a.dmg",
            "rion-tw/rion-studio"
        ));
    }

    #[test]
    fn semantic_versions_are_compared_without_lexical_errors() {
        assert!(version_is_newer("1.10.0", "1.9.9"));
        assert!(!version_is_newer("1.2.0", "1.2.0"));
        assert!(!version_is_newer("1.1.9", "1.2.0"));
    }

    #[test]
    fn latest_release_prefers_the_platform_specific_preview_asset() {
        let asset = if cfg!(target_os = "macos") {
            "Rion.Studio.Preview-mac.dmg"
        } else {
            "Rion.Studio.Preview-win.exe"
        };
        let status = resolve_status(
            "1.0.0",
            "rion-tw/rion-studio",
            json!({
                "tag_name": "v1.1.0",
                "html_url": "https://github.com/rion-tw/rion-studio/releases/tag/v1.1.0",
                "assets": [{
                    "name": asset,
                    "browser_download_url": format!(
                        "https://github.com/rion-tw/rion-studio/releases/download/v1.1.0/{asset}"
                    )
                }]
            }),
        )
        .unwrap();
        assert_eq!(status["state"], "available");
        assert_eq!(status["availableVersion"], "1.1.0");
        assert_eq!(status["installerName"], asset);
    }
}
