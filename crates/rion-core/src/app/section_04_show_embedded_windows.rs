impl AppCore {
    fn show_embedded_windows(&self, window_id: Option<String>) -> CoreResult<Value> {
        let window_ids = match window_id {
            Some(window_id) => vec![window_id],
            None => self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot
                .windows
                .into_iter()
                .map(|window| window.window_id)
                .collect(),
        };
        serde_json::to_value(self.apply_embedded_runtime_command(
            Vec::new(),
            None,
            window_ids.clone(),
            window_ids,
            None,
        )?)
        .map_err(|error| CoreError::Internal(error.to_string()))
    }
}
