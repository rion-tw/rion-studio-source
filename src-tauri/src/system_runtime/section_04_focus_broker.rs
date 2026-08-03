#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeFocusLease {
    lifecycle_epoch: u64,
    mode: NativePresentationFocus,
    sequence: u64,
    tab_id: Option<String>,
    window_generation: u64,
    window_id: String,
}

#[derive(Default)]
struct NativeFocusBrokerState {
    confirmed: Option<NativeFocusLease>,
    current: Option<NativeFocusLease>,
}

#[derive(Default)]
struct NativeFocusBroker {
    current_sequence: AtomicU64,
    mutation_lane: Mutex<()>,
    next_sequence: AtomicU64,
    state: Mutex<NativeFocusBrokerState>,
}

impl NativeFocusBroker {
    fn accept(
        &self,
        window_id: impl Into<String>,
        window_generation: u64,
        lifecycle_epoch: u64,
        tab_id: Option<String>,
        mode: NativePresentationFocus,
    ) -> NativeFocusLease {
        let state = self.state.lock();
        let sequence = self
            .next_sequence
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        let lease = NativeFocusLease {
            lifecycle_epoch,
            mode,
            sequence,
            tab_id,
            window_generation,
            window_id: window_id.into(),
        };
        if let Ok(mut state) = state {
            state.current = Some(lease.clone());
            self.current_sequence.store(sequence, Ordering::Release);
        } else {
            self.current_sequence.store(0, Ordering::Release);
        }
        lease
    }

    fn begin_mutation(
        &self,
        lease: &NativeFocusLease,
    ) -> Result<Option<std::sync::MutexGuard<'_, ()>>, &'static str> {
        let guard = self
            .mutation_lane
            .lock()
            .map_err(|_| "SYSTEM_RUNTIME_FOCUS_BROKER_UNAVAILABLE")?;
        Ok(self.is_current(lease).then_some(guard))
    }

    fn is_current(&self, lease: &NativeFocusLease) -> bool {
        lease.sequence != 0
            && self.current_sequence.load(Ordering::Acquire) == lease.sequence
            && self.state.lock().ok().is_some_and(|state| {
                state.current.as_ref() == Some(lease)
            })
    }

    fn confirm(&self, lease: &NativeFocusLease) -> bool {
        if self.current_sequence.load(Ordering::Acquire) != lease.sequence {
            return false;
        }
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.current.as_ref() != Some(lease) {
            return false;
        }
        state.confirmed = Some(lease.clone());
        true
    }

    fn observe_native_focus(
        &self,
        window_id: &str,
        window_generation: u64,
        lifecycle_epoch: u64,
        tab_id: Option<String>,
    ) -> NativeFocusLease {
        if let Some(current) = self.state.lock().ok().and_then(|state| {
            state
                .current
                .as_ref()
                .filter(|lease| {
                    lease.window_id == window_id
                        && lease.window_generation == window_generation
                        && lease.lifecycle_epoch == lifecycle_epoch
                })
                .cloned()
        }) && self.confirm(&current)
        {
            return current;
        }
        let observed = self.accept(
            window_id,
            window_generation,
            lifecycle_epoch,
            tab_id,
            NativePresentationFocus::WindowAndContent,
        );
        let _ = self.confirm(&observed);
        observed
    }

    fn observe_native_blur(&self, window_id: &str, window_generation: u64) {
        if let Ok(mut state) = self.state.lock()
            && state.confirmed.as_ref().is_some_and(|lease| {
                lease.window_id == window_id && lease.window_generation == window_generation
            })
        {
            state.confirmed = None;
        }
    }

    fn revoke_window(&self, window_id: &str, window_generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.current.as_ref().is_some_and(|lease| {
                lease.window_id == window_id && lease.window_generation == window_generation
            }) {
                state.current = None;
                self.current_sequence.store(0, Ordering::Release);
            }
            if state.confirmed.as_ref().is_some_and(|lease| {
                lease.window_id == window_id && lease.window_generation == window_generation
            }) {
                state.confirmed = None;
            }
        }
    }

    fn revoke_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.current = None;
            state.confirmed = None;
            self.current_sequence.store(0, Ordering::Release);
        } else {
            self.current_sequence.store(0, Ordering::Release);
        }
    }

    #[cfg(test)]
    fn snapshot(&self) -> (Option<NativeFocusLease>, Option<NativeFocusLease>) {
        self.state
            .lock()
            .map(|state| (state.current.clone(), state.confirmed.clone()))
            .unwrap_or_default()
    }
}

impl SystemRuntimeExecutor {
    fn runtime_focus_identity(
        &self,
        window_id: &str,
    ) -> RuntimeResult<(u64, Option<String>)> {
        let window_generation = self
            .state()?
            .display_hosts
            .get(window_id)
            .map(|host| host.generation)
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
        let selected_tab_id = self
            .presentation
            .existing(window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .and_then(|state| state.selected_tab_id.clone())
            });
        Ok((window_generation, selected_tab_id))
    }

    fn complete_direct_focus(
        &self,
        operation: NativeOperationContext,
        stage: &'static str,
        status: NativeOperationStatus,
        failure_code: Option<&str>,
    ) {
        self.operations.complete(NativeOperationReceipt::with_status(
            operation,
            stage,
            status,
            failure_code,
        ));
    }

    fn focus_runtime_window_direct(
        &self,
        window_id: &str,
        window: &Window,
        trigger: &'static str,
    ) -> RuntimeResult<NativeOperationStatus> {
        self.require_runtime_accepting()?;
        let (window_generation, tab_id) = self.runtime_focus_identity(window_id)?;
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Focus,
            trigger,
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
        .with_window(window_id)
        .with_window_generation(window_generation)
        .with_lifecycle_epoch(self.lifecycle_epoch());
        if let Some(tab_id) = tab_id.as_ref() {
            operation = operation.with_tab(tab_id);
        }
        self.operations.register(operation.clone()).map_err(|code| {
            RuntimeError::new(code, "The native focus operation could not be accepted.")
        })?;
        let _ = self.operations.mark_in_flight(&operation.operation_id);
        let lease = self.focus_broker.accept(
            window_id,
            window_generation,
            self.lifecycle_epoch(),
            tab_id,
            NativePresentationFocus::WindowAndContent,
        );
        let guard = self.focus_broker.begin_mutation(&lease).map_err(|code| {
            self.complete_direct_focus(
                operation.clone(),
                "nativeFocusBrokerUnavailable",
                NativeOperationStatus::Failed,
                Some(code),
            );
            RuntimeError::new(code, "The native focus broker is unavailable.")
        })?;
        let Some(_guard) = guard else {
            self.complete_direct_focus(
                operation,
                "nativeFocusSuperseded",
                NativeOperationStatus::Superseded,
                None,
            );
            return Ok(NativeOperationStatus::Superseded);
        };
        if let Err(error) = window.set_focus() {
            self.complete_direct_focus(
                operation,
                "nativeWindowFocusFailed",
                NativeOperationStatus::Failed,
                Some("NATIVE_WINDOW_FOCUS_FAILED"),
            );
            return Err(RuntimeError::new(
                "NATIVE_WINDOW_FOCUS_FAILED",
                error.to_string(),
            ));
        }
        let status = if self.focus_broker.confirm(&lease) {
            NativeOperationStatus::Applied
        } else {
            NativeOperationStatus::Superseded
        };
        self.complete_direct_focus(operation, "nativeWindowFocused", status, None);
        Ok(status)
    }

    pub(crate) fn focus_selected_overlay_webview(
        &self,
        webview: &Webview,
        role_id: &str,
    ) -> RuntimeResult<()> {
        self.require_runtime_accepting()?;
        let (window_id, window_generation, tab_id) = {
            let state = self.state()?;
            if let Some(tab_id) = state.role_tabs.get(role_id)
                && let Some(tab) = state.tabs.get(tab_id)
                && tab.roles.get(role_id).is_some_and(|surface| {
                    surface.webview.label() == webview.label()
                })
            {
                let generation = state
                    .display_hosts
                    .get(&tab.window_id)
                    .map(|host| host.generation)
                    .unwrap_or_default();
                (tab.window_id.clone(), generation, Some(tab_id.clone()))
            } else if state.popup_roles.get(webview.label()).map(String::as_str) == Some(role_id) {
                (format!("popup:{}", webview.label()), 0, None)
            } else {
                return Err(RuntimeError::new(
                    "OVERLAY_WEBVIEW_FOCUS_STATE_FAILED",
                    "The overlay WebView is no longer owned by the selected role.",
                ));
            }
        };
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Focus,
            "overlay-pointer",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
        .with_role(role_id)
        .with_window(&window_id)
        .with_window_generation(window_generation)
        .with_lifecycle_epoch(self.lifecycle_epoch());
        if let Some(tab_id) = tab_id.as_ref() {
            operation = operation.with_tab(tab_id);
        }
        self.operations.register(operation.clone()).map_err(|code| {
            RuntimeError::new(code, "The overlay focus operation could not be accepted.")
        })?;
        let _ = self.operations.mark_in_flight(&operation.operation_id);
        let lease = self.focus_broker.accept(
            &window_id,
            window_generation,
            self.lifecycle_epoch(),
            tab_id,
            NativePresentationFocus::ContentOnly,
        );
        let guard = self.focus_broker.begin_mutation(&lease).map_err(|code| {
            self.complete_direct_focus(
                operation.clone(),
                "nativeFocusBrokerUnavailable",
                NativeOperationStatus::Failed,
                Some(code),
            );
            RuntimeError::new(code, "The native focus broker is unavailable.")
        })?;
        let Some(_guard) = guard else {
            self.complete_direct_focus(
                operation,
                "nativeFocusSuperseded",
                NativeOperationStatus::Superseded,
                None,
            );
            return Ok(());
        };
        if let Err(error) = webview.set_focus() {
            self.complete_direct_focus(
                operation,
                "nativeContentFocusFailed",
                NativeOperationStatus::Failed,
                Some("NATIVE_CONTENT_FOCUS_FAILED"),
            );
            return Err(RuntimeError::new(
                "NATIVE_CONTENT_FOCUS_FAILED",
                error.to_string(),
            ));
        }
        let status = if self.focus_broker.confirm(&lease) {
            NativeOperationStatus::Applied
        } else {
            NativeOperationStatus::Superseded
        };
        self.complete_direct_focus(operation, "nativeContentFocused", status, None);
        Ok(())
    }
}
