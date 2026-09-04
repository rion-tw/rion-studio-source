struct EmbeddedWorkspaceLaunchRequest {
    target: EmbeddedLaunchTargetRecord,
    launch_preview_id: Option<String>,
    launch_tab_id: Option<String>,
    launch_attempt_id: String,
    presentation_intent: EmbeddedLaunchPresentationIntent,
    restore_role_slots: Option<Vec<GameWindowRoleSlotRecord>>,
}

struct EmbeddedWorkspaceLeaseLaunchRequest {
    workspace: StateLaunchWorkspaceRecord,
    role_ids: Vec<String>,
    target: EmbeddedLaunchTargetRecord,
    launch_preview_id: Option<String>,
    launch_tab_id: Option<String>,
    launch_attempt_id: String,
    presentation_intent: EmbeddedLaunchPresentationIntent,
    lease_id: String,
}

impl AppCore {
    fn commit_embedded_role_launch_outcome(
        &self,
        role: StateRoleRecord,
        tab_id: String,
        window_id: String,
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
            let logical_tab_is_live = self.browser_runtime.snapshot().is_ok_and(|snapshot| {
                snapshot
                    .windows
                    .values()
                    .any(|window| window.contains_tab(&tab_id))
            });
            if !logical_tab_is_live
                || matches!(error.code(), "LAUNCH_CANCELLED" | "LAUNCH_PREVIEW_STALE")
            {
                // An authoritative close/stop/supersede transaction owns native
                // membership teardown. The AppKit ownership follower is
                // phase-only, so publishing the already-removed logical tab
                // before EmbeddedDestroyTab would cross that boundary and
                // race the exact close acknowledgement.
                self.emit_browser_statuses();
            } else {
                self.publish_embedded_runtime_snapshot_best_effort();
            }
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
            })
            .and_then(|_| {
                self.persist_runtime_ui_windows(std::slice::from_ref(&window_id))
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
        request: EmbeddedWorkspaceLaunchRequest,
    ) -> CoreResult<EmbeddedWorkspaceLaunchStart> {
        let EmbeddedWorkspaceLaunchRequest {
            target,
            launch_preview_id,
            launch_tab_id,
            launch_attempt_id,
            presentation_intent,
            restore_role_slots,
        } = request;
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
            if restore_role_slots.is_some()
                && let Some(saved_workspace_slots) = self
                    .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
                    .into_iter()
                    .find(|window| window.id == target.window_id)
                    .and_then(|window| {
                        window.tabs.into_iter().find(|tab| {
                            tab.tab_type == "workspace"
                                && tab.source_id == workspace_id
                                && launch_tab_id
                                    .as_deref()
                                    .is_none_or(|tab_id| tab.id == tab_id)
                                && !tab.workspace_slots.is_empty()
                        })
                    })
                    .map(|tab| tab.workspace_slots)
            {
                // A saved Game Window owns its runtime layout snapshot, while
                // the Workspace remains authoritative for current slot
                // content. Restore every stable slot's geometry together so a
                // Web slot cannot drift from the adjacent restored Role slot.
                for slot in &mut workspace.slots {
                    if let Some(saved) = saved_workspace_slots
                        .iter()
                        .find(|saved| saved.id == slot.id)
                    {
                        slot.rect = saved.rect.clone();
                        slot.browser_zoom_percent = saved.browser_zoom_percent;
                    }
                }
            }
            if let Some(role_slots) = &restore_role_slots {
                for saved in role_slots {
                    if let Some(slot) = workspace.slots.iter_mut().find(|slot| {
                        slot.id == saved.slot_id
                            || slot.role_id.as_deref() == Some(saved.role_id.as_str())
                    }) {
                        slot.rect = saved.rect.clone();
                        slot.browser_zoom_percent = saved.browser_zoom_percent;
                    }
                }
            }
            if !workspace
                .slots
                .iter()
                .any(|slot| slot.role_id.is_some() || slot.web.is_some())
            {
                return Err(CoreError::Domain {
                    code: "WORKSPACE_CONTENT_REQUIRED",
                    message: "The launch workspace has no roles or web apps.".to_owned(),
                });
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
                if runtime_workspace.state == "stopping" {
                    return Err(CoreError::Domain {
                        code: "WORKSPACE_ALREADY_RUNNING",
                        message: "The workspace is already launching or stopping.".to_owned(),
                    });
                }
                let tab_id = runtime_workspace.tab_id.clone();
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
            self.start_embedded_workspace_with_lease(EmbeddedWorkspaceLeaseLaunchRequest {
                workspace,
                role_ids,
                target,
                launch_preview_id,
                launch_tab_id,
                launch_attempt_id,
                presentation_intent,
                lease_id: lease.id.clone(),
            })
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
        request: EmbeddedWorkspaceLeaseLaunchRequest,
    ) -> CoreResult<EmbeddedWorkspaceLaunchStart> {
        let EmbeddedWorkspaceLeaseLaunchRequest {
            workspace,
            role_ids,
            target,
            launch_preview_id,
            launch_tab_id,
            launch_attempt_id,
            presentation_intent,
            lease_id,
        } = request;
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
        self.reset_browser_launch_retry_state(&launch_roles)?;
        let workspace_resolution =
            self.resolve_workspace_browser_engine(&roles, &available_games, &settings)?;
        require_browser_runtime_resolution(&workspace_resolution)?;
        let workspace_resolved_engine = workspace_resolution.resolved_engine;
        let global_web_profile = if self.runtime_contract_version
            >= CHROMIUM_RUNTIME_CONTRACT_VERSION
            && workspace.slots.iter().any(|slot| slot.web.is_some())
        {
            Some(crate::global_web_profile::ensure(&self.user_data_dir)?)
        } else {
            None
        };
        let audio_muted =
            self.saved_game_window_tab_audio_muted(&target.window_id, "workspace", &workspace.id)?;
        let requested_tab_id = launch_tab_id.or(self.saved_game_window_tab_id(
            &target.window_id,
            "workspace",
            &workspace.id,
        )?);
        let requested_tab_id = if global_web_profile.is_some() && requested_tab_id.is_none() {
            Some(uuid::Uuid::new_v4().to_string())
        } else {
            requested_tab_id
        };
        let web_surfaces = requested_tab_id
            .as_deref()
            .filter(|_| global_web_profile.is_some())
            .map(|tab_id| {
                workspace
                    .slots
                    .iter()
                    .enumerate()
                    .filter_map(|(index, slot)| {
                        slot.web.as_ref()?;
                        Some(crate::model::EmbeddedWebSurfaceIdentityRecord {
                            surface_id: workspace_web_surface_id(tab_id, index),
                            slot_id: slot.id.clone(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let launch_role_ids = launch_roles
            .iter()
            .map(|role| role.id.clone())
            .collect::<Vec<_>>();
        self.mark_role_session_launch_admitted(&launch_role_ids)?;
        let tab_admission = self.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            tab_id: requested_tab_id,
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            tab_type: "workspace".to_owned(),
            workspace_id: Some(workspace.id.clone()),
            audio_muted,
            attempt_generation: Some(launch_attempt_id.clone()),
            window_id: target.window_id.clone(),
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
            web_surfaces,
        })?;
        let tab_id = tab_admission
            .created_tab_id
            .ok_or_else(|| CoreError::Internal("workspace tab was not created".to_owned()))?;
        if !tab_admission.tab_created {
            return Ok(EmbeddedWorkspaceLaunchStart::Completed(Vec::new()));
        }
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
        let mut effect_roles = workspace
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
                    web: None,
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
        effect_roles.extend(
            workspace
                .slots
                .iter()
                .enumerate()
                .filter_map(|(index, slot)| {
                    let web = slot.web.clone()?;
                    Some(EmbeddedRoleViewEffectRecord {
                        role: workspace_web_surface_role(&tab_id, index, &web),
                        web: Some(web),
                        resolved_engine: workspace_resolved_engine,
                        rect: slot.rect.clone(),
                        zoom_factor: slot.browser_zoom_percent.unwrap_or(100.0) / 100.0,
                        zoom_mode: if slot.browser_zoom_percent.is_some() {
                            "fixed".to_owned()
                        } else {
                            "adaptive".to_owned()
                        },
                    })
                }),
        );
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let runtime_tab = runtime_snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| CoreError::Internal("workspace runtime tab disappeared".to_owned()))?;
        let mut effect_slots = workspace
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
                    web: None,
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
        effect_slots.extend(
            workspace
                .slots
                .iter()
                .enumerate()
                .filter_map(|(index, slot)| {
                    let web = slot.web.clone()?;
                    Some(EmbeddedRoleSlotEffectRecord {
                        slot_id: slot.id.clone(),
                        role: workspace_web_surface_role(&tab_id, index, &web),
                        web: Some(web),
                        rect: slot.rect.clone(),
                        zoom_factor: slot.browser_zoom_percent.unwrap_or(100.0) / 100.0,
                        zoom_mode: if slot.browser_zoom_percent.is_some() {
                            "fixed".to_owned()
                        } else {
                            "adaptive".to_owned()
                        },
                        state: "running".to_owned(),
                        owner: None,
                    })
                }),
        );
        let tab = EmbeddedTabEffectRecord {
            appkit_window_generation: None,
            appkit_topology_revision: None,
            tab_id: tab_id.clone(),
            audio_muted,
            attempt_generation: Some(launch_attempt_id),
            launch_preview_id,
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            workspace_id: Some(workspace.id.clone()),
            workspace_template: Some(workspace.template.clone()),
            workspace_slots: workspace.slots.clone(),
            workspace_appearance: settings.workspace,
            target,
            slots: effect_slots,
            roles: effect_roles,
        };
        let target = tab.target.clone();
        let window_id = target.window_id.clone();
        let title = tab.name.clone();
        let handle = self.start_system_launch(SystemLaunchRequest {
            tab_id: &tab_id,
            tab,
            roles: &launch_roles,
            runtime_snapshot,
            global_web_profile,
            presentation_intent,
            resolved_engine: workspace_resolved_engine,
        })?;
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
                presentation_intent,
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
            presentation_intent,
            role_ids,
            roles,
            tab_id,
            target: _,
            title: _,
            window_id,
            workspace_id,
        } = pending;
        let launch =
            self.finish_system_launch(handle, &roles, &tab_id, presentation_intent);
        self.commit_embedded_workspace_launch_outcome(
            role_ids,
            tab_id,
            window_id,
            workspace_id,
            launch,
        )
    }

    fn commit_embedded_workspace_launch_outcome(
        &self,
        role_ids: Vec<String>,
        tab_id: String,
        window_id: String,
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
            let logical_tab_is_live = self.browser_runtime.snapshot().is_ok_and(|snapshot| {
                snapshot
                    .windows
                    .values()
                    .any(|window| window.contains_tab(&tab_id))
            });
            if !logical_tab_is_live
                || matches!(error.code(), "LAUNCH_CANCELLED" | "LAUNCH_PREVIEW_STALE")
            {
                // The transaction which removed the logical tab owns native
                // membership teardown; only publish renderer status from this
                // background outcome.
                self.emit_browser_statuses();
            } else {
                self.publish_embedded_runtime_snapshot_best_effort();
            }
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
            .and_then(|_| {
                self.commit_embedded_runtime_snapshot_without_native_effect(
                    &std::collections::HashSet::new(),
                )
            })
            .and_then(|_| {
                self.persist_runtime_ui_windows(std::slice::from_ref(&window_id))
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
        if target_slot.owner.as_ref().map(|owner| owner.generation) != expected_owner_generation {
            return Err(CoreError::Domain {
                code: "RUNTIME_ROLE_OWNER_STALE",
                message: "The role owner changed before the takeover started.".to_owned(),
            });
        }
        if target_slot
            .owner
            .as_ref()
            .is_some_and(|owner| owner.tab_id == tab_id && owner.slot_id == slot_id)
        {
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
        let mut preserves_active_macro = false;
        let mut ownership_transfer = None;
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
            require_browser_runtime_resolution(&resolution)?;
            self.mark_role_session_launch_admitted(std::slice::from_ref(&role_id))?;

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
                    let admission =
                        self.macro_runtime.begin_role_ownership_transfer(&role_id)?;
                    preserves_active_macro = admission.preserves_active_macro;
                    ownership_transfer = Some(admission);
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
                let claim_result =
                    self.invoke_browser_runtime(BrowserRuntimeCommand::ClaimRoleSlot {
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
                            let _ =
                                self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                                    role_id: role_id.clone(),
                                    expected_tab_id: Some(tab_id.to_owned()),
                                });
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
                .ok_or_else(|| {
                    CoreError::Internal("claimed runtime role slot disappeared".to_owned())
                })?;
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
                                web: None,
                                rect: claimed_slot.rect.clone(),
                                zoom_factor,
                                zoom_mode: zoom_mode.clone(),
                                state: "launching".to_owned(),
                                owner: claimed_slot.owner.clone(),
                            }),
                            role: Box::new(EmbeddedRoleViewEffectRecord {
                                role: role.clone(),
                                web: None,
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
                        tab_id,
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
                })
                .and_then(|snapshot| {
                    let topology_changed = self.complete_chromium_runtime_launch(
                        tab_id,
                        std::slice::from_ref(&role_id),
                    )?;
                    if topology_changed {
                        // Ready advances the Core window revision even though
                        // membership is unchanged. Project the terminal fence
                        // before exposing the completed launch.
                        self.project_embedded_runtime_snapshot_without_persistence(None)?;
                    }
                    Ok(snapshot)
                });
            match completion {
                Ok(snapshot) => Ok(snapshot),
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
                    Err(error)
                }
            }
        })();
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(snapshot), Ok(())) => {
                if !preserves_active_macro {
                    if let Some(admission) = ownership_transfer {
                        if admission.transfer_started {
                            let completed = self
                                .macro_runtime
                                .complete_role_ownership_transfer_after_launch(
                                    &role_id,
                                    admission.input_epoch,
                                )?;
                            if !completed {
                                return Err(CoreError::Internal(
                                    "role ownership transfer completion changed input epoch"
                                        .to_owned(),
                                ));
                            }
                        } else {
                            self.macro_runtime.allow_role_after_launch(&role_id);
                        }
                    } else {
                        self.macro_runtime.allow_role_after_launch(&role_id);
                    }
                }
                // An ownership transfer remains quiesced until the native
                // navigation fence observes both input drain and page-ready.
                // The Core mutation can complete before that authoritative
                // event, so it must not resume the active macro here.
                Ok(snapshot)
            }
            (Err(error), _) | (Ok(_), Err(error)) => {
                if preserves_active_macro {
                    let _ = self.macro_runtime.request_stop_role(&role_id);
                    self.emit_browser_statuses();
                }
                Err(error)
            }
        }
    }

    fn stop_embedded_workspace(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, true, true, None)
    }

    fn stop_embedded_workspace_under_active_lease(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, false, true, None)
    }
}
