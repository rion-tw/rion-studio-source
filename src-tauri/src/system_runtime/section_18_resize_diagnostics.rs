impl SystemRuntimeExecutor {
    fn record_resize_worker_event(
        &self,
        window_label: &str,
        status: &'static str,
        received_count: u64,
        coalesced_count: u64,
        applied_count: u64,
        elapsed: Duration,
    ) {
        let (level, event, message) = match status {
            "timed-out" => (
                LogLevel::Warn,
                "native.window-resize-worker-timed-out",
                "The native resize worker exceeded its geometry-lane deadline.",
            ),
            "spawn-failed" => (
                LogLevel::Error,
                "native.window-resize-worker-spawn-failed",
                "The native resize worker could not be started.",
            ),
            "settled" => (
                LogLevel::Debug,
                "native.window-resize-worker-settled",
                "The native resize worker applied its final exact projection.",
            ),
            "stopped" => (
                LogLevel::Debug,
                "native.window-resize-worker-stopped",
                "The native resize worker stopped before settling.",
            ),
            _ => (
                LogLevel::Debug,
                "native.window-resize-worker-started",
                "The native resize worker started.",
            ),
        };
        let context = json!({
            "appliedCount": applied_count,
            "coalescedCount": coalesced_count,
            "elapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "receivedCount": received_count,
            "status": status,
            "windowLabel": window_label,
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Browser,
                        event: event.to_owned(),
                        message: message.to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }
}
