const RECENT_RUNTIME_FAILURE_CAPACITY: usize = 20;

#[derive(Default)]
struct RuntimeDiagnosticsState {
    recent_failures: VecDeque<SystemRuntimeFailureRecord>,
}

impl RuntimeDiagnosticsState {
    fn push_failure(&mut self, failure: SystemRuntimeFailureRecord) {
        while self.recent_failures.len() >= RECENT_RUNTIME_FAILURE_CAPACITY {
            self.recent_failures.pop_front();
        }
        self.recent_failures.push_back(failure);
    }

    fn failures_newest_first(&self) -> Vec<SystemRuntimeFailureRecord> {
        self.recent_failures.iter().rev().cloned().collect()
    }
}

fn effect_acknowledgement_status(
    report: &CoreEffectDispatchReport,
    effect_id: &str,
) -> &'static str {
    if report.accepted.iter().any(|candidate| candidate == effect_id) {
        "accepted"
    } else if report.duplicate.iter().any(|candidate| candidate == effect_id) {
        "duplicate"
    } else if report.late.iter().any(|candidate| candidate == effect_id) {
        "late"
    } else if report.unknown.iter().any(|candidate| candidate == effect_id) {
        "unknown"
    } else if report
        .operation_mismatch
        .iter()
        .any(|candidate| candidate == effect_id)
    {
        "operationMismatch"
    } else {
        "missing"
    }
}

fn effect_acknowledgement_error_code(status: &str) -> Option<&'static str> {
    match status {
        "accepted" => None,
        "duplicate" => Some("CORE_EFFECT_ACK_DUPLICATE"),
        "late" => Some("CORE_EFFECT_ACK_LATE"),
        "unknown" => Some("CORE_EFFECT_ACK_UNKNOWN"),
        "operationMismatch" => Some("CORE_EFFECT_ACK_OPERATION_MISMATCH"),
        "dispatchFailed" => Some("CORE_EFFECT_ACK_DISPATCH_FAILED"),
        _ => Some("CORE_EFFECT_ACK_MISSING"),
    }
}

fn runtime_diagnostic_count(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

fn diagnostic_surface_is_closing(phase: ManagedSurfacePhase) -> bool {
    matches!(
        phase,
        ManagedSurfacePhase::CloseRequested
            | ManagedSurfacePhase::Isolating
            | ManagedSurfacePhase::Isolated
            | ManagedSurfacePhase::Releasing
            | ManagedSurfacePhase::Retired
    )
}

impl SystemRuntimeExecutor {
    fn remember_runtime_failure(&self, failure: SystemRuntimeFailureRecord) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.push_failure(failure);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_effect_failure(
        &self,
        action: &str,
        effect_id: &str,
        operation_id: &str,
        stage: &str,
        code: &str,
        acknowledgement_status: &str,
        elapsed: Duration,
        persist_runtime: bool,
        scope: &str,
    ) {
        let captured_at = chrono::Utc::now().to_rfc3339();
        self.remember_runtime_failure(SystemRuntimeFailureRecord {
            captured_at,
            subsystem: "effect".to_owned(),
            stage: stage.to_owned(),
            code: code.to_owned(),
            action: Some(action.to_owned()),
            effect_id: Some(effect_id.to_owned()),
            operation_id: Some(operation_id.to_owned()),
            role_id: None,
            source_role_id: None,
            tab_id: None,
            window_id: None,
            rollback_error_count: None,
        });
        let context = json!({
            "acknowledgementStatus": acknowledgement_status,
            "action": action,
            "effectId": effect_id,
            "elapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
            "errorCode": code,
            "operationId": operation_id,
            "persistRuntime": persist_runtime,
            "platform": current_runtime_platform(),
            "runtimeHealthy": self.health.is_healthy(),
            "scope": scope,
            "stage": stage,
        });
        let core = Arc::clone(&self.core);
        let error = log_error_details(
            code,
            "A native runtime effect did not complete cleanly.",
        );
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Warn,
                        source: LogSource::Browser,
                        event: "system-runtime.effect-failed".to_owned(),
                        message: "A native runtime effect did not complete cleanly.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: Some(error),
                    }],
                })
                .await;
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn record_effect_outcome_failures(
        &self,
        action: &str,
        effect_id: &str,
        operation_id: &str,
        result_error: Option<&rion_core::CoreErrorPayload>,
        acknowledgement_status: &str,
        elapsed: Duration,
        persist_runtime: bool,
        scope: &str,
    ) {
        if let Some(error) = result_error {
            let stage = if error.code == "SYSTEM_RUNTIME_PERSIST_FAILED" {
                "restoreSessionPersistence"
            } else {
                "nativeExecution"
            };
            self.record_effect_failure(
                action,
                effect_id,
                operation_id,
                stage,
                &error.code,
                acknowledgement_status,
                elapsed,
                persist_runtime,
                scope,
            );
        }
        if let Some(code) = effect_acknowledgement_error_code(acknowledgement_status) {
            self.record_effect_failure(
                action,
                effect_id,
                operation_id,
                "coreAcknowledgement",
                code,
                acknowledgement_status,
                elapsed,
                persist_runtime,
                scope,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_local_storage_sync_failure(
        &self,
        operation: &str,
        stage: &str,
        code: &str,
        role_id: Option<&str>,
        source_role_id: Option<&str>,
        generation: Option<u64>,
        rollback_error_count: usize,
        deduplicate: bool,
    ) {
        if deduplicate
            && let (Some(role_id), Some(generation)) = (role_id, generation)
        {
            let key = (role_id.to_owned(), format!("failure:{operation}:{stage}:{code}"));
            let should_record = self.state.lock().ok().is_none_or(|mut state| {
                if state.local_storage_sync_diagnostics.get(&key) == Some(&generation) {
                    false
                } else {
                    state.local_storage_sync_diagnostics.insert(key, generation);
                    true
                }
            });
            if !should_record {
                return;
            }
        }
        let rollback_error_count = runtime_diagnostic_count(rollback_error_count);
        self.remember_runtime_failure(SystemRuntimeFailureRecord {
            captured_at: chrono::Utc::now().to_rfc3339(),
            subsystem: "localStorageSync".to_owned(),
            stage: stage.to_owned(),
            code: code.to_owned(),
            action: Some(operation.to_owned()),
            effect_id: None,
            operation_id: None,
            role_id: role_id.map(str::to_owned),
            source_role_id: source_role_id.map(str::to_owned),
            tab_id: None,
            window_id: None,
            rollback_error_count: (rollback_error_count > 0).then_some(rollback_error_count),
        });
        let context = json!({
            "errorCode": code,
            "generation": generation,
            "operation": operation,
            "platform": current_runtime_platform(),
            "roleId": role_id,
            "rollbackErrorCount": rollback_error_count,
            "runtimeHealthy": self.health.is_healthy(),
            "sourceRoleId": source_role_id,
            "stage": stage,
        });
        let core = Arc::clone(&self.core);
        let error = log_error_details(
            code,
            "A localStorage synchronization operation failed.",
        );
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Warn,
                        source: LogSource::Browser,
                        event: "local-storage-sync.operation-failed".to_owned(),
                        message: "A localStorage synchronization operation failed.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: Some(error),
                    }],
                })
                .await;
        });
    }

    pub fn system_runtime_diagnostics(&self) -> SystemRuntimeDiagnosticsRecord {
        let mut collection_error_codes = Vec::new();
        let mut record = SystemRuntimeDiagnosticsRecord {
            platform: current_runtime_platform().to_owned(),
            healthy: self.health.is_healthy(),
            snapshot_complete: true,
            collection_error_codes: Vec::new(),
            recovery_required: None,
            display_host_count: None,
            tab_count: None,
            role_count: None,
            launching_tab_count: None,
            degraded_tab_count: None,
            managed_surface_count: None,
            retired_surface_count: None,
            closing_surface_count: None,
            quarantined_surface_count: None,
            pending_close_tab_count: None,
            quarantined_role_count: None,
            recovering_role_count: None,
            active_input_fence_count: None,
            retryable_failed_launch_count: None,
            failed_launch_count: None,
            local_storage_sync_source_count: None,
            local_storage_sync_dependent_count: None,
            active_native_creation_count: None,
            native_creation_limit: runtime_diagnostic_count(self.native_creation_slots.limit),
            recent_failures: Vec::new(),
        };
        match self.state.lock() {
            Ok(state) => {
                let surfaces = state
                    .surface_registry
                    .values()
                    .chain(state.retired_surface_registry.values())
                    .collect::<Vec<_>>();
                let role_surfaces = state
                    .tabs
                    .values()
                    .flat_map(|tab| tab.roles.values())
                    .collect::<Vec<_>>();
                record.recovery_required = Some(state.recovery_required);
                record.display_host_count = Some(runtime_diagnostic_count(state.display_hosts.len()));
                record.tab_count = Some(runtime_diagnostic_count(state.tabs.len()));
                record.role_count = Some(runtime_diagnostic_count(role_surfaces.len()));
                record.launching_tab_count = Some(runtime_diagnostic_count(
                    state
                        .launch_phases
                        .values()
                        .filter(|phase| !matches!(phase, LaunchPhase::Ready | LaunchPhase::Degraded))
                        .count(),
                ));
                record.degraded_tab_count = Some(runtime_diagnostic_count(
                    state
                        .launch_phases
                        .values()
                        .filter(|phase| matches!(phase, LaunchPhase::Degraded))
                        .count(),
                ));
                record.managed_surface_count =
                    Some(runtime_diagnostic_count(state.surface_registry.len()));
                record.retired_surface_count =
                    Some(runtime_diagnostic_count(state.retired_surface_registry.len()));
                record.closing_surface_count = Some(runtime_diagnostic_count(
                    surfaces
                        .iter()
                        .filter(|surface| diagnostic_surface_is_closing(surface.phase))
                        .count(),
                ));
                record.quarantined_surface_count = Some(runtime_diagnostic_count(
                    surfaces
                        .iter()
                        .filter(|surface| surface.phase == ManagedSurfacePhase::Quarantined)
                        .count(),
                ));
                record.pending_close_tab_count = Some(runtime_diagnostic_count(
                    state.close_coordinator.closing_tabs.len(),
                ));
                record.quarantined_role_count = Some(runtime_diagnostic_count(
                    state.close_coordinator.quarantined_roles.len(),
                ));
                record.recovering_role_count =
                    Some(runtime_diagnostic_count(state.recovering_roles.len()));
                record.active_input_fence_count =
                    Some(runtime_diagnostic_count(state.navigation_input_fences.len()));
                record.retryable_failed_launch_count = Some(runtime_diagnostic_count(
                    state.retryable_failed_launches.len(),
                ));
                record.failed_launch_count =
                    Some(runtime_diagnostic_count(state.failed_launch_diagnostics.len()));
                record.local_storage_sync_source_count = Some(runtime_diagnostic_count(
                    role_surfaces
                        .iter()
                        .filter(|surface| {
                            surface
                                .local_storage_sync
                                .as_ref()
                                .is_some_and(|config| config.source_role_id.is_none())
                        })
                        .count(),
                ));
                record.local_storage_sync_dependent_count = Some(runtime_diagnostic_count(
                    role_surfaces
                        .iter()
                        .filter(|surface| {
                            surface
                                .local_storage_sync
                                .as_ref()
                                .is_some_and(|config| config.source_role_id.is_some())
                        })
                        .count(),
                ));
            }
            Err(_) => collection_error_codes.push("SYSTEM_RUNTIME_STATE_LOCK_POISONED".to_owned()),
        }
        match self.native_creation_slots.active.lock() {
            Ok(active) => {
                record.active_native_creation_count = Some(runtime_diagnostic_count(*active));
            }
            Err(_) => collection_error_codes
                .push("SYSTEM_RUNTIME_CREATION_LOCK_POISONED".to_owned()),
        }
        match self.diagnostics.lock() {
            Ok(diagnostics) => record.recent_failures = diagnostics.failures_newest_first(),
            Err(_) => collection_error_codes
                .push("SYSTEM_RUNTIME_DIAGNOSTICS_LOCK_POISONED".to_owned()),
        }
        record.snapshot_complete = collection_error_codes.is_empty();
        record.collection_error_codes = collection_error_codes;
        record
    }
}
