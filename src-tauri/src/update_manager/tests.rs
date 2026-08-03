use std::fs;

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
