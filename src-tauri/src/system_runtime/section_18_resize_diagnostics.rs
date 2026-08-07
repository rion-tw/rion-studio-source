impl SystemRuntimeExecutor {
    #[cfg(windows)]
    fn record_windows_geometry_receipt(
        &self,
        window_id: &str,
        receipt: WindowsGeometryReceipt,
    ) {
        let status = match receipt.status {
            WindowsGeometryStatus::Applied => "applied",
            WindowsGeometryStatus::Failed => "failed",
            WindowsGeometryStatus::Unchanged => "unchanged",
        };
        let context = json!({
            "dpi": receipt.key.dpi,
            "frameRevision": receipt.key.frame_revision,
            "height": receipt.key.height,
            "hostGeneration": receipt.key.generation,
            "planRevision": receipt.key.plan_revision,
            "presentation": match receipt.key.presentation {
                WindowsGeometryPresentation::Maximized => "maximized",
                WindowsGeometryPresentation::Restored => "restored",
            },
            "status": status,
            "terminal": receipt.terminal,
            "width": receipt.key.width,
            "windowId": window_id,
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if receipt.status == WindowsGeometryStatus::Failed {
                            LogLevel::Warn
                        } else {
                            LogLevel::Debug
                        },
                        source: LogSource::Browser,
                        event: "native.windows-geometry-receipt".to_owned(),
                        message: "The Windows geometry coordinator completed a revision-fenced frame."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    #[cfg(windows)]
    fn record_windows_live_resize_counters(
        &self,
        window_label: &str,
        counters: WindowsLiveResizeCounters,
        observation: WindowsLiveResizeObservation,
    ) {
        if counters.received == 0 {
            return;
        }
        let context = json!({
            "appliedCount": counters.applied,
            "clientHeight": observation.client_height,
            "clientWidth": observation.client_width,
            "deferredCount": counters.deferred,
            "errorCount": counters.errors,
            "eventHeight": observation.event_height,
            "eventWidth": observation.event_width,
            "fallbackCount": counters.fallback,
            "frameSequence": observation.frame_sequence,
            "matchedLatestFrame": observation.matched_latest_frame,
            "matchStatus": observation.match_status,
            "nativeFastPathAvailable": observation.native_fast_path_available,
            "nativeFrameUnchanged": observation.native_frame_unchanged,
            "parentPositionAppliedCount": counters.parent_position_applied,
            "parentPositionErrorCount": counters.parent_position_errors,
            "parentPositionReceivedCount": counters.parent_position_received,
            "platform": "windows",
            "planEpoch": observation.plan_epoch,
            "receivedCount": counters.received,
            "unchangedCount": counters.unchanged,
            "windowLabel": window_label,
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if counters.errors > 0 {
                            LogLevel::Warn
                        } else {
                            LogLevel::Debug
                        },
                        source: LogSource::Browser,
                        event: "native.window-live-resize".to_owned(),
                        message: "The Windows UI-thread live resize adapter drained its frame counters."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    #[cfg(not(windows))]
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
