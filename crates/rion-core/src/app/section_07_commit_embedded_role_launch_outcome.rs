impl AppCore {
    fn commit_embedded_role_launch_outcome(
        &self,
        role: StateRoleRecord,
        tab_id: String,
        launch: CoreResult<crate::operation_actor::OperationOutcome>,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        if let Err(error) = launch {
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                role_id: role.id.clone(),
                expected_tab_id: Some(tab_id.clone()),
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
                tab_id: tab_id.clone(),
                slot_id: None,
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
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                role_id: role.id.clone(),
                expected_tab_id: Some(tab_id.clone()),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        self.macro_runtime.allow_role_after_launch(&role.id);
        Ok(vec![embedded_launch_result(&role.id, launched_at)])
    }

    fn start_embedded_workspace_for_roles(
        &self,
        workspace_id: &str,
        expected_role_ids: &[String],
        target: EmbeddedLaunchTargetRecord,
        launch_preview_id: Option<String>,
        restore_role_slots: Option<Vec<GameWindowRoleSlotRecord>>,
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
            let mut workspace =
                serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                    "launchWorkspaces",
                    "id",
                    workspace_id,
                    "WORKSPACE_NOT_FOUND",
                    "Launch workspace not found.",
                )?)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            if let Some(role_slots) = &restore_role_slots {
                workspace.slots = role_slots
                    .iter()
                    .map(|slot| crate::model::StateWorkspaceSlotRecord {
                        id: slot.slot_id.clone(),
                        role_id: Some(slot.role_id.clone()),
                        browser_zoom_percent: slot.browser_zoom_percent,
                        rect: slot.rect.clone(),
                    })
                    .collect();
            }
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
            if restore_role_slots.is_none() && current != expected {
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
                if runtime_workspace.state == "stopping" {
                    return Err(CoreError::Domain {
                        code: "WORKSPACE_ALREADY_RUNNING",
                        message: "The workspace is already launching or stopping.".to_owned(),
                    });
                }
                let tab_id = runtime_workspace.tab_id.clone();
                self.apply_embedded_tab_selection_without_native_effect(
                    BrowserRuntimeCommand::ActivateTab {
                        tab_id: tab_id.clone(),
                    },
                )?;
                return Ok(EmbeddedWorkspaceLaunchStart::Completed(
                    runtime_workspace
                        .role_ids
                        .iter()
                        .filter_map(|role_id| {
                            let launched_at = snapshot
                                .roles
                                .iter()
                                .find(|role| {
                                    &role.role_id == role_id && role.owner.tab_id == tab_id
                                })
                                .and_then(|role| role.launched_at.clone())?;
                            Some(embedded_launch_result(role_id, launched_at))
                        })
                        .collect(),
                ));
            }
            self.start_embedded_workspace_with_lease(
                workspace,
                role_ids,
                target,
                launch_preview_id,
                lease.id.clone(),
            )
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
        launch_preview_id: Option<String>,
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
        let existing_role_ids = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .roles
            .into_iter()
            .map(|role| role.role_id)
            .collect::<std::collections::HashSet<_>>();
        let launch_roles = roles
            .iter()
            .filter(|role| !existing_role_ids.contains(&role.id))
            .cloned()
            .collect::<Vec<_>>();
        self.reset_system_launch_retry_state(&launch_roles)?;
        let workspace_resolution =
            self.resolve_workspace_browser_engine(&roles, &available_games, &settings)?;
        require_system_resolution(&workspace_resolution)?;
        let workspace_resolved_engine = workspace_resolution.resolved_engine;
        let tab_id = self
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: self.saved_game_window_tab_id(
                    &target.window_id,
                    "workspace",
                    &workspace.id,
                )?,
                source_id: workspace.id.clone(),
                name: workspace.name.clone(),
                window_id: target.window_id.clone(),
                tab_type: "workspace".to_owned(),
                workspace_id: Some(workspace.id.clone()),
                role_slots: workspace
                    .slots
                    .iter()
                    .filter_map(|slot| {
                        Some(RuntimeRoleSlotInputRecord {
                            slot_id: slot.id.clone(),
                            role_id: slot.role_id.clone()?,
                            rect: slot.rect.clone(),
                            browser_zoom_percent: slot.browser_zoom_percent,
                        })
                    })
                    .collect(),
            })?
            .created_tab_id
            .ok_or_else(|| CoreError::Internal("workspace tab was not created".to_owned()))?;
        for role in &launch_roles {
            let slot_id = workspace
                .slots
                .iter()
                .find(|slot| slot.role_id.as_deref() == Some(role.id.as_str()))
                .map(|slot| slot.id.clone());
            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role.id.clone(),
                runtime: "embedded".to_owned(),
                tab_id: tab_id.clone(),
                slot_id,
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
                let role = launch_roles
                    .iter()
                    .find(|role| &role.id == role_id)?
                    .clone();
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
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let runtime_tab = runtime_snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| CoreError::Internal("workspace runtime tab disappeared".to_owned()))?;
        let effect_slots = workspace
            .slots
            .iter()
            .filter_map(|slot| {
                let role_id = slot.role_id.as_ref()?;
                let role = roles.iter().find(|role| &role.id == role_id)?.clone();
                let runtime_slot = runtime_tab
                    .slots
                    .iter()
                    .find(|runtime_slot| runtime_slot.slot_id == slot.id)?;
                Some(EmbeddedRoleSlotEffectRecord {
                    slot_id: slot.id.clone(),
                    role,
                    rect: slot.rect.clone(),
                    zoom_factor: slot.browser_zoom_percent.unwrap_or(100.0) / 100.0,
                    zoom_mode: if slot.browser_zoom_percent.is_some() {
                        "fixed".to_owned()
                    } else {
                        "adaptive".to_owned()
                    },
                    state: runtime_slot.state.clone(),
                    owner: runtime_slot.owner.clone(),
                })
            })
            .collect::<Vec<_>>();
        let tab = EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            attempt_generation: None,
            launch_preview_id,
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            workspace_id: Some(workspace.id.clone()),
            workspace_template: Some(workspace.template.clone()),
            workspace_appearance: settings.workspace,
            target,
            slots: effect_slots,
            roles: effect_roles,
        };
        let target = tab.target.clone();
        let window_id = target.window_id.clone();
        let title = tab.name.clone();
        let handle = self.start_system_launch(&tab_id, tab, &launch_roles, runtime_snapshot)?;
        if let Err(error) = self.commit_embedded_runtime_snapshot_without_native_effect(
            &std::collections::HashSet::new(),
        ) {
            let _ = self.operation_actor.cancel(&handle.operation_id);
            for role in &launch_roles {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                    role_id: role.id.clone(),
                    expected_tab_id: Some(tab_id.clone()),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        Ok(EmbeddedWorkspaceLaunchStart::Pending(Box::new(
            PendingEmbeddedWorkspaceLaunch {
                handle,
                lease_id,
                role_ids: launch_roles.iter().map(|role| role.id.clone()).collect(),
                roles: launch_roles,
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
        _workspace_id: String,
        launch: CoreResult<crate::operation_actor::OperationOutcome>,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        if let Err(error) = launch {
            for role_id in &role_ids {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                    role_id: role_id.clone(),
                    expected_tab_id: Some(tab_id.clone()),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        let launched_at = chrono::Utc::now().to_rfc3339();
        let mut commands = Vec::with_capacity(role_ids.len());
        for role_id in &role_ids {
            commands.push(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                tab_id: tab_id.clone(),
                slot_id: None,
                state: "running".to_owned(),
                launched_at: Some(launched_at.clone()),
            });
        }
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
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                    role_id: role_id.clone(),
                    expected_tab_id: Some(tab_id.clone()),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id });
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

    fn claim_embedded_role_slot(
        &self,
        tab_id: &str,
        slot_id: &str,
        expected_owner_generation: Option<u64>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let initial_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let target_tab = initial_snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        let target_slot = target_tab
            .slots
            .iter()
            .find(|slot| slot.slot_id == slot_id)
            .cloned()
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_ROLE_SLOT_NOT_FOUND",
                message: "Runtime role slot was not found.".to_owned(),
            })?;
        if target_slot.owner.as_ref().map(|owner| owner.generation)
            != expected_owner_generation
        {
            return Err(CoreError::Domain {
                code: "RUNTIME_ROLE_OWNER_STALE",
                message: "The role owner changed before the takeover started.".to_owned(),
            });
        }
        if target_slot.owner.as_ref().is_some_and(|owner| {
            owner.tab_id == tab_id && owner.slot_id == slot_id
        }) {
            return Err(CoreError::Domain {
                code: "RUNTIME_ROLE_SLOT_ALREADY_OWNED",
                message: "This role slot already owns the native game surface.".to_owned(),
            });
        }
        let role_id = target_slot.role_id.clone();
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![role_id.clone()],
            kind: "normal".to_owned(),
        })?;
        let result = (|| -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
            let role = self
                .read_typed_state_collection::<StateRoleRecord>("roles")?
                .into_iter()
                .find(|role| role.id == role_id)
                .ok_or_else(|| CoreError::Domain {
                    code: "ROLE_NOT_FOUND",
                    message: "Role not found.".to_owned(),
                })?;
            let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
                "gameBrowserSettings",
                "game browser settings are missing",
            )?;
            let game = self.state_game(&role.game_id)?;
            let resolution = self.resolve_role_browser_engine(&role, &game, &settings)?;
            require_system_resolution(&resolution)?;

            let source_owner = {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let snapshot = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot;
                let current_tab = snapshot
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .ok_or_else(|| CoreError::Domain {
                        code: "RUNTIME_TAB_NOT_FOUND",
                        message: "Runtime tab was closed before the takeover began.".to_owned(),
                    })?;
                let current_slot = current_tab
                    .slots
                    .iter()
                    .find(|slot| slot.slot_id == slot_id && slot.role_id == role_id)
                    .ok_or_else(|| CoreError::Domain {
                        code: "RUNTIME_ROLE_SLOT_NOT_FOUND",
                        message: "Runtime role slot changed before the takeover began.".to_owned(),
                    })?;
                if current_slot.owner.as_ref().map(|owner| owner.generation)
                    != expected_owner_generation
                {
                    return Err(CoreError::Domain {
                        code: "RUNTIME_ROLE_OWNER_STALE",
                        message: "The role owner changed before the takeover began.".to_owned(),
                    });
                }
                let source_owner = snapshot
                    .roles
                    .iter()
                    .find(|runtime_role| runtime_role.role_id == role_id)
                    .map(|runtime_role| runtime_role.owner.clone());
                if let Some(owner) = source_owner.as_ref() {
                    self.macro_runtime.request_stop_role(&role_id)?;
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                        role_id: role_id.clone(),
                        runtime: "embedded".to_owned(),
                        tab_id: owner.tab_id.clone(),
                        slot_id: Some(owner.slot_id.clone()),
                        state: "stopping".to_owned(),
                        launched_at: snapshot
                            .roles
                            .iter()
                            .find(|runtime_role| runtime_role.role_id == role_id)
                            .and_then(|runtime_role| runtime_role.launched_at.clone()),
                    })?;
                }
                source_owner
            };
            self.emit_browser_statuses();

            if source_owner.is_some() {
                self.run_embedded_runtime_effect(
                    &role_id,
                    CoreEffectAction::EmbeddedDestroyRole {
                        role_id: role_id.clone(),
                    },
                    None,
                    None,
                )?;
            }

            let claimed = {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let claim_result = self.invoke_browser_runtime(BrowserRuntimeCommand::ClaimRoleSlot {
                    role_id: role_id.clone(),
                    tab_id: tab_id.to_owned(),
                    slot_id: slot_id.to_owned(),
                    expected_owner_generation,
                });
                if let Err(error) = claim_result {
                    if let Some(owner) = source_owner.as_ref() {
                        let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                            role_id: role_id.clone(),
                            expected_tab_id: Some(owner.tab_id.clone()),
                        });
                    }
                    Err(error)
                } else {
                    match self.commit_embedded_runtime_snapshot_without_native_effect(
                        &std::collections::HashSet::new(),
                    ) {
                        Ok(snapshot) => Ok(snapshot),
                        Err(error) => {
                            let _ = self.invoke_browser_runtime(
                                BrowserRuntimeCommand::ReleaseRole {
                                    role_id: role_id.clone(),
                                    expected_tab_id: Some(tab_id.to_owned()),
                                },
                            );
                            Err(error)
                        }
                    }
                }
            };
            let claimed = match claimed {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.publish_embedded_runtime_snapshot_best_effort();
                    return Err(error);
                }
            };
            let claimed_slot = claimed
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .and_then(|tab| tab.slots.iter().find(|slot| slot.slot_id == slot_id))
                .cloned()
                .ok_or_else(|| CoreError::Internal(
                    "claimed runtime role slot disappeared".to_owned(),
                ))?;
            let zoom_factor = claimed_slot.browser_zoom_percent.unwrap_or(100.0) / 100.0;
            let zoom_mode = if target_slot.browser_zoom_percent.is_some() {
                "fixed".to_owned()
            } else {
                "adaptive".to_owned()
            };
            let native_attach = self.run_effect_plan_for_roles(
                vec![
                    effect_step(
                        &role_id,
                        CoreEffectAction::EmbeddedClaimRoleSlot {
                            tab_id: tab_id.to_owned(),
                            slot: Box::new(EmbeddedRoleSlotEffectRecord {
                                slot_id: slot_id.to_owned(),
                                role: role.clone(),
                                rect: claimed_slot.rect.clone(),
                                zoom_factor,
                                zoom_mode: zoom_mode.clone(),
                                state: "launching".to_owned(),
                                owner: claimed_slot.owner.clone(),
                            }),
                            role: Box::new(EmbeddedRoleViewEffectRecord {
                                role: role.clone(),
                                resolved_engine: resolution.resolved_engine,
                                rect: claimed_slot.rect.clone(),
                                zoom_factor,
                                zoom_mode,
                            }),
                        },
                        Duration::from_secs(45),
                        Some(CoreEffectAction::EmbeddedDestroyRole {
                            role_id: role_id.clone(),
                        }),
                    ),
                    effect_step(
                        &role_id,
                        CoreEffectAction::EmbeddedLoadRoles {
                            roles: vec![EmbeddedRoleLoadEffectRecord {
                                role_id: role_id.clone(),
                                resolved_engine: resolution.resolved_engine,
                                url: role.launch_url.clone(),
                                zoom_factor,
                            }],
                        },
                        Duration::from_secs(45),
                        None,
                    ),
                ],
                std::slice::from_ref(&role_id),
            );
            if let Err(error) = native_attach {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                    role_id: role_id.clone(),
                    expected_tab_id: Some(tab_id.to_owned()),
                });
                self.publish_embedded_runtime_snapshot_best_effort();
                return Err(error);
            }

            let launched_at = chrono::Utc::now().to_rfc3339();
            let completion = self
                .invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                    role_id: role_id.clone(),
                    runtime: "embedded".to_owned(),
                    tab_id: tab_id.to_owned(),
                    slot_id: Some(slot_id.to_owned()),
                    state: "running".to_owned(),
                    launched_at: Some(launched_at.clone()),
                })
                .and_then(|_| {
                    self.commit_embedded_runtime_snapshot_without_native_effect(
                        &std::collections::HashSet::new(),
                    )
                });
            let completed = match completion {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                        role_id: role_id.clone(),
                        runtime: "embedded".to_owned(),
                        tab_id: tab_id.to_owned(),
                        slot_id: Some(slot_id.to_owned()),
                        state: "stopping".to_owned(),
                        launched_at: None,
                    });
                    self.emit_browser_statuses();
                    self.run_embedded_runtime_effect(
                        &role_id,
                        CoreEffectAction::EmbeddedDestroyRole {
                            role_id: role_id.clone(),
                        },
                        None,
                        None,
                    )?;
                    let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                        role_id: role_id.clone(),
                        expected_tab_id: Some(tab_id.to_owned()),
                    });
                    self.publish_embedded_runtime_snapshot_best_effort();
                    return Err(error);
                }
            };
            self.macro_runtime.allow_role_after_launch(&role_id);
            Ok(completed)
        })();
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(snapshot), Ok(())) => Ok(snapshot),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn stop_embedded_workspace(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, true, true, None)
    }

    fn stop_embedded_workspace_under_active_lease(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, false, true, None)
    }

}
