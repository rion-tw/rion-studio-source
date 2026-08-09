impl SystemRuntimeExecutor {
    fn runtime_tab_close_projection_fenced(&self, tab_id: &str) -> RuntimeResult<bool> {
        self.presentation
            .live
            .kernel
            .snapshot()
            .map(|snapshot| snapshot.tombstones.contains_key(tab_id))
            .map_err(|error| RuntimeError::new("RUNTIME_KERNEL_UNAVAILABLE", error.to_string()))
    }
}
