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
            let superseded = revisions.get(&window_id).is_some_and(
                |(saved_generation, saved_revision)| {
                    *saved_generation > window_generation
                        || (*saved_generation == window_generation && *saved_revision >= revision)
                },
            );
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
