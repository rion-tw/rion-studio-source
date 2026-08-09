impl SystemRuntimeExecutor {
    fn reserve_native_tab_for_create(
        &self,
        tab: &EmbeddedTabEffectRecord,
        tab_type: &str,
        revision: u64,
        active_tab_id: Option<&str>,
        launch_preview: Option<&ProvisionalLaunch>,
        window_restore: Option<&PendingWindowTabRestore>,
    ) -> RuntimeResult<()> {
        if let Some(restore) = window_restore {
            return if restore.visible_tab_ids.contains(&tab.tab_id) {
                self.try_ensure_native_tab(
                    &tab.target.window_id,
                    &tab.tab_id,
                    &tab.name,
                    tab_type,
                    tab.workspace_template.as_deref(),
                )
            } else {
                Ok(())
            };
        }
        if let Some(preview) = launch_preview {
            debug_assert_eq!(preview.id, tab.tab_id);
            let _ = (active_tab_id, revision);
            return Ok(());
        }
        self.reserve_native_tab(
            &tab.target.window_id,
            &tab.tab_id,
            &tab.name,
            tab_type,
            tab.workspace_template.as_deref(),
            revision,
        )
    }
}
