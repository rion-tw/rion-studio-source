struct EmbeddedRoleLaunchRequest {
    target: EmbeddedLaunchTargetRecord,
    launch_preview_id: Option<String>,
    launch_tab_id: Option<String>,
    launch_attempt_id: String,
    zoom_factor: f64,
    lease_id: String,
    restore_role_slot: Option<GameWindowRoleSlotRecord>,
}

impl AppCore {
    pub fn browser_runtime_snapshot(
        &self,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        Ok(self.browser_runtime.snapshot()?.browser_runtime)
    }

    pub fn runtime_restore_session(&self) -> CoreResult<crate::model::RuntimeRestoreSessionRecord> {
        self.read_optional_scalar_state::<crate::model::RuntimeRestoreSessionRecord>(
            "runtimeRestoreSession",
        )?
        .map(crate::domain::normalize_runtime_restore_session)
        .transpose()
        .map(|session| session.unwrap_or_else(crate::domain::default_runtime_restore_session))
    }

    pub fn replace_runtime_restore_session(
        &self,
        session: crate::model::RuntimeRestoreSessionRecord,
    ) -> CoreResult<crate::model::RuntimeRestoreSessionRecord> {
        let session = crate::domain::normalize_runtime_restore_session(session)?;
        self.replace_scalar_state("runtimeRestoreSession", session.clone())?;
        Ok(session)
    }

    pub fn update_runtime_restore_session(
        &self,
        update: impl FnOnce(&mut crate::model::RuntimeRestoreSessionRecord),
    ) -> CoreResult<crate::model::RuntimeRestoreSessionRecord> {
        let _state_guard = self.state_mutation_guard()?;
        let mut session = self
            .read_optional_scalar_state::<crate::model::RuntimeRestoreSessionRecord>(
                "runtimeRestoreSession",
            )?
            .map(crate::domain::normalize_runtime_restore_session)
            .transpose()?
            .unwrap_or_else(crate::domain::default_runtime_restore_session);
        update(&mut session);
        let session = crate::domain::normalize_runtime_restore_session(session)?;
        self.replace_scalar_state_under_guard("runtimeRestoreSession", session.clone())?;
        Ok(session)
    }

    pub fn app_snapshot(&self) -> CoreResult<crate::model::CoreAppSnapshotRecord> {
        let _state_guard = self.state_mutation_guard()?;
        let _authority_guard = self
            .runtime_authority_barrier
            .read()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let _status_guard = self
            .browser_status_emit_guard
            .lock()
            .map_err(|_| CoreError::Internal("browser status projection lock poisoned".to_owned()))?;
        let state_snapshot = self.read_typed_snapshot()?;
        let runtime_snapshot = self.browser_runtime.snapshot()?;
        let role_statuses = self.decorate_browser_statuses_from_snapshot(
            embedded_role_statuses(runtime_snapshot.browser_runtime.roles.clone()),
            &state_snapshot,
            &runtime_snapshot.browser_runtime,
        )?;
        let mut logical_windows = runtime_snapshot
            .windows
            .values()
            .map(|window| crate::model::RuntimeWindowTabSnapshotRecord {
                window_id: window.window_id.clone(),
                window_generation: window.window_generation,
                revision: window.revision,
                tabs: window
                    .tabs
                    .iter()
                    .map(|tab| crate::model::GameWindowTabRecord {
                        id: tab.id.clone(),
                        tab_type: tab.tab_type.clone(),
                        source_id: tab.source_id.clone(),
                        name: tab.title.clone(),
                        role_slots: tab.role_slots.clone(),
                        workspace_slots: tab.workspace_slots.clone(),
                        hidden: window.hidden_tab_ids.contains(&tab.id),
                        audio_muted: tab.audio_muted,
                    })
                    .collect(),
                active_tab_id: window.selected_tab_id.clone(),
            })
            .collect::<Vec<_>>();
        logical_windows.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        let owner_by_role = runtime_snapshot
            .browser_runtime
            .roles
            .iter()
            .map(|role| (role.role_id.as_str(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let mut projected_tabs = Vec::new();
        let mut projected_windows = Vec::new();
        let mut projected_workspaces = Vec::new();
        for window in &logical_windows {
            projected_windows.push(crate::model::BrowserRuntimeWindowRecord {
                window_id: window.window_id.clone(),
                active_tab_id: window.active_tab_id.clone(),
                tab_ids: window.tabs.iter().map(|tab| tab.id.clone()).collect(),
            });
            for tab in &window.tabs {
                let slots = tab
                    .role_slots
                    .iter()
                    .map(|slot| {
                        let owner = owner_by_role.get(slot.role_id.as_str());
                        let owned_here = owner.is_some_and(|role| {
                            role.owner.tab_id == tab.id && role.owner.slot_id == slot.slot_id
                        });
                        crate::model::RuntimeRoleSlotRecord {
                            slot_id: slot.slot_id.clone(),
                            role_id: slot.role_id.clone(),
                            rect: slot.rect.clone(),
                            browser_zoom_percent: slot.browser_zoom_percent,
                            state: owner
                                .map_or("available", |role| {
                                    if owned_here {
                                        role.state.as_str()
                                    } else {
                                        "blocked"
                                    }
                                })
                                .to_owned(),
                            owner: owner.map(|role| role.owner.clone()),
                        }
                    })
                    .collect::<Vec<_>>();
                projected_tabs.push(crate::model::BrowserRuntimeTabRecord {
                    id: tab.id.clone(),
                    source_id: tab.source_id.clone(),
                    name: tab.name.clone(),
                    window_id: window.window_id.clone(),
                    tab_type: tab.tab_type.clone(),
                    workspace_id: (tab.tab_type == "workspace")
                        .then(|| tab.source_id.clone()),
                    slots: slots.clone(),
                    hidden: tab.hidden,
                });
                if tab.tab_type == "workspace" {
                    let state = if slots.iter().any(|slot| slot.state == "stopping") {
                        "stopping"
                    } else if slots.iter().all(|slot| slot.state == "running") {
                        "running"
                    } else if slots.iter().any(|slot| slot.state == "launching")
                        && slots
                            .iter()
                            .all(|slot| matches!(slot.state.as_str(), "launching" | "running"))
                    {
                        "launching"
                    } else {
                        "partial"
                    };
                    projected_workspaces.push(crate::model::BrowserRuntimeWorkspaceRecord {
                        workspace_id: tab.source_id.clone(),
                        name: tab.name.clone(),
                        runtime: "embedded".to_owned(),
                        window_id: window.window_id.clone(),
                        tab_id: tab.id.clone(),
                        role_ids: tab
                            .role_slots
                            .iter()
                            .map(|slot| slot.role_id.clone())
                            .collect(),
                        state: state.to_owned(),
                    });
                }
            }
        }
        let browser_runtime = crate::model::BrowserRuntimeSnapshot {
            windows: projected_windows,
            roles: runtime_snapshot.browser_runtime.roles.clone(),
            tabs: projected_tabs,
            workspaces: projected_workspaces,
        };
        let revision = self
            .app_snapshot_sequence
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        Ok(crate::model::CoreAppSnapshotRecord {
            revision,
            state_revision: state_snapshot.revision,
            runtime_revision: runtime_snapshot.revision,
            state: state_snapshot,
            browser_runtime,
            logical_windows,
            role_statuses,
            macro_statuses: self.macro_runtime.statuses()?,
        })
    }

    async fn acquire_browser_operation_async(
        self: &Arc<Self>,
        request: BrowserOperationRequest,
    ) -> CoreResult<crate::model::BrowserOperationLease> {
        let core = Arc::clone(self);
        tokio::task::spawn_blocking(move || core.browser_operations.acquire(request))
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
    }

    fn emit_browser_statuses(&self) {
        // Status decoration reads persisted role metadata after taking the
        // runtime snapshot. Without one projection lane, a slower older close
        // can publish its `stopping` snapshot after a newer close has already
        // published the empty/running state. Serialize only snapshot projection
        // and emission; native lifecycle work remains fully concurrent.
        let Ok(_emit_guard) = self.browser_status_emit_guard.lock() else {
            return;
        };
        if let Ok(statuses) = self.browser_statuses() {
            self.emit(vec![CoreEvent::BrowserStatuses { statuses }]);
        }
    }

    pub fn browser_statuses(&self) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let runtime_snapshot = self.browser_runtime.snapshot()?.browser_runtime;
        let statuses = embedded_role_statuses(runtime_snapshot.roles.clone());
        let state_snapshot = self.read_typed_snapshot()?;
        self.decorate_browser_statuses_from_snapshot(statuses, &state_snapshot, &runtime_snapshot)
    }

    fn macro_active_role_ids(&self) -> CoreResult<Vec<String>> {
        let ready_roles = self
            .system_webview_ready_roles
            .read()
            .map_err(|_| CoreError::Internal("system WebView readiness lock poisoned".to_owned()))?;
        let mut role_ids = self
            .browser_runtime
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .roles
            .into_iter()
            .filter(|role| {
                role.runtime == "embedded"
                    && role.state == "running"
                    && ready_roles.contains(&role.role_id)
            })
            .map(|role| role.role_id)
            .collect::<Vec<_>>();
        role_ids.sort();
        role_ids.dedup();
        Ok(role_ids)
    }

    pub fn browser_workspace_statuses(
        &self,
    ) -> CoreResult<Vec<crate::model::BrowserWorkspaceStatusRecord>> {
        let snapshot = self
            .browser_runtime
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let role_statuses =
            self.decorate_browser_statuses(embedded_role_statuses(snapshot.roles.clone()))?;
        let status_by_role = role_statuses
            .into_iter()
            .map(|status| (status.role_id.clone(), status))
            .collect::<std::collections::HashMap<_, _>>();
        let role_ids_by_workspace = snapshot
            .workspaces
            .iter()
            .map(|workspace| (workspace.workspace_id.clone(), workspace.role_ids.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut statuses = embedded_workspace_statuses(snapshot.workspaces);
        for status in &mut statuses {
            let role_statuses = role_ids_by_workspace
                .get(&status.workspace_id)
                .into_iter()
                .flatten()
                .filter_map(|role_id| status_by_role.get(role_id))
                .collect::<Vec<_>>();
            let Some(first) = role_statuses.first() else {
                continue;
            };
            status.resolved_engine = role_statuses
                .iter()
                .all(|candidate| candidate.resolved_engine == first.resolved_engine)
                .then_some(first.resolved_engine)
                .flatten();
            status.host_kind = role_statuses
                .iter()
                .all(|candidate| candidate.host_kind == first.host_kind)
                .then_some(first.host_kind)
                .flatten();
            status.issue_reason = role_statuses
                .iter()
                .find_map(|candidate| candidate.issue_reason);
            status.capability_snapshot = role_statuses
                .iter()
                .all(|candidate| candidate.capability_snapshot == first.capability_snapshot)
                .then(|| first.capability_snapshot.clone())
                .flatten();
        }
        Ok(statuses)
    }

    fn decorate_browser_statuses(
        &self,
        statuses: Vec<crate::model::BrowserRoleStatusRecord>,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let state_snapshot = self.read_typed_snapshot()?;
        let runtime_snapshot = self.browser_runtime.snapshot()?.browser_runtime;
        self.decorate_browser_statuses_from_snapshot(statuses, &state_snapshot, &runtime_snapshot)
    }

    fn decorate_browser_statuses_from_snapshot(
        &self,
        mut statuses: Vec<crate::model::BrowserRoleStatusRecord>,
        state_snapshot: &CoreStateSnapshotRecord,
        runtime_snapshot: &crate::model::BrowserRuntimeSnapshot,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        if statuses.is_empty() {
            return Ok(statuses);
        }
        let roles = state_snapshot
            .roles
            .iter()
            .cloned()
            .map(|role| (role.id.clone(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let games = state_snapshot
            .games
            .iter()
            .cloned()
            .map(|game| (game.id.clone(), game))
            .collect::<std::collections::HashMap<_, _>>();
        let workspaces = &state_snapshot.launch_workspaces;
        let workspace_by_tab = runtime_snapshot
            .tabs
            .iter()
            .filter(|tab| tab.tab_type == "workspace")
            .map(|tab| (tab.id.clone(), tab.source_id.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let active_workspace_by_role = runtime_snapshot
            .roles
            .iter()
            .filter_map(|role| {
                workspace_by_tab
                    .get(&role.owner.tab_id)
                    .cloned()
                    .map(|workspace_id| (role.role_id.clone(), workspace_id))
            })
            .collect::<std::collections::HashMap<_, _>>();
        let settings = state_snapshot.game_browser_settings.clone().ok_or_else(|| {
            CoreError::StateDatabase("game browser settings are missing".to_owned())
        })?;
        let ready_roles = self
            .system_webview_ready_roles
            .read()
            .map_err(|_| CoreError::Internal("system WebView readiness lock poisoned".to_owned()))?
            .clone();
        for status in &mut statuses {
            let Some(role) = roles.get(&status.role_id) else {
                continue;
            };
            let Some(game) = games.get(&role.game_id) else {
                continue;
            };
            let system_runtime = self.system_webview_runtime()?;
            let resolution = self.resolve_role_browser_engine(role, game, &settings)?;
            status.resolved_engine = Some(resolution.resolved_engine);
            status.host_kind = Some(resolution.host_kind);
            status.issue_reason = resolution.issue_reason;
            status.capability_snapshot = Some(system_runtime.capability_snapshot.clone());
        }
        for workspace in workspaces {
            let active_role_ids = active_workspace_by_role
                .iter()
                .filter_map(|(role_id, workspace_id)| {
                    (workspace_id == &workspace.id).then_some(role_id.as_str())
                })
                .collect::<std::collections::HashSet<_>>();
            if active_role_ids.is_empty() {
                continue;
            }
            let workspace_roles = active_role_ids
                .iter()
                .filter_map(|role_id| roles.get(*role_id).cloned())
                .collect::<Vec<_>>();
            let resolution =
                self.resolve_workspace_browser_engine(&workspace_roles, &games, &settings)?;
            let capability_snapshot = Some(self.system_webview_runtime()?.capability_snapshot);
            for status in &mut statuses {
                if status.runtime_mode != "embedded"
                    || !active_role_ids.contains(status.role_id.as_str())
                {
                    continue;
                }
                status.resolved_engine = Some(resolution.resolved_engine);
                status.host_kind = Some(resolution.host_kind);
                status.issue_reason = match status.issue_reason {
                    Some(reason @ crate::model::SystemWebViewIssueReason::RuntimeCrashed) => {
                        Some(reason)
                    }
                    _ => resolution.issue_reason,
                };
                status.capability_snapshot = capability_snapshot.clone();
            }
        }
        for status in &mut statuses {
            let macro_input_available = status.capability_snapshot.as_ref().is_some_and(|snapshot| {
                system_capability_verified(snapshot.trusted_input)
                    && system_capability_verified(snapshot.background_input)
                    && system_capability_available(snapshot.frame_evaluation)
            });
            status.automation_state = if status.issue_reason.is_some() || !macro_input_available {
                Some("unavailable".to_owned())
            } else if ready_roles.contains(&status.role_id) {
                Some("ready".to_owned())
            } else {
                None
            };
        }
        Ok(statuses)
    }

    fn register_system_webview_runtime(
        &self,
        mut registration: SystemWebViewRuntimeRegistrationRecord,
    ) -> CoreResult<SystemWebViewRuntimeRegistrationRecord> {
        let expected_platform = match self.platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        };
        let expected_engine = match self.platform {
            rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
            rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
        };
        if registration.platform != expected_platform || registration.engine != expected_engine {
            return Err(CoreError::InvalidInput(
                "system WebView registration does not match the current platform".to_owned(),
            ));
        }
        if registration.adapter_version.trim().is_empty() || registration.adapter_version.len() > 64
        {
            return Err(CoreError::InvalidInput(
                "system WebView adapter version is invalid".to_owned(),
            ));
        }
        let probe = rion_platform::probe_system_webview(self.platform);
        let baseline_available = [
            registration.capability_snapshot.navigation,
            registration.capability_snapshot.persistent_session,
            registration.capability_snapshot.audio_mute,
        ]
        .into_iter()
        .all(system_capability_available);
        registration.available &= probe.available && baseline_available;
        if !registration.available && registration.failure_reason.is_none() {
            registration.failure_reason = Some(
                if self.platform == rion_platform::Platform::Macos
                    && !registration
                        .capability_snapshot
                        .trusted_input
                        .eq(&crate::model::EngineCapabilityStatus::Supported)
                {
                    crate::model::SystemWebViewIssueReason::WebkitSpiUnavailable
                } else {
                    crate::model::SystemWebViewIssueReason::RuntimeCreationFailed
                },
            );
        }
        let mut runtime = self
            .system_webview_runtime
            .write()
            .map_err(|_| CoreError::Internal("system WebView runtime lock poisoned".to_owned()))?;
        *runtime = registration.clone();
        self.system_webview_issues
            .write()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?
            .clear();
        self.system_webview_ready_roles
            .write()
            .map_err(|_| CoreError::Internal("system WebView readiness lock poisoned".to_owned()))?
            .clear();
        Ok(registration)
    }

    fn system_webview_runtime(&self) -> CoreResult<SystemWebViewRuntimeRegistrationRecord> {
        self.system_webview_runtime
            .read()
            .map(|runtime| runtime.clone())
            .map_err(|_| CoreError::Internal("system WebView runtime lock poisoned".to_owned()))
    }

    fn resolve_role_browser_engine(
        &self,
        role: &StateRoleRecord,
        game: &StateGameRecord,
        settings: &GameBrowserSettingsRecord,
    ) -> CoreResult<crate::model::BrowserEngineResolutionRecord> {
        let system_runtime = self.system_webview_runtime()?;
        let (system_available, system_failure_reason) =
            self.system_runtime_preflight(role, game, settings, &system_runtime)?;
        Ok(crate::engine_resolution::resolve_browser_engine(
            crate::engine_resolution::BrowserEngineResolutionInput {
                platform: self.platform,
                system_available,
                system_failure_reason,
            },
        ))
    }

    fn resolve_workspace_browser_engine(
        &self,
        roles: &[StateRoleRecord],
        games: &std::collections::HashMap<String, StateGameRecord>,
        settings: &GameBrowserSettingsRecord,
    ) -> CoreResult<crate::model::BrowserEngineResolutionRecord> {
        let resolutions = roles
            .iter()
            .map(|role| {
                let game = games.get(&role.game_id).ok_or_else(|| CoreError::Domain {
                    code: "GAME_NOT_FOUND",
                    message: "Game not found.".to_owned(),
                })?;
                self.resolve_role_browser_engine(role, game, settings)
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let system_engine = match self.platform {
            rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
            rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
        };
        Ok(crate::model::BrowserEngineResolutionRecord {
            resolved_engine: system_engine,
            host_kind: crate::model::BrowserHostKind::SystemNative,
            issue_reason: resolutions
                .iter()
                .find_map(|resolution| resolution.issue_reason),
        })
    }

    fn system_runtime_preflight(
        &self,
        role: &StateRoleRecord,
        _game: &StateGameRecord,
        _settings: &GameBrowserSettingsRecord,
        runtime: &SystemWebViewRuntimeRegistrationRecord,
    ) -> CoreResult<(bool, Option<crate::model::SystemWebViewIssueReason>)> {
        if let Some(reason) = self
            .system_webview_issues
            .read()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?
            .get(&role.id)
            .copied()
        {
            return Ok((false, Some(reason)));
        }
        if !runtime.available {
            return Ok((false, runtime.failure_reason));
        }
        let role_uses_macros = self
            .read_typed_state_collection::<StateMacroRecord>("macros")?
            .into_iter()
            .any(|macro_record| {
                macro_record.enabled && macro_record.role_ids.iter().any(|id| id == &role.id)
            });
        if role_uses_macros
            && (!system_capability_verified(runtime.capability_snapshot.trusted_input)
                || !system_capability_verified(runtime.capability_snapshot.background_input)
                || !system_capability_available(runtime.capability_snapshot.frame_evaluation))
        {
            return Ok((
                false,
                Some(crate::model::SystemWebViewIssueReason::MacroInputUnavailable),
            ));
        }
        Ok((true, None))
    }

    fn reset_system_launch_retry_state(&self, roles: &[StateRoleRecord]) -> CoreResult<()> {
        {
            let mut ready_roles = self.system_webview_ready_roles.write().map_err(|_| {
                CoreError::Internal("system WebView readiness lock poisoned".to_owned())
            })?;
            for role in roles {
                ready_roles.remove(&role.id);
            }
        }
        let mut issues = self
            .system_webview_issues
            .write()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?;
        for role in roles {
            if matches!(
                issues.get(&role.id),
                Some(crate::model::SystemWebViewIssueReason::RuntimeCreationFailed)
            ) {
                issues.remove(&role.id);
            }
        }
        Ok(())
    }

    fn record_system_webview_issue(
        &self,
        role_ids: &[String],
        reason: crate::model::SystemWebViewIssueReason,
    ) -> CoreResult<()> {
        {
            let mut ready_roles = self.system_webview_ready_roles.write().map_err(|_| {
                CoreError::Internal("system WebView readiness lock poisoned".to_owned())
            })?;
            role_ids.iter().for_each(|role_id| {
                ready_roles.remove(role_id);
            });
        }
        let mut issues = self
            .system_webview_issues
            .write()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?;
        role_ids.iter().for_each(|role_id| {
            issues.insert(role_id.clone(), reason);
        });
        Ok(())
    }

    pub fn invoke_browser_runtime(
        &self,
        command: crate::model::BrowserRuntimeCommand,
    ) -> CoreResult<crate::model::BrowserRuntimeResult> {
        if matches!(&command, crate::model::BrowserRuntimeCommand::Snapshot) {
            return self.browser_runtime.invoke_browser_runtime(command);
        }
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        self.browser_runtime.invoke_browser_runtime(command)
    }

    pub fn runtime_kernel(&self) -> Arc<crate::runtime_kernel::RuntimeKernel> {
        Arc::clone(&self.browser_runtime)
    }

    pub fn runtime_authority_barrier(&self) -> Arc<RwLock<()>> {
        Arc::clone(&self.runtime_authority_barrier)
    }

    pub fn apply_runtime_intent(
        &self,
        intent: crate::runtime_kernel::RuntimeIntent,
    ) -> CoreResult<crate::runtime_kernel::RuntimeCommit> {
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        self.browser_runtime.apply(intent)
    }

    async fn accept_browser_role_launch(
        self: &Arc<Self>,
        role_id: String,
        target: EmbeddedLaunchTargetRecord,
        launch_preview_id: Option<String>,
        launch_tab_id: Option<String>,
        zoom_factor: f64,
        restore_role_slots: Option<Vec<GameWindowRoleSlotRecord>>,
    ) -> CoreResult<crate::model::BrowserLaunchAdmissionRecord> {
        let admission_operation_id = uuid::Uuid::new_v4().to_string();
        let admission_attempt_id = uuid::Uuid::new_v4().to_string();
        let admission_requested_tab_id = launch_tab_id.clone();
        let completion_zoom_factor = zoom_factor;
        let completion_permit = self.launch_completion.try_reserve()?;
        let restore_role_slot =
            validate_restored_role_slot(&role_id, restore_role_slots.as_deref())?;
        let restoring = restore_role_slot.is_some();
        let admission_role_id = role_id.clone();
        let core = Arc::clone(self);
        let start_launch_preview_id = launch_preview_id.clone();
        let start_launch_tab_id = launch_tab_id.clone();
        let start_attempt_id = admission_attempt_id.clone();
        let start = tokio::task::spawn_blocking(move || {
            core.ensure_role_session_recovery_complete(&role_id)?;
            let lease = core.browser_operations.acquire(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "normal".to_owned(),
            })?;
            match core.start_embedded_role_with_lease(
                &role_id,
                EmbeddedRoleLaunchRequest {
                    target,
                    launch_preview_id: start_launch_preview_id,
                    launch_tab_id: start_launch_tab_id,
                    launch_attempt_id: start_attempt_id,
                    zoom_factor,
                    lease_id: lease.id.clone(),
                    restore_role_slot,
                },
            ) {
                Ok(EmbeddedRoleLaunchStart::Completed(value)) => {
                    core.browser_operations.complete(&lease.id)?;
                    Ok(EmbeddedRoleLaunchStart::Completed(value))
                }
                Ok(EmbeddedRoleLaunchStart::Pending(pending)) if restoring => {
                    let result = core.settle_embedded_role_launch_blocking(*pending);
                    let completion = core.browser_operations.complete(&lease.id);
                    match (result, completion) {
                        (Ok(value), Ok(())) => Ok(EmbeddedRoleLaunchStart::Completed(value)),
                        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                    }
                }
                Ok(EmbeddedRoleLaunchStart::Pending(pending)) => {
                    Ok(EmbeddedRoleLaunchStart::Pending(pending))
                }
                Err(error) => {
                    let _ = core.browser_operations.complete(&lease.id);
                    Err(error)
                }
            }
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))??;

        match start {
            EmbeddedRoleLaunchStart::Completed(results) => {
                let result_was_empty = results.is_empty();
                let statuses = self.decorate_browser_statuses(
                    results.into_iter().map(embedded_status).collect(),
                )?;
                let tab_id = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot
                    .tabs
                    .into_iter()
                    .find(|tab| tab.tab_type == "role" && tab.source_id == admission_role_id)
                    .map(|tab| tab.id)
                    .or(admission_requested_tab_id)
                    .ok_or_else(|| {
                        CoreError::Internal(
                            "role launch admission omitted its logical tab identity".to_owned(),
                        )
                    })?;
                Ok(crate::model::BrowserLaunchAdmissionRecord {
                    attempt_id: admission_attempt_id,
                    completion: crate::model::BrowserLaunchAdmissionCompletion::Completed,
                    disposition: if restoring {
                        "admitted"
                    } else if result_was_empty {
                        "joined"
                    } else {
                        "existing"
                    }
                    .to_owned(),
                    operation_id: admission_operation_id,
                    statuses,
                    tab_id,
                })
            }
            EmbeddedRoleLaunchStart::Pending(pending) => {
                let accepted_at = Instant::now();
                let accepted_role_id = pending.role.id.clone();
                let pending_tab_id = pending.tab_id.clone();
                let accepted = vec![launching_browser_status(accepted_role_id)];
                let core = Arc::clone(self);
                completion_permit.send(Box::pin(async move {
                    let PendingEmbeddedRoleLaunch {
                        handle,
                        lease_id,
                        role,
                        tab_id,
                        target,
                        window_id,
                    } = *pending;
                    let completion_tab_id = tab_id.clone();
                    let completion_source_id = role.id.clone();
                    let completion_title = role.name.clone();
                    let launch = core
                        .finish_system_launch_async(handle, std::slice::from_ref(&role))
                        .await;
                    let completion_core = Arc::clone(&core);
                    let completion = tokio::task::spawn_blocking(move || {
                        let result = completion_core
                            .commit_embedded_role_launch_outcome(role, tab_id, launch);
                        let lease_completion =
                            completion_core.browser_operations.complete(&lease_id);
                        match (result, lease_completion) {
                            (Ok(value), Ok(())) => Ok(value),
                            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                        }
                    })
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))
                    .and_then(|result| result);
                    if let Err(error) = &completion {
                        eprintln!("Background role launch failed after acceptance: {error}");
                    }
                    core.notify_browser_launch_completion(BrowserLaunchCompletionRecord {
                        accepted_at,
                        error: completion.as_ref().err().map(|error| error.payload()),
                        launch_preview_id,
                        source_id: completion_source_id,
                        tab_id: completion_tab_id,
                        tab_type: "role".to_owned(),
                        target,
                        title: completion_title,
                        window_id,
                        zoom_factor: Some(completion_zoom_factor),
                    });
                    core.emit_browser_statuses();
                }));
                Ok(crate::model::BrowserLaunchAdmissionRecord {
                    attempt_id: admission_attempt_id,
                    completion:
                        crate::model::BrowserLaunchAdmissionCompletion::PendingNativeCompletion,
                    disposition: "admitted".to_owned(),
                    operation_id: admission_operation_id,
                    statuses: accepted,
                    tab_id: pending_tab_id,
                })
            }
        }
    }

    fn launch_embedded_role(
        &self,
        role_id: &str,
        target: EmbeddedLaunchTargetRecord,
        zoom_factor: f64,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        self.ensure_role_session_recovery_complete(role_id)?;
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![role_id.to_owned()],
            kind: "normal".to_owned(),
        })?;
        let result = self
            .start_embedded_role_with_lease(
                role_id,
                EmbeddedRoleLaunchRequest {
                    target,
                    launch_preview_id: None,
                    launch_tab_id: None,
                    launch_attempt_id: uuid::Uuid::new_v4().to_string(),
                    zoom_factor,
                    lease_id: lease.id.clone(),
                    restore_role_slot: None,
                },
            )
            .and_then(|start| match start {
                EmbeddedRoleLaunchStart::Completed(value) => Ok(value),
                EmbeddedRoleLaunchStart::Pending(pending) => {
                    self.settle_embedded_role_launch_blocking(*pending)
                }
            });
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn start_embedded_role_with_lease(
        &self,
        role_id: &str,
        request: EmbeddedRoleLaunchRequest,
    ) -> CoreResult<EmbeddedRoleLaunchStart> {
        let EmbeddedRoleLaunchRequest {
            target,
            launch_preview_id,
            launch_tab_id,
            launch_attempt_id,
            zoom_factor,
            lease_id,
            restore_role_slot,
        } = request;
        let role = serde_json::from_value::<StateRoleRecord>(self.read_state_record(
            "roles",
            "id",
            role_id,
            "ROLE_NOT_FOUND",
            "Role not found.",
        )?)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let mut snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        if restore_role_slot.is_some()
            && let Some(stale_tab_id) = snapshot
                .tabs
                .iter()
                .find(|tab| {
                    tab.tab_type == "role"
                        && tab.source_id == role_id
                        && !snapshot
                            .roles
                            .iter()
                            .any(|runtime_role| runtime_role.owner.tab_id == tab.id)
                })
                .map(|tab| tab.id.clone())
        {
            // A demand-only role tab may survive an older close path even though
            // it has no native tab or role owner. Restore must rebuild the saved
            // tab instead of treating that empty Core record as completion.
            snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                    tab_id: stale_tab_id,
                })?
                .snapshot;
        }
        if let Some(runtime_role) = snapshot
            .roles
            .iter()
            .find(|candidate| candidate.role_id == role_id && candidate.runtime == "embedded")
        {
            if runtime_role.state != "running" {
                return Err(CoreError::Domain {
                    code: "ROLE_ALREADY_RUNNING",
                    message: "The role is already launching or stopping.".to_owned(),
                });
            }
            if let Some(restore_role_slot) = restore_role_slot {
                return self.create_restored_role_demand(
                    RestoredRoleDemandRequest {
                        role,
                        runtime_role: runtime_role.clone(),
                        target,
                        launch_preview_id,
                        launch_tab_id,
                        launch_attempt_id,
                        restore_role_slot,
                        runtime_snapshot: snapshot,
                    },
                );
            }
            self.run_effect_plan(vec![effect_step(
                role_id,
                CoreEffectAction::EmbeddedFocusRole {
                    role_id: role_id.to_owned(),
                    zoom_factor: Some(zoom_factor),
                },
                Duration::from_secs(10),
                None,
            )])?;
            return Ok(EmbeddedRoleLaunchStart::Completed(vec![
                embedded_launch_result(
                    role_id,
                    runtime_role
                        .launched_at
                        .clone()
                        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                ),
            ]));
        }
        if snapshot.tabs.iter().any(|tab| {
            tab.tab_type == "role" && tab.source_id == role_id
        }) {
            return Ok(EmbeddedRoleLaunchStart::Completed(Vec::new()));
        }
        if snapshot
            .roles
            .iter()
            .any(|candidate| candidate.role_id == role_id)
        {
            return Err(CoreError::Domain {
                code: "ROLE_ALREADY_RUNNING",
                message: "The role is already running.".to_owned(),
            });
        }

        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let game = self.state_game(&role.game_id)?;
        self.reset_system_launch_retry_state(std::slice::from_ref(&role))?;
        let resolution = self.resolve_role_browser_engine(&role, &game, &settings)?;
        require_system_resolution(&resolution)?;
        let resolved_engine = resolution.resolved_engine;

        let role_slot_input = restore_role_slot.unwrap_or_else(|| GameWindowRoleSlotRecord {
            slot_id: format!("role:{}", role.id),
            role_id: role.id.clone(),
            rect: full_window_rect(),
            browser_zoom_percent: Some((zoom_factor * 100.0).clamp(25.0, 500.0)),
        });
        let role_zoom_factor = role_slot_input
            .browser_zoom_percent
            .unwrap_or(zoom_factor * 100.0)
            .clamp(25.0, 500.0)
            / 100.0;
        let requested_tab_id = launch_tab_id
            .or(self.saved_game_window_tab_id(&target.window_id, "role", &role.id)?);
        let tab_admission = self.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: requested_tab_id,
                source_id: role.id.clone(),
                name: role.name.clone(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_slots: vec![RuntimeRoleSlotInputRecord {
                    slot_id: role_slot_input.slot_id.clone(),
                    role_id: role.id.clone(),
                    rect: role_slot_input.rect.clone(),
                    browser_zoom_percent: role_slot_input.browser_zoom_percent,
                }],
            })?;
        let tab_id = tab_admission
            .created_tab_id
            .ok_or_else(|| CoreError::Internal("embedded tab was not created".to_owned()))?;
        if !tab_admission.tab_created {
            return Ok(EmbeddedRoleLaunchStart::Completed(Vec::new()));
        }
        self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role.id.clone(),
            runtime: "embedded".to_owned(),
            tab_id: tab_id.clone(),
            slot_id: Some(role_slot_input.slot_id.clone()),
            state: "launching".to_owned(),
            launched_at: None,
        })?;
        let role_slot = EmbeddedRoleSlotEffectRecord {
            slot_id: role_slot_input.slot_id,
            role: role.clone(),
            web: None,
            rect: role_slot_input.rect.clone(),
            zoom_factor: role_zoom_factor,
            zoom_mode: "fixed".to_owned(),
            state: "launching".to_owned(),
            owner: self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot
                .roles
                .into_iter()
                .find(|runtime| runtime.role_id == role.id)
                .map(|runtime| runtime.owner),
        };
        let tab = EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            attempt_generation: Some(launch_attempt_id),
            launch_preview_id,
            source_id: role.id.clone(),
            name: role.name.clone(),
            workspace_id: None,
            workspace_template: None,
            workspace_slots: Vec::new(),
            workspace_appearance: settings.workspace,
            target,
            slots: vec![role_slot],
            roles: vec![EmbeddedRoleViewEffectRecord {
                role: role.clone(),
                web: None,
                resolved_engine,
                rect: role_slot_input.rect,
                zoom_factor: role_zoom_factor,
                zoom_mode: "fixed".to_owned(),
            }],
        };
        let target = tab.target.clone();
        let window_id = target.window_id.clone();
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let handle =
            self.start_system_launch(&tab_id, tab, std::slice::from_ref(&role), runtime_snapshot)?;
        if let Err(error) = self.commit_embedded_runtime_snapshot_without_native_effect(
            &std::collections::HashSet::new(),
        ) {
            let _ = self.operation_actor.cancel(&handle.operation_id);
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
        Ok(EmbeddedRoleLaunchStart::Pending(Box::new(
            PendingEmbeddedRoleLaunch {
                handle,
                lease_id,
                role,
                tab_id,
                target,
                window_id,
            },
        )))
    }

    fn settle_embedded_role_launch_blocking(
        &self,
        pending: PendingEmbeddedRoleLaunch,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let PendingEmbeddedRoleLaunch {
            handle,
            lease_id: _,
            role,
            tab_id,
            target: _,
            window_id: _,
        } = pending;
        let launch = self.finish_system_launch(handle, std::slice::from_ref(&role));
        self.commit_embedded_role_launch_outcome(role, tab_id, launch)
    }

}
