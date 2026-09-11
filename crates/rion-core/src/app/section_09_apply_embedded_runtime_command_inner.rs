impl AppCore {
    fn apply_embedded_runtime_command_inner(
        &self,
        transition: EmbeddedRuntimeTransition,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let EmbeddedRuntimeTransition {
            commands,
            target,
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
            parent_operation_id,
        } = transition;
        let mut result = self.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?;
        for command in commands {
            result = self.invoke_browser_runtime(command)?;
        }
        let next = result.snapshot;
        let effect = CoreEffectAction::EmbeddedFollowRoleOwnership {
            lifecycle_epoch: self.application_lifecycle_epoch.load(Ordering::Acquire),
            roles: next.roles.clone(),
            windows: self.embedded_runtime_window_projections()?,
            target: target.clone(),
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
        };
        self.run_embedded_runtime_effect(
            "embedded-runtime",
            effect,
            None,
            parent_operation_id.as_deref(),
        )?;
        self.emit_browser_statuses();
        Ok(next)
    }

    fn saved_game_window_tab_id(
        &self,
        window_id: &str,
        tab_type: &str,
        source_id: &str,
    ) -> CoreResult<Option<String>> {
        Ok(self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .into_iter()
            .find(|window| window.id == window_id)
            .and_then(|window| {
                window
                    .tabs
                    .into_iter()
                    .find(|tab| tab.tab_type == tab_type && tab.source_id == source_id)
            })
            .map(|tab| tab.id))
    }

    fn saved_game_window_tab_audio_muted(
        &self,
        window_id: &str,
        tab_type: &str,
        source_id: &str,
    ) -> CoreResult<bool> {
        Ok(self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .into_iter()
            .find(|window| window.id == window_id)
            .and_then(|window| {
                window.tabs.into_iter().find(|tab| {
                    tab.tab_type == tab_type && tab.source_id == source_id
                })
            })
            .is_some_and(|tab| tab.audio_muted))
    }

    fn publish_embedded_runtime_snapshot(
        &self,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        self.publish_embedded_runtime_snapshot_with_removed(&std::collections::HashSet::new())
    }

    fn project_embedded_runtime_snapshot_without_persistence(
        &self,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let step = effect_step(
            "embedded-runtime-projection",
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                lifecycle_epoch: self.application_lifecycle_epoch.load(Ordering::Acquire),
                roles: snapshot.roles.clone(),
                windows: self.embedded_runtime_window_projections()?,
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            },
            Duration::from_secs(15),
            None,
        );
        if let Some(parent_operation_id) = parent_operation_id {
            self.run_effect_plan_with_parent(vec![step], parent_operation_id)?;
        } else {
            self.run_effect_plan(vec![step])?;
        }
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn completed_chromium_runtime_projection_step(
        &self,
        tab_id: &str,
        presentation_intent: EmbeddedLaunchPresentationIntent,
    ) -> CoreResult<(
        crate::model::BrowserRuntimeSnapshot,
        crate::operation_actor::OperationStep,
    )> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let (reveal_window_ids, focus_window_ids, focus_tab_id) =
            if presentation_intent == EmbeddedLaunchPresentationIntent::Foreground {
                let window_id = snapshot
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .map(|tab| tab.window_id.clone())
                    .ok_or_else(|| CoreError::Domain {
                        code: "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                        message: "The foreground Chromium tab retired before terminal focus."
                            .to_owned(),
                    })?;
                (
                    vec![window_id.clone()],
                    vec![window_id],
                    Some(tab_id.to_owned()),
                )
            } else {
                (Vec::new(), Vec::new(), None)
            };
        let step = effect_step(
            "embedded-runtime-projection",
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                lifecycle_epoch: self.application_lifecycle_epoch.load(Ordering::Acquire),
                roles: snapshot.roles.clone(),
                windows: self.embedded_runtime_window_projections()?,
                target: None,
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
            },
            Duration::from_secs(15),
            None,
        );
        Ok((snapshot, step))
    }

    fn project_completed_chromium_runtime_launch(
        &self,
        tab_id: &str,
        presentation_intent: EmbeddedLaunchPresentationIntent,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let (snapshot, step) =
            self.completed_chromium_runtime_projection_step(tab_id, presentation_intent)?;
        self.run_effect_plan(vec![step])?;
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn project_surviving_chromium_window_after_close(
        &self,
        window_id: Option<&str>,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<()> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION {
            return Ok(());
        }
        let Some(window_id) = window_id else {
            return Ok(());
        };
        let snapshot = self.browser_runtime.snapshot()?;
        if snapshot
            .windows
            .get(window_id)
            .is_some_and(|window| !window.tabs.is_empty())
        {
            // Native destruction removes the surface, but only Core can advance
            // the surviving window's topology revision and successor selection.
            self.project_embedded_runtime_snapshot_without_persistence(parent_operation_id)?;
        }
        Ok(())
    }

    fn browser_runtime_snapshot_without_persistence(
        &self,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn commit_embedded_runtime_snapshot_without_native_effect(
        &self,
        _removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        // Native isolation and the in-memory runtime transition are already
        // committed at this point. Publish that authoritative state before the
        // SQLite durability step so a slow or failed writer cannot leave the UI
        // indefinitely showing roles as `stopping` after their exact surfaces
        // are offline.
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn publish_embedded_runtime_snapshot_with_removed(
        &self,
        _removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        self.run_effect_plan(vec![effect_step(
            "embedded-runtime-projection",
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                lifecycle_epoch: self.application_lifecycle_epoch.load(Ordering::Acquire),
                roles: snapshot.roles.clone(),
                windows: self.embedded_runtime_window_projections()?,
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            },
            Duration::from_secs(15),
            None,
        )])?;
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn publish_embedded_runtime_snapshot_best_effort(&self) {
        if self.publish_embedded_runtime_snapshot().is_err() {
            self.emit_browser_statuses();
        }
    }

    fn embedded_runtime_window_projections(
        &self,
    ) -> CoreResult<Vec<crate::model::EmbeddedRuntimeWindowProjectionRecord>> {
        let snapshot = self.browser_runtime.snapshot()?;
        let workspace_appearance = self
            .read_scalar_state::<GameBrowserSettingsRecord>(
                "gameBrowserSettings",
                "game browser settings are missing",
            )?
            .workspace;
        let activation_by_tab = &snapshot.tab_activations;
        let mut windows = snapshot
            .windows
            .into_values()
            .map(|window| {
                let mut hidden_tab_ids = window.hidden_tab_ids.into_iter().collect::<Vec<_>>();
                hidden_tab_ids.sort();
                let tab_phases = window
                    .tabs
                    .iter()
                    .map(|tab| crate::model::EmbeddedRuntimeTabPhaseProjectionRecord {
                        tab_id: tab.id.clone(),
                        phase: activation_by_tab
                            .get(&tab.id)
                            .filter(|activation| {
                                activation.owner_window_id == window.window_id
                                    && activation.window_generation.0
                                        == window.window_generation
                            })
                            .map(|activation| activation.phase)
                            .unwrap_or(crate::model::RuntimeTabActivationPhaseRecord::Ready),
                    })
                    .collect();
                crate::model::EmbeddedRuntimeWindowProjectionRecord {
                    workspace_tabs: window
                        .tabs
                        .iter()
                        .filter(|tab| !tab.workspace_slots.is_empty())
                        .map(|tab| crate::model::EmbeddedRuntimeWorkspaceTabProjectionRecord {
                            tab_id: tab.id.clone(),
                            workspace_slots: tab.workspace_slots.clone(),
                            workspace_appearance: workspace_appearance.clone(),
                        })
                        .collect(),
                    window_id: window.window_id,
                    window_generation: window.window_generation,
                    topology_revision: window.revision,
                    tab_ids: window.tabs.into_iter().map(|tab| tab.id).collect(),
                    tab_phases,
                    hidden_tab_ids,
                    active_tab_id: window.selected_tab_id,
                }
            })
            .collect::<Vec<_>>();
        windows.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        Ok(windows)
    }

    pub fn resolve_role_paths(&self, role_id: &str) -> CoreResult<crate::model::RolePathsRecord> {
        self.with_runtime(|_| crate::role_browser_data::paths(&self.user_data_dir, role_id))
    }

    pub fn prepare_embedded_key_transition(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifier_codes: &[String],
        owner_id: &str,
    ) -> CoreResult<crate::model::EmbeddedKeyTransitionRecord> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .prepare(role_id, phase, code, modifier_codes, owner_id)
    }

    pub fn complete_embedded_key_transition(
        &self,
        transition_id: &str,
        succeeded: bool,
    ) -> CoreResult<()> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .complete(transition_id, succeeded)
    }

    pub fn reassert_embedded_keys(
        &self,
        role_id: &str,
    ) -> CoreResult<crate::model::EmbeddedKeyTransitionRecord> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .reassert(role_id)
    }

    pub fn has_embedded_held_keys(&self, role_id: &str) -> CoreResult<bool> {
        Ok(self
            .embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .has_held_keys(role_id))
    }

    pub fn clear_embedded_keys(&self, role_id: &str) -> CoreResult<()> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .clear_role(role_id);
        Ok(())
    }

    pub fn dispatch_browser_results(&self, results: Vec<BrowserActionResult>) -> CoreResult<()> {
        self.macro_runtime.dispatch_results(results).map(|_| ())
    }

    pub fn dispatch_core_effect_results(
        &self,
        results: Vec<CoreEffectResult>,
    ) -> CoreResult<CoreEffectDispatchReport> {
        let mut browser_results = Vec::new();
        let mut operation_results = Vec::new();
        let mut browser_effect_ids = Vec::new();
        for result in results {
            let effect_id = result.effect_id.clone();
            if let Some(result) =
                crate::browser_action_effects::result_as_browser_action(result.clone())
            {
                browser_effect_ids.push(effect_id);
                browser_results.push(result);
            } else {
                operation_results.push(result);
            }
        }
        let browser_report = self.macro_runtime.dispatch_results(browser_results)?;
        let mut report = self.operation_actor.dispatch_results(operation_results)?;

        debug_assert!(browser_report
            .accepted
            .iter()
            .chain(&browser_report.duplicate)
            .chain(&browser_report.late)
            .chain(&browser_report.unknown)
            .all(|effect_id| browser_effect_ids.contains(effect_id)));
        report.accepted.extend(browser_report.accepted);
        report.duplicate.extend(browser_report.duplicate);
        report.late.extend(browser_report.late);
        report.unknown.extend(browser_report.unknown);
        report
            .operation_mismatch
            .extend(browser_report.operation_mismatch);
        Ok(report)
    }

    pub fn core_effect_is_pending(
        &self,
        effect_id: &str,
        operation_id: &str,
    ) -> CoreResult<bool> {
        self.operation_actor
            .effect_is_pending(effect_id, operation_id)
    }

    pub fn resolve_workspace_layout(
        &self,
        input: &crate::model::WorkspaceLayoutInput,
    ) -> crate::model::WorkspaceLayoutOutput {
        crate::resolve_workspace_layout(input)
    }

    pub fn resolve_adaptive_workspace_zoom(
        &self,
        viewport_width: f64,
        current_percent: Option<u32>,
    ) -> u32 {
        layout::adaptive_zoom_percent(viewport_width, current_percent)
    }

    pub fn normalize_workspace_rects(
        &self,
        rects: &[crate::model::LayoutRect],
    ) -> Vec<crate::model::LayoutRect> {
        layout::normalize_rect_edges(rects)
    }

    pub fn create_workspace_dividers(
        &self,
        roles: &[crate::model::LayoutRoleInput],
    ) -> Vec<crate::model::WorkspaceDividerDescriptor> {
        layout::create_dividers(roles)
    }

    pub fn resize_workspace_divider(
        &self,
        input: &crate::model::WorkspaceDividerResizeInput,
    ) -> CoreResult<crate::model::WorkspaceDividerResizeOutput> {
        layout::resize_divider(input).ok_or_else(|| {
            CoreError::InvalidInput("workspace divider does not reference live roles".to_owned())
        })
    }

    fn replace_scalar_state<T: serde::Serialize>(&self, key: &str, value: T) -> CoreResult<Value> {
        let _guard = self.state_mutation_guard()?;
        self.replace_scalar_state_under_guard(key, value)
    }

    fn replace_scalar_state_under_guard<T: serde::Serialize>(
        &self,
        key: &str,
        value: T,
    ) -> CoreResult<Value> {
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let value =
            serde_json::to_value(value).map_err(|error| CoreError::Internal(error.to_string()))?;
        self.with_runtime(|runtime| {
            let revision = runtime.state.replace_scalar(key.to_owned(), value)?;
            self.emit(vec![CoreEvent::StateChanged {
                revision,
                changed_collections: Vec::new(),
            }]);
            Ok(json!({ "revision": revision }))
        })
    }

    fn replace_game_browser_settings(
        &self,
        settings: GameBrowserSettingsRecord,
    ) -> CoreResult<GameBrowserSettingsRecord> {
        let _appearance_lease = self.workspace_appearance_sequence.acquire()?;
        let _lane = self.embedded_runtime_sequence.acquire()?;
        let previous = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let settings = normalize_game_browser_settings(settings);
        validate_game_browser_settings(&settings)?;
        self.commit_game_browser_settings(previous, settings)
    }

    fn patch_game_browser_settings(
        &self,
        patch: GameBrowserSettingsPatchRecord,
    ) -> CoreResult<GameBrowserSettingsRecord> {
        let _appearance_lease = self.workspace_appearance_sequence.acquire()?;
        let _lane = self.embedded_runtime_sequence.acquire()?;
        let mut settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let previous = settings.clone();
        let patch_macro_badge_position = patch.macro_badge_position.is_some();
        let patch_macro_overlay = patch.macro_overlay.is_some();
        let patch_workspace = patch.workspace.is_some();
        let mut candidate = settings.clone();
        if let Some(macro_badge_position) = patch.macro_badge_position {
            candidate.macro_badge_position = macro_badge_position;
        }
        if let Some(macro_overlay) = patch.macro_overlay {
            if let Some(show_tool_button) = macro_overlay.show_tool_button {
                candidate.macro_overlay.show_tool_button = show_tool_button;
            }
            if let Some(show_running_badges) = macro_overlay.show_running_badges {
                candidate.macro_overlay.show_running_badges = show_running_badges;
            }
            if let Some(show_click_markers) = macro_overlay.show_click_markers {
                candidate.macro_overlay.show_click_markers = show_click_markers;
            }
        }
        if let Some(workspace) = patch.workspace {
            candidate.workspace = workspace;
        }
        let candidate = normalize_game_browser_settings(candidate);
        validate_game_browser_settings(&candidate)?;
        if patch_macro_badge_position {
            settings.macro_badge_position = candidate.macro_badge_position;
        }
        if patch_macro_overlay {
            settings.macro_overlay = candidate.macro_overlay;
        }
        if patch_workspace {
            settings.workspace = candidate.workspace;
        }
        self.commit_game_browser_settings(previous, settings)
    }

    fn commit_game_browser_settings(
        &self,
        previous: GameBrowserSettingsRecord,
        settings: GameBrowserSettingsRecord,
    ) -> CoreResult<GameBrowserSettingsRecord> {
        let workspace_changed = previous.workspace != settings.workspace;
        let refresh_live_workspace = workspace_changed
            && self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION
            && self.has_live_workspace_tabs()?;
        {
            let _guard = self.state_mutation_guard()?;
            self.replace_scalar_state_under_guard("gameBrowserSettings", settings.clone())?;
        }
        if !refresh_live_workspace {
            return Ok(settings);
        }
        let projection = self
            .supersede_active_workspace_divider_gestures()
            .and_then(|()| self.project_workspace_appearance());
        if let Err(error) = projection {
            let restored = (|| {
                let _guard = self.state_mutation_guard()?;
                self.replace_scalar_state_under_guard(
                    "gameBrowserSettings",
                    previous.clone(),
                )?;
                Ok::<(), CoreError>(())
            })();
            return match restored {
                Ok(()) => Err(error),
                Err(_) => Err(CoreError::Domain {
                    code: "WORKSPACE_APPEARANCE_COMPENSATION_FAILED",
                    message: "Workspace appearance failed and its persisted setting could not be restored. Restart Rion Studio before retrying.".to_owned(),
                }),
            };
        }
        Ok(settings)
    }

    fn has_live_workspace_tabs(&self) -> CoreResult<bool> {
        Ok(self.browser_runtime.snapshot()?.windows.values().any(|window| {
            window.tabs.iter().any(|tab| !tab.workspace_slots.is_empty())
        }))
    }

    fn project_workspace_appearance(&self) -> CoreResult<()> {
        if self.platform == rion_platform::Platform::Windows {
            self.project_embedded_runtime_snapshot_without_persistence(None)?;
            return Ok(());
        }
        let mut window_ids = self
            .browser_runtime
            .snapshot()?
            .windows
            .values()
            .filter(|window| {
                window.tabs.iter().any(|tab| !tab.workspace_slots.is_empty())
            })
            .map(|window| window.window_id.clone())
            .collect::<Vec<_>>();
        window_ids.sort();
        let outcome = self.run_embedded_runtime_effect(
            "workspace-appearance-observation",
            CoreEffectAction::EmbeddedObserveAppKitWorkspaceAppearance {
                window_ids: window_ids.clone(),
            },
            None,
            None,
        )?;
        let value_json = outcome
            .results
            .first()
            .and_then(|result| result.value_json.as_deref())
            .ok_or_else(|| CoreError::Effect {
                code: "APPKIT_WORKSPACE_APPEARANCE_OBSERVATION_MISSING".to_owned(),
                message: "Electron omitted the exact AppKit workspace-appearance observation."
                    .to_owned(),
            })?;
        let observation = serde_json::from_str::<
            crate::model::AppKitWorkspaceAppearanceObservationReceiptRecord,
        >(value_json)
        .map_err(|_| CoreError::Effect {
            code: "APPKIT_WORKSPACE_APPEARANCE_OBSERVATION_INVALID".to_owned(),
            message: "Electron returned an invalid AppKit workspace-appearance observation."
                .to_owned(),
        })?;
        if uuid::Uuid::parse_str(&observation.observation_id).is_err()
            || observation.adapter_sequence == 0
            || observation.hosts.len() != window_ids.len()
        {
            return Err(CoreError::Effect {
                code: "APPKIT_WORKSPACE_APPEARANCE_OBSERVATION_INCOMPLETE".to_owned(),
                message: "Electron omitted a live AppKit workspace host observation.".to_owned(),
            });
        }
        let expected = window_ids.into_iter().collect::<std::collections::HashSet<_>>();
        let before = self.browser_runtime.snapshot()?;
        let _event_lane = self.appkit_event_sequence.acquire()?;
        let mut projected_windows = Vec::with_capacity(observation.hosts.len());
        let mut seen = std::collections::HashSet::new();
        for host in observation.hosts {
            let event = crate::model::AppKitRuntimeEventRecord {
                event_id: observation.observation_id.clone(),
                adapter_sequence: observation.adapter_sequence,
                hosts: vec![host],
                action: crate::model::AppKitRuntimeEventActionRecord::Layout {
                    layout_sequence: observation.adapter_sequence,
                },
            };
            validate_appkit_runtime_event_platform(self)?;
            validate_appkit_runtime_event_shape(&event)?;
            let host = event.hosts.first().expect("validated one AppKit host");
            if !expected.contains(&host.identity.logical_window_id)
                || !seen.insert(host.identity.logical_window_id.clone())
                || !self.accept_appkit_event_sequence(&host.identity, event.adapter_sequence)?
                || !appkit_observations_match(&event.hosts, &before)
            {
                return Err(CoreError::Domain {
                    code: "APPKIT_WORKSPACE_APPEARANCE_OBSERVATION_STALE",
                    message: "The AppKit workspace host changed before appearance projection."
                        .to_owned(),
                });
            }
            let projection = self.build_appkit_projection(&event)?;
            if projection.windows.len() != 1 {
                return Err(CoreError::Effect {
                    code: "APPKIT_WORKSPACE_APPEARANCE_PROJECTION_INVALID".to_owned(),
                    message: "Core produced an invalid AppKit workspace-appearance projection."
                        .to_owned(),
                });
            }
            projected_windows.extend(projection.windows);
        }
        let projection_event_id = observation.observation_id;
        let quarantine_scope = projected_windows.clone();
        let projection_target = projected_windows
            .first()
            .expect("validated live AppKit workspace projection")
            .identity
            .logical_window_id
            .clone();
        let native = self.run_embedded_runtime_effect(
            &projection_target,
            CoreEffectAction::EmbeddedApplyAppKitProjection {
                projection: Box::new(crate::model::AppKitRuntimeProjectionEffectRecord {
                    event_id: projection_event_id.clone(),
                    windows: projected_windows,
                }),
            },
            None,
            None,
        );
        if let Err(error) = native {
            if appkit_projection_failure_requires_quarantine(error.code()) {
                self.reconcile_appkit_projection_quarantine_under_runtime_sequence(
                    &projection_event_id,
                    &quarantine_scope,
                )
                .map_err(|reconciliation_error| CoreError::Domain {
                    code: "WORKSPACE_APPEARANCE_PROJECTION_INDETERMINATE",
                    message: format!(
                        "Workspace appearance projection could not prove native compensation or isolate its window: {}",
                        reconciliation_error.code()
                    ),
                })?;
            }
            return Err(error);
        }
        self.emit_browser_statuses();
        Ok(())
    }

    fn read_optional_scalar_state<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> CoreResult<Option<T>> {
        let value = self.with_runtime(|runtime| runtime.state.read_scalar(key.to_owned()))?;
        value
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    CoreError::StateDatabase(format!("stored {key} is invalid: {error}"))
                })
            })
            .transpose()
    }

    fn read_legal_acceptance_fail_closed(&self) -> CoreResult<Option<LegalAcceptanceRecord>> {
        let value =
            self.with_runtime(|runtime| runtime.state.read_scalar("legalAcceptance".to_owned()))?;
        Ok(value
            .and_then(|value| serde_json::from_value::<LegalAcceptanceRecord>(value).ok())
            .filter(|acceptance| validate_legal_acceptance(acceptance).is_ok()))
    }

    fn read_scalar_state<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
        missing_message: &str,
    ) -> CoreResult<T> {
        self.read_optional_scalar_state(key)?
            .ok_or_else(|| CoreError::StateDatabase(missing_message.to_owned()))
    }

    fn mutate_state(&self, mutation: StateMutation) -> CoreResult<Value> {
        let _guard = self.state_mutation_guard()?;
        self.mutate_state_under_guard(mutation)
    }

    fn mutate_state_under_guard(&self, mutation: StateMutation) -> CoreResult<Value> {
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
        let changed_collections = mutation.changed_collections();
        let result = self.with_runtime(|runtime| runtime.state.mutate(mutation))?;
        let revision = result
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if result.get("changed").and_then(Value::as_bool).unwrap_or(true) {
            self.emit(vec![CoreEvent::StateChanged {
                revision,
                changed_collections,
            }]);
        }
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    }

    fn read_state_collection(&self, key: &str) -> CoreResult<Value> {
        self.with_runtime(|runtime| runtime.state.read_collection(key.to_owned()))
    }

    fn read_typed_state_collection<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> CoreResult<Vec<T>> {
        serde_json::from_value(self.read_state_collection(key)?)
            .map_err(|error| CoreError::StateDatabase(format!("stored {key} are invalid: {error}")))
    }

    fn read_state_record(
        &self,
        collection: &str,
        id_field: &str,
        id: &str,
        code: &'static str,
        message: &str,
    ) -> CoreResult<Value> {
        debug_assert!(matches!(id_field, "id" | "gameId"));
        self.with_runtime(|runtime| {
            runtime
                .state
                .read_record(collection.to_owned(), id.to_owned())
        })?
        .ok_or_else(|| CoreError::Domain {
            code,
            message: message.to_owned(),
        })
    }

    fn read_typed_snapshot(&self) -> CoreResult<crate::model::CoreStateSnapshotRecord> {
        let value = self.with_runtime(|runtime| runtime.state.snapshot())?;
        serde_json::from_value(value).map_err(|error| {
            CoreError::StateDatabase(format!("state snapshot is invalid: {error}"))
        })
    }

    fn ensure_role_exists(&self, id: &str) -> CoreResult<()> {
        self.read_state_record("roles", "id", id, "ROLE_NOT_FOUND", "Role not found.")
            .map(|_| ())
    }

    fn portable(&self) -> CoreResult<std::sync::MutexGuard<'_, crate::portable::PortableRuntime>> {
        self.portable
            .lock()
            .map_err(|_| CoreError::Internal("portable runtime lock poisoned".to_owned()))
    }

    fn state_mutation_guard(&self) -> CoreResult<std::sync::MutexGuard<'_, ()>> {
        self.state_mutation_guard
            .lock()
            .map_err(|_| CoreError::Internal("state mutation lock poisoned".to_owned()))
    }

    pub fn schedule_wait(
        &self,
        id: String,
        duration_ms: u32,
    ) -> CoreResult<tokio::sync::oneshot::Receiver<CoreResult<()>>> {
        self.with_runtime(|runtime| runtime.scheduler.schedule(id, duration_ms))
    }

    pub fn cancel_wait(&self, id: String) -> CoreResult<()> {
        self.with_runtime(|runtime| runtime.scheduler.cancel(id))
    }

    pub fn subscribe(&self) -> CoreResult<Receiver<Vec<CoreEvent>>> {
        let (sender, receiver) = bounded(EVENT_QUEUE_CAPACITY);
        sender
            .try_send(vec![CoreEvent::Ready {
                schema_version: SCHEMA_VERSION,
            }])
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        self.subscribers
            .lock()
            .map_err(|_| CoreError::Internal("subscriber lock poisoned".to_owned()))?
            .push(sender);
        Ok(receiver)
    }

    pub fn acquire_browser_operation(
        &self,
        request: crate::model::BrowserOperationRequest,
    ) -> CoreResult<crate::model::BrowserOperationLease> {
        self.with_runtime(|_| Ok(()))?;
        self.browser_operations.acquire(request)
    }

    pub fn complete_browser_operation(&self, id: &str) -> CoreResult<()> {
        self.browser_operations.complete(id)
    }

}
