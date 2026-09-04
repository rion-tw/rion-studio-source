struct EmbeddedRuntimeTransition {
    commands: Vec<BrowserRuntimeCommand>,
    target: Option<EmbeddedLaunchTargetRecord>,
    reveal_window_ids: Vec<String>,
    focus_window_ids: Vec<String>,
    focus_tab_id: Option<String>,
    parent_operation_id: Option<String>,
}

struct SystemLaunchRequest<'a> {
    tab_id: &'a str,
    tab: EmbeddedTabEffectRecord,
    roles: &'a [StateRoleRecord],
    runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
    global_web_profile: Option<crate::model::GlobalWebProfilePathsRecord>,
    presentation_intent: EmbeddedLaunchPresentationIntent,
    resolved_engine: crate::model::ResolvedBrowserEngine,
}

impl AppCore {
    fn stop_embedded_workspace_with_operation_lease(
        &self,
        workspace_id: &str,
        acquire_operation_lease: bool,
        persist_closed_tab: bool,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<()> {
        let initial_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let initial_role_ids = initial_snapshot
            .workspaces
            .iter()
            .find(|workspace| {
                workspace.workspace_id == workspace_id && workspace.runtime == "embedded"
            })
            .map(|workspace| {
                initial_snapshot
                    .roles
                    .iter()
                    .filter(|role| role.owner.tab_id == workspace.tab_id)
                    .map(|role| role.role_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let initial_tab_id = initial_snapshot
            .workspaces
            .iter()
            .find(|workspace| {
                workspace.workspace_id == workspace_id && workspace.runtime == "embedded"
            })
            .map(|workspace| workspace.tab_id.clone());
        let initial_window_id = initial_tab_id.as_deref().and_then(|tab_id| {
            initial_snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .map(|tab| tab.window_id.clone())
        });
        let logical_close_operation_id = parent_operation_id.map_or_else(
            || format!("workspace-stop:{workspace_id}:{}", uuid::Uuid::new_v4()),
            str::to_owned,
        );
        let reload_admission =
            self.supersede_controlled_role_reloads(&initial_role_ids, "tabStop")?;
        self.cancel_embedded_operations(&initial_role_ids)?;
        let lease = acquire_operation_lease
            .then(|| {
                let mut operation_role_ids = initial_role_ids.clone();
                operation_role_ids.push(workspace_operation_key(workspace_id));
                self.browser_operations.acquire(BrowserOperationRequest {
                    role_ids: operation_role_ids,
                    kind: "normal".to_owned(),
                })
            })
            .transpose()?;
        let result = (|| {
            let logical_close = match (initial_tab_id.as_deref(), initial_window_id.as_deref()) {
                (Some(tab_id), Some(window_id)) => self.prepare_runtime_logical_close(
                    &logical_close_operation_id,
                    window_id,
                    None,
                    None,
                    tab_id,
                    None,
                )?,
                _ => None,
            };
            let prepared = {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let snapshot = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot;
                let workspace = snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| {
                        workspace.workspace_id == workspace_id && workspace.runtime == "embedded"
                    })
                    .cloned();
                if let Some(workspace) = workspace {
                    let tab_id = workspace.tab_id.clone();
                    let owned_roles = snapshot
                        .roles
                        .iter()
                        .filter(|role| role.owner.tab_id == tab_id)
                        .cloned()
                        .collect::<Vec<_>>();
                    for role in &owned_roles {
                        let role_id = &role.role_id;
                        self.macro_runtime.request_stop_role(role_id)?;
                        self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                            role_id: role_id.clone(),
                            runtime: "embedded".to_owned(),
                            tab_id: tab_id.clone(),
                            slot_id: Some(role.owner.slot_id.clone()),
                            state: "stopping".to_owned(),
                            launched_at: role.launched_at.clone(),
                        })?;
                    }
                    self.embedded_closing_tabs
                        .lock()
                        .map_err(|_| {
                            CoreError::Internal("embedded closing tab lock poisoned".to_owned())
                        })?
                        .insert(tab_id.clone());
                    Some((owned_roles, tab_id))
                } else {
                    None
                }
            };
            drop(reload_admission);

            let Some((owned_roles, tab_id)) = prepared else {
                // Cancelling an in-flight launch removes its speculative Core
                // topology immediately, but EmbeddedCreateTab may already have
                // attached native surfaces. Run cleanup after releasing the
                // Core sequence lease so the native acknowledgement cannot
                // deadlock against runtime-state finalization.
                if let Some(tab_id) = initial_tab_id.as_deref() {
                    let native_close = self.run_embedded_runtime_effect(
                        tab_id,
                        CoreEffectAction::EmbeddedDestroyTab {
                            tab_id: tab_id.to_owned(),
                            attempt_generation: None,
                            next_active_tab_id: None,
                        },
                        None,
                        parent_operation_id,
                    );
                    match native_close {
                        Ok(_) => {
                            if let Some(close) = logical_close.as_ref() {
                                self.finish_runtime_logical_close(close, "closed")?;
                            }
                        }
                        Err(error) => {
                            if let Some(close) = logical_close.as_ref() {
                                let _ = self.finish_runtime_logical_close(close, "failed");
                            }
                            return Err(error);
                        }
                    }
                    let _sequence = self.embedded_runtime_sequence.acquire()?;
                    let current = self
                        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                        .snapshot;
                    if current.tabs.iter().any(|tab| {
                        tab.id == tab_id
                            && tab.tab_type == "workspace"
                            && tab.source_id == workspace_id
                    }) {
                        self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                            tab_id: tab_id.to_owned(),
                        })?;
                    }
                    for role_id in &initial_role_ids {
                        self.macro_runtime.release_role(role_id)?;
                    }
                }
                return Ok(());
            };

            // Keep durability behind native isolation. The final runtime commit
            // below persists the coalesced workspace removal.
            self.emit_browser_statuses();
            let native_close = self.run_embedded_runtime_effect(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    attempt_generation: None,
                    next_active_tab_id: None,
                },
                None,
                parent_operation_id,
            );
            match native_close {
                Ok(_) => {
                    if let Some(close) = logical_close.as_ref() {
                        self.finish_runtime_logical_close(close, "closed")?;
                    }
                }
                Err(error) => {
                    if let Some(close) = logical_close.as_ref() {
                        let _ = self.finish_runtime_logical_close(close, "failed");
                    }
                    return Err(error);
                }
            }

            {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let current = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot;
                if owned_roles.iter().any(|owned| {
                    current
                        .roles
                        .iter()
                        .find(|role| role.role_id == owned.role_id)
                        .is_none_or(|role| role.owner.tab_id != tab_id || role.state != "stopping")
                }) {
                    return Err(CoreError::Domain {
                        code: "SYSTEM_SURFACE_CLOSE_STALE",
                        message: "The workspace changed before its close transaction committed."
                            .to_owned(),
                    });
                }
                for role in &owned_roles {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                        role_id: role.role_id.clone(),
                        expected_tab_id: Some(tab_id.clone()),
                    })?;
                }
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                    tab_id: tab_id.clone(),
                })?;
                self.embedded_closing_tabs
                    .lock()
                    .map_err(|_| {
                        CoreError::Internal("embedded closing tab lock poisoned".to_owned())
                    })?
                    .remove(&tab_id);
            }
            for role in &owned_roles {
                self.macro_runtime.release_role(&role.role_id)?;
            }
            if persist_closed_tab {
                self.commit_embedded_runtime_snapshot_without_native_effect(
                    &std::collections::HashSet::new(),
                )?;
            } else {
                self.browser_runtime_snapshot_without_persistence()?;
            }
            Ok(())
        })();
        let Some(lease) = lease else {
            return result;
        };
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }

    fn stop_embedded_window(
        &self,
        request: &RuntimeWindowStopRequestRecord,
        delete: bool,
    ) -> CoreResult<()> {
        self.stop_embedded_window_runtime(request, delete)
    }

    fn admit_embedded_window_close(
        &self,
        mut request: RuntimeWindowStopRequestRecord,
    ) -> CoreResult<RuntimeWindowStopRequestRecord> {
        if request.admission_id.is_some() || !request.closing_tabs.is_empty() {
            return Ok(request);
        }
        let initial = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let initial_tabs = initial
            .tabs
            .iter()
            .filter(|tab| request.tab_ids.iter().any(|tab_id| tab_id == &tab.id))
            .cloned()
            .collect::<Vec<_>>();
        let mut role_ids = initial_tabs
            .iter()
            .flat_map(|tab| tab.slots.iter().map(|slot| slot.role_id.clone()))
            .collect::<Vec<_>>();
        role_ids.sort();
        role_ids.dedup();
        let reload_admission = self.supersede_controlled_role_reloads(&role_ids, "windowClose")?;
        self.cancel_embedded_operations(&role_ids)?;
        for role_id in &role_ids {
            self.macro_runtime.request_stop_role(role_id)?;
        }

        let mut operation_role_ids = role_ids;
        operation_role_ids.extend(
            initial_tabs
                .iter()
                .filter(|tab| tab.tab_type == "workspace")
                .map(|tab| workspace_operation_key(&tab.source_id)),
        );
        operation_role_ids.sort();
        operation_role_ids.dedup();
        let lease = if operation_role_ids.is_empty() {
            None
        } else {
            Some(self.browser_operations.acquire(BrowserOperationRequest {
                role_ids: operation_role_ids,
                kind: "normal".to_owned(),
            })?)
        };

        let admitted = (|| {
            let _window_sequence = self.embedded_window_sequence.acquire()?;
            let _runtime_sequence = self.embedded_runtime_sequence.acquire()?;
            let current = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let closing_tabs = current
                .tabs
                .iter()
                .filter(|tab| request.tab_ids.iter().any(|tab_id| tab_id == &tab.id))
                .map(|tab| crate::model::RuntimeWindowClosingTabRecord {
                    tab_id: tab.id.clone(),
                    source_id: tab.source_id.clone(),
                    tab_type: tab.tab_type.clone(),
                    role_ids: tab.slots.iter().map(|slot| slot.role_id.clone()).collect(),
                })
                .collect::<Vec<_>>();
            let covered_role_ids = lease
                .as_ref()
                .map(|lease| {
                    lease
                        .role_ids
                        .iter()
                        .map(String::as_str)
                        .collect::<std::collections::HashSet<_>>()
                })
                .unwrap_or_default();
            if closing_tabs.iter().any(|tab| {
                tab.role_ids
                    .iter()
                    .any(|role_id| !covered_role_ids.contains(role_id.as_str()))
            }) {
                return Err(CoreError::Domain {
                    code: "SYSTEM_WINDOW_CLOSE_SCOPE_CHANGED",
                    message: "Window role ownership changed before close admission committed."
                        .to_owned(),
                });
            }
            self.invoke_browser_runtime(BrowserRuntimeCommand::CloseTabs {
                tab_ids: request.tab_ids.clone(),
            })?;
            self.embedded_closing_tabs
                .lock()
                .map_err(|_| CoreError::Internal("embedded closing tab lock poisoned".to_owned()))?
                .extend(request.tab_ids.iter().cloned());
            request.admission_id = lease.as_ref().map(|lease| lease.id.clone());
            request.closing_tabs = closing_tabs;
            Ok(request)
        })();
        let request = match admitted {
            Ok(request) => request,
            Err(error) => {
                if let Some(lease) = lease {
                    let _ = self.browser_operations.abort(&lease.id);
                }
                return Err(error);
            }
        };
        drop(reload_admission);
        self.browser_runtime_snapshot_without_persistence()?;
        Ok(request)
    }

    fn stop_embedded_window_runtime(
        &self,
        request: &RuntimeWindowStopRequestRecord,
        delete: bool,
    ) -> CoreResult<()> {
        let admitted_request = if request.admission_id.is_some() || !request.closing_tabs.is_empty()
        {
            request.clone()
        } else {
            self.admit_embedded_window_close(request.clone())?
        };
        let result = self.finish_admitted_embedded_window_close(&admitted_request, delete);
        let completion = admitted_request
            .admission_id
            .as_deref()
            .map(|admission_id| self.browser_operations.complete(admission_id));
        match (result, completion) {
            (Ok(()), None | Some(Ok(()))) => Ok(()),
            (Err(error), _) => Err(error),
            (Ok(()), Some(Err(error))) => Err(error),
        }
    }

    fn finish_admitted_embedded_window_close(
        &self,
        request: &RuntimeWindowStopRequestRecord,
        delete: bool,
    ) -> CoreResult<()> {
        let window_id = request.window_id.as_str();
        let pending_role_ids = request
            .closing_tabs
            .iter()
            .flat_map(|tab| tab.role_ids.iter().cloned())
            .collect::<std::collections::HashSet<_>>();
        for role_id in &pending_role_ids {
            self.macro_runtime.request_stop_role(role_id)?;
        }
        let mut first_error = None;
        for tab_id in &request.tab_ids {
            if let Err(error) = self.run_embedded_runtime_effect(
                tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    attempt_generation: None,
                    next_active_tab_id: None,
                },
                None,
                Some(&request.parent_operation_id),
            ) && first_error.is_none()
            {
                first_error = Some(error);
            }
            if let Ok(mut closing_tabs) = self.embedded_closing_tabs.lock() {
                closing_tabs.remove(tab_id);
            }
        }
        self.browser_runtime_snapshot_without_persistence()?;
        if let Some(error) = first_error {
            return Err(error);
        }
        for role_id in &pending_role_ids {
            self.macro_runtime.release_role(role_id)?;
        }

        if !delete {
            return Ok(());
        }

        let persisted_window_exists = self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .iter()
            .any(|window| window.id == window_id);
        if persisted_window_exists {
            self.mutate_state(StateMutation::GameWindowDelete {
                id: window_id.to_owned(),
            })?;
        }
        Ok(())
    }

    fn run_effect_plan(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        self.run_effect_plan_for_roles(steps, &[])
    }

    fn run_effect_plan_with_parent(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
        parent_operation_id: &str,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let handle = self.operation_actor.start_with_parent(
            crate::operation_actor::OperationPlan { steps },
            parent_operation_id.to_owned(),
        )?;
        self.finish_effect_plan_for_roles(handle, &[])
    }

    fn run_embedded_runtime_effect_plan(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        match parent_operation_id {
            Some(parent_operation_id) => {
                self.run_effect_plan_with_parent(steps, parent_operation_id)
            }
            None => self.run_effect_plan(steps),
        }
    }

    fn run_embedded_runtime_effect(
        &self,
        handle_id: &str,
        action: CoreEffectAction,
        compensation: Option<CoreEffectAction>,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        self.run_embedded_runtime_effect_plan(
            vec![effect_step(
                handle_id,
                action,
                Duration::from_secs(15),
                compensation,
            )],
            parent_operation_id,
        )
    }

    fn start_system_launch(
        &self,
        request: SystemLaunchRequest<'_>,
    ) -> CoreResult<crate::operation_actor::OperationHandle> {
        let SystemLaunchRequest {
            tab_id,
            mut tab,
            roles,
            runtime_snapshot,
            global_web_profile,
            presentation_intent,
            resolved_engine,
        } = request;
        let web_surface_load = embedded_web_surface_load_plan(&tab, global_web_profile)?;
        if let Some((window_generation, topology_revision)) =
            self.ensure_chromium_runtime_launch_topology(&tab)?
        {
            tab.appkit_window_generation = Some(window_generation);
            tab.appkit_topology_revision = Some(topology_revision);
        }
        // Stable System WebView launch previews already own WindowAndContent focus. Chromium has
        // no shell-side preview, so only a fresh foreground Chromium launch receives this exact
        // post-topology focus projection; restore hydration must preserve the current key window.
        let foreground_windows = (presentation_intent
            == EmbeddedLaunchPresentationIntent::Foreground
            && self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION
            && resolved_engine == crate::model::ResolvedBrowserEngine::Chromium)
            .then(|| self.embedded_runtime_window_projections())
            .transpose()?;
        let role_ids = roles.iter().map(|role| role.id.clone()).collect::<Vec<_>>();
        self.start_effect_plan_for_roles(
            embedded_launch_effects(
                tab_id,
                tab.clone(),
                roles,
                runtime_snapshot.clone(),
                self.application_lifecycle_epoch.load(Ordering::Acquire),
                web_surface_load,
                foreground_windows,
            )?,
            &role_ids,
        )
    }

    fn finish_system_launch(
        &self,
        handle: crate::operation_actor::OperationHandle,
        roles: &[StateRoleRecord],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let role_ids = roles.iter().map(|role| role.id.clone()).collect::<Vec<_>>();
        let launch = self.finish_effect_plan_for_roles(handle, &role_ids);
        let error = match launch {
            Ok(outcome) => return Ok(outcome),
            Err(error) => error,
        };
        if matches!(error.code(), "LAUNCH_CANCELLED" | "LAUNCH_PREVIEW_STALE") {
            return Err(error);
        }
        let failure_reason = crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed;
        self.record_browser_runtime_issue(&role_ids, failure_reason)?;
        Err(error)
    }

    async fn finish_system_launch_async(
        &self,
        handle: crate::operation_actor::OperationHandle,
        roles: &[StateRoleRecord],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let role_ids = roles.iter().map(|role| role.id.clone()).collect::<Vec<_>>();
        let launch = self
            .finish_effect_plan_for_roles_async(handle, &role_ids)
            .await;
        let error = match launch {
            Ok(outcome) => return Ok(outcome),
            Err(error) => error,
        };
        if error.code() == "LAUNCH_CANCELLED" {
            return Err(error);
        }
        self.record_browser_runtime_issue(
            &role_ids,
            crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed,
        )?;
        Err(error)
    }

    fn report_crashed_system_surface(
        &self,
        role_id: &str,
        reason: Option<&str>,
        expected_tab_id: Option<&str>,
        expected_owner_generation: Option<u64>,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let runtime_role = snapshot
            .roles
            .iter()
            .find(|role| role.role_id == role_id && role.runtime == "embedded")
            .ok_or_else(|| CoreError::Domain {
                code: "EMBEDDED_ROLE_NOT_RUNNING",
                message: "The embedded role is not running.".to_owned(),
            })?;
        match (expected_tab_id, expected_owner_generation) {
            (None, None) => {}
            (Some(tab_id), Some(owner_generation))
                if runtime_role.owner.tab_id == tab_id
                    && runtime_role.owner.generation == owner_generation => {}
            (Some(_), Some(_)) => {
                return Err(CoreError::Domain {
                    code: "RUNTIME_ROLE_OWNER_STALE",
                    message: "The failed system surface no longer owns this runtime role."
                        .to_owned(),
                });
            }
            _ => {
                return Err(CoreError::Domain {
                    code: "RUNTIME_ROLE_OWNER_FENCE_INVALID",
                    message: "Both runtime role owner fences are required together.".to_owned(),
                });
            }
        }
        let owner_tab = snapshot
            .tabs
            .iter()
            .find(|tab| runtime_role.owner.tab_id == tab.id)
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        if !owner_tab
            .slots
            .iter()
            .any(|slot| slot.slot_id == runtime_role.owner.slot_id && slot.role_id == role_id)
        {
            return Err(CoreError::Domain {
                code: "RUNTIME_ROLE_OWNER_STALE",
                message: "The failed system surface no longer owns this runtime role.".to_owned(),
            });
        }
        let project_chromium_failure = self.degrade_chromium_runtime_role_failure_activation(
            &authority_guard,
            role_id,
            &owner_tab.id,
            &owner_tab.window_id,
            runtime_role.owner.generation,
        )?;
        let reload_admission =
            self.supersede_controlled_role_reloads(&[role_id.to_owned()], "surfaceRecovery")?;
        let affected_role_ids = [role_id.to_owned()];
        #[cfg(test)]
        let after_owner_fence = self
            .system_surface_failure_after_owner_fence_hook
            .lock()
            .map_err(|_| {
                CoreError::Internal("system surface failure hook lock poisoned".to_owned())
            })?
            .clone();
        #[cfg(test)]
        if let Some(hook) = after_owner_fence {
            hook();
        }
        self.macro_runtime
            .terminalize_role_after_navigation_failure(role_id)?;
        let failure_reason = if reason == Some("popup-unsupported") {
            crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed
        } else {
            crate::model::BrowserRuntimeFailureReason::RuntimeCrashed
        };
        {
            let mut ready_roles = self.browser_runtime_ready_roles.write().map_err(|_| {
                CoreError::Internal("browser runtime readiness lock poisoned".to_owned())
            })?;
            for role_id in &affected_role_ids {
                ready_roles.remove(role_id);
            }
        }
        {
            let mut issues = self.browser_runtime_issues.write().map_err(|_| {
                CoreError::Internal("browser runtime issue lock poisoned".to_owned())
            })?;
            for role_id in &affected_role_ids {
                issues.insert(role_id.clone(), failure_reason);
            }
        }
        let statuses = self
            .browser_statuses()?
            .into_iter()
            .filter(|status| affected_role_ids.contains(&status.role_id))
            .collect::<Vec<_>>();
        drop(reload_admission);
        if project_chromium_failure {
            drop(authority_guard);
            self.project_embedded_runtime_snapshot_without_persistence(None)?;
        } else {
            self.emit(vec![CoreEvent::BrowserStatuses {
                statuses: self.browser_statuses()?,
            }]);
        }
        Ok(statuses)
    }

    fn report_recovered_system_surface(
        &self,
        role_id: &str,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let runtime_role = snapshot
            .roles
            .iter()
            .find(|role| role.role_id == role_id && role.runtime == "embedded")
            .ok_or_else(|| CoreError::Domain {
                code: "EMBEDDED_ROLE_NOT_RUNNING",
                message: "The embedded role is not running.".to_owned(),
            })?;
        let role_ids = snapshot
            .tabs
            .iter()
            .find(|tab| runtime_role.owner.tab_id == tab.id)
            .map(|tab| {
                tab.slots
                    .iter()
                    .map(|slot| slot.role_id.clone())
                    .collect::<Vec<_>>()
            })
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        {
            let mut issues = self.browser_runtime_issues.write().map_err(|_| {
                CoreError::Internal("browser runtime issue lock poisoned".to_owned())
            })?;
            for role_id in &role_ids {
                issues.remove(role_id);
            }
        }
        {
            let mut ready_roles = self.browser_runtime_ready_roles.write().map_err(|_| {
                CoreError::Internal("browser runtime readiness lock poisoned".to_owned())
            })?;
            ready_roles.extend(role_ids.iter().cloned());
        }
        let statuses = self
            .browser_statuses()?
            .into_iter()
            .filter(|status| role_ids.contains(&status.role_id))
            .collect::<Vec<_>>();
        self.emit(vec![CoreEvent::BrowserStatuses {
            statuses: self.browser_statuses()?,
        }]);
        Ok(statuses)
    }

    fn run_effect_plan_for_roles(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let handle = self.start_effect_plan_for_roles(steps, role_ids)?;
        self.finish_effect_plan_for_roles(handle, role_ids)
    }

    fn start_effect_plan_for_roles(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationHandle> {
        let plan = crate::operation_actor::OperationPlan { steps };
        let handle = if role_ids.is_empty() {
            self.operation_actor.start(plan)?
        } else {
            self.operation_actor.start_launch(plan)?
        };
        let operation_id = handle.operation_id.clone();
        if !role_ids.is_empty() {
            let mut operations = match self.embedded_operations.lock() {
                Ok(operations) => operations,
                Err(_) => {
                    let _ = self.operation_actor.cancel(&operation_id);
                    return Err(CoreError::Internal(
                        "embedded operation registry poisoned".to_owned(),
                    ));
                }
            };
            role_ids.iter().for_each(|role_id| {
                operations.insert(role_id.clone(), operation_id.clone());
            });
        }
        Ok(handle)
    }

    fn finish_effect_plan_for_roles(
        &self,
        handle: crate::operation_actor::OperationHandle,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let operation_id = handle.operation_id.clone();
        let outcome = handle.outcome.blocking_recv().map_err(|_| {
            CoreError::Internal("operation actor stopped before returning an outcome".to_owned())
        });
        self.resolve_effect_plan_outcome(operation_id, outcome, role_ids)
    }

    async fn finish_effect_plan_for_roles_async(
        &self,
        handle: crate::operation_actor::OperationHandle,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let operation_id = handle.operation_id.clone();
        let outcome = handle.outcome.await.map_err(|_| {
            CoreError::Internal("operation actor stopped before returning an outcome".to_owned())
        });
        self.resolve_effect_plan_outcome(operation_id, outcome, role_ids)
    }

    fn resolve_effect_plan_outcome(
        &self,
        operation_id: String,
        outcome: CoreResult<crate::operation_actor::OperationOutcome>,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        if !role_ids.is_empty() {
            let mut operations = self.embedded_operations.lock().map_err(|_| {
                CoreError::Internal("embedded operation registry poisoned".to_owned())
            })?;
            operations.retain(|_, candidate| candidate != &operation_id);
        }
        let outcome = outcome?;
        if !outcome.compensation_failures.is_empty() {
            let compensation_code_values = outcome
                .compensation_failures
                .iter()
                .map(|failure| failure.error.code.clone())
                .collect::<Vec<_>>();
            let compensation_codes = compensation_code_values.join(", ");
            let root_cause_code = outcome.error.as_ref().map(|error| error.code.clone());
            let _ = self.invoke(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level: LogLevel::Error,
                    source: crate::model::LogSource::Main,
                    event: "operation.compensation-failed".to_owned(),
                    message: "A native operation failed and its compensation did not complete."
                        .to_owned(),
                    context_raw_json: serde_json::to_string(&json!({
                        "compensationCode": compensation_code_values,
                        "operationId": operation_id,
                        "rootCauseCode": root_cause_code,
                        "roleIds": role_ids,
                    }))
                    .ok(),
                    error: outcome
                        .error
                        .as_ref()
                        .map(|error| crate::model::LogErrorDetails {
                            name: error.code.clone(),
                            message: error.message.clone(),
                            stack: None,
                            cause: None,
                        }),
                }],
            });
            let journal_error = self
                .record_operation_compensation_failure(&outcome, role_ids)
                .err()
                .map(|error| format!(" The recovery journal also failed: {error}"))
                .unwrap_or_default();
            return Err(CoreError::Effect {
                code: "CORE_OPERATION_COMPENSATION_FAILED".to_owned(),
                message: format!(
                    "The desktop shell operation failed and its native compensation did not complete ({compensation_codes}). Restart Rion Studio before retrying.{journal_error}"
                ),
            });
        }
        if let Some(error) = &outcome.error {
            if matches!(
                error.code.as_str(),
                "CORE_OPERATION_CANCELLED" | "CHROMIUM_RUNTIME_EFFECT_CANCELLED"
            ) {
                return Err(CoreError::Effect {
                    code: "LAUNCH_CANCELLED".to_owned(),
                    message: "Browser launch was cancelled.".to_owned(),
                });
            }
            return Err(CoreError::Effect {
                code: error.code.clone(),
                message: error.message.clone(),
            });
        }
        Ok(outcome)
    }

    fn record_operation_compensation_failure(
        &self,
        outcome: &crate::operation_actor::OperationOutcome,
        role_ids: &[String],
    ) -> CoreResult<()> {
        let failures = outcome
            .compensation_failures
            .iter()
            .map(|failure| {
                json!({
                    "target": &failure.effect.target,
                    "action": &failure.effect.action,
                    "error": &failure.error,
                })
            })
            .collect::<Vec<_>>();
        self.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: format!("native-compensation-{}", outcome.operation_id),
                kind: "native_effect_compensation_v1".to_owned(),
                phase: "restart-required".to_owned(),
                payload: json!({
                    "operationId": outcome.operation_id,
                    "roleIds": role_ids,
                    "originalError": &outcome.error,
                    "failures": failures,
                }),
            })
        })
    }

    fn cancel_embedded_operations(&self, role_ids: &[String]) -> CoreResult<()> {
        let operation_ids = {
            let operations = self.embedded_operations.lock().map_err(|_| {
                CoreError::Internal("embedded operation registry poisoned".to_owned())
            })?;
            role_ids
                .iter()
                .filter_map(|role_id| operations.get(role_id).cloned())
                .collect::<std::collections::HashSet<_>>()
        };
        for operation_id in operation_ids {
            self.operation_actor.cancel(&operation_id)?;
        }
        Ok(())
    }

    fn save_runtime_game_window(
        &self,
        input: GameWindowSaveRuntimeInputRecord,
    ) -> CoreResult<Value> {
        if let Some(existing) = self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .into_iter()
            .find(|window| window.id == input.window_id)
        {
            return serde_json::to_value(existing)
                .map_err(|error| CoreError::Internal(error.to_string()));
        }

        // The shell constructs this record from LiveWindowTabState, which owns
        // open-window topology. Core validates the persisted domain record in
        // StateMutation; its role-ownership snapshot is intentionally not a
        // prerequisite for saving a newly detached live window.
        self.mutate_state(StateMutation::GameWindowSaveRuntime(input))
    }
}
