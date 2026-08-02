impl SystemRuntimeExecutor {
    #[allow(clippy::too_many_arguments)]
    fn load_or_rebuild_local_storage_sync_snapshot(
        &self,
        dependent_role_id: &str,
        source_role_id: &str,
        source_launch_url: &str,
        origin: &str,
        keys: &[String],
        selectors: &[String],
        codec: Option<&str>,
    ) -> RuntimeResult<PersistedLocalStorageSyncSnapshot> {
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_LANE_POISONED",
                "The localStorage synchronization lifecycle lane is unavailable.",
            )
        })?;
        match self.load_local_storage_sync_snapshot(
            source_role_id,
            origin,
            keys,
            selectors,
            codec,
        ) {
            Ok(snapshot) => Ok(snapshot),
            Err(error)
                if matches!(
                    error.code,
                    "LOCAL_STORAGE_SYNC_CACHE_UNAVAILABLE"
                        | "LOCAL_STORAGE_SYNC_CACHE_INVALID"
                        | "LOCAL_STORAGE_SYNC_CACHE_TOO_LARGE"
                ) =>
            {
                let snapshot = self.capture_local_storage_sync_source_snapshot(
                    source_role_id,
                    source_launch_url,
                    origin,
                    keys,
                    selectors,
                    codec,
                    false,
                )
                .inspect_err(|error| {
                    self.record_local_storage_sync_failure(
                        "dependentLaunch",
                        "cacheRebuildCapture",
                        error.code,
                        Some(dependent_role_id),
                        Some(source_role_id),
                        None,
                        0,
                        false,
                    );
                })?;
                self.persist_local_storage_sync_snapshot(snapshot.clone())
                    .inspect_err(|error| {
                        self.record_local_storage_sync_failure(
                            "dependentLaunch",
                            "cachePersist",
                            error.code,
                            Some(dependent_role_id),
                            Some(source_role_id),
                            None,
                            0,
                            false,
                        );
                    })?;
                Ok(snapshot)
            }
            Err(error) => {
                self.record_local_storage_sync_failure(
                    "dependentLaunch",
                    "cacheLoad",
                    error.code,
                    Some(dependent_role_id),
                    Some(source_role_id),
                    None,
                    0,
                    false,
                );
                Err(error)
            }
        }
    }

    fn record_local_storage_sync_cache_rebuild_skipped(
        &self,
        role_id: &str,
        source_role_id: &str,
        error: &RuntimeError,
    ) {
        let should_record = self.state.lock().ok().is_none_or(|mut state| {
            state
                .local_storage_sync_diagnostics
                .insert((role_id.to_owned(), error.code.to_owned()), 0)
                .is_none()
        });
        if !should_record {
            return;
        }
        let context = json!({
            "dependentRoleId": role_id,
            "rootCauseCode": error.code,
            "sourceRoleId": source_role_id,
        });
        let core = Arc::clone(&self.core);
        let details = log_error_details(error.code, &error.message);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Warn,
                        source: LogSource::Browser,
                        event: "local-storage-sync.cache-rebuild-skipped".to_owned(),
                        message: "The dependent role launched with its own local settings because the source snapshot could not be rebuilt.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: Some(details),
                    }],
                })
                .await;
        });
    }
}
