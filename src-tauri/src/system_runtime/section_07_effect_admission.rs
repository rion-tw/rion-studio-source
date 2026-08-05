impl SystemRuntimeExecutor {
    fn create_effect_is_still_pending(&self, effect: &CoreEffectRequest) -> bool {
        self.core
            .core_effect_is_pending(&effect.effect_id, &effect.operation_id)
            .unwrap_or(false)
    }

    fn retire_unacknowledged_created_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let Some(window_id) = self.presentation.tab_window(tab_id).map_err(|message| {
            RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
        })? else {
            return Ok(());
        };
        let mut next_tab_id = None;
        if let Some(presentation) = self.presentation.existing(&window_id)
            && let Ok(mut presentation) = presentation.lock()
            && presentation.contains_tab(tab_id)
        {
            let was_selected = presentation.selected_tab_id.as_deref() == Some(tab_id);
            let revision = self.presentation.next_revision();
            presentation.remove_tab(tab_id, revision);
            if was_selected {
                next_tab_id = presentation.tabs.last().map(|tab| tab.id.clone());
                presentation.select(next_tab_id.clone(), revision);
            }
        }
        self.remove_native_tab_reservation(&window_id, tab_id, next_tab_id.as_deref());
        self.destroy_tab(tab_id)?;
        self.record_presentation_event(
            LogLevel::Debug,
            "tab.stale-create-retired",
            "A cancelled native create effect was isolated before it could become an orphan tab.",
            &window_id,
            Some(tab_id),
            self.presentation.current_revision(),
            "effect-admission",
            0,
        );
        Ok(())
    }
}
