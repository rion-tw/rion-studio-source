fn failed_native_presentation_outcome(message: String) -> NativePresentationOutcome {
    NativePresentationOutcome {
        applied: true,
        presentation_applied: false,
        focus_applied: false,
        focus_superseded: false,
        hidden_surface_count: 0,
        hide_ms: 0,
        main_queue_wait_ms: 0,
        main_thread_ms: 0,
        no_op: false,
        shown_surface_count: 0,
        show_ms: 0,
        visibility_errors: vec![message],
        webview_focus_ms: 0,
        window_focused_after: None,
        window_focus_applied: false,
        window_focus_ms: 0,
        window_restore_applied: false,
        window_visible_after: None,
        window_visibility_ms: 0,
        window_was_minimized: None,
    }
}

fn capture_presentation_batch_events(
    batch: &NativePresentationBatch,
    outcome: &NativePresentationOutcome,
    receipt: &NativePresentationReceipt,
) {
    let request = &batch.request;
    let elapsed_ms = request
        .requested_at
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let first_revision = if batch.first_revision == 0 {
        request.revision
    } else {
        batch.first_revision
    };
    let context = json!({
        "coalescedCount": batch.request_count.saturating_sub(1),
        "elapsedMs": elapsed_ms,
        "firstRevision": first_revision,
        "firstRequestAgeMs": batch.first_requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        "focusApplied": outcome.focus_applied,
        "focusSuperseded": outcome.focus_superseded,
        "focusMode": request.focus.diagnostic_name(),
        "hideMs": outcome.hide_ms,
        "hiddenSurfaceCount": outcome.hidden_surface_count,
        "mainQueueWaitMs": outcome.main_queue_wait_ms,
        "mainThreadMs": outcome.main_thread_ms,
        "noOp": outcome.no_op,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "presentationApplied": outcome.presentation_applied,
        "preCloseTransition": request.trigger.contains("close"),
        "requestCount": batch.request_count,
        "revision": request.revision,
        "receiptAppliedRevision": receipt.applied_revision,
        "receiptStatus": receipt.status.as_str(),
        "receiptSurfaceCount": receipt.surface_identities.len(),
        "showMs": outcome.show_ms,
        "shownSurfaceCount": outcome.shown_surface_count,
        "tabId": request.tab_id,
        "trigger": request.trigger,
        "visibilityErrorCount": outcome.visibility_errors.len(),
        "webViewFocusMs": outcome.webview_focus_ms,
        "windowId": request.window_id,
        "windowFocusedAfter": outcome.window_focused_after,
        "windowFocusApplied": outcome.window_focus_applied,
        "windowFocusMs": outcome.window_focus_ms,
        "windowRestoreApplied": outcome.window_restore_applied,
        "windowVisibleAfter": outcome.window_visible_after,
        "windowVisibilityMs": outcome.window_visibility_ms,
        "windowWasMinimized": outcome.window_was_minimized,
    });
    let completion_event = if !outcome.visibility_errors.is_empty() {
        "native.presentation-failed"
    } else if outcome.applied {
        "native.presentation-completed"
    } else {
        "tab.selection-superseded"
    };
    let completion_message = if !outcome.visibility_errors.is_empty() {
        "Native tab presentation encountered a platform visibility error."
    } else if outcome.applied {
        "Native tab presentation completed on the platform UI thread."
    } else {
        "A stale native tab presentation was discarded before platform mutation."
    };
    let mut entries = vec![
        LogCaptureRecord {
            level: LogLevel::Debug,
            source: LogSource::Browser,
            event: "tab.selection-coalesced".to_owned(),
            message: "Runtime tab selection requests were coalesced into one native batch."
                .to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        },
        LogCaptureRecord {
            level: if outcome.visibility_errors.is_empty() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            source: LogSource::Browser,
            event: completion_event.to_owned(),
            message: completion_message.to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: (!outcome.visibility_errors.is_empty()).then(|| LogErrorDetails {
                name: "NATIVE_PRESENTATION_FAILED".to_owned(),
                message: outcome.visibility_errors.join("; "),
                stack: None,
                cause: None,
            }),
        },
    ];
    if outcome.main_queue_wait_ms > 100 || outcome.main_thread_ms > 100 {
        entries.push(LogCaptureRecord {
            level: LogLevel::Warn,
            source: LogSource::Browser,
            event: "native.event-loop-heartbeat-delayed".to_owned(),
            message: "The platform UI-thread presentation exceeded its latency budget.".to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        });
    }
    let core = Arc::clone(&request.core);
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture { entries })
            .await;
    });
}
