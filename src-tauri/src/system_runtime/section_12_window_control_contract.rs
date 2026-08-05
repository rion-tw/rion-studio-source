impl SystemRuntimeExecutor {
    pub fn hide_runtime_window(
        &self,
        window_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.request_runtime_window_control(
            window_id,
            Some(false),
            None,
            "hide-runtime-window",
        )
    }

    pub fn minimize_runtime_window(
        &self,
        window_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.request_runtime_window_control(
            window_id,
            None,
            Some(NativeWindowMode::Minimized),
            "minimize-runtime-window",
        )
    }

    pub fn toggle_runtime_window_maximized(
        &self,
        window_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.request_runtime_window_control(
            window_id,
            None,
            Some(NativeWindowMode::ToggleMaximized),
            "toggle-maximized-runtime-window",
        )
    }

    fn request_runtime_window_control(
        &self,
        window_id: &str,
        visibility: Option<bool>,
        mode: Option<NativeWindowMode>,
        trigger: &'static str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.require_runtime_accepting()
            .map_err(|error| error.message)?;
        let (revision, operation_id) = self
            .request_window_contract_presentation(
                window_id,
                visibility,
                NativePresentationFocus::None,
                mode,
                trigger,
            )
            .map_err(|error| error.message)?;
        self.wait_for_presentation_paint_barrier(window_id, revision);
        self.publish_projection();
        self.wait_native_operation_summary(&operation_id)
    }
}
