impl AppCore {
    pub fn macro_input_diagnostics(&self) -> CoreResult<MacroInputDiagnosticsRecord> {
        self.macro_runtime.input_diagnostics()
    }

    pub fn role_ownership_transfer_active(&self, role_id: &str) -> CoreResult<bool> {
        self.macro_runtime.role_ownership_transfer_active(role_id)
    }

    fn release_macro_role(&self, role_id: String) -> CoreResult<Value> {
        self.macro_runtime.release_role(&role_id)?;
        Ok(json!({ "released": true }))
    }

    fn macro_input_fence(&self, role_id: String) -> CoreResult<Value> {
        serde_json::to_value(self.fence_macro_input(&role_id)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn macro_input_drain(&self, role_id: String, input_epoch: u64) -> CoreResult<Value> {
        serde_json::to_value(self.drain_macro_input(&role_id, input_epoch)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn macro_input_resume(&self, role_id: String, input_epoch: u64) -> CoreResult<Value> {
        serde_json::to_value(self.resume_macro_input(&role_id, input_epoch)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    pub fn fence_macro_input(&self, role_id: &str) -> CoreResult<MacroInputEpochRecord> {
        let input_epoch = self.macro_runtime.fence_role_input(role_id)?;
        Ok(MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current: true,
        })
    }

    pub fn terminalize_macro_runs_after_navigation_failure(
        &self,
        role_id: &str,
    ) -> CoreResult<()> {
        self.macro_runtime
            .terminalize_role_after_navigation_failure(role_id)
    }

    pub fn drain_macro_input(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<MacroInputEpochRecord> {
        let current = self.macro_runtime.drain_role_input(role_id, input_epoch)?;
        Ok(MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current,
        })
    }

    pub fn resume_macro_input(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<MacroInputEpochRecord> {
        let current = self.macro_runtime.resume_role_input(role_id, input_epoch)?;
        Ok(MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current,
        })
    }

}
