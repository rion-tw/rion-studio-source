const DISPLAY_TOPOLOGY_RECONCILE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DisplayTopologyTransactionClassification {
    committed: bool,
    exact_readback: bool,
    rollback_error_count: usize,
}

fn display_topology_transaction_status(
    classification: DisplayTopologyTransactionClassification,
) -> NativeOperationStatus {
    if classification.rollback_error_count > 0 {
        NativeOperationStatus::Indeterminate
    } else if !classification.committed {
        NativeOperationStatus::Failed
    } else if !classification.exact_readback {
        NativeOperationStatus::Degraded
    } else {
        NativeOperationStatus::Applied
    }
}

struct TopologyNativeEntry {
    generation: u64,
    previous_target: EmbeddedLaunchTargetRecord,
    readback: Option<EmbeddedLaunchTargetRecord>,
    snapshot: NativeWindowGeometrySnapshot,
    tab_ids: Vec<String>,
    target: EmbeddedLaunchTargetRecord,
    window: Window,
}

struct ActiveTopologyGeometryGuard<'a> {
    state: &'a Mutex<RuntimeState>,
    window_ids: Vec<String>,
}

impl Drop for ActiveTopologyGeometryGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            for window_id in &self.window_ids {
                state.active_geometry_windows.remove(window_id);
            }
        }
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn request_display_topology_refresh(&self, cause: &str) {
        if let Some(state) = self.app.try_state::<crate::CoreState>()
            && let Err(error) = state.display_topology.request(self.app.clone(), cause)
        {
            eprintln!("Display topology event could not be queued: cause={cause} error={error}");
        }
    }

    pub(crate) fn reconcile_display_topology_targets<F>(
        &self,
        topology_revision: u64,
        mut targets: Vec<EmbeddedLaunchTargetRecord>,
        persist: F,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String>
    where
        F: FnOnce(&[EmbeddedLaunchTargetRecord]) -> Result<(), String>,
    {
        self.require_runtime_accepting()
            .map_err(|error| error.code.to_owned())?;
        targets.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        if targets
            .windows(2)
            .any(|pair| pair[0].window_id == pair[1].window_id)
        {
            return Err("SYSTEM_DISPLAY_TOPOLOGY_TARGET_DUPLICATE".to_owned());
        }

        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::DisplayTopology,
            "nativeDisplayTopologyChanged",
            DISPLAY_TOPOLOGY_RECONCILE_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::TopologyCommitted)
        .with_topology_revision(topology_revision);
        let operation_id = operation.operation_id.clone();
        self.operations
            .register(operation.clone())
            .map_err(str::to_owned)?;

        let issue_guard = match self
            .native_window_mutations
            .issue_gate
            .lock_until(operation.required_deadline())
        {
            Ok(guard) => guard,
            Err(code) => {
                return Ok(self
                    .operations
                    .complete(NativeOperationReceipt::with_status(
                        operation,
                        "displayTopologyIssueGate",
                        NativeOperationStatus::Failed,
                        Some(code),
                    ))
                    .summary());
            }
        };

        let mut entries = {
            let state = match self.state() {
                Ok(state) => state,
                Err(error) => {
                    return Ok(self
                        .operations
                        .complete(NativeOperationReceipt::with_status(
                            operation,
                            "displayTopologyRuntimeSnapshot",
                            NativeOperationStatus::Failed,
                            Some(error.code),
                        ))
                        .summary());
                }
            };
            targets
                .iter()
                .filter_map(|target| {
                    let host = state.display_hosts.get(&target.window_id)?;
                    let tab_ids = self.live_tab_ids_for_window(&target.window_id);
                    Some((
                        host.generation,
                        host.target.clone(),
                        host.window.clone(),
                        tab_ids,
                        target.clone(),
                    ))
                })
                .collect::<Vec<_>>()
        };

        let mut lanes = Vec::with_capacity(entries.len());
        for (_, _, _, _, target) in &entries {
            match self
                .native_window_mutations
                .issue_under_gate(&target.window_id)
            {
                Ok((_, lane)) => lanes.push(lane),
                Err(error) => {
                    return Ok(self
                        .operations
                        .complete(NativeOperationReceipt::with_status(
                            operation,
                            "displayTopologyMutationIssue",
                            NativeOperationStatus::Failed,
                            Some(error.code),
                        ))
                        .summary());
                }
            }
        }
        let lane_guards = match lock_lanes_until_deadline(&lanes, operation.required_deadline()) {
            Ok(guards) => guards,
            Err(code) => {
                return Ok(self
                    .operations
                    .complete(NativeOperationReceipt::with_status(
                        operation,
                        "displayTopologyMutationLane",
                        NativeOperationStatus::Failed,
                        Some(code),
                    ))
                    .summary());
            }
        };
        if !self.operations.mark_in_flight(&operation_id) {
            drop(lane_guards);
            drop(issue_guard);
            return self
                .operations
                .wait(&operation_id)
                .map(|receipt| receipt.summary())
                .map_err(str::to_owned);
        }

        let refreshed = self.state.lock().ok().is_some_and(|state| {
            entries.iter_mut().all(
                |(generation, previous_target, window, tab_ids, target)| {
                    let Some(host) = state.display_hosts.get(&target.window_id) else {
                        return false;
                    };
                    *generation = host.generation;
                    *previous_target = host.target.clone();
                    *window = host.window.clone();
                    *tab_ids = self.live_tab_ids_for_window(&target.window_id);
                    true
                },
            )
        });
        if !refreshed {
            return Ok(self
                .operations
                .complete(NativeOperationReceipt::with_status(
                    operation,
                    "displayTopologyGenerationFence",
                    NativeOperationStatus::Failed,
                    Some("SYSTEM_DISPLAY_TOPOLOGY_GENERATION_CHANGED"),
                ))
                .summary());
        }

        let active_window_ids = entries
            .iter()
            .map(|(_, _, _, _, target)| target.window_id.clone())
            .collect::<Vec<_>>();
        if let Ok(mut state) = self.state.lock() {
            state
                .active_geometry_windows
                .extend(active_window_ids.iter().cloned());
        }
        let _active_guard = ActiveTopologyGeometryGuard {
            state: &self.state,
            window_ids: active_window_ids,
        };

        let mut native_entries = Vec::with_capacity(entries.len());
        for (generation, previous_target, window, tab_ids, target) in entries.drain(..) {
            let snapshot = match native_window_geometry_snapshot(&window) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    return Ok(self.finish_display_topology_failure(
                        operation,
                        "displayTopologyNativeSnapshot",
                        error.code,
                        &native_entries,
                        0,
                    ));
                }
            };
            native_entries.push(TopologyNativeEntry {
                generation,
                previous_target,
                readback: None,
                snapshot,
                tab_ids,
                target,
                window,
            });
        }

        let mut attempted = 0;
        let mut exact_readback = true;
        for index in 0..native_entries.len() {
            attempted = index + 1;
            let entry = &mut native_entries[index];
            if self
                .apply_window_geometry_native(
                    &entry.window,
                    &entry.target,
                    GeometryMutationScope::WindowAndLayout,
                    &entry.tab_ids,
                )
                .is_err()
            {
                return Ok(self.finish_display_topology_failure(
                    operation,
                    "displayTopologyNativeApply",
                    "SYSTEM_DISPLAY_TOPOLOGY_APPLY_FAILED",
                    &native_entries,
                    attempted,
                ));
            }
            match geometry_target_readback(&entry.window, &entry.target) {
                Ok((readback, matches)) => {
                    exact_readback &= matches;
                    entry.readback = Some(readback);
                }
                Err(_) => {
                    return Ok(self.finish_display_topology_failure(
                        operation,
                        "displayTopologyNativeReadback",
                        "SYSTEM_DISPLAY_TOPOLOGY_READBACK_FAILED",
                        &native_entries,
                        attempted,
                    ));
                }
            }
        }

        let generation_matches = self.state.lock().ok().is_some_and(|state| {
            native_entries.iter().all(|entry| {
                state
                    .display_hosts
                    .get(&entry.target.window_id)
                    .is_some_and(|host| host.generation == entry.generation)
            })
        });
        if !generation_matches {
            return Ok(self.finish_display_topology_failure(
                operation,
                "displayTopologyGenerationFence",
                "SYSTEM_DISPLAY_TOPOLOGY_GENERATION_CHANGED",
                &native_entries,
                attempted,
            ));
        }

        for target in &mut targets {
            if let Some(readback) = native_entries
                .iter()
                .find(|entry| entry.target.window_id == target.window_id)
                .and_then(|entry| entry.readback.as_ref())
            {
                *target = readback.clone();
            }
        }
        if let Ok(mut state) = self.state.lock() {
            for entry in &native_entries {
                if let Some(host) = state.display_hosts.get_mut(&entry.target.window_id)
                    && let Some(readback) = entry.readback.as_ref()
                {
                    host.target = readback.clone();
                }
            }
        } else {
            return Ok(self.finish_display_topology_failure(
                operation,
                "displayTopologyRuntimeCommit",
                "SYSTEM_DISPLAY_TOPOLOGY_STATE_UNAVAILABLE",
                &native_entries,
                attempted,
            ));
        }

        if persist(&targets).is_err() {
            return Ok(self.finish_display_topology_failure(
                operation,
                "displayTopologyPersistence",
                "SYSTEM_DISPLAY_TOPOLOGY_PERSIST_FAILED",
                &native_entries,
                attempted,
            ));
        }

        let receipt = self.operations.complete(NativeOperationReceipt::with_status(
            operation,
            "displayTopologyCommitted",
            display_topology_transaction_status(DisplayTopologyTransactionClassification {
                committed: true,
                exact_readback,
                rollback_error_count: 0,
            }),
            (!exact_readback).then_some("SYSTEM_DISPLAY_TOPOLOGY_READBACK_ADJUSTED"),
        ));
        drop(lane_guards);
        drop(issue_guard);
        self.publish_projection();
        Ok(receipt.summary())
    }

    fn finish_display_topology_failure(
        &self,
        operation: NativeOperationContext,
        stage: &'static str,
        failure_code: &'static str,
        entries: &[TopologyNativeEntry],
        attempted: usize,
    ) -> SystemRuntimeOperationSummaryRecord {
        let rollback_errors = self.rollback_display_topology_entries(entries, attempted);
        let rollback_failed = !rollback_errors.is_empty();
        if rollback_failed {
            self.health.mark_unhealthy();
        }
        let receipt = NativeOperationReceipt::with_status(
            operation,
            stage,
            display_topology_transaction_status(DisplayTopologyTransactionClassification {
                committed: false,
                exact_readback: false,
                rollback_error_count: rollback_errors.len(),
            }),
            Some(if rollback_failed {
                "SYSTEM_DISPLAY_TOPOLOGY_ROLLBACK_FAILED"
            } else {
                failure_code
            }),
        );
        self.operations
            .complete(if rollback_failed {
                receipt.with_rollback_error_count(rollback_errors.len())
            } else {
                receipt
            })
            .summary()
    }

    fn rollback_display_topology_entries(
        &self,
        entries: &[TopologyNativeEntry],
        attempted: usize,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        for entry in entries.iter().take(attempted).rev() {
            errors.extend(self.rollback_window_geometry_native(
                &entry.window,
                &entry.snapshot,
                GeometryMutationScope::WindowAndLayout,
                &entry.tab_ids,
            ));
        }
        match self.state.lock() {
            Ok(mut state) => {
                for entry in entries.iter().take(attempted) {
                    match state.display_hosts.get_mut(&entry.target.window_id) {
                        Some(host) if host.generation == entry.generation => {
                            host.target = entry.previous_target.clone();
                        }
                        Some(_) => errors.push(format!(
                            "generation changed for {}",
                            entry.target.window_id
                        )),
                        None => errors.push(format!(
                            "runtime host disappeared for {}",
                            entry.target.window_id
                        )),
                    }
                }
            }
            Err(_) => errors.push("runtime state unavailable".to_owned()),
        }
        errors
    }
}

fn lock_lanes_until_deadline<'a>(
    lanes: &'a [Arc<NativeWindowMutationLane>],
    deadline: Instant,
) -> Result<Vec<NativeWindowMutationPermit<'a>>, &'static str> {
    let mut guards = Vec::with_capacity(lanes.len());
    for lane in lanes {
        guards.push(lane.lock_until(deadline)?);
    }
    Ok(guards)
}
