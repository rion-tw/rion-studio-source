impl AppCore {
    fn commit_closed_embedded_window(
        &self,
        request: &RuntimeWindowStopRequestRecord,
    ) -> CoreResult<()> {
        {
            // Native destruction has acknowledged every admitted tab. Keep the
            // exact topology check and removal under one authority boundary so an
            // older terminal result cannot retire a replacement window.
            let _authority_guard = self.runtime_authority_barrier.write().map_err(|_| {
                CoreError::Internal("runtime authority barrier poisoned".to_owned())
            })?;
            let snapshot = self.browser_runtime.snapshot()?;
            let Some(window) = snapshot.windows.get(&request.window_id) else {
                return Ok(());
            };
            if window.window_generation != request.window_generation
                || window.revision != request.topology_revision
                || window.all_tab_ids() != request.tab_ids
            {
                return Err(CoreError::Domain {
                    code: "SYSTEM_WINDOW_CLOSE_SCOPE_CHANGED",
                    message: "Window topology changed before acknowledged native close committed."
                        .to_owned(),
                });
            }
            self.browser_runtime
                .apply(crate::RuntimeIntent::RemoveWindow {
                    operation_id: format!("{}:remove-window", request.parent_operation_id),
                    window_id: request.window_id.clone(),
                })?;
        }
        // The recovery journal is SQLite state: leave the runtime authority
        // barrier first, because snapshot readers take the state guard before it.
        self.retire_closed_window_from_restore_session(&request.window_id)
    }

    /// Normal exit rewrites the whole cohort from the final native snapshot, but
    /// an unclean session only accumulates live windows. A committed close is
    /// the exact event that ends this window's membership, so crash recovery
    /// and the running Dashboard never treat a user-closed window as interrupted.
    fn retire_closed_window_from_restore_session(&self, window_id: &str) -> CoreResult<()> {
        self.update_runtime_restore_session(|session| {
            let mut retired = false;
            if let Some(live_window_ids) = session.live_window_ids.as_mut() {
                let before = live_window_ids.len();
                live_window_ids.retain(|candidate| candidate != window_id);
                retired |= live_window_ids.len() != before;
            }
            let before = session.restore_in_progress_window_ids.len();
            session
                .restore_in_progress_window_ids
                .retain(|candidate| candidate != window_id);
            retired |= session.restore_in_progress_window_ids.len() != before;
            if session.last_focused_window_id.as_deref() == Some(window_id) {
                session.last_focused_window_id = None;
                retired = true;
            }
            if retired {
                session.session_generation = session.session_generation.saturating_add(1);
            }
        })?;
        Ok(())
    }
}
