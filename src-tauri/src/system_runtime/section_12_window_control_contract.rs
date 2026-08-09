fn live_window_activation_available(
    live_tab_count: Option<usize>,
    empty_host_available: bool,
) -> bool {
    live_tab_count.is_some_and(|tab_count| tab_count > 0 || empty_host_available)
}

impl SystemRuntimeExecutor {
    pub(crate) fn focus_live_runtime_window(&self, window_id: &str) -> Result<(), String> {
        match self.activate_live_runtime_window(window_id, "quick-menu-live-window") {
            Ok(true) => Ok(()),
            Ok(false) => Err(
                "Live runtime window state was not found or contains no tabs.".to_owned(),
            ),
            Err(error) if error == "Runtime display host was not found." => {
                self.queue_live_runtime_window_activation(window_id, "quick-menu-live-window")
            }
            Err(error) => Err(error),
        }
    }

    fn queue_live_runtime_window_activation(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> Result<(), String> {
        let window_generation = self
            .presentation
            .existing(window_id)
            .and_then(|live| {
                (!live.tabs.is_empty() && live.window_generation > 0)
                    .then_some(live.window_generation)
            })
            .ok_or_else(|| "Live runtime window state was not found or contains no tabs.".to_owned())?;
        *self
            .pending_window_activation
            .lock()
            .map_err(|_| "Runtime window activation intent is unavailable.".to_owned())? =
            Some(PendingWindowActivation {
                trigger,
                window_generation,
                window_id: window_id.to_owned(),
            });
        self.complete_pending_window_activation(window_id, window_generation);
        Ok(())
    }

    fn complete_pending_window_activation(&self, window_id: &str, window_generation: u64) {
        let intent = self.pending_window_activation.lock().ok().and_then(|mut pending| {
            let current = pending.as_ref()?;
            if current.window_id != window_id {
                return None;
            }
            let intent = pending.take()?;
            (intent.window_generation == window_generation).then_some(intent)
        });
        let Some(intent) = intent else {
            return;
        };
        if let Err(error) = self.activate_live_runtime_window(&intent.window_id, intent.trigger) {
            eprintln!(
                "Generation-fenced runtime window activation failed: window={} generation={} error={error}",
                intent.window_id, intent.window_generation
            );
        }
    }

    fn cancel_pending_window_activation(&self, window_id: &str) {
        if let Ok(mut pending) = self.pending_window_activation.lock()
            && pending
                .as_ref()
                .is_some_and(|intent| intent.window_id == window_id)
        {
            *pending = None;
        }
    }

    pub(crate) fn activate_live_runtime_window(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> Result<bool, String> {
        let live_tab_count = self
            .presentation
            .existing(window_id)
            .map(|live| live.all_tab_ids().len());
        let window = {
            let mut state = self.state().map_err(|error| error.message)?;
            let empty_host_available = state.native_resources.display_hosts.contains_key(window_id)
                && !state.retiring_window_revisions.contains_key(window_id)
                && !state.quarantined_window_hosts.contains(window_id);
            if !live_window_activation_available(live_tab_count, empty_host_available) {
                return Ok(false);
            }
            state.tab_drag_cursor_leases.remove(window_id);
            state
                .native_resources.display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
        };
        set_tab_drag_window_interaction(&window, false)?;
        self.request_window_contract_presentation(
            window_id,
            Some(true),
            NativePresentationFocus::WindowAndContent,
            None,
            trigger,
        )
        .map(|_| true)
        .map_err(|error| error.message)
    }

    pub(crate) fn reveal_live_runtime_window(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> Result<bool, String> {
        let started = Instant::now();
        let live_tab_count = self
            .presentation
            .existing(window_id)
            .map(|live| live.all_tab_ids().len());
        if !live_window_activation_available(live_tab_count, false) {
            return Ok(false);
        }
        self.request_window_contract_presentation(
            window_id,
            Some(true),
            NativePresentationFocus::None,
            None,
            trigger,
        )
        .map_err(|error| error.message)?;
        self.record_runtime_stage(
            format!("window.first-visible:{window_id}"),
            "completed",
            started,
        );
        Ok(true)
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
