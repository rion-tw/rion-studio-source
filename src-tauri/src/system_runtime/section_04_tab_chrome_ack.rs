#[cfg(windows)]
impl PresentationRegistry {
    fn begin_tab_chrome_acknowledgement(
        &self,
        webview_label: &str,
        window_generation: u64,
    ) -> Result<(), &'static str> {
        let mut acknowledgements = self
            .tab_chrome_acknowledgements
            .lock()
            .map_err(|_| "WINDOWS_TAB_CHROME_ACK_COORDINATOR_UNAVAILABLE")?;
        let acknowledgement = acknowledgements
            .entry(webview_label.to_owned())
            .or_default();
        if acknowledgement.window_generation != window_generation {
            *acknowledgement = WindowsTabChromeAcknowledgementState {
                window_generation,
                ..Default::default()
            };
        }
        if acknowledgement.retired {
            return Err("WINDOWS_TAB_CHROME_HOST_RETIRED");
        }
        Ok(())
    }

    fn acknowledge_tab_chrome(
        &self,
        webview_label: &str,
        window_generation: u64,
        revision: u64,
    ) -> bool {
        if let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() {
            let Some(acknowledgement) = acknowledgements.get_mut(webview_label) else {
                return false;
            };
            if acknowledgement.window_generation != window_generation
                || acknowledgement.retired
            {
                return false;
            }
            acknowledgement.applied_revision =
                acknowledgement.applied_revision.max(revision);
            drop(acknowledgements);
            self.tab_chrome_changed.notify_all();
            return true;
        }
        false
    }

    fn retire_tab_chrome_acknowledgements(
        &self,
        webview_label: &str,
        window_generation: u64,
    ) {
        if let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() {
            let acknowledgement = acknowledgements
                .entry(webview_label.to_owned())
                .or_default();
            if acknowledgement.window_generation == 0
                || acknowledgement.window_generation == window_generation
            {
                acknowledgement.window_generation = window_generation;
                acknowledgement.retired = true;
                drop(acknowledgements);
                self.tab_chrome_changed.notify_all();
            }
        }
    }

    fn wait_for_tab_chrome_acknowledgement(
        &self,
        webview_label: &str,
        window_generation: u64,
        revision: u64,
        timeout: Duration,
    ) -> WindowsTabChromeAcknowledgementWaitOutcome {
        let deadline = Instant::now() + timeout;
        let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() else {
            return WindowsTabChromeAcknowledgementWaitOutcome::Timeout;
        };
        loop {
            let Some(acknowledgement) = acknowledgements.get(webview_label).copied() else {
                return WindowsTabChromeAcknowledgementWaitOutcome::Superseded;
            };
            if acknowledgement.window_generation != window_generation
                || acknowledgement.retired
            {
                return WindowsTabChromeAcknowledgementWaitOutcome::Superseded;
            }
            if acknowledgement.applied_revision >= revision {
                return WindowsTabChromeAcknowledgementWaitOutcome::Applied;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return WindowsTabChromeAcknowledgementWaitOutcome::Timeout;
            }
            let Ok((next, wait)) = self
                .tab_chrome_changed
                .wait_timeout(acknowledgements, remaining)
            else {
                return WindowsTabChromeAcknowledgementWaitOutcome::Timeout;
            };
            acknowledgements = next;
            if wait.timed_out() {
                return WindowsTabChromeAcknowledgementWaitOutcome::Timeout;
            }
        }
    }

}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    fn dispatch_windows_tab_chrome_mutation(
        &self,
        tab_strip: &Webview,
        mutation: String,
        operation: &'static str,
    ) -> RuntimeResult<u64> {
        let revision = WINDOWS_TAB_CHROME_REVISION.fetch_add(1, Ordering::AcqRel);
        let (window_id, window_generation) = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .native_resources
                    .display_hosts
                    .iter()
                    .find_map(|(window_id, host)| {
                        (host.tab_strip.label() == tab_strip.label())
                            .then(|| (window_id.clone(), host.generation))
                    })
            })
            .ok_or_else(|| {
                RuntimeError::new(
                    "WINDOWS_TAB_CHROME_HOST_RETIRED",
                    "The Windows tab chrome host generation is no longer live.",
                )
            })?;
        self.presentation
            .begin_tab_chrome_acknowledgement(tab_strip.label(), window_generation)
            .map_err(|code| {
                RuntimeError::new(
                    code,
                    "The Windows tab chrome host generation is no longer authoritative.",
                )
            })?;
        tab_strip
            .eval(format!(
                "globalThis.__rionApplyRuntimeTabChromeMutation?.({revision}, () => {{ {mutation} }});"
            ))
            .map_err(RuntimeError::tauri)?;

        let native_operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            operation,
            WINDOWS_TAB_CHROME_ACK_TIMEOUT,
            "windows",
        )
        .with_revision(revision)
        .with_window(&window_id)
        .with_window_generation(window_generation);
        let app = self.app.clone();
        let presentation = Arc::clone(&self.presentation);
        let core = Arc::clone(&self.core);
        let webview_label = tab_strip.label().to_owned();
        let worker_operation = native_operation.clone();
        let worker = std::thread::Builder::new()
            .name(format!("rion-tab-chrome-ack-{revision}"))
            .spawn(move || {
                let outcome = presentation.wait_for_tab_chrome_acknowledgement(
                    &webview_label,
                    window_generation,
                    revision,
                    WINDOWS_TAB_CHROME_ACK_TIMEOUT,
                );
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state.runtime.record_native_operation_receipt(match outcome {
                        WindowsTabChromeAcknowledgementWaitOutcome::Applied => {
                            NativeOperationReceipt::applied(
                            worker_operation,
                            "windowsTabChromeAcknowledged",
                            )
                        }
                        WindowsTabChromeAcknowledgementWaitOutcome::Superseded => {
                            NativeOperationReceipt::with_status(
                                worker_operation,
                                "windowsTabChromeHostRetired",
                                NativeOperationStatus::Superseded,
                                Some("WINDOWS_TAB_CHROME_HOST_RETIRED"),
                            )
                        }
                        WindowsTabChromeAcknowledgementWaitOutcome::Timeout => {
                            NativeOperationReceipt::with_status(
                            worker_operation,
                            "windowsTabChromeAcknowledgementFailed",
                            NativeOperationStatus::Failed,
                            Some("WINDOWS_TAB_CHROME_ACK_TIMEOUT"),
                            )
                        }
                    });
                }
                let applied = outcome == WindowsTabChromeAcknowledgementWaitOutcome::Applied;
                let superseded =
                    outcome == WindowsTabChromeAcknowledgementWaitOutcome::Superseded;
                let context = json!({
                    "operation": operation,
                    "platform": "windows",
                    "revision": revision,
                    "status": if applied { "applied" } else if superseded { "superseded" } else { "failed" },
                    "webviewLabel": webview_label,
                });
                tauri::async_runtime::spawn(async move {
                    let _ = core
                        .invoke_async(CoreCommand::LogsCapture {
                            entries: vec![LogCaptureRecord {
                                level: if applied || superseded { LogLevel::Debug } else { LogLevel::Warn },
                                source: LogSource::Browser,
                                event: if applied {
                                    "native.tab-chrome-completed"
                                } else if superseded {
                                    "native.tab-chrome-superseded"
                                } else {
                                    "native.tab-chrome-failed"
                                }
                                .to_owned(),
                                message: if applied {
                                    "The Windows tab chrome acknowledged the native presentation revision."
                                } else if superseded {
                                    "The retired Windows tab chrome host superseded its pending native presentation revision."
                                } else {
                                    "The Windows tab chrome did not acknowledge the native presentation revision before its deadline."
                                }
                                .to_owned(),
                                context_raw_json: serde_json::to_string(&context).ok(),
                                error: (!applied && !superseded).then(|| LogErrorDetails {
                                    name: "WINDOWS_TAB_CHROME_ACK_TIMEOUT".to_owned(),
                                    message: "The Windows tab chrome acknowledgement timed out."
                                        .to_owned(),
                                    stack: None,
                                    cause: None,
                                }),
                            }],
                        })
                        .await;
                });
            });
        if let Err(error) = worker {
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                native_operation,
                "windowsTabChromeAcknowledgementUnavailable",
                NativeOperationStatus::Indeterminate,
                Some("WINDOWS_TAB_CHROME_ACK_WORKER_FAILED"),
            ));
            return Err(RuntimeError::new(
                "WINDOWS_TAB_CHROME_ACK_WORKER_FAILED",
                format!("Windows tab chrome acknowledgement worker could not start: {error}"),
            ));
        }
        Ok(revision)
    }

    pub(crate) fn acknowledge_tab_chrome_presentation(
        &self,
        webview_label: &str,
        revision: u64,
    ) -> Result<(), String> {
        let window_generation = self.state.lock().ok().and_then(|state| {
            state
                .native_resources.display_hosts
                .values()
                .find_map(|host| {
                    (host.tab_strip.label() == webview_label).then_some(host.generation)
                })
        });
        let Some(window_generation) = window_generation else {
            return Err("The Windows tab chrome acknowledgement is invalid.".to_owned());
        };
        if revision == 0 {
            return Err("The Windows tab chrome acknowledgement is invalid.".to_owned());
        }
        self.presentation
            .acknowledge_tab_chrome(webview_label, window_generation, revision)
            .then_some(())
            .ok_or_else(|| "The Windows tab chrome acknowledgement is stale.".to_owned())
    }

}
