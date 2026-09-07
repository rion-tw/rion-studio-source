impl AppCore {
    fn commit_closed_embedded_window(
        &self,
        request: &RuntimeWindowStopRequestRecord,
    ) -> CoreResult<()> {
        // Native destruction has acknowledged every admitted tab. Keep the
        // exact topology check and removal under one authority boundary so an
        // older terminal result cannot retire a replacement window.
        let _authority_guard = self
            .runtime_authority_barrier
            .write()
            .map_err(|_| CoreError::Internal("runtime authority barrier poisoned".to_owned()))?;
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
        Ok(())
    }
}
