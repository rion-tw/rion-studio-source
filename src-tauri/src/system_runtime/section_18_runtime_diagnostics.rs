const RECENT_RUNTIME_FAILURE_CAPACITY: usize = 20;
const RECENT_INPUT_FENCE_EVENT_CAPACITY: usize = 40;

#[derive(Default)]
struct RuntimeDiagnosticsState {
    recent_failures: VecDeque<SystemRuntimeFailureRecord>,
    recent_input_fence_events: VecDeque<SystemRuntimeInputFenceEventRecord>,
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

    fn push_input_fence_event(&mut self, event: SystemRuntimeInputFenceEventRecord) {
        while self.recent_input_fence_events.len() >= RECENT_INPUT_FENCE_EVENT_CAPACITY {
            self.recent_input_fence_events.pop_front();
        }
        self.recent_input_fence_events.push_back(event);
    }

    fn input_fence_events_newest_first(&self) -> Vec<SystemRuntimeInputFenceEventRecord> {
        self.recent_input_fence_events
            .iter()
            .rev()
            .cloned()
            .collect()
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
            | ManagedSurfacePhase::Retired
    )
}

fn diagnostic_input_fence_state(
    fence: Option<&RoleInputFence>,
    native_disabled: bool,
    core_stopping: bool,
    core_quiesced: bool,
) -> (&'static str, bool) {
    let orphaned_core = core_quiesced && fence.is_none() && !native_disabled;
    let orphaned_native = (fence.is_some() || native_disabled) && !core_quiesced && !core_stopping;
    if orphaned_core {
        ("orphaned-core", true)
    } else if orphaned_native {
        ("orphaned-native", true)
    } else if fence.is_some_and(|fence| fence.recovery_scheduled) {
        ("recovering", false)
    } else if fence.is_some_and(|fence| fence.resuming) {
        ("resuming", false)
    } else if fence.is_some_and(|fence| !fence.drained) {
        ("draining", false)
    } else {
        ("waiting-page-finish", false)
    }
}

impl SystemRuntimeExecutor {
    fn record_native_operation_receipt(&self, receipt: NativeOperationReceipt) {
        let _terminal = self.operations.record_untracked(receipt);
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "native-operation-terminal",
            _terminal.context.window_id.as_deref(),
            _terminal.context.window_generation,
            _terminal.context.topology_revision,
            serde_json::to_value(_terminal.summary()).unwrap_or_else(|error| {
                serde_json::json!({ "serializationError": error.to_string() })
            }),
        );
    }

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


    pub fn system_runtime_diagnostics(
        &self,
        core_input: Option<MacroInputDiagnosticsRecord>,
    ) -> SystemRuntimeDiagnosticsRecord {
        let mut collection_error_codes = Vec::new();
        if core_input.is_none() {
            collection_error_codes.push("CORE_INPUT_DIAGNOSTICS_UNAVAILABLE".to_owned());
        }
        let core_input_roles = core_input
            .unwrap_or(MacroInputDiagnosticsRecord { roles: Vec::new() })
            .roles
            .into_iter()
            .map(|role| (role.role_id.clone(), role))
            .collect::<HashMap<_, _>>();
        let native_input_lanes = match self.input_dispatch_lanes.lock() {
            Ok(lanes) => lanes
                .iter()
                .map(|(role_id, lane)| {
                    (
                        role_id.clone(),
                        (
                            lane.epoch.load(Ordering::Acquire),
                            lane.normal_enabled.load(Ordering::Acquire),
                        ),
                    )
                })
                .collect::<HashMap<_, _>>(),
            Err(_) => {
                collection_error_codes.push("SYSTEM_INPUT_LANE_LOCK_POISONED".to_owned());
                HashMap::new()
            }
        };
        let mut record = SystemRuntimeDiagnosticsRecord {
            contract_version: SYSTEM_RUNTIME_CONTRACT_VERSION,
            platform: current_runtime_platform().to_owned(),
            shutdown_state: RuntimeShutdownState::from_raw(
                self.shutdown_state.load(Ordering::Acquire),
            )
            .as_str()
            .to_owned(),
            application_lifecycle: Some(self.application_lifecycle_status()),
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
            active_input_fences: Vec::new(),
            recent_input_fence_events: Vec::new(),
            retryable_failed_launch_count: None,
            failed_launch_count: None,
            active_native_creation_count: None,
            native_creation_limit: runtime_diagnostic_count(self.native_creation_slots.limit),
            recent_failures: Vec::new(),
            recent_operations: Vec::new(),
            capability_evidence: self.capability_evidence(),
            active_lifecycle_operation_count: None,
            active_navigation_operation_count: None,
            runtime_kernel_revision: None,
            runtime_kernel_logical_surface_count: None,
            runtime_kernel_pending_operation_count: None,
            runtime_kernel_tombstone_count: None,
            runtime_native_resource_invariants_ok: None,
            runtime_native_resource_invariant_failure_count: None,
            recent_runtime_kernel_operations: Vec::new(),
        };
        match self.state.lock() {
            Ok(state) => {
                let surfaces = state
                    .native_resources.surface_registry
                    .values()
                    .chain(state.native_resources.retired_surface_registry.values())
                    .collect::<Vec<_>>();
                let role_surfaces = state
                    .native_resources.tabs
                    .values()
                    .flat_map(|tab| tab.roles.values())
                    .collect::<Vec<_>>();
                record.recovery_required = Some(
                    state.runtime_restart_required
                        || !state.session_recovery_window_ids.is_empty(),
                );
                record.display_host_count = Some(runtime_diagnostic_count(state.native_resources.display_hosts.len()));
                record.tab_count = Some(runtime_diagnostic_count(state.native_resources.tabs.len()));
                record.role_count = Some(runtime_diagnostic_count(role_surfaces.len()));
                let launch_phases = self.presentation.statuses.launch_phases();
                record.launching_tab_count = Some(runtime_diagnostic_count(
                    launch_phases
                        .iter()
                        .filter(|phase| !matches!(phase, LaunchPhase::Ready | LaunchPhase::Degraded))
                        .count(),
                ));
                record.degraded_tab_count = Some(runtime_diagnostic_count(
                    launch_phases
                        .iter()
                        .filter(|phase| matches!(phase, LaunchPhase::Degraded))
                        .count(),
                ));
                record.managed_surface_count =
                    Some(runtime_diagnostic_count(state.native_resources.surface_registry.len()));
                record.active_lifecycle_operation_count = Some(runtime_diagnostic_count(
                    surfaces
                        .iter()
                        .filter(|surface| diagnostic_surface_is_closing(surface.phase))
                        .count(),
                ));
                record.active_navigation_operation_count = Some(runtime_diagnostic_count(
                    role_surfaces
                        .iter()
                        .filter(|surface| surface.navigation.operation_active())
                        .count()
                        + state
                            .role_input_fences
                            .values()
                            .filter(|fence| fence.navigation_operation.is_some())
                            .count(),
                ));
                record.retired_surface_count =
                    Some(runtime_diagnostic_count(state.native_resources.retired_surface_registry.len()));
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
                let mut active_role_ids = state
                    .role_input_fences
                    .keys()
                    .cloned()
                    .collect::<HashSet<_>>();
                active_role_ids.extend(core_input_roles.iter().filter_map(|(role_id, role)| {
                    (role.stopping || role.quiesced).then_some(role_id.clone())
                }));
                active_role_ids.extend(native_input_lanes.iter().filter_map(
                    |(role_id, (_, normal_enabled))| (!normal_enabled).then_some(role_id.clone()),
                ));
                let mut active_role_ids = active_role_ids.into_iter().collect::<Vec<_>>();
                active_role_ids.sort();
                record.active_input_fences = active_role_ids
                    .into_iter()
                    .map(|role_id| {
                        let fence = state.role_input_fences.get(&role_id);
                        let core_role = core_input_roles.get(&role_id);
                        let core_stopping = core_role.is_some_and(|role| role.stopping);
                        let core_quiesced = core_role.is_some_and(|role| role.quiesced);
                        let native_lane = native_input_lanes.get(&role_id).copied();
                        let native_disabled = native_lane.is_some_and(|(_, enabled)| !enabled);
                        let (state_name, inconsistent) = diagnostic_input_fence_state(
                            fence,
                            native_disabled,
                            core_stopping,
                            core_quiesced,
                        );
                        if inconsistent {
                            collection_error_codes
                                .push("SYSTEM_INPUT_FENCE_STATE_MISMATCH".to_owned());
                        }
                        let input_epoch = fence
                            .map(|fence| fence.input_epoch)
                            .or_else(|| core_role.map(|role| role.input_epoch))
                            .or_else(|| native_lane.map(|lane| lane.0))
                            .unwrap_or_default();
                        let pending_page_finish_count = state
                            .main_frame_navigation_input_fences
                            .values()
                            .filter(|ticket| {
                                ticket.role_id == role_id
                                    && ticket.input_epoch == input_epoch
                                    && !ticket.page_finished
                            })
                            .count();
                        SystemRuntimeInputFenceRecord {
                            role_id,
                            input_epoch,
                            reason: fence
                                .map(|fence| fence.reason.clone())
                                .unwrap_or_else(|| "state-mismatch".to_owned()),
                            state: state_name.to_owned(),
                            age_ms: fence
                                .map(|fence| {
                                    fence
                                        .started_at
                                        .elapsed()
                                        .as_millis()
                                        .min(u64::MAX as u128) as u64
                                })
                                .unwrap_or_default(),
                            core_stopping,
                            core_quiesced,
                            native_input_enabled: native_lane.map(|lane| lane.1),
                            drained: fence.is_some_and(|fence| fence.drained),
                            pending_page_finish_count: runtime_diagnostic_count(
                                pending_page_finish_count,
                            ),
                            surface_generation: fence.map(|fence| fence.surface_generation),
                            recovery_scheduled: fence
                                .is_some_and(|fence| fence.recovery_scheduled),
                        }
                    })
                    .collect();
                record.active_input_fence_count = Some(runtime_diagnostic_count(
                    record.active_input_fences.len(),
                ));
                record.retryable_failed_launch_count = Some(runtime_diagnostic_count(
                    state.retryable_failed_launches.len(),
                ));
                record.failed_launch_count =
                    Some(runtime_diagnostic_count(state.failed_launch_diagnostics.len()));
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
        let runtime_kernel = self.core.runtime_kernel();
        match runtime_kernel.audit() {
            Ok(audit) => {
                record.runtime_kernel_revision = Some(audit.revision);
                record.runtime_kernel_logical_surface_count =
                    Some(runtime_diagnostic_count(audit.logical_surface_count));
                record.runtime_kernel_pending_operation_count =
                    Some(runtime_diagnostic_count(audit.pending_operation_count));
                record.runtime_kernel_tombstone_count =
                    Some(runtime_diagnostic_count(audit.tombstone_count));
                record.recent_runtime_kernel_operations = audit.trace;
            }
            Err(error) => {
                eprintln!("RuntimeKernel invariant audit failed: {error}");
                collection_error_codes.push("SYSTEM_RUNTIME_KERNEL_INVARIANT_FAILED".to_owned());
            }
        }
        match runtime_kernel.snapshot().and_then(|snapshot| {
            self.audit_native_resource_invariants(&snapshot)
                .map_err(rion_core::CoreError::Internal)
        }) {
            Ok(failures) => {
                record.runtime_native_resource_invariants_ok = Some(failures.is_empty());
                record.runtime_native_resource_invariant_failure_count =
                    Some(runtime_diagnostic_count(failures.len()));
                if !failures.is_empty() {
                    let trace = record
                        .recent_runtime_kernel_operations
                        .last()
                        .map(|entry| {
                            format!(
                                "intent={} operation={:?} revision={} tab={:?} windows={:?}",
                                entry.intent_kind,
                                entry.operation_id,
                                entry.revision,
                                entry.tab_id,
                                entry.window_ids
                            )
                        })
                        .unwrap_or_else(|| "trace=empty".to_owned());
                    eprintln!(
                        "NativeResourceRegistry invariant audit failed: failures={} details={} latestTrace={trace}",
                        failures.len(),
                        failures.join("; ")
                    );
                    collection_error_codes
                        .push("SYSTEM_NATIVE_RESOURCE_INVARIANT_FAILED".to_owned());
                }
            }
            Err(error) => {
                eprintln!("NativeResourceRegistry invariant audit could not run: {error}");
                collection_error_codes
                    .push("SYSTEM_NATIVE_RESOURCE_INVARIANT_UNAVAILABLE".to_owned());
            }
        }
        match self.diagnostics.lock() {
            Ok(diagnostics) => {
                record.recent_failures = diagnostics.failures_newest_first();
                record.recent_input_fence_events =
                    diagnostics.input_fence_events_newest_first();
            }
            Err(_) => collection_error_codes
                .push("SYSTEM_RUNTIME_DIAGNOSTICS_LOCK_POISONED".to_owned()),
        }
        record.recent_operations = self.operations.recent_summaries();
        record.snapshot_complete = collection_error_codes.is_empty();
        record.collection_error_codes = collection_error_codes;
        record
    }

    fn audit_native_resource_invariants(
        &self,
        kernel: &RuntimeSnapshot,
    ) -> Result<Vec<String>, String> {
        let live_tab_owners = kernel
            .windows
            .iter()
            .flat_map(|(window_id, window)| {
                window
                    .tabs
                    .iter()
                    .map(move |tab| (tab.id.clone(), window_id.clone()))
            })
            .collect::<HashMap<_, _>>();
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        let mut failures = Vec::new();
        let mut live_labels = HashSet::new();
        for (instance_id, surface) in &state.native_resources.surface_registry {
            if instance_id != &surface.instance_id {
                failures.push(format!(
                    "surface-instance-key-mismatch:{instance_id}:{}",
                    surface.instance_id
                ));
            }
            if !live_labels.insert(surface.webview.label().to_owned()) {
                failures.push(format!("duplicate-live-label:{}", surface.webview.label()));
            }
            let requires_owner = matches!(
                surface.phase,
                ManagedSurfacePhase::Live | ManagedSurfacePhase::Provisional
            );
            let closing = surface
                .tab_id
                .as_ref()
                .is_some_and(|tab_id| state.close_coordinator.closing_tabs.contains(tab_id));
            if requires_owner
                && !closing
                && surface.tab_id.as_ref().is_some_and(|tab_id| {
                    live_tab_owners.get(tab_id) != Some(&surface.window_id)
                })
            {
                failures.push(format!(
                    "live-surface-owner-mismatch:{}:{}:{:?}",
                    surface.instance_id, surface.window_id, surface.tab_id
                ));
            }
        }
        for (tab_id, tab) in &state.native_resources.tabs {
            let closing = state.close_coordinator.closing_tabs.contains(tab_id);
            if !closing && !live_tab_owners.contains_key(tab_id) {
                failures.push(format!("native-tab-without-logical-owner:{tab_id}"));
            }
            for (role_id, role) in &tab.roles {
                if !state.native_resources.surface_registry.get(&role.surface_instance_id).is_some_and(
                    |surface| {
                        surface.tab_id.as_deref() == Some(tab_id.as_str())
                            && surface.role_id.as_deref() == Some(role_id.as_str())
                            && surface.webview.label() == role.webview.label()
                    },
                ) {
                    failures.push(format!(
                        "role-handle-not-registered:{tab_id}:{role_id}:{}",
                        role.surface_instance_id
                    ));
                }
            }
        }
        for (window_id, host) in &state.native_resources.display_hosts {
            let retiring = state.retiring_native_window_hosts.contains_key(window_id)
                || state.quarantined_window_hosts.contains(window_id);
            if !retiring
                && kernel.windows.get(window_id).is_none_or(|window| {
                    window.window_generation != host.generation
                })
            {
                failures.push(format!(
                    "native-window-generation-without-logical-owner:{window_id}:{}",
                    host.generation
                ));
            }
        }
        failures.sort();
        failures.dedup();
        Ok(failures)
    }
}
