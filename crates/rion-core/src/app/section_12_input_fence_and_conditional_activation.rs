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

}
