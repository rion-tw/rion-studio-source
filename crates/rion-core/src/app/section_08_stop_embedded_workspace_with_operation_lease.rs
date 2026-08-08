struct EmbeddedRuntimeTransition {
    commands: Vec<BrowserRuntimeCommand>,
    target: Option<EmbeddedLaunchTargetRecord>,
    reveal_window_ids: Vec<String>,
    focus_window_ids: Vec<String>,
    focus_tab_id: Option<String>,
    parent_operation_id: Option<String>,
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

            let Some((owned_roles, tab_id)) = prepared else {
                // Cancelling an in-flight launch removes its speculative Core
                // topology immediately, but EmbeddedCreateTab may already have
                // attached native surfaces. Run cleanup after releasing the
                // Core sequence lease so the native acknowledgement cannot
                // deadlock against runtime-state finalization.
                if let Some(tab_id) = initial_tab_id.as_deref() {
                    self.run_embedded_runtime_effect(
                        tab_id,
                        CoreEffectAction::EmbeddedDestroyTab {
                            tab_id: tab_id.to_owned(),
                            attempt_generation: None,
                            next_active_tab_id: None,
                        },
                        None,
                        parent_operation_id,
                    )?;
                }
                return Ok(());
            };

            // Keep durability behind native isolation. The final runtime commit
            // below persists the coalesced workspace removal.
            self.emit_browser_statuses();
            self.run_embedded_runtime_effect(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    attempt_generation: None,
                    next_active_tab_id: None,
                },
                None,
                parent_operation_id,
            )?;

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
                        .is_none_or(|role| {
                            role.owner.tab_id != tab_id
                                || role.state != "stopping"
                        })
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

    fn stop_embedded_window_runtime(
        &self,
        request: &RuntimeWindowStopRequestRecord,
        delete: bool,
    ) -> CoreResult<()> {
        let window_id = request.window_id.as_str();
        let live_tab_ids = request.tab_ids.as_slice();
        let tab_is_in_close_scope = |tab: &crate::model::BrowserRuntimeTabRecord| {
            live_tab_ids.iter().any(|tab_id| tab_id == &tab.id)
        };
        let pending_role_ids = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .tabs
            .iter()
            .filter(|tab| tab_is_in_close_scope(tab))
            .flat_map(|tab| tab.slots.iter().map(|slot| slot.role_id.clone()))
            .collect::<Vec<_>>();
        self.cancel_embedded_operations(&pending_role_ids)?;
        for role_id in &pending_role_ids {
            self.macro_runtime.request_stop_role(role_id)?;
        }
        let sources = {
            let _window_sequence = self.embedded_window_sequence.acquire()?;
            let snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let mut sources = snapshot
                .tabs
                .iter()
                .filter(|tab| tab_is_in_close_scope(tab))
                .map(|tab| (tab.tab_type.clone(), tab.source_id.clone()))
                .collect::<Vec<_>>();
            sources.sort();
            sources.dedup();
            sources
        };

        for (tab_type, source_id) in sources {
            if tab_type == "workspace" {
                self.stop_embedded_workspace_with_operation_lease(
                    &source_id,
                    true,
                    false,
                    Some(&request.parent_operation_id),
                )?;
            } else {
                self.stop_embedded_role_with_operation_lease(
                    &source_id,
                    true,
                    true,
                    false,
                    Some(&request.parent_operation_id),
                )?;
            }
        }

        let removed_unowned_demands = {
            let _window_sequence = self.embedded_window_sequence.acquire()?;
            let _runtime_sequence = self.embedded_runtime_sequence.acquire()?;
            let current = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let remaining_tab_ids = current
                .tabs
                .iter()
                .filter(|tab| tab_is_in_close_scope(tab))
                .map(|tab| tab.id.clone())
                .collect::<Vec<_>>();
            if current.roles.iter().any(|role| {
                remaining_tab_ids
                    .iter()
                    .any(|tab_id| tab_id == &role.owner.tab_id)
            }) {
                return Err(CoreError::Domain {
                    code: "SYSTEM_SURFACE_CLOSE_STALE",
                    message: "A role owner remained after the window close transaction."
                        .to_owned(),
                });
            }
            for tab_id in &remaining_tab_ids {
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                    tab_id: tab_id.clone(),
                })?;
            }
            !remaining_tab_ids.is_empty()
        };
        if removed_unowned_demands {
            self.emit_browser_statuses();
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
        tab_id: &str,
        tab: EmbeddedTabEffectRecord,
        roles: &[StateRoleRecord],
        runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
    ) -> CoreResult<crate::operation_actor::OperationHandle> {
        let role_ids = roles.iter().map(|role| role.id.clone()).collect::<Vec<_>>();
        self.start_effect_plan_for_roles(
            embedded_launch_effects(tab_id, tab.clone(), roles, runtime_snapshot.clone()),
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
        let failure_reason = crate::model::SystemWebViewIssueReason::RuntimeCreationFailed;
        self.record_system_webview_issue(&role_ids, failure_reason)?;
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
        self.record_system_webview_issue(
            &role_ids,
            crate::model::SystemWebViewIssueReason::RuntimeCreationFailed,
        )?;
        Err(error)
    }

    fn report_crashed_system_surface(
        &self,
        role_id: &str,
        reason: Option<&str>,
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
        let _ = self.macro_runtime.stop_role(role_id);
        let failure_reason = if reason == Some("popup-unsupported") {
            crate::model::SystemWebViewIssueReason::RuntimeCreationFailed
        } else {
            crate::model::SystemWebViewIssueReason::RuntimeCrashed
        };
        {
            let mut issues = self.system_webview_issues.write().map_err(|_| {
                CoreError::Internal("system WebView issue lock poisoned".to_owned())
            })?;
            for role_id in &role_ids {
                issues.insert(role_id.clone(), failure_reason);
            }
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
            let mut issues = self.system_webview_issues.write().map_err(|_| {
                CoreError::Internal("system WebView issue lock poisoned".to_owned())
            })?;
            for role_id in &role_ids {
                issues.remove(role_id);
            }
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
                        .map(|error| {
                            crate::model::LogErrorDetails {
                                name: error.code.clone(),
                                message: error.message.clone(),
                                stack: None,
                                cause: None,
                            }
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
            if error.code == "CORE_OPERATION_CANCELLED" {
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
