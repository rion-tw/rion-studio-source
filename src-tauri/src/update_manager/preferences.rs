use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{AUTOMATIC_UPDATE_INTERVAL, AUTOMATIC_UPDATE_RETRY_DELAYS};

pub(super) const UPDATE_PREFERENCES_FILE: &str = "app-update-preferences.json";
static UPDATE_PREFERENCES_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdatePreferences {
    #[serde(default = "default_auto_update_enabled")]
    pub(super) auto_update_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) last_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(super) consecutive_failures: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_version: Option<String>,
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

pub(super) fn load_update_preferences(path: &Path) -> UpdatePreferences {
    fs::read(path)
        .ok()
        .and_then(|content| serde_json::from_slice::<UpdatePreferences>(&content).ok())
        .unwrap_or_default()
}

pub(super) fn write_update_preferences(
    path: &Path,
    preferences: &UpdatePreferences,
) -> Result<(), String> {
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

pub(super) fn automatic_check_delay(
    preferences: &UpdatePreferences,
    now: DateTime<Utc>,
) -> Duration {
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
