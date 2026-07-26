use std::{sync::Mutex, time::Duration};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::native_shell;

const DEFAULT_RELEASE_REPOSITORY: &str = "rion-tw/rion-studio";
const UPDATE_STATUS_EVENT: &str = "rion://update-status";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);

struct PendingUpdate {
    bytes: Vec<u8>,
    update: Update,
}

pub struct UpdateManager {
    app: AppHandle,
    current_version: String,
    packaged: bool,
    pending: Mutex<Option<PendingUpdate>>,
    status: Mutex<Value>,
}

impl UpdateManager {
    pub fn new(app: AppHandle, current_version: String) -> Self {
        let packaged = !cfg!(debug_assertions);
        let configured = embedded_updater_public_key().is_some();
        Self {
            app,
            current_version: current_version.clone(),
            packaged,
            pending: Mutex::new(None),
            status: Mutex::new(json!({
                "currentVersion": current_version,
                "installMode": "automatic",
                "isPackaged": packaged,
                "state": if packaged && configured { "idle" } else { "unsupported" },
                "error": if packaged && !configured {
                    Some("This build does not contain a Tauri updater verification key.")
                } else {
                    None::<&str>
                }
            })),
        }
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| self.error_status("Update status is unavailable."))
    }

    pub async fn check(&self) -> Value {
        if !self.packaged {
            return self.set_status(json!({
                "currentVersion": self.current_version,
                "installMode": "automatic",
                "isPackaged": false,
                "state": "unsupported"
            }));
        }
        let Some(public_key) = embedded_updater_public_key() else {
            return self.set_status(
                self.error_status("This build does not contain a Tauri updater verification key."),
            );
        };
        if matches!(
            self.status()["state"].as_str(),
            Some("checking" | "downloading")
        ) {
            return self.status();
        }
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
        let checked_at = chrono::Utc::now().to_rfc3339();
        self.set_status(json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": true,
            "state": "checking",
            "checkedAt": checked_at
        }));
        let endpoint = match updater_endpoint(DEFAULT_RELEASE_REPOSITORY) {
            Ok(endpoint) => endpoint,
            Err(error) => return self.set_status(self.error_status(&error)),
        };
        let updater = match self
            .app
            .updater_builder()
            .pubkey(public_key)
            .timeout(UPDATE_TIMEOUT)
            .endpoints(vec![endpoint])
            .and_then(|builder| builder.build())
        {
            Ok(updater) => updater,
            Err(error) => return self.set_status(self.error_status(&error.to_string())),
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                return self.set_status(json!({
                    "currentVersion": self.current_version,
                    "installMode": "automatic",
                    "isPackaged": true,
                    "state": "not_available",
                    "checkedAt": checked_at
                }));
            }
            Err(error) => return self.set_status(self.error_status(&error.to_string())),
        };
        let available_version = update.version.clone();
        self.set_status(json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": true,
            "state": "available",
            "availableVersion": available_version,
            "checkedAt": checked_at
        }));
        self.set_status(json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": true,
            "state": "downloading",
            "availableVersion": available_version,
            "downloadProgress": 0,
            "checkedAt": checked_at
        }));
        let mut downloaded = 0_u64;
        let bytes = match update
            .download(
                |chunk_length, content_length| {
                    downloaded = downloaded.saturating_add(chunk_length as u64);
                    let progress = content_length
                        .filter(|length| *length > 0)
                        .map(|length| ((downloaded as f64 / length as f64) * 100.0).round())
                        .unwrap_or(0.0)
                        .clamp(0.0, 100.0) as u8;
                    self.set_status(json!({
                        "currentVersion": self.current_version,
                        "installMode": "automatic",
                        "isPackaged": true,
                        "state": "downloading",
                        "availableVersion": available_version,
                        "downloadProgress": progress,
                        "checkedAt": checked_at
                    }));
                },
                || {},
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) => return self.set_status(self.error_status(&error.to_string())),
        };
        match self.pending.lock() {
            Ok(mut pending) => {
                *pending = Some(PendingUpdate { bytes, update });
            }
            Err(_) => {
                return self.set_status(self.error_status("Pending update state is unavailable."));
            }
        }
        self.set_status(json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": true,
            "state": "downloaded",
            "availableVersion": available_version,
            "downloadProgress": 100,
            "checkedAt": checked_at
        }))
    }

    pub fn install_downloaded(&self) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Pending update state is unavailable.".to_owned())?;
        let update = pending
            .as_ref()
            .ok_or_else(|| "No verified update is ready to install.".to_owned())?;
        update
            .update
            .install(&update.bytes)
            .map_err(|error| error.to_string())?;
        *pending = None;
        Ok(())
    }

    pub fn open_release_page(&self) -> Result<(), String> {
        native_shell::open_url(&format!(
            "https://github.com/{DEFAULT_RELEASE_REPOSITORY}/releases/latest"
        ))
    }

    fn error_status(&self, error: &str) -> Value {
        json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": self.packaged,
            "state": if self.packaged { "error" } else { "unsupported" },
            "error": error,
            "checkedAt": chrono::Utc::now().to_rfc3339()
        })
    }

    fn set_status(&self, status: Value) -> Value {
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        let _ = self.app.emit(UPDATE_STATUS_EVENT, &status);
        status
    }
}

pub(crate) fn embedded_updater_public_key() -> Option<&'static str> {
    option_env!("RION_STUDIO_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn updater_endpoint(repository: &str) -> Result<url::Url, String> {
    let repository = normalized_repository(repository)
        .ok_or_else(|| "The updater release repository is invalid.".to_owned())?;
    let configured = option_env!("RION_STUDIO_UPDATER_ENDPOINT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!("https://github.com/{repository}/releases/latest/download/latest.json")
        });
    let url = url::Url::parse(&configured)
        .map_err(|_| "The updater endpoint URL is invalid.".to_owned())?;
    if url.scheme() != "https" {
        return Err("The updater endpoint must use HTTPS.".to_owned());
    }
    Ok(url)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_and_signed_endpoint_are_allowlisted() {
        assert_eq!(
            normalized_repository("rion-tw/rion-studio").as_deref(),
            Some("rion-tw/rion-studio")
        );
        assert!(normalized_repository("rion-tw/rion-studio/extra").is_none());
        let endpoint = updater_endpoint("rion-tw/rion-studio").unwrap();
        assert_eq!(endpoint.scheme(), "https");
        assert_eq!(endpoint.host_str(), Some("github.com"));
        assert!(
            endpoint
                .path()
                .ends_with("/releases/latest/download/latest.json")
        );
    }
}
