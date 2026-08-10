impl SystemRuntimeExecutor {
    pub fn prepare_restored_window_tabs(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        tabs: &[GameWindowTabRecord],
        active_tab_id: Option<String>,
    ) -> Result<(), String> {
        self.prepare_restored_window_tabs_internal(target, tabs, active_tab_id, None)
            .map(|_| ())
    }

    pub(crate) fn prepare_restored_window_tabs_with_launch(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        tabs: &[GameWindowTabRecord],
        source_id: &str,
        tab_type: &str,
    ) -> Result<LaunchPreviewHandle, String> {
        self.prepare_restored_window_tabs_internal(
            target,
            tabs,
            None,
            Some((source_id, tab_type)),
        )?
        .ok_or_else(|| "The restored launch preview was not created.".to_owned())
    }

    fn prepare_restored_window_tabs_internal(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        tabs: &[GameWindowTabRecord],
        active_tab_id: Option<String>,
        appended_source: Option<(&str, &str)>,
    ) -> Result<Option<LaunchPreviewHandle>, String> {
        let window_id = target.window_id.as_str();
        let ordered_tab_ids = tabs.iter().map(|tab| tab.id.clone()).collect::<Vec<_>>();
        if ordered_tab_ids.is_empty() && appended_source.is_none() {
            return Ok(None);
        }
        if active_tab_id
            .as_ref()
            .is_some_and(|tab_id| !ordered_tab_ids.contains(tab_id))
        {
            return Err("The saved active tab is outside its saved window order.".to_owned());
        }
        if ordered_tab_ids.iter().collect::<HashSet<_>>().len() != ordered_tab_ids.len() {
            return Err("The saved window contains duplicate runtime tab identifiers.".to_owned());
        }
        for tab_id in &ordered_tab_ids {
            if let Some(owner) = self
                .presentation
                .tab_window(tab_id)
                .map_err(|message| message.to_owned())?
                && owner != window_id
            {
                return Err(format!(
                    "Runtime tab {tab_id} is already presented by window {owner}."
                ));
            }
        }
        let title = active_tab_id
            .as_ref()
            .and_then(|active| tabs.iter().find(|tab| &tab.id == active))
            .or_else(|| tabs.first())
            .map(|tab| tab.name.as_str())
            .unwrap_or(RION_STUDIO_APP_NAME);
        let launch_preview = appended_source.map(|(source_id, tab_type)| {
            (
                allocate_launch_preview_handle(source_id, tab_type),
                source_id.to_owned(),
                tab_type.to_owned(),
            )
        });
        let existing_tab_ids = {
            let state = self.state().map_err(|error| error.message)?;
            ordered_tab_ids
                .iter()
                .filter(|tab_id| state.native_resources.tabs.contains_key(*tab_id))
                .cloned()
                .collect::<HashSet<_>>()
        };
        let mut visible_tab_ids = tabs
            .iter()
            .filter(|tab| !tab.hidden)
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>();
        if let Some((preview, _, _)) = launch_preview.as_ref() {
            visible_tab_ids.push(preview.provisional_tab_id.clone());
        }
        let mut reserved_tab_ids = existing_tab_ids.clone();
        reserved_tab_ids.extend(
            tabs.iter()
                .filter(|tab| tab.hidden)
                .map(|tab| tab.id.clone()),
        );
        let mut live_tabs = tabs
            .iter()
            .map(|tab| LiveTabRecord {
                audio_muted: tab.audio_muted,
                closable: true,
                icon_data_url: None,
                id: tab.id.clone(),
                persistable: true,
                role_ids: tab
                    .role_slots
                    .iter()
                    .map(|slot| slot.role_id.clone())
                    .collect(),
                role_slots: tab.role_slots.clone(),
                source_id: tab.source_id.clone(),
                tab_type: tab.tab_type.clone(),
                title: tab.name.clone(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: None,
            })
            .collect::<Vec<_>>();
        if let Some((preview, source_id, tab_type)) = launch_preview.as_ref() {
            live_tabs.push(LiveTabRecord {
                audio_muted: false,
                closable: true,
                icon_data_url: None,
                id: preview.provisional_tab_id.clone(),
                persistable: false,
                role_ids: if tab_type == "role" {
                    vec![source_id.clone()]
                } else {
                    Vec::new()
                },
                role_slots: Vec::new(),
                source_id: source_id.clone(),
                tab_type: tab_type.clone(),
                title: "Loading…".to_owned(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: None,
            });
        }
        let hidden_tab_ids = tabs
            .iter()
            .filter(|tab| tab.hidden)
            .map(|tab| tab.id.clone())
            .collect::<HashSet<_>>();
        let generation = self
            .presentation
            .existing(window_id)
            .map(|live| live.window_generation)
            .unwrap_or_default();
        let receipt = self.presentation.commit_live_topology(LiveTopologyCommitInput {
            commit_id: uuid::Uuid::new_v4().to_string(),
            source: "restore",
            primary_window_id: window_id.to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: launch_preview
                    .as_ref()
                    .map(|(preview, _, _)| preview.provisional_tab_id.clone())
                    .or(active_tab_id
                    .clone()
                    .or_else(|| visible_tab_ids.first().cloned())),
                hidden_tab_ids,
                tabs: live_tabs,
                ui_sequence: 1,
                window_generation: generation,
                window_id: window_id.to_owned(),
            }],
        })?;
        let revision = receipt.revision;
        {
            let mut state = self.state().map_err(|error| error.message)?;
            if let Some((preview, source_id, tab_type)) = launch_preview.as_ref() {
                if active_provisional_launch(&state, source_id, tab_type).is_some() {
                    return Err("The requested source already has an admitted launch intent."
                        .to_owned());
                }
                insert_provisional_launch(
                    &mut state,
                    ProvisionalLaunch {
                        cancelled: false,
                        failed: false,
                        host_created: false,
                        id: preview.provisional_tab_id.clone(),
                        launch_preview_id: preview.launch_preview_id.clone(),
                        source_id: source_id.clone(),
                        tab_type: tab_type.clone(),
                        window_id: window_id.to_owned(),
                    },
                );
            }
            state.pending_window_tab_restores.insert(
                window_id.to_owned(),
                PendingWindowTabRestore {
                    active_tab_id: launch_preview
                        .as_ref()
                        .map(|(preview, _, _)| preview.provisional_tab_id.clone())
                        .or(active_tab_id.clone()),
                    host_created: false,
                    ordered_tab_ids: ordered_tab_ids.clone(),
                    reserved_tab_ids,
                    successful_tab_ids: existing_tab_ids.clone(),
                    terminal_tab_ids: existing_tab_ids,
                    visible_tab_ids: visible_tab_ids.clone(),
                },
            );
        }
        // Restore commits the complete desired topology before creating a native window or tab
        // reservation. The host generation is then projected back into the same Kernel aggregate
        // by `ensure_display_host`; failure leaves retryable desired tabs, never native-only truth.
        let (_, host_created) = match self
            .with_native_creation_lane(window_id, || self.ensure_display_host(target, title))
        {
            Ok(result) => result,
            Err(error) => {
                if let Some((preview, _, _)) = launch_preview.as_ref() {
                    self.cancel_tab_launch_preview(&preview.launch_preview_id);
                }
                return Err(error.message);
            }
        };
        if let Ok(mut state) = self.state.lock() {
            if let Some(restore) = state.pending_window_tab_restores.get_mut(window_id) {
                restore.host_created = host_created;
            }
            if let Some((preview, _, _)) = launch_preview.as_ref()
                && let Some(launch) = state.provisional_launches.get_mut(&preview.launch_preview_id)
            {
                launch.host_created = host_created;
            }
        }
        self.schedule_live_projection_membership_follow();
        for tab in tabs {
            self.presentation
                .statuses
                .set_presentation_phase(&tab.id, TabRuntimePhase::Reserved);
        }
        for tab in tabs.iter().filter(|tab| !tab.hidden) {
            if let Err(error) = self.reserve_native_tab(
                window_id,
                &tab.id,
                &tab.name,
                &tab.tab_type,
                None,
                revision,
            ) {
                self.presentation
                    .statuses
                    .set_presentation_phase(&tab.id, TabRuntimePhase::Failed);
                eprintln!(
                    "Restored tab chrome remains pending while live topology is retained: window={window_id} tab={} error={}",
                    tab.id, error.message
                );
                continue;
            }
            self.mark_restored_native_tab_reserved(window_id, &tab.id);
        }
        if let Some((preview, _, tab_type)) = launch_preview.as_ref() {
            self.presentation.statuses.set_presentation_phase(
                &preview.provisional_tab_id,
                TabRuntimePhase::Reserved,
            );
            if let Err(error) = self.reserve_native_tab(
                window_id,
                &preview.provisional_tab_id,
                "Loading…",
                tab_type,
                None,
                revision,
            ) {
                self.cancel_tab_launch_preview(&preview.launch_preview_id);
                return Err(error.message);
            }
        }
        self.schedule_native_tab_order_projection(window_id.to_owned(), visible_tab_ids);
        self.apply_native_active_style(
            window_id,
            launch_preview
                .as_ref()
                .map(|(preview, _, _)| preview.provisional_tab_id.as_str())
                .or(active_tab_id.as_deref())
                .or_else(|| ordered_tab_ids.first().map(String::as_str)),
            revision,
            "saved-window-restore-seeded",
        );
        self.publish_launcher_presence();
        Ok(launch_preview.map(|(preview, _, _)| preview))
    }

    pub fn discard_prepared_restored_window_tabs(&self, window_id: &str) {
        let prepared = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_window_tab_restores.remove(window_id));
        let Some(prepared) = prepared else {
            return;
        };
        let orphaned_tab_ids = self
            .state
            .lock()
            .ok()
            .map(|state| {
                prepared
                    .ordered_tab_ids
                    .iter()
                    .filter(|tab_id| {
                        !state.native_resources.tabs.contains_key(*tab_id)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if orphaned_tab_ids.is_empty() {
            return;
        }
        for tab_id in &orphaned_tab_ids {
            self.presentation
                .statuses
                .set_presentation_phase(tab_id, TabRuntimePhase::Failed);
        }
        // Restore cleanup owns only native resources. The one-pass restored live
        // topology remains intact so failed surfaces can hydrate into placeholders
        // and retry without a visible reorder or tab deletion.
        self.publish_launcher_presence();
    }

    fn pending_window_tab_restore(&self, window_id: &str) -> Option<PendingWindowTabRestore> {
        self.state.lock().ok().and_then(|state| {
            state
                .pending_window_tab_restores
                .get(window_id)
                .cloned()
        })
    }

    fn restored_tab_selection_intent(
        &self,
        window_id: &str,
        tab_id: &str,
        launch_preview: Option<&ProvisionalLaunch>,
    ) -> (Option<PendingWindowTabRestore>, bool) {
        let restore = self.pending_window_tab_restore(window_id);
        let preview_is_selected = launch_preview.is_some_and(|preview| {
            self.presentation
                .existing(window_id)
                .map(|selection| {
                    selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                })
                .unwrap_or(false)
        });
        let should_select = restore.as_ref().map_or_else(
            || {
                launch_preview.is_none_or(|preview| {
                    self.presentation
                        .existing(window_id)
                        .map(|selection| {
                            selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                        })
                        .unwrap_or(true)
                })
            },
            |restore| {
                if preview_is_selected {
                    return true;
                }
                restore
                    .active_tab_id
                    .as_ref()
                    .or_else(|| restore.ordered_tab_ids.first())
                    .is_some_and(|active_tab_id| active_tab_id == tab_id)
            },
        );
        (restore, should_select)
    }

    fn mark_restored_native_tab_reserved(&self, window_id: &str, tab_id: &str) {
        if let Ok(mut state) = self.state.lock()
            && let Some(restore) = state.pending_window_tab_restores.get_mut(window_id)
            && restore.ordered_tab_ids.iter().any(|saved| saved == tab_id)
        {
            restore.reserved_tab_ids.insert(tab_id.to_owned());
        }
    }

    fn mark_restored_tab_creation_terminal(
        &self,
        window_id: &str,
        tab_id: &str,
        succeeded: bool,
    ) {
        if let Ok(mut state) = self.state.lock()
            && let Some(restore) = state.pending_window_tab_restores.get_mut(window_id)
            && restore.ordered_tab_ids.iter().any(|saved| saved == tab_id)
        {
            restore.terminal_tab_ids.insert(tab_id.to_owned());
            if succeeded {
                restore.successful_tab_ids.insert(tab_id.to_owned());
            }
        }
    }

    fn finish_restored_tab_creation(&self, window_id: &str, tab_id: &str, succeeded: bool) {
        self.mark_restored_tab_creation_terminal(window_id, tab_id, succeeded);
        if let Err(error) = self.reconcile_prepared_restored_window_tabs(window_id) {
            eprintln!(
                "Saved Game Window tab order could not be finalized after native creation: window={window_id} tab={tab_id} error={}",
                error.message
            );
        }
    }

    pub fn finish_prepared_restored_window_tabs(&self, window_id: &str) -> Result<(), String> {
        self.reconcile_prepared_restored_window_tabs(window_id)
            .map_err(|error| error.message)
    }

    fn reconcile_prepared_restored_window_tabs(&self, window_id: &str) -> RuntimeResult<()> {
        let Some(prepared) = self.pending_window_tab_restore(window_id) else {
            return Ok(());
        };
        let Some(coordinator) = self.presentation.existing(window_id) else {
            return Ok(());
        };
        let (topology_ready, all_terminal, all_successful) = {
            let live_ready = prepared
                .ordered_tab_ids
                .iter()
                .all(|tab_id| coordinator.contains_tab(tab_id));
            // Create effects are accepted concurrently during restore. A Live tab can exist
            // before its AppKit/WebView2 chrome reservation has reached the native queue. Do
            // not consume the saved ordering fence until every expected reservation is queued,
            // otherwise the last concurrent create can append itself after the final reorder.
            let topology_ready = live_ready
                && prepared
                    .ordered_tab_ids
                    .iter()
                    .all(|tab_id| prepared.reserved_tab_ids.contains(tab_id));
            let all_terminal = prepared
                .ordered_tab_ids
                .iter()
                .all(|tab_id| prepared.terminal_tab_ids.contains(tab_id));
            let all_successful = all_terminal
                && prepared
                    .ordered_tab_ids
                    .iter()
                    .all(|tab_id| prepared.successful_tab_ids.contains(tab_id));
            (topology_ready, all_terminal, all_successful)
        };
        let retired = all_terminal
            && (!all_successful || topology_ready)
            && self.state.lock().is_ok_and(|mut state| {
                if state.pending_window_tab_restores.get(window_id) != Some(&prepared) {
                    return false;
                }
                state.pending_window_tab_restores.remove(window_id);
                true
            });
        if retired && all_successful {
            self.schedule_live_window_state_persistence(window_id);
        }
        Ok(())
    }
}
