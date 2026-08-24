#[cfg(any(test, all(windows, feature = "desktop-e2e")))]
fn selected_surface_reprojection_stale_reasons(results: &[Value]) -> Vec<String> {
    let mut reasons = results
        .iter()
        .filter(|result| result.get("status").and_then(Value::as_str) == Some("stale"))
        .filter_map(|result| result.get("staleReason").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    reasons.sort_unstable();
    reasons.dedup();
    reasons
}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    fn record_windows_selected_surface_reprojection(
        &self,
        target: &WindowsSelectedSurfaceReprojectionTarget,
        phase: LaunchPhase,
        elapsed: Duration,
        reparented_surface_count: usize,
        bounds_projection_error: Option<String>,
        results: Vec<Value>,
    ) {
        let failed = bounds_projection_error.is_some()
            || results.iter().any(|result| {
                matches!(
                    result.get("status").and_then(Value::as_str),
                    Some("failed" | "indeterminate")
                )
            });
        let applied_surface_count = results
            .iter()
            .filter(|result| result.get("status").and_then(Value::as_str) == Some("applied"))
            .count();
        let stale_surface_count = results
            .iter()
            .filter(|result| result.get("status").and_then(Value::as_str) == Some("stale"))
            .count();
        #[cfg(feature = "desktop-e2e")]
        let stale_reasons = selected_surface_reprojection_stale_reasons(&results);
        let status = if failed {
            "failed"
        } else if applied_surface_count == 0 {
            "superseded"
        } else {
            "applied"
        };
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "native-selected-surfaces-reprojected",
            Some(&target.fence.window_id),
            Some(target.fence.window_generation),
            None,
            json!({
                "appliedSurfaceCount": applied_surface_count,
                "failed": failed,
                "launchPhase": phase.as_str(),
                "reparentedSurfaceCount": reparented_surface_count,
                "revision": target.fence.revision,
                "staleReasons": stale_reasons,
                "staleSurfaceCount": stale_surface_count,
                "status": status,
                "surfaceCount": target.surfaces.len(),
                "tabId": target.fence.tab_id,
            }),
        );
        let context = json!({
            "appliedSurfaceCount": applied_surface_count,
            "boundsProjectionError": bounds_projection_error,
            "elapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
            "launchPhase": phase.as_str(),
            "lifecycleEpoch": target.fence.lifecycle_epoch,
            "platform": "windows",
            "reparentedSurfaceCount": reparented_surface_count,
            "revision": target.fence.revision,
            "staleSurfaceCount": stale_surface_count,
            "status": status,
            "surfaceCount": target.surfaces.len(),
            "surfaceResults": results,
            "tabId": target.fence.tab_id,
            "windowGeneration": target.fence.window_generation,
            "windowId": target.fence.window_id,
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if failed { LogLevel::Warn } else { LogLevel::Debug },
                        source: LogSource::Browser,
                        event: "native.selected-surfaces-reprojected".to_owned(),
                        message: if failed {
                            "Selected System WebView surfaces did not all complete their post-batch native reprojection."
                        } else if status == "superseded" {
                            "Selected System WebView surface reprojection was superseded before native mutation."
                        } else {
                            "Selected System WebView surfaces completed their post-batch native reprojection."
                        }
                        .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: failed.then(|| {
                            log_error_details(
                                "SYSTEM_SELECTED_SURFACE_REPROJECTION_FAILED",
                                "One or more selected surfaces failed or became indeterminate during native reprojection.",
                            )
                        }),
                    }],
                })
                .await;
        });
    }
}
