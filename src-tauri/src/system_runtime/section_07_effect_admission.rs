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
        self.destroy_tab(tab_id)?;
        self.presentation
            .statuses
            .set_presentation_phase(tab_id, TabRuntimePhase::Failed);
        self.record_presentation_event(
            LogLevel::Debug,
            "tab.stale-create-retired",
            "A cancelled native create effect was isolated while its live tab remained available for retry.",
            &window_id,
            Some(tab_id),
            self.presentation.current_revision(),
            "effect-admission",
            0,
        );
        Ok(())
    }
}
