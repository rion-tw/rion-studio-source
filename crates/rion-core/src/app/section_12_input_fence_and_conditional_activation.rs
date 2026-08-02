impl AppCore {
    pub fn macro_input_diagnostics(&self) -> CoreResult<MacroInputDiagnosticsRecord> {
        self.macro_runtime.input_diagnostics()
    }

    fn release_macro_role(&self, role_id: String) -> CoreResult<Value> {
        self.macro_runtime.release_role(&role_id)?;
        Ok(json!({ "released": true }))
    }

    fn macro_input_fence(&self, role_id: String) -> CoreResult<Value> {
        let input_epoch = self.macro_runtime.fence_role_input(&role_id)?;
        self.macro_input_epoch_value(role_id, input_epoch, true)
    }

    fn macro_input_drain(&self, role_id: String, input_epoch: u64) -> CoreResult<Value> {
        let current = self
            .macro_runtime
            .drain_role_input(&role_id, input_epoch)?;
        self.macro_input_epoch_value(role_id, input_epoch, current)
    }

    fn macro_input_resume(&self, role_id: String, input_epoch: u64) -> CoreResult<Value> {
        let current = self
            .macro_runtime
            .resume_role_input(&role_id, input_epoch)?;
        self.macro_input_epoch_value(role_id, input_epoch, current)
    }

    fn macro_input_epoch_value(
        &self,
        role_id: String,
        input_epoch: u64,
        current: bool,
    ) -> CoreResult<Value> {
        serde_json::to_value(MacroInputEpochRecord {
            role_id,
            input_epoch,
            current,
        })
        .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn conditional_embedded_tab_activation(
        &self,
        tab_id: String,
        window_id: String,
        selection_revision: u64,
    ) -> CoreResult<Value> {
        serde_json::to_value(self.apply_conditional_embedded_tab_selection(
            &tab_id,
            &window_id,
            selection_revision,
        )?)
        .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn apply_conditional_embedded_tab_selection(
        &self,
        tab_id: &str,
        window_id: &str,
        selection_revision: u64,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        if tab_id.is_empty() || window_id.is_empty() || selection_revision == 0 {
            return Err(CoreError::InvalidInput(
                "conditional tab activation identifiers and revision are required".to_owned(),
            ));
        }
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let mut revisions = self.embedded_selection_revisions.lock().map_err(|_| {
            CoreError::Internal("embedded selection revision lock poisoned".to_owned())
        })?;
        if revisions
            .get(window_id)
            .is_some_and(|current| *current >= selection_revision)
        {
            return Ok(snapshot);
        }
        revisions.insert(window_id.to_owned(), selection_revision);
        if !snapshot
            .tabs
            .iter()
            .any(|tab| tab.id == tab_id && tab.window_id == window_id)
        {
            return Ok(snapshot);
        }
        drop(revisions);
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
                tab_id: tab_id.to_owned(),
            })?
            .snapshot;
        self.sync_game_windows_from_runtime(&snapshot, &std::collections::HashSet::new())?;
        Ok(snapshot)
    }
}

fn runtime_game_window_tab_is_valid(tab: &GameWindowTabRecord) -> bool {
    uuid::Uuid::parse_str(tab.id.trim()).is_ok()
        && matches!(tab.tab_type.as_str(), "role" | "workspace")
        && !tab.source_id.trim().is_empty()
        && tab.source_id.len() <= 128
        && (tab.tab_type != "role" || tab.role_ids == [tab.source_id.clone()])
        && tab.role_ids.iter().all(|role_id| {
            !role_id.trim().is_empty() && role_id.len() <= 128
        })
        && tab
            .role_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == tab.role_ids.len()
}
