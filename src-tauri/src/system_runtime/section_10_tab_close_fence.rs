impl SystemRuntimeExecutor {
    fn runtime_tab_close_projection_fenced(&self, tab_id: &str) -> RuntimeResult<bool> {
        Ok(self.state()?.optimistic_closed_tabs.contains(tab_id))
    }
}
