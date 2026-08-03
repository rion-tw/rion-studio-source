impl SystemRuntimeExecutor {
    fn apply_tab_activation_chrome(
        &self,
        activation: &NativeOperationContext,
        _ordered_tab_ids: Vec<String>,
    ) {
        let operation_id = activation.operation_id.clone();
        #[cfg(target_os = "macos")]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                activation.window_id.as_ref().and_then(|window_id| {
                    state
                        .display_hosts
                        .get(window_id)
                        .map(|host| host.tabs_controller.clone())
                })
            })
            .ok_or_else(|| "The AppKit tab controller was not found.".to_owned())
            .and_then(|controller| controller.set_active(activation.tab_id.as_deref()));
        #[cfg(windows)]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                activation.window_id.as_ref().and_then(|window_id| {
                    state
                        .display_hosts
                        .get(window_id)
                        .map(|host| host.tab_strip.clone())
                })
            })
            .ok_or_else(|| "The WebView2 tab strip was not found.".to_owned())
            .and_then(|tab_strip| {
                self.dispatch_windows_tab_activation_chrome(
                    &tab_strip,
                    RuntimeTabActivationRequestRecord {
                        operation_id: activation.operation_id.clone(),
                        revision: activation.revision.unwrap_or_default(),
                        window_id: activation.window_id.clone().unwrap_or_default(),
                        window_generation: activation.window_generation.unwrap_or_default(),
                        lifecycle_epoch: activation.lifecycle_epoch.unwrap_or_default(),
                        target_tab_id: activation.tab_id.clone().unwrap_or_default(),
                        ordered_tab_ids: _ordered_tab_ids,
                        mode: "optimistic".to_owned(),
                    },
                )
                .map_err(|error| error.message)
            });
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: Result<(), String> = Ok(());

        #[cfg(not(windows))]
        self.finish_tab_activation_chrome(
            &operation_id,
            if result.is_ok() {
                TabActivationComponentStatus::Applied
            } else {
                TabActivationComponentStatus::Failed
            },
        );
        #[cfg(windows)]
        if result.is_err() {
            self.finish_tab_activation_chrome(
                &operation_id,
                TabActivationComponentStatus::Failed,
            );
        }
        if let Err(message) = result {
            eprintln!("Tab activation chrome submission failed: {message}");
            self.record_presentation_event(
                LogLevel::Warn,
                "tab.activation-chrome-submit-failed",
                "The native tab chrome could not accept the activation revision.",
                activation.window_id.as_deref().unwrap_or_default(),
                activation.tab_id.as_deref(),
                activation.revision.unwrap_or_default(),
                activation.trigger,
                0,
            );
        }
    }
}
