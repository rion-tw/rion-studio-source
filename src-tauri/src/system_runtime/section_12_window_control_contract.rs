impl SystemRuntimeExecutor {
    pub(crate) fn focus_live_runtime_window(&self, window_id: &str) -> Result<(), String> {
        if self.live_window_tab_ids(window_id)?.is_empty() {
            return Ok(());
        }
        let window = {
            let mut state = self.state().map_err(|error| error.message)?;
            state.tab_drag_cursor_leases.remove(window_id);
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
        };
        set_tab_drag_window_interaction(&window, false, true)?;
        self.request_window_contract_presentation(
            window_id,
            Some(true),
            NativePresentationFocus::WindowAndContent,
            None,
            "quick-menu-live-window",
        )
        .map(|_| ())
        .map_err(|error| error.message)
    }

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
