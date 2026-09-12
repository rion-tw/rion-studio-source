#[test]
fn startup_cleanup_warning_uses_capture_persistence_and_event_publication() {
    let (_directory, core) = core();
    let receiver = core.subscribe().unwrap();
    core.capture_retired_local_storage_cleanup_warning(2)
        .unwrap();

    let page = core
        .invoke(command(json!({
            "type": "logsQuery",
            "query": { "limit": 100 }
        })))
        .unwrap();
    let warning = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["event"] == "storage.retired-local-storage-replay-cleanup-failed"
        })
        .unwrap();
    assert_eq!(warning["context"]["errorCount"], 2);

    let mut published = false;
    for _ in 0..16 {
        let events = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        published |= events.iter().any(|event| matches!(
            event,
            CoreEvent::LogEntriesCaptured { entries }
                if entries.iter().any(|entry|
                    entry.event == "storage.retired-local-storage-replay-cleanup-failed")
        ));
        if published {
            break;
        }
    }
    assert!(published);
}

#[test]
fn logs_clear_bypasses_level_filter_and_publishes_its_audit_entry() {
    let (_directory, core) = core();
    core.invoke(CoreCommand::LogsSetLevel {
        level: LogLevel::Error,
    })
    .unwrap();
    core.invoke(CoreCommand::LogsCapture {
        entries: vec![LogCaptureRecord {
            level: LogLevel::Error,
            source: crate::model::LogSource::Main,
            event: "before_clear".to_owned(),
            message: "Failure before clear.".to_owned(),
            context_raw_json: None,
            error: None,
        }],
    })
    .unwrap();
    let receiver = core.subscribe().unwrap();

    assert_eq!(core.invoke(CoreCommand::LogsClear).unwrap(), json!({ "cleared": true }));
    let page = core
        .invoke(command(json!({
            "type": "logsQuery",
            "query": { "limit": 100 }
        })))
        .unwrap();
    let entries = page["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["event"], "logs_cleared");
    assert_eq!(entries[0]["level"], "info");
    assert_eq!(entries[0]["applicationVersion"], "2.1.0-test");
    assert_eq!(entries[0]["packaged"], false);

    let mut events = Vec::new();
    for _ in 0..16 {
        events.extend(receiver.recv_timeout(Duration::from_secs(2)).unwrap());
        if events.iter().any(|event| matches!(
            event,
            CoreEvent::LogEntriesCaptured { entries }
                if entries.len() == 1 && entries[0].event == "logs_cleared"
        )) {
            break;
        }
    }
    assert!(events.iter().any(|event| matches!(
        event,
        CoreEvent::LogEntriesCaptured { entries }
            if entries.len() == 1 && entries[0].event == "logs_cleared"
    )));
    assert!(events.iter().any(|event| matches!(event, CoreEvent::LogsChanged)));
}

#[test]
fn log_level_change_is_audited_and_debug_status_proves_debug_capture() {
    let (_directory, core) = core();
    core.invoke(CoreCommand::LogsSetLevel {
        level: LogLevel::Debug,
    })
    .unwrap();
    core.invoke(CoreCommand::LogsCapture {
        entries: vec![LogCaptureRecord {
            level: LogLevel::Debug,
            source: crate::model::LogSource::Macro,
            event: "trusted_input_terminal".to_owned(),
            message: "Trusted input reached a terminal outcome.".to_owned(),
            context_raw_json: Some(r#"{"applicationPath":"cdp"}"#.to_owned()),
            error: None,
        }],
    })
    .unwrap();

    let page = core
        .invoke(command(json!({
            "type": "logsQuery",
            "query": { "limit": 100 }
        })))
        .unwrap();
    let entries = page["entries"].as_array().unwrap();
    let audit = entries
        .iter()
        .find(|entry| entry["event"] == "log_level_changed")
        .unwrap();
    assert_eq!(audit["context"]["previousLevel"], "debug");
    assert_eq!(audit["context"]["newLevel"], "debug");

    let status = core.invoke(CoreCommand::LogsStatus).unwrap();
    assert_eq!(status["currentLevel"], "debug");
    assert_eq!(status["debugEntryCount"], 2);
    assert_eq!(status["infoEntryCount"], 1);
    assert!(status["newestDebugTimestamp"].is_string());
}
