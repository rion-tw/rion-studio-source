impl AppCore {
    async fn delete_workspaces_runtime_aware(
        self: &Arc<Self>,
        ids: Vec<String>,
    ) -> CoreResult<Value> {
        let ids = normalize_runtime_bulk_ids(ids)?;
        let workspaces =
            self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?;
        let existing = workspaces
            .iter()
            .map(|workspace| workspace.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut eligible = Vec::new();
        let mut skipped = Vec::new();
        for id in ids {
            if !existing.contains(&id) {
                skipped.push(json!({ "id": id, "reason": "not_found", "relatedNames": [] }));
                continue;
            }
            eligible.push(id);
        }
        if eligible.is_empty() {
            return Ok(json!({ "deletedIds": [], "skipped": skipped }));
        }
        let eligible_set = eligible
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let mut operation_role_ids = workspaces
            .iter()
            .filter(|workspace| eligible_set.contains(workspace.id.as_str()))
            .flat_map(|workspace| workspace.slots.iter())
            .filter_map(|slot| slot.role_id.clone())
            .collect::<Vec<_>>();
        operation_role_ids.extend(
            self.browser_runtime
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot
                .workspaces
                .into_iter()
                .filter(|workspace| eligible_set.contains(workspace.workspace_id.as_str()))
                .flat_map(|workspace| workspace.role_ids),
        );
        operation_role_ids.extend(eligible.iter().map(|id| workspace_operation_key(id)));
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: operation_role_ids,
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let mut stopped = Vec::new();
            for id in eligible {
                match core.stop_embedded_workspace_under_active_lease(&id) {
                    Ok(()) => stopped.push(id),
                    Err(error) => skipped.push(classify_runtime_bulk_error(id, &error)),
                }
            }
            let mut result = core.mutate_state(StateMutation::WorkspacesDelete { ids: stopped })?;
            if let Some(result_skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
                result_skipped.extend(skipped);
            }
            Ok::<_, CoreError>(result)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn mutate_with_role_lease(
        &self,
        role_ids: Vec<String>,
        mutation: StateMutation,
    ) -> CoreResult<Value> {
        let role_ids = role_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect::<Vec<_>>();
        if role_ids.is_empty() {
            return self.mutate_state(mutation);
        }
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids,
            kind: "normal".to_owned(),
        })?;
        let result = self.mutate_state(mutation);
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn update_macro_runtime_aware(
        &self,
        id: String,
        input: crate::model::MacroUpdateInputRecord,
    ) -> CoreResult<Value> {
        let mut macros = self.read_typed_state_collection::<StateMacroRecord>("macros")?;
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let candidate = crate::domain::update_macro(&mut macros, &id, input.clone())?;
        if candidate.role_ids.iter().any(|role_id| {
            !roles
                .iter()
                .any(|candidate_role| candidate_role.id == *role_id)
        }) {
            return Err(CoreError::Domain {
                code: "MACRO_ROLE_ID_INVALID",
                message: "Macro role IDs must reference existing roles.".to_owned(),
            });
        }
        let stop_active = input.enabled == Some(false);
        self.mutate_macros_with_mode(
            vec![id.clone()],
            stop_active,
            StateMutation::MacroUpdate { id, input },
        )
    }

    fn mutate_macros_runtime_aware(
        &self,
        ids: Vec<String>,
        mutation: StateMutation,
    ) -> CoreResult<Value> {
        self.mutate_macros_with_mode(ids, true, mutation)
    }

    fn mutate_macros_with_mode(
        &self,
        ids: Vec<String>,
        stop_active: bool,
        mutation: StateMutation,
    ) -> CoreResult<Value> {
        let lease = self.macro_runtime.acquire_mutation(ids, stop_active)?;
        let result = self.mutate_state(mutation);
        let release = self.macro_runtime.release_mutation(&lease);
        match (result, release) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn delete_role_saga(&self, id: &str) -> CoreResult<Value> {
        self.ensure_role_exists(id)?;
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![id.to_owned()],
            kind: "destructiveMutation".to_owned(),
        })?;
        let result = self.delete_role_saga_under_active_lease(id);
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn delete_role_saga_under_active_lease(&self, id: &str) -> CoreResult<Value> {
        self.ensure_role_exists(id)?;
        self.macro_runtime.stop_role(id)?;
        let operation_id = format!("role-delete-{}", uuid::Uuid::new_v4());
        let mut journal = OperationJournalRecord {
            id: operation_id.clone(),
            kind: "role_delete_v1".to_owned(),
            phase: "prepared".to_owned(),
            payload: json!({ "roleId": id }),
        };
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        let deferred_cleanup = match crate::role_browser_data::quarantine_for_delete(
            &self.user_data_dir,
            id,
            &operation_id,
        ) {
            Ok(crate::role_browser_data::DeleteQuarantineOutcome::DeferredByWindowsLock) => true,
            Ok(crate::role_browser_data::DeleteQuarantineOutcome::Quarantined(_)) => {
                journal.phase = "quarantined".to_owned();
                if let Err(error) = self
                    .with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))
                {
                    let _ = crate::role_browser_data::restore_quarantine(
                        &self.user_data_dir,
                        id,
                        &operation_id,
                    );
                    let _ = self.with_runtime(|runtime| {
                        runtime.state.delete_operation_journal(operation_id.clone())
                    });
                    return Err(error);
                }
                false
            }
            Err(error) => {
                let _ = self.with_runtime(|runtime| {
                    runtime.state.delete_operation_journal(operation_id.clone())
                });
                return Err(error);
            }
        };
        let deletion = self.mutate_state(StateMutation::RoleDelete {
            id: id.to_owned(),
            operation_id: Some(operation_id.clone()),
        });
        let value = match deletion {
            Ok(value) => value,
            Err(error) => {
                let restore = if deferred_cleanup {
                    Ok(())
                } else {
                    crate::role_browser_data::restore_quarantine(
                        &self.user_data_dir,
                        id,
                        &operation_id,
                    )
                };
                let _ = self.with_runtime(|runtime| {
                    runtime.state.delete_operation_journal(operation_id.clone())
                });
                restore?;
                return Err(error);
            }
        };
        if !deferred_cleanup {
            crate::role_browser_data::discard_quarantine(&self.user_data_dir, &operation_id)?;
            self.with_runtime(|runtime| runtime.state.delete_operation_journal(operation_id))?;
        }
        Ok(value)
    }

    fn delete_roles_saga_under_active_lease(&self, ids: Vec<String>) -> CoreResult<Value> {
        for id in &ids {
            self.ensure_role_exists(id)?;
            self.macro_runtime.stop_role(id)?;
        }
        (|| {
            let mut journals = Vec::new();
            for id in &ids {
                let operation_id = format!("role-delete-{}", uuid::Uuid::new_v4());
                let mut journal = OperationJournalRecord {
                    id: operation_id.clone(),
                    kind: "role_delete_v1".to_owned(),
                    phase: "prepared".to_owned(),
                    payload: json!({ "roleId": id }),
                };
                if let Err(error) = self
                    .with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))
                {
                    rollback_role_delete_journals(self, &journals);
                    return Err(error);
                }
                let deferred_cleanup = match crate::role_browser_data::quarantine_for_delete(
                    &self.user_data_dir,
                    id,
                    &operation_id,
                ) {
                    Ok(crate::role_browser_data::DeleteQuarantineOutcome::DeferredByWindowsLock) => {
                        true
                    }
                    Ok(crate::role_browser_data::DeleteQuarantineOutcome::Quarantined(_)) => {
                        journal.phase = "quarantined".to_owned();
                        if let Err(error) = self.with_runtime(|runtime| {
                            runtime.state.put_operation_journal(journal.clone())
                        }) {
                            let current = vec![(id.clone(), journal.id.clone(), false)];
                            rollback_role_delete_journals(self, &current);
                            rollback_role_delete_journals(self, &journals);
                            return Err(error);
                        }
                        false
                    }
                    Err(error) => {
                        let _ = self.with_runtime(|runtime| {
                            runtime.state.delete_operation_journal(operation_id)
                        });
                        rollback_role_delete_journals(self, &journals);
                        return Err(error);
                    }
                };
                journals.push((id.clone(), journal.id, deferred_cleanup));
            }
            let operation_ids = journals
                .iter()
                .map(|(role_id, operation_id, _)| (role_id.clone(), operation_id.clone()))
                .collect();
            let deletion = self.mutate_state(StateMutation::RolesDelete {
                ids: ids.clone(),
                operation_ids,
            });
            let value = match deletion {
                Ok(value) => value,
                Err(error) => {
                    rollback_role_delete_journals(self, &journals);
                    return Err(error);
                }
            };
            for (_, operation_id, deferred_cleanup) in &journals {
                if *deferred_cleanup {
                    continue;
                }
                crate::role_browser_data::discard_quarantine(&self.user_data_dir, operation_id)?;
                self.with_runtime(|runtime| {
                    runtime.state.delete_operation_journal(operation_id.clone())
                })?;
            }
            Ok(value)
        })()
    }

    async fn clear_role_browser_data(self: &Arc<Self>, role_id: String) -> CoreResult<Value> {
        self.ensure_role_exists(&role_id)?;
        self.cancel_embedded_operations(std::slice::from_ref(&role_id))?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let prepared_role_id = role_id.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            core.stop_embedded_role_under_active_lease(&prepared_role_id)?;
            core.macro_runtime.stop_role(&prepared_role_id)?;
            Ok::<_, CoreError>(())
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        match prepared {
            Ok(()) => {}
            Err(error) => {
                let _ = self.browser_operations.abort(&lease.id);
                return Err(error);
            }
        };
        let operation_id = format!("role-browser-clear-{}", uuid::Uuid::new_v4());
        let role_paths = crate::role_browser_data::paths(&self.user_data_dir, &role_id)?;
        let journal = OperationJournalRecord {
            id: operation_id.clone(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "prepared".to_owned(),
            payload: json!({ "roleId": role_id, "hadDirectory": false }),
        };
        let prepare = {
            let core = Arc::clone(self);
            let role_id = role_id.clone();
            let operation_id = operation_id.clone();
            tokio::task::spawn_blocking(move || {
                core.with_runtime(|runtime| runtime.state.put_operation_journal(journal))?;
                let had_directory = match crate::role_browser_data::quarantine(
                    &core.user_data_dir,
                    &role_id,
                    &operation_id,
                ) {
                    Ok(had_directory) => had_directory,
                    Err(error) => {
                        let _ = core.with_runtime(|runtime| {
                            runtime.state.delete_operation_journal(operation_id.clone())
                        });
                        return Err(error);
                    }
                };
                if let Err(error) = core.with_runtime(|runtime| {
                    runtime.state.put_operation_journal(OperationJournalRecord {
                        id: operation_id.clone(),
                        kind: "role_browser_data_clear_v1".to_owned(),
                        phase: "quarantined".to_owned(),
                        payload: json!({
                            "roleId": role_id.clone(),
                            "hadDirectory": had_directory
                        }),
                    })
                }) {
                    if had_directory {
                        let _ = crate::role_browser_data::restore_quarantine(
                            &core.user_data_dir,
                            &role_id,
                            &operation_id,
                        );
                    }
                    let _ = core.with_runtime(|runtime| {
                        runtime.state.delete_operation_journal(operation_id)
                    });
                    return Err(error);
                }
                Ok::<_, CoreError>(had_directory)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
        };
        let had_directory = match prepare {
            Ok(value) => value,
            Err(error) => {
                let _ = self.browser_operations.abort(&lease.id);
                return Err(error);
            }
        };

        let effect = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::RoleBrowserDataClearSession {
                    role_id: role_id.clone(),
                    webview2_user_data_dir: role_paths.webview2_user_data_dir,
                    webkit_data_store_identifier: role_paths.webkit_data_store_identifier,
                },
                Duration::from_secs(30),
            )
            .await;
        if let Err(error) = effect {
            let _ = rollback_role_browser_data_clear(self, &role_id, &operation_id, had_directory);
            let _ = self.browser_operations.abort(&lease.id);
            return Err(error);
        }

        let commit = {
            let core = Arc::clone(self);
            let role_id = role_id.clone();
            let operation_id = operation_id.clone();
            tokio::task::spawn_blocking(move || {
                crate::role_browser_data::ensure(&core.user_data_dir, &role_id)?;
                let role = core.mutate_state(StateMutation::RoleBrowserDataReset {
                    id: role_id.clone(),
                    operation_id: operation_id.clone(),
                });
                let role = match role {
                    Ok(role) => role,
                    Err(error) => {
                        rollback_role_browser_data_clear(
                            &core,
                            &role_id,
                            &operation_id,
                            had_directory,
                        )?;
                        return Err(error);
                    }
                };
                if crate::role_browser_data::discard_quarantine(&core.user_data_dir, &operation_id)
                    .is_ok()
                {
                    let _ = core.with_runtime(|runtime| {
                        runtime.state.delete_operation_journal(operation_id)
                    });
                }
                Ok::<_, CoreError>(role)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
        };
        let completion = if commit.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (commit, completion) {
            (Ok(role), Ok(())) => Ok(role),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn state_game(&self, game_id: &str) -> CoreResult<StateGameRecord> {
        self.read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .find(|game| game.id == game_id)
            .ok_or_else(|| CoreError::Domain {
                code: "GAME_NOT_FOUND",
                message: "Game not found.".to_owned(),
            })
    }

    fn state_workspace(&self, workspace_id: &str) -> CoreResult<StateLaunchWorkspaceRecord> {
        self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| CoreError::Domain {
                code: "WORKSPACE_NOT_FOUND",
                message: "Launch workspace not found.".to_owned(),
            })
    }

    async fn request_core_effect(
        &self,
        handle_id: &str,
        action: CoreEffectAction,
        timeout: Duration,
    ) -> CoreResult<CoreEffectResult> {
        let handle = self
            .operation_actor
            .start(crate::operation_actor::OperationPlan {
                steps: vec![effect_step(handle_id, action, timeout, None)],
            })?;
        let outcome = handle.outcome.await.map_err(|_| {
            CoreError::Internal("operation actor stopped before returning an outcome".to_owned())
        })?;
        if let Some(error) = outcome.error {
            return Err(CoreError::Effect {
                code: error.code,
                message: error.message,
            });
        }
        outcome
            .results
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::Internal("core effect returned no result".to_owned()))
    }

    async fn handle_overlay_request(
        &self,
        role_id: &str,
        request_json: &str,
        language: Option<String>,
    ) -> CoreResult<MacroOverlayViewModelRecord> {
        self.ensure_role_exists(role_id)?;
        let language = {
            let mut current = self
                .overlay_language
                .lock()
                .map_err(|_| CoreError::Internal("overlay language lock poisoned".to_owned()))?;
            if let Some(language) = language {
                validate_overlay_language(&language)?;
                *current = Some(language);
            }
            current.clone()
        };
        let request = crate::overlay::parse_request(request_json)?;
        let mut start_summary = None;
        match request {
            MacroOverlayRequestRecord::Activate
            | MacroOverlayRequestRecord::CoordinateContext
            | MacroOverlayRequestRecord::GameInputContext { .. }
            | MacroOverlayRequestRecord::List => {}
            MacroOverlayRequestRecord::Open => {
                self.request_core_effect(
                    role_id,
                    CoreEffectAction::OverlayOpenMacroPage {
                        role_id: role_id.to_owned(),
                    },
                    Duration::from_secs(10),
                )
                .await?;
            }
            MacroOverlayRequestRecord::CopyCoordinate { coordinate } => {
                self.request_core_effect(
                    role_id,
                    CoreEffectAction::OverlayCopyCoordinate { coordinate },
                    Duration::from_secs(10),
                )
                .await?;
            }
            MacroOverlayRequestRecord::Start { macro_id } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                let assigned_count = macros
                    .iter()
                    .find(|definition| definition.id == macro_id)
                    .map_or(0, |definition| definition.role_ids.len());
                let statuses = self.macro_runtime.start(MacroStartRequest {
                    macros,
                    settings,
                    macro_id,
                    source_role_id: Some(role_id.to_owned()),
                    active_role_ids: self.macro_active_role_ids()?,
                })?;
                start_summary = Some(MacroOverlayStartSummaryRecord {
                    skipped_count: assigned_count.saturating_sub(statuses.len()) as u32,
                    started_count: statuses.len() as u32,
                });
            }
            MacroOverlayRequestRecord::Toggle { macro_id } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_shortcut_available(&macros, role_id, &macro_id)?;
                let assigned_count = macros
                    .iter()
                    .find(|definition| definition.id == macro_id)
                    .map_or(0, |definition| definition.role_ids.len());
                let statuses = self.macro_runtime.toggle(MacroStartRequest {
                    macros,
                    settings,
                    macro_id,
                    source_role_id: Some(role_id.to_owned()),
                    active_role_ids: self.macro_active_role_ids()?,
                })?;
                start_summary = Some(MacroOverlayStartSummaryRecord {
                    skipped_count: assigned_count.saturating_sub(statuses.len()) as u32,
                    started_count: statuses.len() as u32,
                });
            }
            MacroOverlayRequestRecord::Stop { macro_id } => {
                let (macros, _) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                self.macro_runtime
                    .stop_macro_from_role(&macro_id, role_id)?;
            }
            MacroOverlayRequestRecord::Press { macro_id, press_id } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_shortcut_available(&macros, role_id, &macro_id)?;
                let assigned_count = macros
                    .iter()
                    .find(|definition| definition.id == macro_id)
                    .map_or(0, |definition| definition.role_ids.len());
                let statuses = self.macro_runtime.press(MacroPressRequest {
                    start: MacroStartRequest {
                        macros,
                        settings,
                        macro_id,
                        source_role_id: Some(role_id.to_owned()),
                        active_role_ids: self.macro_active_role_ids()?,
                    },
                    press_id,
                })?;
                start_summary = Some(MacroOverlayStartSummaryRecord {
                    skipped_count: assigned_count.saturating_sub(statuses.len()) as u32,
                    started_count: statuses.len() as u32,
                });
            }
            MacroOverlayRequestRecord::Release {
                macro_id,
                press_id,
                release_mode,
            } => {
                self.macro_runtime.release(MacroReleaseRequest {
                    macro_id,
                    source_role_id: role_id.to_owned(),
                    press_id,
                    mode: release_mode.unwrap_or_else(|| "complete_first_iteration".to_owned()),
                })?;
            }
        }
        self.overlay_view_model(role_id, language, start_summary)
    }

    fn overlay_view_model(
        &self,
        role_id: &str,
        language: Option<String>,
        start_summary: Option<MacroOverlayStartSummaryRecord>,
    ) -> CoreResult<MacroOverlayViewModelRecord> {
        let (macros, macro_badge_position) =
            self.with_runtime(|runtime| runtime.state.overlay_configuration())?;
        let shortcut_macro_ids = crate::overlay::shortcut_macro_ids(&macros, role_id);
        let macros = crate::overlay::available_macros(&macros, role_id);
        let macro_ids = macros
            .iter()
            .map(|definition| definition.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let all_statuses = self.macro_runtime.statuses()?;
        let statuses = all_statuses
            .iter()
            .filter(|status| {
                status.role_id == role_id && macro_ids.contains(status.macro_id.as_str())
            })
            .cloned()
            .collect();
        let shortcut_macro_id_set = shortcut_macro_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let shortcut_statuses = all_statuses
            .into_iter()
            .filter(|status| shortcut_macro_id_set.contains(status.macro_id.as_str()))
            .collect();
        let resolved_theme = self
            .resolved_theme
            .lock()
            .map_err(|_| CoreError::Internal("resolved theme lock poisoned".to_owned()))?
            .clone();
        Ok(MacroOverlayViewModelRecord {
            detached: false,
            language,
            macro_badge_position,
            macros,
            shortcut_macro_ids,
            shortcut_statuses,
            resolved_theme,
            start_summary,
            statuses,
        })
    }

}
