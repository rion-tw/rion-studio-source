use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use rion_core::{AppUpdateInstallAttemptRecord, AppUpdateStatusRecord};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

use crate::{
    native_shell,
    update_transaction::{
        InstallAttemptGate, InstallBoundary, InstallJournalRecovery, InstallPlatform,
        install_boundary_contract, install_journal_path, reconcile_install_journal,
        write_install_journal,
    },
};

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

#[path = "update_manager/preferences.rs"]
mod preferences;
use preferences::{
    UPDATE_PREFERENCES_FILE, UpdatePreferences, automatic_check_delay, load_update_preferences,
    write_update_preferences,
};

struct PendingUpdate {
    bytes: Arc<Vec<u8>>,
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
    install_submission: Mutex<()>,
    install_gate: InstallAttemptGate,
    install_journal_path: PathBuf,
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
        let install_journal_path = install_journal_path(user_data_dir);
        let journal_recovery = reconcile_install_journal(&install_journal_path, &current_version);
        if preferences.pending_version.as_deref() == Some(&current_version)
            || matches!(journal_recovery, InstallJournalRecovery::Applied(_))
        {
            preferences.pending_version = None;
            preferences.consecutive_failures = 0;
            let _ = write_update_preferences(&preferences_path, &preferences);
        }
        let auto_update_enabled = preferences.auto_update_enabled;
        let startup_status = match &journal_recovery {
            InstallJournalRecovery::Applied(attempt) => json!({
                "currentVersion": current_version,
                "installMode": "automatic",
                "isPackaged": packaged,
                "autoUpdateEnabled": auto_update_enabled,
                "state": if packaged && configured { "idle" } else { "unsupported" },
                "installAttempt": attempt
            }),
            InstallJournalRecovery::Failed(attempt, code) => json!({
                "currentVersion": current_version,
                "installMode": "automatic",
                "isPackaged": packaged,
                "autoUpdateEnabled": auto_update_enabled,
                "state": "install_failed",
                "availableVersion": attempt.target_version,
                "installAttempt": attempt,
                "canRetryInstall": false,
                "errorCode": code,
                "error": "The update did not advance the installed application version."
            }),
            InstallJournalRecovery::Corrupt(code) => json!({
                "currentVersion": current_version,
                "installMode": "automatic",
                "isPackaged": packaged,
                "autoUpdateEnabled": auto_update_enabled,
                "state": "install_failed",
                "canRetryInstall": false,
                "errorCode": code,
                "error": "The previous update transaction journal could not be recovered."
            }),
            InstallJournalRecovery::None => json!({
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
            }),
        };
        Self {
            app,
            automatic_force_check: AtomicBool::new(false),
            check_gate: tokio::sync::Mutex::new(()),
            configured,
            current_version: current_version.clone(),
            install_submission: Mutex::new(()),
            install_gate: InstallAttemptGate::default(),
            install_journal_path,
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
            status: Mutex::new(startup_status),
        }
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| self.error_status("Update status is unavailable."))
    }

    pub fn status_record(&self) -> AppUpdateStatusRecord {
        serde_json::from_value(self.status()).unwrap_or_else(|_| AppUpdateStatusRecord {
            current_version: self.current_version.clone(),
            install_mode: "automatic".to_owned(),
            is_packaged: self.packaged,
            auto_update_enabled: self.auto_update_enabled(),
            state: if self.packaged {
                "error"
            } else {
                "unsupported"
            }
            .to_owned(),
            available_version: None,
            download_progress: None,
            download_url: None,
            release_page_url: None,
            installer_name: None,
            error: Some("Update status is unavailable.".to_owned()),
            error_code: Some("UPDATE_STATUS_UNAVAILABLE".to_owned()),
            checked_at: Some(chrono::Utc::now().to_rfc3339()),
            install_attempt: None,
            can_retry_install: None,
        })
    }

    pub fn set_auto_update_enabled(&self, enabled: bool) -> Result<AppUpdateStatusRecord, String> {
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
        serde_json::from_value(status).map_err(|error| error.to_string())
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

    pub async fn check_manual(&self) -> AppUpdateStatusRecord {
        self.check(UpdateCheckReason::Manual).await;
        self.status_record()
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
            .on_before_exit(move || {
                let (post_drain_phase, post_drain_state) = match install_boundary_contract(
                    InstallPlatform::Windows,
                    InstallBoundary::BeforeExit,
                ) {
                    Ok(contract) => contract,
                    Err(_) => {
                        let _ = crate::prepare_application_update_exit(&before_exit_app);
                        before_exit_app.cleanup_before_exit();
                        before_exit_app.restart();
                    }
                };
                let draining_transition = before_exit_app
                    .try_state::<crate::CoreState>()
                    .map(|state| {
                        state
                            .updates
                            .transition_install("draining", "draining", None, None, false)
                    })
                    .transpose();
                if draining_transition.is_err() {
                    let _ = crate::prepare_application_update_exit(&before_exit_app);
                    before_exit_app.cleanup_before_exit();
                    before_exit_app.restart();
                }
                let drain_result = crate::prepare_application_update_exit(&before_exit_app);
                let terminal_transition = before_exit_app
                    .try_state::<crate::CoreState>()
                    .map(|state| {
                        if let Err(error) = drain_result.as_ref() {
                            state.updates.transition_install(
                                "failedAfterDrain",
                                "install_failed",
                                Some("UPDATE_INSTALL_DRAIN_FAILED"),
                                Some(error),
                                false,
                            )
                        } else {
                            state.updates.transition_install(
                                post_drain_phase,
                                post_drain_state,
                                None,
                                None,
                                false,
                            )
                        }
                    })
                    .transpose();
                if drain_result.is_err() || terminal_transition.is_err() {
                    before_exit_app.cleanup_before_exit();
                    before_exit_app.restart();
                }
                before_exit_app.cleanup_before_exit();
            })
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
                *pending = Some(PendingUpdate {
                    bytes: Arc::new(bytes),
                    update,
                });
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

    pub fn accept_install(&self) -> Result<(AppUpdateInstallAttemptRecord, bool), String> {
        let _submission = self
            .install_submission
            .lock()
            .map_err(|_| "Update install submission gate is unavailable.".to_owned())?;
        if let Some(attempt) = self.install_gate.active_attempt()? {
            return Ok((attempt, false));
        }
        let target_version = self
            .pending
            .lock()
            .map_err(|_| "Pending update state is unavailable.".to_owned())?
            .as_ref()
            .map(|pending| pending.update.version.clone())
            .ok_or_else(|| "No verified update is ready to install.".to_owned())?;
        let (attempt, leader) = self.install_gate.accept(&target_version)?;
        if leader {
            if let Err(error) = write_install_journal(&self.install_journal_path, &attempt) {
                let _ = self.install_gate.transition(
                    "failedBeforeDrain",
                    Some("UPDATE_INSTALL_JOURNAL_WRITE_FAILED"),
                );
                return Err(error);
            }
            self.set_install_status("preparing", &attempt, None, None, false);
        }
        Ok((attempt, leader))
    }

    pub fn transition_install(
        &self,
        phase: &str,
        state: &str,
        failure_code: Option<&str>,
        error: Option<&str>,
        can_retry: bool,
    ) -> Result<AppUpdateInstallAttemptRecord, String> {
        let attempt = self.install_gate.transition(phase, failure_code)?;
        if let Err(journal_error) = write_install_journal(&self.install_journal_path, &attempt) {
            let failed_after_drain = self.install_gate.has_started_draining();
            let failure = self
                .install_gate
                .transition(
                    if failed_after_drain {
                        "failedAfterDrain"
                    } else {
                        "failedBeforeDrain"
                    },
                    Some("UPDATE_INSTALL_JOURNAL_WRITE_FAILED"),
                )
                .unwrap_or(attempt);
            let _ = write_install_journal(&self.install_journal_path, &failure);
            self.set_install_status(
                "install_failed",
                &failure,
                Some("UPDATE_INSTALL_JOURNAL_WRITE_FAILED"),
                Some(&journal_error),
                !failed_after_drain,
            );
            return Err(journal_error);
        }
        self.set_install_status(state, &attempt, failure_code, error, can_retry);
        Ok(attempt)
    }

    pub fn install_downloaded(&self) -> Result<(), String> {
        let (update, bytes) = {
            let pending = self
                .pending
                .lock()
                .map_err(|_| "Pending update state is unavailable.".to_owned())?;
            let pending = pending
                .as_ref()
                .ok_or_else(|| "No verified update is ready to install.".to_owned())?;
            (pending.update.clone(), Arc::clone(&pending.bytes))
        };
        if let Err(error) = update.install(bytes.as_slice()) {
            return Err(error.to_string());
        }
        if let Ok(mut pending) = self.pending.lock()
            && pending
                .as_ref()
                .is_some_and(|pending| pending.update.version == update.version)
        {
            *pending = None;
        }
        Ok(())
    }

    pub fn install_has_started_draining(&self) -> bool {
        self.install_gate.has_started_draining()
    }

    fn set_install_status(
        &self,
        state: &str,
        attempt: &AppUpdateInstallAttemptRecord,
        error_code: Option<&str>,
        error: Option<&str>,
        can_retry: bool,
    ) -> Value {
        self.set_status(json!({
            "currentVersion": self.current_version,
            "installMode": "automatic",
            "isPackaged": self.packaged,
            "state": state,
            "availableVersion": attempt.target_version,
            "installAttempt": attempt,
            "canRetryInstall": can_retry,
            "errorCode": error_code,
            "error": error,
            "checkedAt": chrono::Utc::now().to_rfc3339()
        }))
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
#[path = "update_manager/tests.rs"]
mod tests;
