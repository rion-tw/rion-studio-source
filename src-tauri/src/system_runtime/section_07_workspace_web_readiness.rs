#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EmptyRoleLoadBoundaryKind {
    PlaceholderOnly,
    WorkspaceWeb,
}

#[derive(Clone)]
struct PendingTabReadinessIdentity {
    attempt_generation: String,
    lifecycle_epoch: u64,
    tab_id: String,
}

#[derive(Clone)]
struct WorkspaceWebReadinessTarget {
    navigation: Arc<NavigationTracker>,
    surface: Webview,
    surface_generation: u64,
    surface_instance_id: String,
}

struct PendingWorkspaceWebNavigation {
    navigation: Arc<NavigationTracker>,
    operation: NativeOperationContext,
    surface: Webview,
    surface_generation: u64,
    surface_instance_id: String,
}

struct PendingWorkspaceWebReadiness {
    identity: PendingTabReadinessIdentity,
    navigations: Vec<PendingWorkspaceWebNavigation>,
}

#[derive(Clone)]
struct WorkspaceWebNavigationWait {
    navigation: Arc<NavigationTracker>,
    operation: NativeOperationContext,
}

enum EmptyRoleLoadBoundary {
    PlaceholderOnly(PendingTabReadinessIdentity),
    WorkspaceWeb(PendingWorkspaceWebReadiness),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceWebReadinessOutcome {
    Degraded,
    Ready,
}

fn empty_role_load_boundary_kind(
    attached_surface_count: usize,
    workspace_web_surface_count: usize,
) -> Option<EmptyRoleLoadBoundaryKind> {
    if attached_surface_count == 0 {
        Some(EmptyRoleLoadBoundaryKind::PlaceholderOnly)
    } else if attached_surface_count == workspace_web_surface_count {
        Some(EmptyRoleLoadBoundaryKind::WorkspaceWeb)
    } else {
        None
    }
}

fn aggregate_workspace_web_readiness(
    statuses: &[NativeOperationStatus],
) -> WorkspaceWebReadinessOutcome {
    if !statuses.is_empty()
        && statuses
            .iter()
            .all(|status| *status == NativeOperationStatus::Applied)
    {
        WorkspaceWebReadinessOutcome::Ready
    } else {
        // A superseded initial navigation is terminal for a still-current launch. This
        // includes a Loading-time chrome navigation or reload. Close and surface-generation
        // supersedes are discarded later by the exact launch identity fence. A lifecycle
        // interruption terminalizes that same launch as Degraded so resume cannot strand it
        // in Loading; its late page events remain fenced by the lifecycle epoch.
        WorkspaceWebReadinessOutcome::Degraded
    }
}

fn workspace_web_readiness_commit_allowed(
    outcome: WorkspaceWebReadinessOutcome,
    lifecycle_identity_is_current: bool,
    launch_identity_is_current: bool,
) -> bool {
    launch_identity_is_current
        && (outcome == WorkspaceWebReadinessOutcome::Degraded
            || lifecycle_identity_is_current)
}

async fn wait_workspace_web_navigation_batch(
    application_lifecycle: Arc<ApplicationLifecycleCoordinator>,
    operations: Arc<NativeOperationRegistry>,
    lifecycle_epoch: u64,
    waits: Vec<WorkspaceWebNavigationWait>,
) -> Vec<NativeOperationReceipt> {
    let mut receipts = (0..waits.len()).map(|_| None).collect::<Vec<_>>();
    let mut tasks = tokio::task::JoinSet::new();
    for (index, wait) in waits.iter().cloned().enumerate() {
        let application_lifecycle = Arc::clone(&application_lifecycle);
        let operations = Arc::clone(&operations);
        tasks.spawn(async move {
            (
                index,
                wait_navigation_for_lifecycle_contract(
                    application_lifecycle,
                    operations,
                    wait.navigation,
                    lifecycle_epoch,
                    wait.operation,
                )
                .await,
            )
        });
    }

    let mut siblings_cancelled = false;
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((index, receipt)) => {
                let status = receipt.status;
                receipts[index] = Some(receipt);
                if status != NativeOperationStatus::Applied && !siblings_cancelled {
                    siblings_cancelled = true;
                    for (pending_index, wait) in waits.iter().enumerate() {
                        if pending_index != index && receipts[pending_index].is_none() {
                            wait.navigation.reset();
                        }
                    }
                }
            }
            Err(_) => {
                tasks.abort_all();
                for (index, wait) in waits.iter().enumerate() {
                    if receipts[index].is_none() {
                        wait.navigation.reset();
                        receipts[index] = Some(NativeOperationReceipt::with_status(
                            wait.operation.clone(),
                            "workspaceWebReadinessWait",
                            NativeOperationStatus::Failed,
                            Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
                        ));
                    }
                }
                while tasks.join_next().await.is_some() {}
                break;
            }
        }
    }

    receipts
        .into_iter()
        .enumerate()
        .map(|(index, receipt)| {
            receipt.unwrap_or_else(|| {
                NativeOperationReceipt::with_status(
                    waits[index].operation.clone(),
                    "workspaceWebReadinessWait",
                    NativeOperationStatus::Failed,
                    Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
                )
            })
        })
        .collect()
}

impl SystemRuntimeExecutor {
    fn prepare_empty_role_load_boundary(
        &self,
        tab_id: &str,
        parent_operation_id: &str,
    ) -> RuntimeResult<EmptyRoleLoadBoundary> {
        self.require_runtime_accepting()?;
        let lifecycle_epoch = self.lifecycle_epoch();
        self.require_application_lifecycle_epoch(lifecycle_epoch)?;
        let (attempt_generation, attached_surface_count, targets) = {
            let state = self.state()?;
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || state.tab_close_pending(tab_id)
                || state.close_previews.contains_key(tab_id)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "The runtime tab closed before Workspace Web readiness admission.",
                ));
            }
            let tab = state.native_resources.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "Runtime tab was not found while admitting Workspace Web readiness.",
                )
            })?;
            let attempt_generation = state
                .launch_attempt_generations
                .get(tab_id)
                .cloned()
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_LAUNCH_SUPERSEDED",
                        "The runtime launch attempt was superseded before readiness admission.",
                    )
                })?;
            let targets = tab
                .roles
                .values()
                .filter(|surface| surface.workspace_web.is_some())
                .map(|surface| WorkspaceWebReadinessTarget {
                    navigation: Arc::clone(&surface.navigation),
                    surface: surface.webview.clone(),
                    surface_generation: surface.generation,
                    surface_instance_id: surface.surface_instance_id.clone(),
                })
                .collect::<Vec<_>>();
            (attempt_generation, tab.roles.len(), targets)
        };
        let identity = PendingTabReadinessIdentity {
            attempt_generation,
            lifecycle_epoch,
            tab_id: tab_id.to_owned(),
        };
        match empty_role_load_boundary_kind(attached_surface_count, targets.len()) {
            Some(EmptyRoleLoadBoundaryKind::PlaceholderOnly) => {
                return Ok(EmptyRoleLoadBoundary::PlaceholderOnly(identity));
            }
            Some(EmptyRoleLoadBoundaryKind::WorkspaceWeb) => {}
            None => {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_ROLE_LOAD_INVALID",
                    "An empty Role load cannot establish readiness for attached Role surfaces.",
                ));
            }
        }

        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let controlled_labels = targets
            .iter()
            .map(|target| target.surface.label().to_owned())
            .collect::<Vec<_>>();
        let mut pending: Vec<PendingWorkspaceWebNavigation> =
            Vec::with_capacity(targets.len());
        for target in &targets {
            let operation = NativeOperationContext::new(
                NativeOperationSubsystem::Navigation,
                "embeddedLoadWorkspaceWeb",
                NAVIGATION_TIMEOUT,
            )
            .with_parent_operation_id(parent_operation_id)
            .with_tab(tab_id)
            .with_window(&window_id)
            .with_lifecycle_epoch(lifecycle_epoch)
            .with_surface_generation(target.surface_generation);
            let setup = (|| -> RuntimeResult<()> {
                self.operations.register(operation.clone()).map_err(|code| {
                    RuntimeError::new(
                        code,
                        "The native operation registry could not accept Workspace Web navigation.",
                    )
                })?;
                target
                    .navigation
                    .adopt_current_navigation(&operation)
                    .map_err(|message| {
                        RuntimeError::new("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE", message)
                    })?;
                if self
                    .require_application_lifecycle_epoch(lifecycle_epoch)
                    .is_err()
                    || !self.operations.mark_in_flight(&operation.operation_id)
                {
                    return Err(RuntimeError::new(
                        "SYSTEM_LIFECYCLE_STALE",
                        "Workspace Web navigation was cancelled before its page-finish wait began.",
                    ));
                }
                Ok(())
            })();
            if let Err(error) = setup {
                target.navigation.reset();
                self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                    operation,
                    "workspaceWebReadinessSetup",
                    NativeOperationStatus::Failed,
                    Some(error.code),
                ));
                for accepted in pending {
                    accepted.navigation.reset();
                    self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                        accepted.operation,
                        "workspaceWebReadinessBatchAborted",
                        NativeOperationStatus::Superseded,
                        Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                    ));
                }
                self.finish_controlled_navigations(&controlled_labels);
                return Err(error);
            }
            pending.push(PendingWorkspaceWebNavigation {
                navigation: Arc::clone(&target.navigation),
                operation,
                surface: target.surface.clone(),
                surface_generation: target.surface_generation,
                surface_instance_id: target.surface_instance_id.clone(),
            });
        }
        Ok(EmptyRoleLoadBoundary::WorkspaceWeb(
            PendingWorkspaceWebReadiness {
                identity,
                navigations: pending,
            },
        ))
    }

    fn tab_readiness_launch_identity_is_current(
        &self,
        identity: &PendingTabReadinessIdentity,
    ) -> bool {
        self.presentation.statuses.launch_phase(&identity.tab_id)
            == Some(LaunchPhase::Navigating)
            && self.state.lock().ok().is_some_and(|state| {
                state.launch_attempt_generations.get(&identity.tab_id)
                    == Some(&identity.attempt_generation)
                    && !state.close_coordinator.closing_tabs.contains(&identity.tab_id)
                    && !state.tab_close_pending(&identity.tab_id)
                    && !state.close_previews.contains_key(&identity.tab_id)
                    && state.native_resources.tabs.contains_key(&identity.tab_id)
            })
    }

    fn tab_readiness_identity_is_current(
        &self,
        identity: &PendingTabReadinessIdentity,
    ) -> bool {
        self.application_lifecycle_epoch_matches(identity.lifecycle_epoch)
            && self.tab_readiness_launch_identity_is_current(identity)
    }

    fn placeholder_readiness_is_current(
        &self,
        identity: &PendingTabReadinessIdentity,
    ) -> bool {
        self.tab_readiness_identity_is_current(identity)
            && self.state.lock().ok().is_some_and(|state| {
                state
                    .native_resources
                    .tabs
                    .get(&identity.tab_id)
                    .is_some_and(|tab| tab.roles.is_empty())
            })
    }

    fn workspace_web_readiness_launch_identity_is_current(
        &self,
        readiness: &PendingWorkspaceWebReadiness,
    ) -> bool {
        self.tab_readiness_launch_identity_is_current(&readiness.identity)
            && self.state.lock().ok().is_some_and(|state| {
                let Some(tab) = state.native_resources.tabs.get(&readiness.identity.tab_id) else {
                    return false;
                };
                tab.roles.len() == readiness.navigations.len()
                    && readiness.navigations.iter().all(|pending| {
                        tab.roles.values().any(|surface| {
                            surface.workspace_web.is_some()
                                && surface.generation == pending.surface_generation
                                && surface.surface_instance_id == pending.surface_instance_id
                                && surface.webview.label() == pending.surface.label()
                        })
                    })
            })
    }

    fn workspace_web_readiness_is_current(
        &self,
        readiness: &PendingWorkspaceWebReadiness,
    ) -> bool {
        self.application_lifecycle_epoch_matches(readiness.identity.lifecycle_epoch)
            && self.workspace_web_readiness_launch_identity_is_current(readiness)
    }

    fn abandon_workspace_web_readiness(&self, readiness: PendingWorkspaceWebReadiness) {
        let labels = readiness
            .navigations
            .iter()
            .map(|pending| pending.surface.label().to_owned())
            .collect::<Vec<_>>();
        for pending in readiness.navigations {
            pending.navigation.reset();
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                pending.operation,
                "workspaceWebReadinessSuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_NAVIGATION_SUPERSEDED"),
            ));
        }
        self.finish_controlled_navigations(&labels);
    }

    async fn complete_workspace_web_readiness(
        &self,
        readiness: PendingWorkspaceWebReadiness,
        runtime_operation_id: &str,
        started: Instant,
    ) {
        let labels = readiness
            .navigations
            .iter()
            .map(|pending| pending.surface.label().to_owned())
            .collect::<Vec<_>>();
        let waits = readiness
            .navigations
            .iter()
            .map(|pending| WorkspaceWebNavigationWait {
                navigation: Arc::clone(&pending.navigation),
                operation: pending.operation.clone(),
            })
            .collect::<Vec<_>>();
        let receipts = wait_workspace_web_navigation_batch(
            Arc::clone(&self.application_lifecycle),
            Arc::clone(&self.operations),
            readiness.identity.lifecycle_epoch,
            waits,
        )
        .await;
        let mut statuses = Vec::with_capacity(receipts.len());
        for (pending, receipt) in readiness.navigations.iter().zip(receipts) {
            let status = receipt.status;
            let failure_code = receipt.failure_code.clone();
            self.record_native_operation_receipt(receipt);
            self.record_runtime_stage(
                format!(
                    "tab.workspace-web-ready:{}:{}:{}",
                    readiness.identity.tab_id,
                    pending.surface_instance_id,
                    failure_code.as_deref().unwrap_or("page-finished")
                ),
                if status == NativeOperationStatus::Applied {
                    "completed"
                } else {
                    "failed"
                },
                started,
            );
            statuses.push(status);
        }
        self.finish_controlled_navigations(&labels);
        let outcome = aggregate_workspace_web_readiness(&statuses);
        let launch_identity_is_current =
            self.workspace_web_readiness_launch_identity_is_current(&readiness);
        let lifecycle_identity_is_current = self.workspace_web_readiness_is_current(&readiness);
        if !workspace_web_readiness_commit_allowed(
            outcome,
            lifecycle_identity_is_current,
            launch_identity_is_current,
        ) {
            return;
        }
        match outcome {
            WorkspaceWebReadinessOutcome::Ready => {
                if self
                    .apply_runtime_native_event_for_operation(runtime_operation_id, "ready")
                    .ok()
                    == Some(RuntimeCommitStatus::Applied)
                    && self.workspace_web_readiness_is_current(&readiness)
                {
                    self.set_launch_phase(
                        &readiness.identity.tab_id,
                        LaunchPhase::EssentialReady,
                    );
                    self.schedule_optional_hydration(&readiness.identity.tab_id);
                }
            }
            WorkspaceWebReadinessOutcome::Degraded => {
                // Commit Degraded before the terminal native failure event. The Kernel does not
                // permit Failed -> Degraded, and the degraded activation is what keeps the
                // still-attached native surface out of dormant reactivation on selection.
                self.set_launch_phase(&readiness.identity.tab_id, LaunchPhase::Degraded);
                let _ = self
                    .apply_runtime_native_event_for_operation(runtime_operation_id, "failed");
            }
        }
    }
}
