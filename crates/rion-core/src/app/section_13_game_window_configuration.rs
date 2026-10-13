// Convert only a captured Kernel snapshot; never combine tabs from one revision
// with placement or ownership metadata from a later snapshot.
fn runtime_window_tab_snapshot(
    window: &crate::RuntimeLiveWindowRecord,
    ownership_tab_by_id: &std::collections::HashMap<&str, &crate::model::BrowserRuntimeTabRecord>,
) -> crate::model::RuntimeWindowTabSnapshotRecord {
    crate::model::RuntimeWindowTabSnapshotRecord {
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        revision: window.revision,
        window_zoom_factor: window.window_zoom_factor.unwrap_or(1.0),
        presentation: window.placement.as_ref().map(|placement| placement.presentation.clone()),
        tabs: window.tabs.iter().map(|tab| crate::model::GameWindowTabRecord {
            id: tab.id.clone(),
            tab_type: tab.tab_type.clone(),
            source_id: tab.source_id.clone(),
            name: tab.title.clone(),
            role_slots: tab.role_slots.clone(),
            workspace_slots: tab.workspace_slots.clone(),
            hidden: window.hidden_tab_ids.contains(&tab.id),
            audio_muted: ownership_tab_by_id.get(tab.id.as_str())
                .map_or(tab.audio_muted, |ownership| ownership.audio_muted),
        }).collect(),
        active_tab_id: window.selected_tab_id.clone(),
    }
}

impl AppCore {
    pub fn commit_runtime_window_snapshots(
        &self,
        input: GameWindowRuntimeSnapshotBatchCommitInputRecord,
    ) -> CoreResult<RuntimeWindowPersistenceBatchReceiptRecord> {
        self.commit_runtime_window_snapshot_batch_inner(input.inputs)
    }

    fn commit_runtime_window_snapshot(
        &self,
        input: GameWindowRuntimeSnapshotCommitInputRecord,
    ) -> CoreResult<Value> {
        let receipt = self.commit_runtime_window_snapshot_batch_inner(vec![input])?;
        serde_json::to_value(
            receipt
                .receipts
                .into_iter()
                .next()
                .ok_or_else(|| CoreError::Internal("runtime window receipt is missing".to_owned()))?,
        )
        .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn commit_runtime_window_snapshot_batch(
        &self,
        input: GameWindowRuntimeSnapshotBatchCommitInputRecord,
    ) -> CoreResult<Value> {
        serde_json::to_value(self.commit_runtime_window_snapshot_batch_inner(input.inputs)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn commit_runtime_window_snapshot_batch_inner(
        &self,
        inputs: Vec<GameWindowRuntimeSnapshotCommitInputRecord>,
    ) -> CoreResult<RuntimeWindowPersistenceBatchReceiptRecord> {
        self.commit_runtime_window_snapshot_batch_with_revision_fence(inputs, true)
    }

    fn commit_authoritative_runtime_window_snapshot_batch_inner(
        &self,
        inputs: Vec<GameWindowRuntimeSnapshotCommitInputRecord>,
    ) -> CoreResult<RuntimeWindowPersistenceBatchReceiptRecord> {
        self.commit_runtime_window_snapshot_batch_with_revision_fence(inputs, false)
    }

    fn commit_runtime_window_snapshot_batch_with_revision_fence(
        &self,
        inputs: Vec<GameWindowRuntimeSnapshotCommitInputRecord>,
        enforce_revision_fence: bool,
    ) -> CoreResult<RuntimeWindowPersistenceBatchReceiptRecord> {
        if inputs.is_empty() {
            return Err(CoreError::InvalidInput(
                "runtime window snapshot batch cannot be empty".to_owned(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        if inputs
            .iter()
            .any(|input| !seen.insert(input.snapshot.window_id.clone()))
        {
            return Err(CoreError::InvalidInput(
                "runtime window snapshot batch contains a duplicate window".to_owned(),
            ));
        }
        let mut revisions = self
            .runtime_window_persistence_revisions
            .lock()
            .map_err(|_| {
                CoreError::Internal(
                    "runtime window persistence revision lock poisoned".to_owned(),
                )
            })?;
        let mut applied = Vec::new();
        let mut receipts = Vec::with_capacity(inputs.len());
        for input in inputs {
            let window_id = input.snapshot.window_id.clone();
            let window_generation = input.snapshot.window_generation;
            let revision = input.snapshot.revision;
            let superseded = enforce_revision_fence
                && revisions.get(&window_id).is_some_and(|(saved_generation, saved_revision)| {
                    *saved_generation > window_generation
                        || (*saved_generation == window_generation
                            && *saved_revision >= revision)
                });
            receipts.push(RuntimeWindowPersistenceReceiptRecord {
                window_id,
                window_generation,
                revision,
                status: if superseded { "superseded" } else { "applied" }.to_owned(),
            });
            if !superseded {
                applied.push(input);
            }
        }
        if !applied.is_empty() {
            self.mutate_state(StateMutation::GameWindowRuntimeSnapshotBatch {
                inputs: applied,
            })?;
            for receipt in receipts.iter().filter(|receipt| receipt.status == "applied") {
                revisions.insert(
                    receipt.window_id.clone(),
                    (receipt.window_generation, receipt.revision),
                );
            }
        }
        Ok(RuntimeWindowPersistenceBatchReceiptRecord { receipts })
    }

    fn delete_game_window(&self, id: String) -> CoreResult<Value> {
        self.mutate_state(StateMutation::GameWindowDelete { id })
    }

    fn save_game_window_configuration(
        &self,
        id: String,
        input: GameWindowUpdateInputRecord,
    ) -> CoreResult<Value> {
        self.mutate_state(StateMutation::GameWindowUpdate { id, input })
    }
}
