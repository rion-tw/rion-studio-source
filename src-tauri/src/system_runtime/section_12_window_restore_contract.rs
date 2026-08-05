impl SystemRuntimeExecutor {
    pub fn prepare_restored_window_tabs(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        tabs: &[GameWindowTabRecord],
        active_tab_id: Option<String>,
    ) -> Result<(), String> {
        let window_id = target.window_id.as_str();
        let ordered_tab_ids = tabs.iter().map(|tab| tab.id.clone()).collect::<Vec<_>>();
        if ordered_tab_ids.is_empty() {
            return Ok(());
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
        let (_, host_created) = self
            .with_native_creation_lane(window_id, || self.ensure_display_host(target, title))
            .map_err(|error| error.message)?;
        let existing_tab_ids = {
            let state = self.state().map_err(|error| error.message)?;
            ordered_tab_ids
                .iter()
                .filter(|tab_id| {
                    state
                        .tabs
                        .get(*tab_id)
                        .is_some_and(|tab| tab.window_id == window_id)
                })
                .cloned()
                .collect::<HashSet<_>>()
        };
        let visible_tab_ids = tabs
            .iter()
            .filter(|tab| !tab.hidden)
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>();
        let mut reserved_tab_ids = existing_tab_ids.clone();
        reserved_tab_ids.extend(
            tabs.iter()
                .filter(|tab| tab.hidden)
                .map(|tab| tab.id.clone()),
        );
        {
            let mut state = self.state().map_err(|error| error.message)?;
            state.pending_window_tab_restores.insert(
                window_id.to_owned(),
                PendingWindowTabRestore {
                    active_tab_id: active_tab_id.clone(),
                    host_created,
                    ordered_tab_ids: ordered_tab_ids.clone(),
                    reserved_tab_ids,
                    successful_tab_ids: existing_tab_ids.clone(),
                    terminal_tab_ids: existing_tab_ids,
                    visible_tab_ids: visible_tab_ids.clone(),
                },
            );
        }
        let revision = self.presentation.next_revision();
        let presentation = self
            .presentation
            .coordinator(window_id)
            .map_err(|message| message.to_owned())?;
        {
            let mut live = presentation.lock().map_err(|_| {
                "The restored tab presentation state is unavailable.".to_owned()
            })?;
            for tab in tabs {
                live.insert_tab(
                    TabPresentation {
                        closable: true,
                        icon_data_url: None,
                        id: tab.id.clone(),
                        phase: TabPresentationPhase::Reserved,
                        role_ids: tab
                            .role_slots
                            .iter()
                            .map(|slot| slot.role_id.clone())
                            .collect(),
                        source_id: tab.source_id.clone(),
                        tab_type: tab.tab_type.clone(),
                        title: tab.name.clone(),
                        #[cfg(any(windows, target_os = "macos"))]
                        workspace_template: None,
                    },
                    revision,
                    false,
                );
                if tab.hidden {
                    live.set_tab_hidden(&tab.id, true, revision);
                }
            }
            live.reorder_known_tabs(&ordered_tab_ids);
            live.select(
                active_tab_id
                    .clone()
                    .or_else(|| visible_tab_ids.first().cloned()),
                revision,
            );
        }
        let mut created_native_tab_ids = Vec::<String>::new();
        for tab in tabs.iter().filter(|tab| !tab.hidden) {
            if let Err(error) = self.reserve_native_tab(
                window_id,
                &tab.id,
                &tab.name,
                &tab.tab_type,
                None,
                revision,
            ) {
                for reserved_tab_id in created_native_tab_ids.iter().rev() {
                    let _ = self.try_remove_native_tab_reservation(
                        window_id,
                        reserved_tab_id,
                        active_tab_id.as_deref(),
                    );
                }
                if let Ok(mut live) = presentation.lock() {
                    for tab_id in &ordered_tab_ids {
                        live.remove_tab(tab_id, revision);
                    }
                }
                if let Ok(mut state) = self.state.lock() {
                    state.pending_window_tab_restores.remove(window_id);
                }
                self.remove_empty_display_host(window_id, host_created);
                return Err(error.message);
            }
            created_native_tab_ids.push(tab.id.clone());
            self.mark_restored_native_tab_reserved(window_id, &tab.id);
        }
        if let Err(error) = self.reorder_native_tabs(window_id, &visible_tab_ids) {
            eprintln!(
                "Saved Game Window tab chrome could not be seeded in order: window={window_id} error={}",
                error.message
            );
        }
        self.apply_native_active_style(
            window_id,
            active_tab_id.as_deref().or_else(|| ordered_tab_ids.first().map(String::as_str)),
            revision,
            "saved-window-restore-seeded",
        );
        self.publish_launcher_presence();
        Ok(())
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
                        !state
                            .tabs
                            .get(*tab_id)
                            .is_some_and(|tab| tab.window_id == window_id)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if orphaned_tab_ids.is_empty() {
            return;
        }
        let revision = self.presentation.next_revision();
        let mut active_tab_id = None;
        if let Some(presentation) = self.presentation.existing(window_id)
            && let Ok(mut live) = presentation.lock()
        {
            for tab_id in &orphaned_tab_ids {
                live.remove_tab(tab_id, revision);
            }
            if live
                .selected_tab_id
                .as_ref()
                .is_none_or(|selected| !live.contains_tab(selected))
            {
                let successor = live.tabs.first().map(|tab| tab.id.clone());
                live.select(successor, revision);
            }
            active_tab_id = live.selected_tab_id.clone();
        }
        for tab_id in orphaned_tab_ids.iter().rev() {
            let _ = self.try_remove_native_tab_reservation(
                window_id,
                tab_id,
                active_tab_id.as_deref(),
            );
        }
        self.remove_empty_display_host(window_id, prepared.host_created);
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
        let should_select = restore.as_ref().map_or_else(
            || {
                launch_preview.is_none_or(|preview| {
                    self.presentation
                        .existing(window_id)
                        .and_then(|presentation| {
                            presentation.lock().ok().map(|selection| {
                                selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                            })
                        })
                        .unwrap_or(true)
                })
            },
            |restore| {
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
        let revision = self.presentation.next_revision();
        let (topology_ready, all_terminal, all_successful, active_tab_id) = {
            let mut live = coordinator.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The restored tab presentation state is unavailable.",
                )
            })?;
            live.reorder_known_tabs(&prepared.ordered_tab_ids);
            live.revision = revision;
            let live_ready = prepared
                .ordered_tab_ids
                .iter()
                .all(|tab_id| live.contains_tab(tab_id));
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
            if topology_ready {
                let active_tab_id = prepared
                    .active_tab_id
                    .clone()
                    .or_else(|| prepared.visible_tab_ids.first().cloned());
                live.select(active_tab_id, revision);
            }
            (
                topology_ready,
                all_terminal,
                all_successful,
                live.selected_tab_id.clone(),
            )
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
        if topology_ready && let Some(active_tab_id) = active_tab_id {
            let _ = self.request_tab_presentation(
                &active_tab_id,
                NativePresentationFocus::None,
                "saved-window-restore",
            )
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        } else if topology_ready {
            self.apply_native_active_style(window_id, None, revision, "saved-window-restore");
        }
        if retired && all_successful {
            self.schedule_live_window_state_persistence(window_id);
        }
        Ok(())
    }
}
