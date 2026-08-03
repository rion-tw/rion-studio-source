impl AppCore {
    fn commit_embedded_role_launch_outcome(
        &self,
        role: StateRoleRecord,
        tab_id: String,
        launch: CoreResult<crate::operation_actor::OperationOutcome>,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        if let Err(error) = launch {
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role.id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        let launched_at = chrono::Utc::now().to_rfc3339();
        let completion = self
            .invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role.id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: None,
                tab_id: Some(tab_id.clone()),
                state: "running".to_owned(),
                launched_at: Some(launched_at.clone()),
            })
            .and_then(|_| {
                self.commit_embedded_runtime_snapshot_without_native_effect(
                    &std::collections::HashSet::new(),
                )
            });
        if let Err(error) = completion {
            let _ = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    attempt_generation: None,
                    next_active_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )]);
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role.id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        self.macro_runtime.allow_role_after_launch(&role.id);
        Ok(vec![embedded_launch_result(&role.id, launched_at)])
    }

    fn launch_embedded_workspace(
        &self,
        workspace_id: &str,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let workspace =
            serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                "launchWorkspaces",
                "id",
                workspace_id,
                "WORKSPACE_NOT_FOUND",
                "Launch workspace not found.",
            )?)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let expected_role_ids = workspace
            .slots
            .iter()
            .filter_map(|slot| slot.role_id.clone())
            .collect::<Vec<_>>();
        self.launch_embedded_workspace_for_roles(workspace_id, &expected_role_ids, target)
    }

    fn launch_embedded_workspace_for_roles(
        &self,
        workspace_id: &str,
        expected_role_ids: &[String],
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        match self.start_embedded_workspace_for_roles(workspace_id, expected_role_ids, target)? {
            EmbeddedWorkspaceLaunchStart::Completed(value) => Ok(value),
            EmbeddedWorkspaceLaunchStart::Pending(pending) => {
                let lease_id = pending.lease_id.clone();
                let result = self.settle_embedded_workspace_launch_blocking(*pending);
                let completion = self.browser_operations.complete(&lease_id);
                match (result, completion) {
                    (Ok(value), Ok(())) => Ok(value),
                    (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                }
            }
        }
    }

    fn start_embedded_workspace_for_roles(
        &self,
        workspace_id: &str,
        expected_role_ids: &[String],
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<EmbeddedWorkspaceLaunchStart> {
        if expected_role_ids.is_empty() {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLES_REQUIRED",
                message: "The launch workspace has no roles.".to_owned(),
            });
        }
        let mut operation_role_ids = expected_role_ids.to_vec();
        operation_role_ids.push(workspace_operation_key(workspace_id));
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: operation_role_ids,
            kind: "normal".to_owned(),
        })?;
        let result = (|| {
            let workspace =
                serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                    "launchWorkspaces",
                    "id",
                    workspace_id,
                    "WORKSPACE_NOT_FOUND",
                    "Launch workspace not found.",
                )?)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            let role_ids = workspace
                .slots
                .iter()
                .filter_map(|slot| slot.role_id.clone())
                .collect::<Vec<_>>();
            let expected = expected_role_ids
                .iter()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            let current = role_ids
                .iter()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            if current != expected {
                return Err(CoreError::Domain {
                    code: "WORKSPACE_DATA_CHANGED",
                    message: "The launch workspace roles changed while launch was waiting."
                        .to_owned(),
                });
            }
            for role_id in &role_ids {
                self.ensure_role_session_recovery_complete(role_id)?;
            }
            let snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            if let Some(runtime_workspace) = snapshot
                .workspaces
                .iter()
                .find(|candidate| candidate.workspace_id == workspace_id)
            {
                if runtime_workspace.state != "running" {
                    return Err(CoreError::Domain {
                        code: "WORKSPACE_ALREADY_RUNNING",
                        message: "The workspace is already launching or stopping.".to_owned(),
                    });
                }
                let tab_id = runtime_workspace.tab_id.clone().ok_or_else(|| {
                    CoreError::Internal("embedded workspace runtime is missing its tab".to_owned())
                })?;
                self.apply_embedded_tab_selection_without_native_effect(
                    BrowserRuntimeCommand::ActivateTab {
                        tab_id: tab_id.clone(),
                    },
                )?;
                return Ok(EmbeddedWorkspaceLaunchStart::Completed(
                    runtime_workspace
                        .role_ids
                        .iter()
                        .map(|role_id| {
                            let launched_at = snapshot
                                .roles
                                .iter()
                                .find(|role| &role.role_id == role_id)
                                .and_then(|role| role.launched_at.clone())
                                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                            embedded_launch_result(role_id, launched_at)
                        })
                        .collect(),
                ));
            }
            self.start_embedded_workspace_with_lease(workspace, role_ids, target, lease.id.clone())
        })();
        match result {
            Ok(EmbeddedWorkspaceLaunchStart::Pending(pending)) => {
                Ok(EmbeddedWorkspaceLaunchStart::Pending(pending))
            }
            Ok(EmbeddedWorkspaceLaunchStart::Completed(value)) => {
                self.browser_operations.complete(&lease.id)?;
                Ok(EmbeddedWorkspaceLaunchStart::Completed(value))
            }
            Err(error) => {
                let _ = self.browser_operations.complete(&lease.id);
                Err(error)
            }
        }
    }

    fn start_embedded_workspace_with_lease(
        &self,
        workspace: StateLaunchWorkspaceRecord,
        role_ids: Vec<String>,
        target: EmbeddedLaunchTargetRecord,
        lease_id: String,
    ) -> CoreResult<EmbeddedWorkspaceLaunchStart> {
        let available_roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| (role.id.clone(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let roles = role_ids
            .iter()
            .filter_map(|role_id| available_roles.get(role_id).cloned())
            .collect::<Vec<_>>();
        if roles.len() != role_ids.len() {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLE_NOT_FOUND",
                message: "A launch workspace role no longer exists.".to_owned(),
            });
        }
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let available_games = self
            .read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .map(|game| (game.id.clone(), game))
            .collect::<std::collections::HashMap<_, _>>();
        self.reset_system_launch_retry_state(&roles)?;
        let workspace_resolution =
            self.resolve_workspace_browser_engine(&roles, &available_games, &settings)?;
        require_system_resolution(&workspace_resolution)?;
        let workspace_resolved_engine = workspace_resolution.resolved_engine;
        self.invoke_browser_runtime(BrowserRuntimeCommand::BeginWorkspace {
            workspace_id: workspace.id.clone(),
            name: workspace.name.clone(),
            window_id: Some(target.window_id.clone()),
            role_ids: role_ids.clone(),
        })?;
        let tab_id = match self.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            tab_id: self.saved_game_window_tab_id(&target.window_id, "workspace", &workspace.id)?,
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            window_id: target.window_id.clone(),
            tab_type: "workspace".to_owned(),
            workspace_id: Some(workspace.id.clone()),
            role_ids: role_ids.clone(),
        }) {
            Ok(result) => result
                .created_tab_id
                .ok_or_else(|| CoreError::Internal("workspace tab was not created".to_owned()))?,
            Err(error) => {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                    workspace_id: workspace.id,
                });
                return Err(error);
            }
        };
        for role_id in &role_ids {
            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: Some(workspace.id.clone()),
                tab_id: Some(tab_id.clone()),
                state: "launching".to_owned(),
                launched_at: None,
            })?;
        }
        self.invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
            tab_id: tab_id.clone(),
        })?;
        let effect_roles = workspace
            .slots
            .iter()
            .filter_map(|slot| {
                let role_id = slot.role_id.as_ref()?;
                let role = roles.iter().find(|role| &role.id == role_id)?.clone();
                Some((slot, role))
            })
            .map(|(slot, role)| {
                Ok(EmbeddedRoleViewEffectRecord {
                    role,
                    resolved_engine: workspace_resolved_engine,
                    rect: slot.rect.clone(),
                    zoom_factor: slot.browser_zoom_percent.unwrap_or(100.0) / 100.0,
                    zoom_mode: if slot.browser_zoom_percent.is_some() {
                        "fixed".to_owned()
                    } else {
                        "adaptive".to_owned()
                    },
                })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let tab = EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            attempt_generation: None,
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            workspace_id: Some(workspace.id.clone()),
            workspace_template: Some(workspace.template.clone()),
            workspace_appearance: settings.workspace,
            target,
            roles: effect_roles,
        };
        let target = tab.target.clone();
        let window_id = target.window_id.clone();
        let title = tab.name.clone();
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let handle = self.start_system_launch(&tab_id, tab, &roles, runtime_snapshot)?;
        if let Err(error) = self.commit_embedded_runtime_snapshot_without_native_effect(
            &std::collections::HashSet::new(),
        ) {
            let _ = self.operation_actor.cancel(&handle.operation_id);
            for role_id in &role_ids {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                workspace_id: workspace.id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        Ok(EmbeddedWorkspaceLaunchStart::Pending(Box::new(
            PendingEmbeddedWorkspaceLaunch {
                handle,
                lease_id,
                role_ids,
                roles,
                tab_id,
                target,
                title,
                window_id,
                workspace_id: workspace.id,
            },
        )))
    }

    fn settle_embedded_workspace_launch_blocking(
        &self,
        pending: PendingEmbeddedWorkspaceLaunch,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let PendingEmbeddedWorkspaceLaunch {
            handle,
            lease_id: _,
            role_ids,
            roles,
            tab_id,
            target: _,
            title: _,
            window_id: _,
            workspace_id,
        } = pending;
        let launch = self.finish_system_launch(handle, &roles);
        self.commit_embedded_workspace_launch_outcome(role_ids, tab_id, workspace_id, launch)
    }

    fn commit_embedded_workspace_launch_outcome(
        &self,
        role_ids: Vec<String>,
        tab_id: String,
        workspace_id: String,
        launch: CoreResult<crate::operation_actor::OperationOutcome>,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        if let Err(error) = launch {
            for role_id in &role_ids {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                workspace_id: workspace_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        let launched_at = chrono::Utc::now().to_rfc3339();
        let mut commands = Vec::with_capacity(role_ids.len() + 1);
        for role_id in &role_ids {
            commands.push(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: Some(workspace_id.clone()),
                tab_id: Some(tab_id.clone()),
                state: "running".to_owned(),
                launched_at: Some(launched_at.clone()),
            });
        }
        commands.push(BrowserRuntimeCommand::SetWorkspaceState {
            workspace_id: workspace_id.clone(),
            state: "running".to_owned(),
        });
        let completion = commands
            .into_iter()
            .try_for_each(|command| self.invoke_browser_runtime(command).map(|_| ()))
            .and_then(|()| {
                self.commit_embedded_runtime_snapshot_without_native_effect(
                    &std::collections::HashSet::new(),
                )
            });
        if let Err(error) = completion {
            let _ = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    attempt_generation: None,
                    next_active_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )]);
            for role_id in &role_ids {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id });
            let _ = self
                .invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace { workspace_id });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        for role_id in &role_ids {
            self.macro_runtime.allow_role_after_launch(role_id);
        }
        Ok(role_ids
            .iter()
            .map(|role_id| embedded_launch_result(role_id, launched_at.clone()))
            .collect())
    }

    fn stop_embedded_role(&self, role_id: &str) -> CoreResult<()> {
        self.stop_embedded_role_with_operation_lease(role_id, true, None)
    }

    fn stop_embedded_role_under_active_lease(&self, role_id: &str) -> CoreResult<()> {
        self.stop_embedded_role_with_operation_lease(role_id, false, None)
    }

    fn stop_embedded_role_with_operation_lease(
        &self,
        role_id: &str,
        acquire_operation_lease: bool,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<()> {
        self.cancel_embedded_operations(&[role_id.to_owned()])?;
        let lease = acquire_operation_lease
            .then(|| {
                self.browser_operations.acquire(BrowserOperationRequest {
                    role_ids: vec![role_id.to_owned()],
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
                let Some(role) = snapshot
                    .roles
                    .iter()
                    .find(|candidate| {
                        candidate.role_id == role_id && candidate.runtime == "embedded"
                    })
                    .cloned()
                else {
                    return Ok(());
                };
                let tab_id = role
                    .tab_id
                    .clone()
                    .ok_or_else(|| CoreError::Internal("embedded role has no tab".to_owned()))?;
                let tab_role_count = snapshot
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .map_or(1, |tab| tab.role_ids.len());
                let next_active_tab_id = (tab_role_count <= 1)
                    .then(|| next_active_tab_after_removal(&snapshot, &tab_id))
                    .flatten();

                // Cancellation is a fence, not a synchronous worker join. Native
                // isolation must never wait for the macro cleanup timeout.
                self.macro_runtime.request_stop_role(role_id)?;
                self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                    role_id: role_id.to_owned(),
                    runtime: "embedded".to_owned(),
                    workspace_id: role.workspace_id.clone(),
                    tab_id: Some(tab_id.clone()),
                    state: "stopping".to_owned(),
                    launched_at: role.launched_at.clone(),
                })?;
                let action = if tab_role_count <= 1 {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::HideTab {
                        tab_id: tab_id.clone(),
                    })?;
                    if let Some(next_tab_id) = next_active_tab_id.as_ref() {
                        self.invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
                            tab_id: next_tab_id.clone(),
                        })?;
                    }
                    self.embedded_closing_tabs
                        .lock()
                        .map_err(|_| {
                            CoreError::Internal("embedded closing tab lock poisoned".to_owned())
                        })?
                        .insert(tab_id.clone());
                    CoreEffectAction::EmbeddedDestroyTab {
                        tab_id: tab_id.clone(),
                        attempt_generation: None,
                        next_active_tab_id,
                    }
                } else {
                    CoreEffectAction::EmbeddedDestroyRole {
                        role_id: role_id.to_owned(),
                    }
                };
                (role, tab_id, tab_role_count, action)
            };

            // Native isolation is the safety boundary. Persistence is committed
            // after the exact game surface is offline; a busy SQLite writer must
            // never leave a visually closed role running.
            self.emit_browser_statuses();
            let (role, tab_id, tab_role_count, action) = prepared;
            self.run_embedded_runtime_effect(
                role_id,
                action,
                None,
                parent_operation_id,
            )?;

            {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let current = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot;
                if current
                    .roles
                    .iter()
                    .find(|candidate| candidate.role_id == role_id)
                    .is_none_or(|candidate| {
                        candidate.tab_id.as_deref() != Some(tab_id.as_str())
                            || candidate.state != "stopping"
                    })
                {
                    return Err(CoreError::Domain {
                        code: "SYSTEM_SURFACE_CLOSE_STALE",
                        message: "The role changed before its close transaction committed."
                            .to_owned(),
                    });
                }
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.to_owned(),
                })?;
                if tab_role_count <= 1 {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                        tab_id: tab_id.clone(),
                    })?;
                    if let Some(workspace_id) = role.workspace_id {
                        self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                            workspace_id,
                        })?;
                    }
                    self.embedded_closing_tabs
                        .lock()
                        .map_err(|_| {
                            CoreError::Internal("embedded closing tab lock poisoned".to_owned())
                        })?
                        .remove(&tab_id);
                }
            }
            if tab_role_count <= 1 {
                self.commit_embedded_runtime_snapshot_without_native_effect(
                    &std::collections::HashSet::new(),
                )?;
            } else {
                self.publish_embedded_runtime_snapshot_with_removed(
                    &std::collections::HashSet::new(),
                )?;
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

    fn stop_embedded_workspace(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, true, None)
    }

    fn stop_embedded_workspace_under_active_lease(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, false, None)
    }

}
