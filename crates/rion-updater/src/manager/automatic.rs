use chrono::{DateTime, Duration, Utc};

use super::{ChromiumUpdateManager, UpdateManagerError, UpdateStatusEnvelope};
use crate::persistence::UpdatePreferences;

const AUTOMATIC_CHECK_INTERVAL_MINUTES: i64 = 6 * 60;
const AUTOMATIC_RETRY_DELAY_MINUTES: [i64; 3] = [15, 60, 6 * 60];

impl ChromiumUpdateManager {
    /// Runs an automatic check from an application event (startup or
    /// foreground) only when the user enabled automatic updates and the last
    /// attempt is old enough. Returns `None` when no check was started.
    pub fn check_for_updates_if_due(
        &self,
    ) -> Result<Option<UpdateStatusEnvelope>, UpdateManagerError> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| UpdateManagerError::StateUnavailable)?;
            if !self.config.packaged
                || state.pending.is_some()
                || state.check_in_flight.is_some()
                || !automatic_check_due(&state.preferences, Utc::now())
            {
                return Ok(None);
            }
        }
        self.check_for_updates().map(Some)
    }
}

pub(super) fn automatic_check_due(preferences: &UpdatePreferences, now: DateTime<Utc>) -> bool {
    if !preferences.auto_update_enabled {
        return false;
    }
    let Some(last_attempt) = preferences
        .last_attempt_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    else {
        return true;
    };
    let delay_minutes = match preferences.consecutive_failures {
        0 => AUTOMATIC_CHECK_INTERVAL_MINUTES,
        failures => {
            let index = usize::from(failures).min(AUTOMATIC_RETRY_DELAY_MINUTES.len()) - 1;
            AUTOMATIC_RETRY_DELAY_MINUTES[index]
        }
    };
    let elapsed = now.signed_duration_since(last_attempt.with_timezone(&Utc));
    // A clock moved backwards cannot postpone checks indefinitely.
    elapsed < Duration::zero() || elapsed >= Duration::minutes(delay_minutes)
}
