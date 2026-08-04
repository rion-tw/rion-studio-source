impl SystemRuntimeExecutor {
    pub fn prepare_restored_window_tabs(
        &self,
        window_id: &str,
        ordered_tab_ids: Vec<String>,
        active_tab_id: Option<String>,
    ) -> Result<(), String> {
        if ordered_tab_ids.is_empty() {
            return Ok(());
        }
        if active_tab_id
            .as_ref()
            .is_some_and(|tab_id| !ordered_tab_ids.contains(tab_id))
        {
            return Err("The saved active tab is outside its saved window order.".to_owned());
        }
        let mut state = self.state().map_err(|error| error.message)?;
        let existing_tab_ids = ordered_tab_ids
            .iter()
            .filter(|tab_id| {
                state
                    .tabs
                    .get(*tab_id)
                    .is_some_and(|tab| tab.window_id == window_id)
            })
            .cloned()
            .collect::<HashSet<_>>();
        state.pending_window_tab_restores.insert(
            window_id.to_owned(),
            PendingWindowTabRestore {
                active_tab_id,
                ordered_tab_ids,
                reserved_tab_ids: existing_tab_ids.clone(),
                successful_tab_ids: existing_tab_ids.clone(),
                terminal_tab_ids: existing_tab_ids,
            },
        );
        Ok(())
    }

    pub fn discard_prepared_restored_window_tabs(&self, window_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_window_tab_restores.remove(window_id);
        }
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
        let (topology_ready, all_terminal, all_successful, ordered, active_tab_id) = {
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
                    .or_else(|| prepared.ordered_tab_ids.first().cloned());
                live.select(active_tab_id, revision);
            }
            (
                topology_ready,
                all_terminal,
                all_successful,
                live.tab_ids(),
                live.selected_tab_id.clone(),
            )
        };
        if topology_ready {
            self.reorder_native_tabs(window_id, &ordered)?;
        }
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
