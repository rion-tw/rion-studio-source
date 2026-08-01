use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

use crate::native_shell;

const DEFAULT_RELEASE_REPOSITORY: &str = "rion-tw/rion-studio";
const UPDATE_STATUS_EVENT: &str = "rion://update-status";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);
const AUTOMATIC_UPDATE_STARTUP_DELAY: Duration = Duration::from_secs(15);
const AUTOMATIC_UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const AUTOMATIC_UPDATE_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(15 * 60),
    Duration::from_secs(60 * 60),
    Duration::from_secs(6 * 60 * 60),
];
const UPDATE_PREFERENCES_FILE: &str = "app-update-preferences.json";
static UPDATE_PREFERENCES_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePreferences {
    #[serde(default = "default_auto_update_enabled")]
    auto_update_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    consecutive_failures: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_version: Option<String>,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            auto_update_enabled: true,
            last_attempt_at: None,
            consecutive_failures: 0,
            pending_version: None,
        }
    }
}

struct PendingUpdate {
    bytes: Vec<u8>,
    update: Update,
}

#[derive(Clone, Copy)]
enum UpdateCheckReason {
    Automatic,
    Manual,
}

pub struct UpdateManager {
    app: AppHandle,
    automatic_force_check: AtomicBool,
    check_gate: tokio::sync::Mutex<()>,
    configured: bool,
    current_version: String,
    legal_accepted: AtomicBool,
    packaged: bool,
    pending: Mutex<Option<PendingUpdate>>,
    preference_write: Mutex<()>,
    preferences: Mutex<UpdatePreferences>,
    preferences_path: PathBuf,
    renderer_ready: AtomicBool,
    scheduler_notify: Notify,
    scheduler_started: AtomicBool,
    startup_delay_scheduled: AtomicBool,
    startup_ready: AtomicBool,
    status: Mutex<Value>,
}

impl UpdateManager {
    pub fn new(
        app: AppHandle,
        current_version: String,
        user_data_dir: &Path,
        legal_accepted: bool,
    ) -> Self {
        let packaged = !cfg!(debug_assertions);
        let configured = embedded_updater_public_key().is_some();
        let preferences_path = user_data_dir.join(UPDATE_PREFERENCES_FILE);
        let mut preferences = load_update_preferences(&preferences_path);
        if preferences.pending_version.as_deref() == Some(&current_version) {
            preferences.pending_version = None;
            preferences.consecutive_failures = 0;
            let _ = write_update_preferences(&preferences_path, &preferences);
        }
        let auto_update_enabled = preferences.auto_update_enabled;
        Self {
            app,
            automatic_force_check: AtomicBool::new(false),
            check_gate: tokio::sync::Mutex::new(()),
            configured,
            current_version: current_version.clone(),
            legal_accepted: AtomicBool::new(legal_accepted),
            packaged,
            pending: Mutex::new(None),
            preference_write: Mutex::new(()),
            preferences: Mutex::new(preferences),
            preferences_path,
            renderer_ready: AtomicBool::new(false),
            scheduler_notify: Notify::new(),
            scheduler_started: AtomicBool::new(false),
            startup_delay_scheduled: AtomicBool::new(false),
            startup_ready: AtomicBool::new(false),
            status: Mutex::new(json!({
                "currentVersion": current_version,
                "installMode": "automatic",
                "isPackaged": packaged,
                "autoUpdateEnabled": auto_update_enabled,
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

    pub fn set_auto_update_enabled(&self, enabled: bool) -> Result<Value, String> {
        self.update_preferences(|preferences| preferences.auto_update_enabled = enabled)?;
        let mut status = self.status();
        if let Some(status) = status.as_object_mut() {
            status.insert("autoUpdateEnabled".to_owned(), Value::Bool(enabled));
        }
        let status = self.set_status(status);
        if enabled {
            self.automatic_force_check.store(true, Ordering::Release);
        }
        self.scheduler_notify.notify_one();
        Ok(status)
    }

    pub fn start_automatic_checks(self: &Arc<Self>) {
        if self.scheduler_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move { manager.run_automatic_checks().await });
    }

    pub fn mark_renderer_ready(self: &Arc<Self>) {
        self.renderer_ready.store(true, Ordering::Release);
        self.schedule_startup_delay_if_ready();
    }

    pub fn mark_legal_accepted(self: &Arc<Self>) {
        self.legal_accepted.store(true, Ordering::Release);
        self.schedule_startup_delay_if_ready();
    }

    pub fn notify_foregrounded(&self) {
        self.scheduler_notify.notify_one();
    }

    pub async fn check_manual(&self) -> Value {
        self.check(UpdateCheckReason::Manual).await
    }

    async fn check(&self, reason: UpdateCheckReason) -> Value {
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
        if self.has_pending_update() {
            return self.status();
        }
        let _check_guard = match self.check_gate.try_lock() {
            Ok(guard) => guard,
            Err(_) if matches!(reason, UpdateCheckReason::Automatic) => {
                self.scheduler_notify.notified().await;
                return self.status();
            }
            Err(_) => return self.status(),
        };
        if self.has_pending_update() {
            return self.status();
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
            Err(error) => return self.finish_check_error(reason, &error),
        };
        let before_exit_app = self.app.clone();
        let updater = match self
            .app
            .updater_builder()
            .pubkey(public_key)
            .timeout(UPDATE_TIMEOUT)
            .on_before_exit(move || crate::prepare_application_update_exit(&before_exit_app))
            .endpoints(vec![endpoint])
            .and_then(|builder| builder.build())
        {
            Ok(updater) => updater,
            Err(error) => return self.finish_check_error(reason, &error.to_string()),
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                self.finish_check_success(None);
                return self.set_status(json!({
                    "currentVersion": self.current_version,
                    "installMode": "automatic",
                    "isPackaged": true,
                    "state": "not_available",
                    "checkedAt": checked_at
                }));
            }
            Err(error) => return self.finish_check_error(reason, &error.to_string()),
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
            Err(error) => return self.finish_check_error(reason, &error.to_string()),
        };
        match self.pending.lock() {
            Ok(mut pending) => {
                *pending = Some(PendingUpdate { bytes, update });
            }
            Err(_) => {
                return self.finish_check_error(reason, "Pending update state is unavailable.");
            }
        }
        self.finish_check_success(Some(available_version.clone()));
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
        if let Err(error) = update.update.install(&update.bytes) {
            let message = error.to_string();
            drop(pending);
            self.set_status(self.error_status(&message));
            return Err(message);
        }
        *pending = None;
        Ok(())
    }

    pub fn open_release_page(&self) -> Result<(), String> {
        native_shell::open_url(&format!(
            "https://github.com/{DEFAULT_RELEASE_REPOSITORY}/releases/latest"
        ))
    }

    async fn run_automatic_checks(self: Arc<Self>) {
        loop {
            self.scheduler_notify.notified().await;
            loop {
                if !self.automatic_checks_eligible() {
                    break;
                }
                if !self.startup_ready.load(Ordering::Acquire) {
                    break;
                }
                let forced = self.automatic_force_check.swap(false, Ordering::AcqRel);
                if self.has_pending_update() {
                    break;
                }
                let delay = if forced {
                    Duration::ZERO
                } else {
                    self.next_automatic_check_delay(Utc::now())
                };
                if delay.is_zero() {
                    self.check(UpdateCheckReason::Automatic).await;
                    continue;
                }
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = self.scheduler_notify.notified() => {}
                }
            }
        }
    }

    fn schedule_startup_delay_if_ready(self: &Arc<Self>) {
        if !self.renderer_ready.load(Ordering::Acquire)
            || !self.legal_accepted.load(Ordering::Acquire)
            || self.startup_delay_scheduled.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AUTOMATIC_UPDATE_STARTUP_DELAY).await;
            if manager
                .preferences
                .lock()
                .map(|preferences| preferences.consecutive_failures == 0)
                .unwrap_or(false)
            {
                manager.automatic_force_check.store(true, Ordering::Release);
            }
            manager.startup_ready.store(true, Ordering::Release);
            manager.scheduler_notify.notify_one();
        });
    }

    fn automatic_checks_eligible(&self) -> bool {
        self.packaged
            && self.configured
            && self.auto_update_enabled()
            && self.renderer_ready.load(Ordering::Acquire)
            && self.legal_accepted.load(Ordering::Acquire)
    }

    fn has_pending_update(&self) -> bool {
        self.pending
            .lock()
            .map(|pending| pending.is_some())
            .unwrap_or(false)
    }

    fn next_automatic_check_delay(&self, now: DateTime<Utc>) -> Duration {
        self.preferences
            .lock()
            .map(|preferences| automatic_check_delay(&preferences, now))
            .unwrap_or(AUTOMATIC_UPDATE_RETRY_DELAYS[0])
    }

    fn finish_check_success(&self, pending_version: Option<String>) {
        if let Err(error) = self.update_preferences(|preferences| {
            preferences.last_attempt_at = Some(Utc::now().to_rfc3339());
            preferences.consecutive_failures = 0;
            preferences.pending_version = pending_version;
        }) {
            eprintln!("Unable to persist successful updater state: {error}");
        }
        self.scheduler_notify.notify_one();
    }

    fn finish_check_error(&self, _reason: UpdateCheckReason, error: &str) -> Value {
        if let Err(persistence_error) = self.update_preferences(|preferences| {
            preferences.last_attempt_at = Some(Utc::now().to_rfc3339());
            preferences.consecutive_failures = preferences.consecutive_failures.saturating_add(1);
        }) {
            eprintln!("Unable to persist updater retry state: {persistence_error}");
        }
        self.scheduler_notify.notify_one();
        self.set_status(self.error_status(error))
    }

    fn update_preferences(
        &self,
        update: impl FnOnce(&mut UpdatePreferences),
    ) -> Result<(), String> {
        let _write_guard = self
            .preference_write
            .lock()
            .map_err(|_| "Update preference writer is unavailable.".to_owned())?;
        let mut current = self
            .preferences
            .lock()
            .map_err(|_| "Update preference state is unavailable.".to_owned())?;
        let mut next = current.clone();
        update(&mut next);
        write_update_preferences(&self.preferences_path, &next)?;
        *current = next;
        Ok(())
    }

    fn error_status(&self, error: &str) -> Value {
        json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": self.packaged,
            "autoUpdateEnabled": self.auto_update_enabled(),
            "state": if self.packaged { "error" } else { "unsupported" },
            "error": error,
            "checkedAt": chrono::Utc::now().to_rfc3339()
        })
    }

    fn set_status(&self, mut status: Value) -> Value {
        if let Some(status) = status.as_object_mut() {
            status.insert(
                "autoUpdateEnabled".to_owned(),
                Value::Bool(self.auto_update_enabled()),
            );
        }
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        let _ = self.app.emit(UPDATE_STATUS_EVENT, &status);
        status
    }

    fn auto_update_enabled(&self) -> bool {
        self.preferences
            .lock()
            .map(|preferences| preferences.auto_update_enabled)
            .unwrap_or(true)
    }
}

fn load_update_preferences(path: &Path) -> UpdatePreferences {
    fs::read(path)
        .ok()
        .and_then(|content| serde_json::from_slice::<UpdatePreferences>(&content).ok())
        .unwrap_or_default()
}

fn write_update_preferences(path: &Path, preferences: &UpdatePreferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Update preferences path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{UPDATE_PREFERENCES_FILE}.{}.{}.tmp",
        std::process::id(),
        UPDATE_PREFERENCES_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let content = serde_json::to_vec(preferences).map_err(|error| error.to_string())?;
        fs::write(&temporary, content).map_err(|error| error.to_string())?;
        rion_platform::atomic_replace_file(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn automatic_check_delay(preferences: &UpdatePreferences, now: DateTime<Utc>) -> Duration {
    let interval = match preferences.consecutive_failures {
        0 if preferences.pending_version.is_some() => return Duration::ZERO,
        0 => AUTOMATIC_UPDATE_INTERVAL,
        failures => {
            AUTOMATIC_UPDATE_RETRY_DELAYS[usize::from(failures.saturating_sub(1))
                .min(AUTOMATIC_UPDATE_RETRY_DELAYS.len() - 1)]
        }
    };
    let Some(last_attempt) = preferences
        .last_attempt_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
    else {
        return Duration::ZERO;
    };
    let Ok(elapsed) = (now - last_attempt).to_std() else {
        return interval;
    };
    interval.saturating_sub(elapsed)
}

const fn default_auto_update_enabled() -> bool {
    true
}

const fn is_zero(value: &u8) -> bool {
    *value == 0
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

    #[test]
    fn update_preferences_default_to_enabled_and_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATE_PREFERENCES_FILE);
        assert!(load_update_preferences(&path).auto_update_enabled);

        let preferences = UpdatePreferences {
            auto_update_enabled: false,
            consecutive_failures: 2,
            last_attempt_at: Some("2026-08-02T00:00:00Z".to_owned()),
            pending_version: Some("2.0.0".to_owned()),
        };
        write_update_preferences(&path, &preferences).unwrap();
        let loaded = load_update_preferences(&path);
        assert!(!loaded.auto_update_enabled);
        assert_eq!(loaded.consecutive_failures, 2);
        assert_eq!(loaded.pending_version.as_deref(), Some("2.0.0"));
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));

        fs::write(&path, b"not-json").unwrap();
        assert!(load_update_preferences(&path).auto_update_enabled);

        fs::write(&path, br#"{"autoUpdateEnabled":false}"#).unwrap();
        let migrated = load_update_preferences(&path);
        assert!(!migrated.auto_update_enabled);
        assert_eq!(migrated.consecutive_failures, 0);
        assert!(migrated.last_attempt_at.is_none());
        assert!(migrated.pending_version.is_none());
    }

    #[test]
    fn automatic_check_cadence_uses_regular_and_bounded_retry_delays() {
        let now = DateTime::parse_from_rfc3339("2026-08-02T06:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut preferences = UpdatePreferences {
            last_attempt_at: Some("2026-08-02T05:50:00Z".to_owned()),
            ..UpdatePreferences::default()
        };
        assert_eq!(
            automatic_check_delay(&preferences, now),
            Duration::from_secs(21_000)
        );

        for (failures, expected) in [(1, 300), (2, 3_000), (3, 21_000), (8, 21_000)] {
            preferences.consecutive_failures = failures;
            assert_eq!(
                automatic_check_delay(&preferences, now),
                Duration::from_secs(expected)
            );
        }

        preferences.last_attempt_at = Some("2026-08-01T00:00:00Z".to_owned());
        assert_eq!(automatic_check_delay(&preferences, now), Duration::ZERO);
    }

    #[test]
    fn pending_version_is_immediately_due_until_a_failed_redownload_backs_off() {
        let now = DateTime::parse_from_rfc3339("2026-08-02T06:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut preferences = UpdatePreferences {
            last_attempt_at: Some("2026-08-02T05:59:00Z".to_owned()),
            pending_version: Some("2.0.0".to_owned()),
            ..UpdatePreferences::default()
        };
        assert_eq!(automatic_check_delay(&preferences, now), Duration::ZERO);
        preferences.consecutive_failures = 1;
        assert_eq!(
            automatic_check_delay(&preferences, now),
            Duration::from_secs(14 * 60)
        );
    }

    #[tokio::test]
    async fn update_check_gate_releases_after_success_and_error_returns() {
        async fn run(gate: &tokio::sync::Mutex<()>, fail: bool) -> Result<(), ()> {
            let _guard = gate.try_lock().map_err(|_| ())?;
            if fail {
                return Err(());
            }
            Ok(())
        }

        let gate = tokio::sync::Mutex::new(());
        let held = gate.try_lock().unwrap();
        assert!(run(&gate, false).await.is_err());
        drop(held);

        assert!(run(&gate, false).await.is_ok());
        assert!(gate.try_lock().is_ok());
        assert!(run(&gate, true).await.is_err());
        assert!(gate.try_lock().is_ok());
    }
}
