impl SystemRuntimeExecutor {
    fn prepare_destroy_tab_presentation(
        &self,
        tab_id: &str,
        next_active_tab_id: Option<&str>,
    ) -> RuntimeResult<()> {
        let started = Instant::now();
        let setup = (|| -> RuntimeResult<_> {
            let (window_id, window, fallback_successor_tab_id) = {
                let state = self.state()?;
                let tab = state.tabs.get(tab_id).ok_or_else(|| {
                    RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
                })?;
                let window_id = tab.window_id.clone();
                let host = state.display_hosts.get(&window_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "Runtime display host was not found.",
                    )
                })?;
                let fallback_successor_tab_id = next_active_tab_id
                    .filter(|next_tab_id| *next_tab_id != tab_id)
                    .filter(|next_tab_id| {
                        state.tabs.get(*next_tab_id).is_some_and(|next_tab| {
                            next_tab.window_id == window_id
                                && !state.optimistic_closed_tabs.contains(*next_tab_id)
                        })
                    })
                    .map(str::to_owned);
                (window_id, host.window.clone(), fallback_successor_tab_id)
            };
            let presentation = self
                .presentation
                .coordinator(&window_id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            let plan = {
                let state = presentation.lock().map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The runtime tab presentation coordinator is unavailable.",
                    )
                })?;
                let fallback_successor_tab_id = fallback_successor_tab_id
                    .filter(|next_tab_id| state.contains_tab(next_tab_id));
                close_preflight_plan(
                    state.contains_tab(tab_id),
                    state.revision,
                    state.selected_tab_id.clone(),
                    fallback_successor_tab_id,
                )
            };
            match plan {
                ClosePreflightPlan::ReusePreview {
                    revision,
                    selected_tab_id,
                } => Ok((
                    window_id,
                    selected_tab_id,
                    revision,
                    "reuse-preview",
                    NativePresentationFocus::ContentOnly,
                )),
                ClosePreflightPlan::PresentSuccessor {
                    tab_id: successor_tab_id,
                } => {
                    let (requested_window_id, revision) = self
                        .request_tab_presentation(
                            &successor_tab_id,
                            NativePresentationFocus::ContentOnly,
                            "close-effect-preflight",
                        )
                        .map_err(|message| {
                            RuntimeError::new("TAURI_RUNTIME_VISIBILITY_FAILED", message)
                        })?;
                    Ok((
                        requested_window_id,
                        Some(successor_tab_id),
                        revision,
                        "fallback-successor",
                        NativePresentationFocus::ContentOnly,
                    ))
                }
                ClosePreflightPlan::HideWindow => {
                    let revision = self.presentation.next_revision();
                    let (previous_tab_id, previous_surfaces) = {
                        let mut state = presentation.lock().map_err(|_| {
                            RuntimeError::new(
                                "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                                "The runtime tab presentation coordinator is unavailable.",
                            )
                        })?;
                        let previous_tab_id = state.selected_tab_id.clone();
                        let previous_surfaces = state.surfaces(previous_tab_id.as_deref());
                        state.select(None, revision);
                        (previous_tab_id, previous_surfaces)
                    };
                    self.apply_native_active_style(
                        &window_id,
                        None,
                        revision,
                        "close-effect-preflight",
                    );
                    self.dispatch_native_presentation(
                        window_id.clone(),
                        None,
                        revision,
                        "close-effect-preflight",
                        Instant::now(),
                        window,
                        previous_tab_id,
                        previous_surfaces,
                        Vec::new(),
                        None,
                        Some(false),
                        NativePresentationFocus::None,
                    );
                    Ok((
                        window_id,
                        None,
                        revision,
                        "fallback-hide-window",
                        NativePresentationFocus::None,
                    ))
                }
            }
        })();
        let (window_id, waited_tab_id, revision, preflight_mode, focus) = match setup {
            Ok(setup) => setup,
            Err(error) => {
                self.record_close_preflight_event(
                    false,
                    "",
                    tab_id,
                    next_active_tab_id,
                    0,
                    "unresolved",
                    NativePresentationFocus::None,
                    started.elapsed(),
                    Some(&error),
                );
                return Err(error);
            }
        };
        // Native presentation is a latest-only queue. Waiting here serializes every close
        // behind the UI thread and turns a close burst into one second per tab. Teardown is
        // already fenced by exact surface identity, so queue the latest successor and let the
        // presentation actor coalesce stale revisions while cleanup continues.
        self.record_close_preflight_event(
            true,
            &window_id,
            tab_id,
            waited_tab_id.as_deref(),
            revision,
            preflight_mode,
            focus,
            started.elapsed(),
            None,
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn record_close_preflight_event(
        &self,
        applied: bool,
        window_id: &str,
        closing_tab_id: &str,
        waited_tab_id: Option<&str>,
        revision: u64,
        preflight_mode: &'static str,
        focus: NativePresentationFocus,
        elapsed: Duration,
        error: Option<&RuntimeError>,
    ) {
        let core = Arc::clone(&self.core);
        let context_raw_json = serde_json::to_string(&json!({
            "applied": applied,
            "closingTabId": closing_tab_id,
            "elapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
            "focusMode": focus.diagnostic_name(),
            "platform": current_runtime_platform(),
            "preflightMode": preflight_mode,
            "revision": revision,
            "waitedTabId": waited_tab_id,
            "windowId": window_id,
        }))
        .ok();
        let error = error.map(|error| log_error_details(error.code, &error.message));
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if applied {
                            LogLevel::Debug
                        } else {
                            LogLevel::Warn
                        },
                        source: LogSource::Browser,
                        event: if applied {
                            "tab.close-successor-preflight-scheduled".to_owned()
                        } else {
                            "tab.close-successor-preflight-failed".to_owned()
                        },
                        message: if applied {
                            "The close successor presentation was queued before native teardown."
                                .to_owned()
                        } else {
                            "The close successor could not be presented before native teardown."
                                .to_owned()
                        },
                        context_raw_json,
                        error,
                    }],
                })
                .await;
        });
    }
}
