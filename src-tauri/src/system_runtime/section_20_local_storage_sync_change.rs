struct StagedLocalStorageSyncError {
    error: RuntimeError,
    source_role_id: Option<String>,
    stage: &'static str,
}

impl StagedLocalStorageSyncError {
    fn new(stage: &'static str, error: RuntimeError) -> Self {
        Self {
            error,
            source_role_id: None,
            stage,
        }
    }

    fn with_source(mut self, source_role_id: Option<&str>) -> Self {
        self.source_role_id = source_role_id.map(str::to_owned);
        self
    }
}

impl SystemRuntimeExecutor {
    pub fn local_storage_sync_changed(
        &self,
        webview_label: &str,
        request: LocalStorageSyncChangeRequest,
    ) -> Result<(), String> {
        let generation = request.generation;
        let _local_storage_sync_guard = match self.local_storage_sync_lane.lock() {
            Ok(guard) => guard,
            Err(_) => {
                self.record_local_storage_sync_failure(
                    "pageChange",
                    "lifecycleLane",
                    "LOCAL_STORAGE_SYNC_LANE_POISONED",
                    None,
                    None,
                    Some(generation),
                    0,
                    false,
                );
                return Err(
                    "The localStorage synchronization lifecycle lane is unavailable.".to_owned(),
                );
            }
        };
        let role_id = match self.role_id_for_webview(webview_label) {
            Ok(role_id) => role_id,
            Err(message) => {
                self.record_local_storage_sync_failure(
                    "pageChange",
                    "authorization",
                    "LOCAL_STORAGE_SYNC_ROLE_UNAVAILABLE",
                    None,
                    None,
                    Some(generation),
                    0,
                    false,
                );
                return Err(message);
            }
        };
        match self.local_storage_sync_changed_for_role(&role_id, webview_label, request) {
            Ok(()) => Ok(()),
            Err(failure) => {
                self.record_local_storage_sync_failure(
                    "pageChange",
                    failure.stage,
                    failure.error.code,
                    Some(&role_id),
                    failure.source_role_id.as_deref(),
                    Some(generation),
                    0,
                    true,
                );
                Err(failure.error.message)
            }
        }
    }

    fn local_storage_sync_changed_for_role(
        &self,
        role_id: &str,
        webview_label: &str,
        request: LocalStorageSyncChangeRequest,
    ) -> Result<(), StagedLocalStorageSyncError> {
        let (config, webview) = {
            let state = self
                .state()
                .map_err(|error| StagedLocalStorageSyncError::new("authorization", error))?;
            let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                StagedLocalStorageSyncError::new(
                    "authorization",
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_ROLE_UNAVAILABLE",
                        "Runtime role was not found.",
                    ),
                )
            })?;
            let surface = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .ok_or_else(|| {
                    StagedLocalStorageSyncError::new(
                        "authorization",
                        RuntimeError::new(
                            "LOCAL_STORAGE_SYNC_ROLE_UNAVAILABLE",
                            "Runtime role was not found.",
                        ),
                    )
                })?;
            let config = surface.local_storage_sync.clone().ok_or_else(|| {
                StagedLocalStorageSyncError::new(
                    "authorization",
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_CAPABILITY_UNAVAILABLE",
                        "This role has no localStorage synchronization capability.",
                    ),
                )
            })?;
            (config, surface.webview.clone())
        };
        if config.token != request.token || config.generation != request.generation {
            return Err(StagedLocalStorageSyncError::new(
                "authorization",
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_UNAUTHORIZED",
                    "The localStorage synchronization capability is invalid.",
                ),
            )
            .with_source(config.source_role_id.as_deref()));
        }
        require_exact_local_storage_sync_origin(&webview, &config.origin)
            .map_err(|error| {
                StagedLocalStorageSyncError::new("originValidation", error)
                    .with_source(config.source_role_id.as_deref())
            })?;
        if request.entries.len() != config.keys.len()
            || request
                .entries
                .iter()
                .zip(&config.keys)
                .any(|((key, _), expected)| key != expected)
        {
            return Err(StagedLocalStorageSyncError::new(
                "payloadValidation",
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_KEYS_INVALID",
                    "The localStorage synchronization key set is invalid.",
                ),
            )
            .with_source(config.source_role_id.as_deref()));
        }
        validate_local_storage_sync_selector_entries(
            config.codec.as_deref(),
            &config.selectors,
            &request.selector_entries,
        )
        .map_err(|error| {
            StagedLocalStorageSyncError::new("payloadValidation", error)
                .with_source(config.source_role_id.as_deref())
        })?;
        if request.diagnostic_code.as_deref().is_some_and(|code| {
            !local_storage_sync_diagnostic_is_valid(config.codec.as_deref(), code)
        }) {
            return Err(StagedLocalStorageSyncError::new(
                "payloadValidation",
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_DIAGNOSTIC_INVALID",
                    "The localStorage synchronization diagnostic is invalid.",
                ),
            )
            .with_source(config.source_role_id.as_deref()));
        }
        {
            let mut state = self.state().map_err(|error| {
                StagedLocalStorageSyncError::new("generationFence", error)
                    .with_source(config.source_role_id.as_deref())
            })?;
            let tab_id = state
                .role_tabs
                .get(role_id)
                .cloned()
                .ok_or_else(|| {
                    StagedLocalStorageSyncError::new(
                        "generationFence",
                        RuntimeError::new(
                            "LOCAL_STORAGE_SYNC_ROLE_UNAVAILABLE",
                            "Runtime role was not found.",
                        ),
                    )
                    .with_source(config.source_role_id.as_deref())
                })?;
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(role_id))
                .filter(|surface| surface.webview.label() == webview_label)
                .ok_or_else(|| {
                    StagedLocalStorageSyncError::new(
                        "generationFence",
                        RuntimeError::new(
                            "LOCAL_STORAGE_SYNC_STALE",
                            "Runtime role generation changed during localStorage synchronization.",
                        ),
                    )
                    .with_source(config.source_role_id.as_deref())
                })?;
            if !surface
                .local_storage_sync
                .as_ref()
                .is_some_and(|config| {
                    config.token == request.token && config.generation == request.generation
                })
            {
                return Err(StagedLocalStorageSyncError::new(
                    "generationFence",
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_STALE",
                        "The localStorage synchronization capability is stale.",
                    ),
                )
                .with_source(config.source_role_id.as_deref()));
            }
            if !accept_local_storage_sync_sequence(
                &mut surface.local_storage_sync_sequence,
                request.sequence,
            ) {
                return Ok(());
            }
        }
        if let Some(code) = request.diagnostic_code.as_deref() {
            self.record_local_storage_sync_diagnostic(role_id, &config, code);
            if matches!(
                code,
                "FLYFF_SETTINGS_INVALID" | "FLYFF_CHINA_SETTINGS_INVALID"
            ) {
                return Ok(());
            }
        }
        if let Some(source_role_id) = config.source_role_id.as_deref() {
            let snapshot = self
                .load_local_storage_sync_snapshot(
                    source_role_id,
                    &config.origin,
                    &config.keys,
                    &config.selectors,
                    config.codec.as_deref(),
                )
                .map_err(|error| {
                    StagedLocalStorageSyncError::new("dependentSnapshotLoad", error)
                        .with_source(Some(source_role_id))
                })?;
            let script = local_storage_sync_apply_script(&snapshot).map_err(|error| {
                StagedLocalStorageSyncError::new("dependentApply", error)
                    .with_source(Some(source_role_id))
            })?;
            webview
                .eval(script)
                .map_err(RuntimeError::tauri)
                .map_err(|error| {
                    StagedLocalStorageSyncError::new("dependentApply", error)
                        .with_source(Some(source_role_id))
                })?;
            return Ok(());
        }
        if config.dependent_role_ids.is_empty() {
            return Ok(());
        }
        let snapshot = PersistedLocalStorageSyncSnapshot {
            codec: config.codec.clone(),
            schema_version: 2,
            source_role_id: role_id.to_owned(),
            origin: config.origin.clone(),
            entries: request.entries,
            selector_entries: request.selector_entries,
        };
        self.persist_local_storage_sync_snapshot(snapshot.clone())
            .map_err(|error| StagedLocalStorageSyncError::new("sourcePersist", error))?;
        self.apply_local_storage_sync_to_running_dependents(role_id, &snapshot)
            .map_err(|error| StagedLocalStorageSyncError::new("dependentFanout", error))
    }
}
