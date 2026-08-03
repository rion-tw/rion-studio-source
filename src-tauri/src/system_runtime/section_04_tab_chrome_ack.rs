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

    fn begin_tab_activation_acknowledgement(&self, operation_id: &str) {
        if let Ok(mut acknowledgements) = self.tab_activation_acknowledgements.lock() {
            acknowledgements.remove(operation_id);
        }
    }

    fn acknowledge_tab_activation(
        &self,
        acknowledgement: RuntimeTabActivationAcknowledgementRecord,
    ) {
        if let Ok(mut acknowledgements) = self.tab_activation_acknowledgements.lock() {
            let preserve_applied = acknowledgements
                .get(&acknowledgement.operation_id)
                .is_some_and(|current| current.status == "applied");
            if !preserve_applied {
                acknowledgements.insert(
                    acknowledgement.operation_id.clone(),
                    acknowledgement,
                );
            }
            self.tab_chrome_changed.notify_all();
        }
    }

    fn wait_for_tab_activation_acknowledgement(
        &self,
        operation_id: &str,
        timeout: Duration,
    ) -> Option<RuntimeTabActivationAcknowledgementRecord> {
        let deadline = Instant::now() + timeout;
        let mut acknowledgements = self.tab_activation_acknowledgements.lock().ok()?;
        loop {
            if let Some(acknowledgement) = acknowledgements.get(operation_id) {
                return Some(acknowledgement.clone());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next, wait) = self
                .tab_chrome_changed
                .wait_timeout(acknowledgements, remaining)
                .ok()?;
            acknowledgements = next;
            if wait.timed_out() && !acknowledgements.contains_key(operation_id) {
                return None;
            }
        }
    }
}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    fn eval_windows_tab_activation(
        tab_strip: &Webview,
        request: &RuntimeTabActivationRequestRecord,
    ) -> RuntimeResult<()> {
        let payload = serde_json::to_string(request).map_err(RuntimeError::tauri)?;
        tab_strip
            .eval(format!(
                "globalThis.__rionApplyRuntimeTabActivation?.({payload});"
            ))
            .map_err(RuntimeError::tauri)
    }

    fn dispatch_windows_tab_activation_chrome(
        &self,
        tab_strip: &Webview,
        request: RuntimeTabActivationRequestRecord,
    ) -> RuntimeResult<()> {
        self.presentation
            .begin_tab_activation_acknowledgement(&request.operation_id);
        Self::eval_windows_tab_activation(tab_strip, &request)?;

        let activations = Arc::clone(&self.tab_activations);
        let core = Arc::clone(&self.core);
        let operations = Arc::clone(&self.operations);
        let presentation = Arc::clone(&self.presentation);
        let retry_tab_strip = tab_strip.clone();
        let operation_id = request.operation_id.clone();
        let worker_operation_id = operation_id.clone();
        let worker = thread::Builder::new()
            .name(format!("rion-tab-activation-chrome-{operation_id}"))
            .spawn(move || {
                let acknowledged = presentation
                    .wait_for_tab_activation_acknowledgement(
                        &worker_operation_id,
                        WINDOWS_TAB_CHROME_ACK_TIMEOUT,
                    )
                    .is_some_and(|acknowledgement| {
                        acknowledgement.status == "applied"
                            && acknowledgement.revision == request.revision
                            && acknowledgement.target_tab_id == request.target_tab_id
                            && acknowledgement.observed_active_tab_id.as_deref()
                                == Some(request.target_tab_id.as_str())
                    });
                let applied = if acknowledged {
                    true
                } else {
                    presentation.begin_tab_activation_acknowledgement(&worker_operation_id);
                    let retry = RuntimeTabActivationRequestRecord {
                        mode: "reconcile".to_owned(),
                        ..request.clone()
                    };
                    Self::eval_windows_tab_activation(&retry_tab_strip, &retry).is_ok()
                        && presentation
                            .wait_for_tab_activation_acknowledgement(
                                &worker_operation_id,
                                WINDOWS_TAB_CHROME_ACK_TIMEOUT,
                            )
                            .is_some_and(|acknowledgement| {
                                acknowledgement.status == "applied"
                                    && acknowledgement.revision == retry.revision
                                    && acknowledgement.target_tab_id == retry.target_tab_id
                                    && acknowledgement.observed_active_tab_id.as_deref()
                                        == Some(retry.target_tab_id.as_str())
                            })
                };
                if let Some(receipt) = activations.record_chrome(
                    &worker_operation_id,
                    if applied {
                        TabActivationComponentStatus::Applied
                    } else {
                        TabActivationComponentStatus::Failed
                    },
                ) {
                    operations.complete(receipt);
                }
                let context = json!({
                    "operationId": worker_operation_id,
                    "platform": "windows",
                    "revision": request.revision,
                    "status": if applied { "applied" } else { "degraded" },
                    "tabId": request.target_tab_id,
                    "windowId": request.window_id,
                });
                tauri::async_runtime::spawn(async move {
                    let _ = core
                        .invoke_async(CoreCommand::LogsCapture {
                            entries: vec![LogCaptureRecord {
                                level: if applied { LogLevel::Debug } else { LogLevel::Warn },
                                source: LogSource::Browser,
                                event: if applied {
                                    "tab.activation-chrome-converged"
                                } else {
                                    "tab.activation-chrome-degraded"
                                }
                                .to_owned(),
                                message: if applied {
                                    "The Windows tab chrome converged with native presentation."
                                } else {
                                    "The Windows tab chrome did not confirm the authoritative active tab after reconciliation."
                                }
                                .to_owned(),
                                context_raw_json: serde_json::to_string(&context).ok(),
                                error: (!applied).then(|| LogErrorDetails {
                                    name: "TAB_ACTIVATION_CHROME_NOT_CONFIRMED".to_owned(),
                                    message: "The active Windows tab chrome could not be confirmed."
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
            self.finish_tab_activation_chrome(
                &operation_id,
                TabActivationComponentStatus::Indeterminate,
            );
            return Err(RuntimeError::new(
                "TAB_ACTIVATION_CHROME_WORKER_FAILED",
                format!("The Windows tab activation worker could not start: {error}"),
            ));
        }
        Ok(())
    }

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

    pub(crate) fn acknowledge_tab_activation_presentation(
        &self,
        webview_label: &str,
        acknowledgement: RuntimeTabActivationAcknowledgementRecord,
    ) -> Result<(), String> {
        let context = self
            .operations
            .context(&acknowledgement.operation_id)
            .ok_or_else(|| "The tab activation operation was not found.".to_owned())?;
        let window_id = self
            .tab_strip_window_for_webview(webview_label)
            .ok_or_else(|| "The tab activation acknowledgement is unauthorized.".to_owned())?;
        let valid = acknowledgement.revision > 0
            && matches!(
                acknowledgement.status.as_str(),
                "applied" | "superseded" | "failed"
            )
            && context.subsystem == NativeOperationSubsystem::TabActivation
            && context.revision == Some(acknowledgement.revision)
            && context.window_id.as_deref() == Some(window_id.as_str())
            && context.tab_id.as_deref() == Some(acknowledgement.target_tab_id.as_str());
        if !valid {
            return Err("The tab activation acknowledgement does not match its operation.".to_owned());
        }
        self.presentation
            .acknowledge_tab_activation(acknowledgement);
        Ok(())
    }
}
