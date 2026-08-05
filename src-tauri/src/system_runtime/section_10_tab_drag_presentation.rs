impl SystemRuntimeExecutor {
    pub(crate) fn tab_drag_source_title(
        &self,
        window_id: &str,
        tab_id: &str,
    ) -> Result<String, String> {
        if self.presentation.tab_window(tab_id)?.as_deref() != Some(window_id) {
            return Err("Runtime tab is outside the source Game Window.".to_owned());
        }
        let presentation = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Runtime tab presentation window was not found.".to_owned())?;
        presentation
            .lock()
            .map_err(|_| "Runtime tab presentation state is unavailable.".to_owned())?
            .tab_title(tab_id)
            .ok_or_else(|| "Runtime tab was not found in the live presentation.".to_owned())
    }
}
