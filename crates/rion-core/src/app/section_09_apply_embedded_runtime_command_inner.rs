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
            focus_active_window_id,
            parent_operation_id,
            persist_runtime_topology,
        } = transition;
        let (previous, mut next_runtime, mut next) = {
            let runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            let previous = runtime.clone();
            let mut next_runtime = previous.clone();
            let mut result = next_runtime.invoke(BrowserRuntimeCommand::Snapshot)?;
            for command in commands {
                result = next_runtime.invoke(command)?;
            }
            (previous, next_runtime, result.snapshot)
        };
        let previous_snapshot = previous
            .clone()
            .invoke(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let focus_tab_id = focus_tab_id.or_else(|| {
            focus_active_window_id.and_then(|window_id| {
                next.windows
                    .iter()
                    .find(|window| window.window_id == window_id)
                    .and_then(|window| window.active_tab_id.clone())
            })
        });
        let effect = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: next.clone(),
            target: target.clone(),
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
        };
        let compensation = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: previous_snapshot.clone(),
            target,
            reveal_window_ids: Vec::new(),
            focus_window_ids: Vec::new(),
            focus_tab_id: None,
        };
        self.run_embedded_runtime_effect(
            "embedded-runtime",
            effect,
            Some(compensation.clone()),
            parent_operation_id.as_deref(),
        )?;
        let removed_window_ids = previous_snapshot
            .windows
            .iter()
            .filter(|previous_window| {
                !previous_window.tab_ids.is_empty()
                    && next
                        .windows
                        .iter()
                        .find(|next_window| next_window.window_id == previous_window.window_id)
                        .is_some_and(|next_window| next_window.tab_ids.is_empty())
            })
            .map(|window| window.window_id.clone())
            .collect::<std::collections::HashSet<_>>();
        if persist_runtime_topology
            && let Err(error) = self.sync_game_windows_from_runtime_transition(
                &previous_snapshot,
                &next,
                &removed_window_ids,
            )
        {
            let _ = self.run_embedded_runtime_effect(
                "embedded-runtime-persistence-rollback",
                compensation,
                None,
                parent_operation_id.as_deref(),
            );
            return Err(error);
        }
        if !removed_window_ids.is_empty() {
            let mut cleaned_runtime = next_runtime.clone();
            for window_id in &removed_window_ids {
                cleaned_runtime.invoke(BrowserRuntimeCommand::RemoveWindow {
                    window_id: window_id.clone(),
                })?;
            }
            let cleaned = cleaned_runtime
                .invoke(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let _ = self.run_embedded_runtime_effect(
                "embedded-runtime-empty-window-cleanup",
                CoreEffectAction::EmbeddedApplyRuntime {
                    snapshot: cleaned.clone(),
                    target: None,
                    reveal_window_ids: Vec::new(),
                    focus_window_ids: Vec::new(),
                    focus_tab_id: None,
                },
                None,
                parent_operation_id.as_deref(),
            );
            next_runtime = cleaned_runtime;
            next = cleaned;
        }
        let mut runtime = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        *runtime = next_runtime;
        drop(runtime);
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

    fn sync_game_windows_from_runtime(
        &self,
        snapshot: &crate::model::BrowserRuntimeSnapshot,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<()> {
        self.sync_game_windows_from_runtime_with_previous(None, snapshot, removed_window_ids)
    }

    fn sync_game_windows_from_runtime_transition(
        &self,
        previous_snapshot: &crate::model::BrowserRuntimeSnapshot,
        snapshot: &crate::model::BrowserRuntimeSnapshot,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<()> {
        self.sync_game_windows_from_runtime_with_previous(
            Some(previous_snapshot),
            snapshot,
            removed_window_ids,
        )
    }

    fn sync_game_windows_from_runtime_with_previous(
        &self,
        previous_snapshot: Option<&crate::model::BrowserRuntimeSnapshot>,
        snapshot: &crate::model::BrowserRuntimeSnapshot,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<()> {
        let _guard = self.state_mutation_guard()?;
        let game_windows =
            self.read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?;
        let game_windows = self.project_game_windows_from_runtime(
            game_windows,
            previous_snapshot,
            snapshot,
            removed_window_ids,
        );
        if !game_windows.is_empty() {
            self.mutate_state_under_guard(StateMutation::GameWindowsRuntimeSync {
                windows: game_windows,
            })?;
        }
        self.clear_pending_game_window_configurations(removed_window_ids)?;
        Ok(())
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
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: snapshot.clone(),
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
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let removed_window_ids = removed_window_ids
            .iter()
            .filter(|window_id| {
                snapshot
                    .windows
                    .iter()
                    .find(|window| &window.window_id == *window_id)
                    .is_some_and(|window| window.tab_ids.is_empty())
            })
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        // Native isolation and the in-memory runtime transition are already
        // committed at this point. Publish that authoritative state before the
        // SQLite durability step so a slow or failed writer cannot leave the UI
        // indefinitely showing roles as `stopping` after their exact surfaces
        // are offline.
        self.emit_browser_statuses();
        self.sync_game_windows_from_runtime(&snapshot, &removed_window_ids)?;
        for window_id in &removed_window_ids {
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWindow {
                window_id: window_id.clone(),
            })?;
        }
        if removed_window_ids.is_empty() {
            Ok(snapshot)
        } else {
            Ok(self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot)
        }
    }

    /// Commits presentation metadata without entering the native runtime effect lane.
    ///
    /// A tab selection is independent from navigation, overlay installation, and launch
    /// verification. Keeping this path free of the launch sequences prevents a slow or
    /// unresponsive page from delaying keyboard and pointer selection. If persistence fails,
    /// the in-memory selection deliberately remains authoritative and can be retried by a
    /// later snapshot sync instead of visually rolling the user back.
    fn apply_embedded_tab_selection_without_native_effect(
        &self,
        command: BrowserRuntimeCommand,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        // Presentation is previewed by the native shell before this commit runs. Serialize only
        // the durable runtime mutation so a long topology transition cannot later replace the
        // browser runtime with a clone that predates this selection.
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let snapshot = self.invoke_browser_runtime(command)?.snapshot;
        Ok(snapshot)
    }

    fn publish_embedded_runtime_snapshot_with_removed(
        &self,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let removed_window_ids = removed_window_ids
            .iter()
            .filter(|window_id| {
                snapshot
                    .windows
                    .iter()
                    .find(|window| &window.window_id == *window_id)
                    .is_some_and(|window| window.tab_ids.is_empty())
            })
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        self.run_effect_plan(vec![effect_step(
            "embedded-runtime-projection",
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: snapshot.clone(),
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            },
            Duration::from_secs(15),
            None,
        )])?;
        self.sync_game_windows_from_runtime(&snapshot, &removed_window_ids)?;
        let mut cleaned = false;
        for window_id in &removed_window_ids {
            if snapshot
                .windows
                .iter()
                .find(|window| &window.window_id == window_id)
                .is_some_and(|window| window.tab_ids.is_empty())
            {
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWindow {
                    window_id: window_id.clone(),
                })?;
                cleaned = true;
            }
        }
        if cleaned {
            let cleaned_snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            self.run_effect_plan(vec![effect_step(
                "embedded-runtime-empty-window-cleanup",
                CoreEffectAction::EmbeddedApplyRuntime {
                    snapshot: cleaned_snapshot.clone(),
                    target: None,
                    reveal_window_ids: Vec::new(),
                    focus_window_ids: Vec::new(),
                    focus_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )])?;
            self.emit_browser_statuses();
            return Ok(cleaned_snapshot);
        }
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn publish_embedded_runtime_snapshot_best_effort(&self) {
        if self.publish_embedded_runtime_snapshot().is_err() {
            self.emit_browser_statuses();
        }
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
        self.macro_runtime.dispatch_results(results)
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
        if !browser_results.is_empty() {
            self.macro_runtime.dispatch_results(browser_results)?;
        }
        let mut report = self.operation_actor.dispatch_results(operation_results)?;
        let core_effects = self.operation_actor.metrics();
        self.with_runtime(|runtime| {
            runtime.telemetry.record_core_effects(core_effects);
            Ok(())
        })?;
        report.accepted.extend(browser_effect_ids);
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
        layout::resolve(input)
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

    fn patch_game_browser_settings(
        &self,
        patch: GameBrowserSettingsPatchRecord,
    ) -> CoreResult<GameBrowserSettingsRecord> {
        let _guard = self.state_mutation_guard()?;
        let mut settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let patch_macro_badge_position = patch.macro_badge_position.is_some();
        let patch_performance = patch.performance.is_some();
        let patch_workspace = patch.workspace.is_some();
        let mut candidate = settings.clone();
        if let Some(macro_badge_position) = patch.macro_badge_position {
            candidate.macro_badge_position = macro_badge_position;
        }
        if let Some(performance) = patch.performance {
            candidate.performance = performance;
        }
        if let Some(workspace) = patch.workspace {
            candidate.workspace = workspace;
        }
        let candidate = normalize_game_browser_settings(candidate);
        validate_game_browser_settings(&candidate)?;
        if patch_macro_badge_position {
            settings.macro_badge_position = candidate.macro_badge_position;
        }
        if patch_performance {
            settings.performance = candidate.performance;
        }
        if patch_workspace {
            settings.workspace = candidate.workspace;
        }
        self.replace_scalar_state_under_guard("gameBrowserSettings", settings.clone())?;
        Ok(settings)
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
        let changed_collections = mutation.changed_collections();
        let result = self.with_runtime(|runtime| runtime.state.mutate(mutation))?;
        let revision = result
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        self.emit(vec![CoreEvent::StateChanged {
            revision,
            changed_collections,
        }]);
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

fn game_window_tabs_conflict(
    saved: &GameWindowTabRecord,
    runtime: &GameWindowTabRecord,
) -> bool {
        saved.id == runtime.id
        || (saved.tab_type == runtime.tab_type && saved.source_id == runtime.source_id)
}

fn merge_runtime_tabs_with_saved(
    saved_tabs: &[GameWindowTabRecord],
    runtime_tabs: Vec<GameWindowTabRecord>,
    previous_live_tab_ids: &std::collections::HashSet<String>,
    live_tab_ids: &std::collections::HashSet<String>,
) -> Vec<GameWindowTabRecord> {
    let replaced_indices = saved_tabs
        .iter()
        .enumerate()
        .filter(|(_, saved)| {
            runtime_tabs
                .iter()
                .any(|runtime| game_window_tabs_conflict(saved, runtime))
        })
        .map(|(index, _)| index)
        .collect::<std::collections::HashSet<_>>();
    let first_replaced = replaced_indices.iter().copied().min();
    let mut preserved = saved_tabs
        .iter()
        .enumerate()
        .filter(|(index, tab)| {
            !replaced_indices.contains(index)
                && !previous_live_tab_ids.contains(&tab.id)
                && !live_tab_ids.contains(&tab.id)
        })
        .map(|(index, tab)| (index, tab.clone()))
        .collect::<Vec<_>>();
    let insertion_index = first_replaced.map_or(preserved.len(), |replaced| {
        preserved
            .iter()
            .take_while(|(index, _)| *index < replaced)
            .count()
    });
    let mut tail = preserved.split_off(insertion_index);
    let mut merged = preserved
        .into_iter()
        .map(|(_, tab)| tab)
        .collect::<Vec<_>>();
    merged.extend(runtime_tabs);
    merged.extend(tail.drain(..).map(|(_, tab)| tab));
    merged
}
