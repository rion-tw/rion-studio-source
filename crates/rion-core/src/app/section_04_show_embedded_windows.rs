impl AppCore {
    fn register_embedded_window(
        &self,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _window_sequence = self.embedded_window_sequence.acquire()?;
        let _runtime_sequence = self.embedded_runtime_sequence.acquire()?;
        let before = self.browser_runtime.snapshot()?;
        let window_id = target.window_id.clone();
        let context_operation_id = format!(
            "embedded-window-register:{}",
            uuid::Uuid::new_v4()
        );
        let existing = before.windows.get(&window_id);
        let initialized = existing.is_none();
        self.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
            crate::RuntimeWindowContextInitializeInput {
                operation_id: format!("{context_operation_id}:context"),
                persisted_name: target.persisted_name.clone(),
                placement: crate::model::GameWindowPlacementRecord {
                    normal_bounds: target.bounds.clone(),
                    saved_work_area: target.work_area.clone(),
                    presentation: target.presentation.clone(),
                },
                target_display: crate::model::DisplayTargetRecord {
                    id: target.display_id,
                    fingerprint: None,
                },
                window_generation: existing.map_or_else(
                    || before.revision.saturating_add(1).max(1),
                    |window| window.window_generation.max(1),
                ),
                window_id: window_id.clone(),
            },
        ))?;

        let result = self.apply_embedded_runtime_command_inner(EmbeddedRuntimeTransition {
            commands: Vec::new(),
            target: Some(target),
            reveal_window_ids: vec![window_id.clone()],
            focus_window_ids: vec![window_id.clone()],
            focus_tab_id: None,
            parent_operation_id: None,
        });
        if result.is_err() && initialized {
            let _ = self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
                operation_id: format!("{context_operation_id}:remove-failed-register"),
                window_id,
            });
        }
        result
    }

    fn show_embedded_windows(&self, window_id: Option<String>) -> CoreResult<Value> {
        let (window_ids, focus_window_ids) = match window_id {
            Some(window_id) => (vec![window_id.clone()], vec![window_id]),
            None => (
                self.embedded_runtime_window_projections()?
                    .into_iter()
                    .map(|window| window.window_id)
                    .collect(),
                Vec::new(),
            ),
        };
        serde_json::to_value(self.apply_embedded_runtime_command(
            Vec::new(),
            None,
            window_ids,
            focus_window_ids,
            None,
        )?)
        .map_err(|error| CoreError::Internal(error.to_string()))
    }
}
