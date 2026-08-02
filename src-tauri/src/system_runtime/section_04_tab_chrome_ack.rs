#[cfg(windows)]
impl PresentationRegistry {
    fn acknowledge_tab_chrome(&self, webview_label: &str, revision: u64) {
        if let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() {
            let applied = acknowledgements.entry(webview_label.to_owned()).or_default();
            *applied = (*applied).max(revision);
            self.tab_chrome_changed.notify_all();
        }
    }

    fn wait_for_tab_chrome_acknowledgement(
        &self,
        webview_label: &str,
        revision: u64,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut acknowledgements) = self.tab_chrome_acknowledgements.lock() else {
            return false;
        };
        while acknowledgements.get(webview_label).copied().unwrap_or_default() < revision {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next, wait)) = self
                .tab_chrome_changed
                .wait_timeout(acknowledgements, remaining)
            else {
                return false;
            };
            acknowledgements = next;
            if wait.timed_out()
                && acknowledgements.get(webview_label).copied().unwrap_or_default() < revision
            {
                return false;
            }
        }
        true
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
        tab_strip
            .eval(format!(
                "globalThis.__rionApplyRuntimeTabChromeMutation?.({revision}, () => {{ {mutation} }});"
            ))
            .map_err(RuntimeError::tauri)?;

        let mut native_operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            operation,
            WINDOWS_TAB_CHROME_ACK_TIMEOUT,
            "windows",
        )
        .with_revision(revision);
        if let Some(window_id) = self.tab_strip_window_for_webview(tab_strip.label()) {
            native_operation = native_operation.with_window(window_id);
        }
        let app = self.app.clone();
        let presentation = Arc::clone(&self.presentation);
        let core = Arc::clone(&self.core);
        let webview_label = tab_strip.label().to_owned();
        let worker_operation = native_operation.clone();
        let worker = std::thread::Builder::new()
            .name(format!("rion-tab-chrome-ack-{revision}"))
            .spawn(move || {
                let applied = presentation.wait_for_tab_chrome_acknowledgement(
                    &webview_label,
                    revision,
                    WINDOWS_TAB_CHROME_ACK_TIMEOUT,
                );
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state.runtime.record_native_operation_receipt(if applied {
                        NativeOperationReceipt::applied(
                            worker_operation,
                            "windowsTabChromeAcknowledged",
                        )
                    } else {
                        NativeOperationReceipt::with_status(
                            worker_operation,
                            "windowsTabChromeAcknowledgementFailed",
                            NativeOperationStatus::Failed,
                            Some("WINDOWS_TAB_CHROME_ACK_TIMEOUT"),
                        )
                    });
                }
                let context = json!({
                    "operation": operation,
                    "platform": "windows",
                    "revision": revision,
                    "status": if applied { "applied" } else { "failed" },
                    "webviewLabel": webview_label,
                });
                tauri::async_runtime::spawn(async move {
                    let _ = core
                        .invoke_async(CoreCommand::LogsCapture {
                            entries: vec![LogCaptureRecord {
                                level: if applied { LogLevel::Debug } else { LogLevel::Warn },
                                source: LogSource::Browser,
                                event: if applied {
                                    "native.tab-chrome-completed"
                                } else {
                                    "native.tab-chrome-failed"
                                }
                                .to_owned(),
                                message: if applied {
                                    "The Windows tab chrome acknowledged the native presentation revision."
                                } else {
                                    "The Windows tab chrome did not acknowledge the native presentation revision before its deadline."
                                }
                                .to_owned(),
                                context_raw_json: serde_json::to_string(&context).ok(),
                                error: (!applied).then(|| LogErrorDetails {
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
        if revision == 0 || self.tab_strip_window_for_webview(webview_label).is_none() {
            return Err("The Windows tab chrome acknowledgement is invalid.".to_owned());
        }
        self.presentation
            .acknowledge_tab_chrome(webview_label, revision);
        Ok(())
    }
}
