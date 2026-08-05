impl SystemRuntimeExecutor {
    pub(crate) fn tab_drag_source_title(
        &self,
        window_id: &str,
        tab_id: &str,
    ) -> Result<String, String> {
        if self.presentation.tab_window(tab_id)?.as_deref() != Some(window_id) {
            return Ok(RION_STUDIO_APP_NAME.to_owned());
        }
        let presentation = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Runtime tab presentation window was not found.".to_owned())?;
        let title = presentation
            .lock()
            .map_err(|_| "Runtime tab presentation state is unavailable.".to_owned())?
            .tab_title(tab_id)
            .unwrap_or_else(|| RION_STUDIO_APP_NAME.to_owned());
        Ok(title)
    }
}
