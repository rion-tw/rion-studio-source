impl SystemRuntimeExecutor {
    fn schedule_native_active_style(
        &self,
        window_id: String,
        tab_id: Option<String>,
        revision: u64,
        trigger: &'static str,
    ) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-active-style-{window_id}"))
            .spawn(move || {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let selection_is_current = runtime
                    .presentation
                    .existing(&window_id)
                    .and_then(|live| {
                        live.lock()
                            .ok()
                            .map(|live| live.selected_tab_id == tab_id)
                    })
                    .unwrap_or(false);
                if selection_is_current {
                    runtime.apply_native_active_style(
                        &window_id,
                        tab_id.as_deref(),
                        revision,
                        trigger,
                    );
                }
            });
    }
}
