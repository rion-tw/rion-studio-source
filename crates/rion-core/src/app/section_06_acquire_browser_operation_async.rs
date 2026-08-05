impl AppCore {
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
        let statuses = embedded_role_statuses(
            self.browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .snapshot()
                .roles,
        );
        self.decorate_browser_statuses(statuses)
    }

    fn macro_active_role_ids(&self) -> CoreResult<Vec<String>> {
        let mut role_ids = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .snapshot()
            .roles
            .into_iter()
            .filter(|role| role.runtime == "embedded" && role.state == "running")
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
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .snapshot();
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
        mut statuses: Vec<crate::model::BrowserRoleStatusRecord>,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        if statuses.is_empty() {
            return Ok(statuses);
        }
        let roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| (role.id.clone(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let games = self
            .read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .map(|game| (game.id.clone(), game))
            .collect::<std::collections::HashMap<_, _>>();
        let workspaces =
            self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?;
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let workspace_by_tab = runtime_snapshot
            .tabs
            .iter()
            .filter(|tab| tab.tab_type == "workspace")
            .map(|tab| (tab.id.clone(), tab.source_id.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let active_workspace_by_role = runtime_snapshot
            .roles
            .into_iter()
            .filter_map(|role| {
                workspace_by_tab
                    .get(&role.owner.tab_id)
                    .cloned()
                    .map(|workspace_id| (role.role_id, workspace_id))
            })
            .collect::<std::collections::HashMap<_, _>>();
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
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
        for workspace in &workspaces {
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
        self.browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .invoke(command)
    }

    async fn accept_browser_role_launch(
        self: &Arc<Self>,
        role_id: String,
        target: EmbeddedLaunchTargetRecord,
        launch_preview_id: Option<String>,
        zoom_factor: f64,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let completion_zoom_factor = zoom_factor;
        let completion_permit = self.launch_completion.try_reserve()?;
        let core = Arc::clone(self);
        let start_launch_preview_id = launch_preview_id.clone();
        let start = tokio::task::spawn_blocking(move || {
            core.ensure_role_session_recovery_complete(&role_id)?;
            let lease = core.browser_operations.acquire(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "normal".to_owned(),
            })?;
            match core.start_embedded_role_with_lease(
                &role_id,
                target,
                start_launch_preview_id,
                zoom_factor,
                lease.id.clone(),
            ) {
                Ok(EmbeddedRoleLaunchStart::Completed(value)) => {
                    core.browser_operations.complete(&lease.id)?;
                    Ok(EmbeddedRoleLaunchStart::Completed(value))
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
            EmbeddedRoleLaunchStart::Completed(results) => Ok(
                self.decorate_browser_statuses(results.into_iter().map(embedded_status).collect())?
            ),
            EmbeddedRoleLaunchStart::Pending(pending) => {
                let accepted_at = Instant::now();
                let accepted_role_id = pending.role.id.clone();
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
                Ok(accepted)
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
                target,
                None,
                zoom_factor,
                lease.id.clone(),
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
        target: EmbeddedLaunchTargetRecord,
        launch_preview_id: Option<String>,
        zoom_factor: f64,
        lease_id: String,
    ) -> CoreResult<EmbeddedRoleLaunchStart> {
        let role = serde_json::from_value::<StateRoleRecord>(self.read_state_record(
            "roles",
            "id",
            role_id,
            "ROLE_NOT_FOUND",
            "Role not found.",
        )?)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
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

        let tab_id = self
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: self.saved_game_window_tab_id(&target.window_id, "role", &role.id)?,
                source_id: role.id.clone(),
                name: role.name.clone(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_slots: vec![RuntimeRoleSlotInputRecord {
                    slot_id: format!("role:{}", role.id),
                    role_id: role.id.clone(),
                    rect: full_window_rect(),
                    browser_zoom_percent: Some(
                        (zoom_factor * 100.0).clamp(25.0, 500.0),
                    ),
                }],
            })?
            .created_tab_id
            .ok_or_else(|| CoreError::Internal("embedded tab was not created".to_owned()))?;
        self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role.id.clone(),
            runtime: "embedded".to_owned(),
            tab_id: tab_id.clone(),
            slot_id: Some(format!("role:{}", role.id)),
            state: "launching".to_owned(),
            launched_at: None,
        })?;
        let role_slot = EmbeddedRoleSlotEffectRecord {
            slot_id: format!("role:{}", role.id),
            role: role.clone(),
            rect: full_window_rect(),
            zoom_factor,
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
            attempt_generation: None,
            launch_preview_id,
            source_id: role.id.clone(),
            name: role.name.clone(),
            workspace_id: None,
            workspace_template: None,
            workspace_appearance: settings.workspace,
            target,
            slots: vec![role_slot],
            roles: vec![EmbeddedRoleViewEffectRecord {
                role: role.clone(),
                resolved_engine,
                rect: full_window_rect(),
                zoom_factor,
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
