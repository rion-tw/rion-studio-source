impl SystemRuntimeExecutor {
    fn record_topology_reconciled(
        &self,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        revision: u64,
    ) {
        let core = Arc::clone(&self.core);
        let context = json!({
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "revision": revision,
            "sourceWindowId": source_window_id,
            "tabId": tab_id,
            "targetWindowId": target_window_id,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Debug,
                        source: LogSource::Browser,
                        event: "tab.topology-reconciled".to_owned(),
                        message:
                            "Runtime tab presentation ownership moved to the authoritative window."
                                .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn apply_native_active_style(
        &self,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
    ) {
        #[cfg(target_os = "macos")]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| host.tabs_controller.clone())
            })
            .ok_or_else(|| "The AppKit tab controller was not found.".to_owned())
            .and_then(|controller| controller.set_active(tab_id));
        #[cfg(windows)]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| host.tab_strip.clone())
            })
            .ok_or_else(|| "The WebView2 tab strip was not found.".to_owned())
            .and_then(|tab_strip| {
                let tab_id = serde_json::to_string(&tab_id).map_err(|error| error.to_string())?;
                tab_strip
                    .eval(format!("window.__rionSetActiveRuntimeTab?.({tab_id});"))
                    .map_err(|error| error.to_string())
            });
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: Result<(), String> = Ok(());

        if result.is_err() {
            self.record_presentation_event(
                LogLevel::Warn,
                "native.active-style-failed",
                "Native active tab style could not be applied optimistically.",
                window_id,
                tab_id,
                revision,
                trigger,
                0,
            );
        }
    }

    fn remember_native_active_style(&self, window_id: &str, tab_id: Option<&str>) {
        #[cfg(target_os = "macos")]
        if let Some(controller) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
        }) {
            controller.remember_active(tab_id);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window_id, tab_id);
    }

    fn reserve_native_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
        revision: u64,
    ) -> RuntimeResult<()> {
        let started = Instant::now();
        let result =
            self.try_reserve_native_tab(window_id, tab_id, name, tab_type, workspace_template);
        self.record_presentation_event(
            if result.is_ok() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            "tab.surface-reserved",
            if result.is_ok() {
                "The provisional native tab was reserved."
            } else {
                "The provisional native tab could not be reserved."
            },
            window_id,
            Some(tab_id),
            revision,
            "launch",
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        result
    }

    fn try_reserve_native_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
    ) -> RuntimeResult<()> {
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = workspace_template;
        #[cfg(target_os = "macos")]
        let controller = {
            self.state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The AppKit tab controller was not found.",
                    )
                })?
        };
        #[cfg(target_os = "macos")]
        let result = controller
            .reserve(window_id, tab_id, name, tab_type, workspace_template)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let tab_strip = {
            self.state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The WebView2 tab strip was not found.",
                    )
                })?
        };
        #[cfg(windows)]
        let result = {
            let payload = serde_json::to_string(&json!({
                "id": tab_id,
                "name": name,
                "type": tab_type,
                "workspaceTemplate": workspace_template,
            }))
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", error.to_string())
            })?;
            tab_strip
                .eval(format!("window.__rionReserveRuntimeTab?.({payload});"))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        result
    }

    fn try_ensure_native_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
    ) -> RuntimeResult<()> {
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = workspace_template;
        #[cfg(target_os = "macos")]
        let result = self
            .state()?
            .display_hosts
            .get(window_id)
            .map(|host| host.tabs_controller.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The AppKit tab controller was not found.",
                )
            })?
            .ensure(window_id, tab_id, name, tab_type, workspace_template)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let result = {
            let tab_strip = self
                .state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The WebView2 tab strip was not found.",
                    )
                })?;
            let payload = serde_json::to_string(&json!({
                "id": tab_id,
                "name": name,
                "type": tab_type,
                "workspaceTemplate": workspace_template,
            }))
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", error.to_string())
            })?;
            tab_strip
                .eval(format!("window.__rionEnsureRuntimeTab?.({payload});"))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        result
    }

    fn remove_native_tab_reservation(
        &self,
        window_id: &str,
        tab_id: &str,
        active_tab_id: Option<&str>,
    ) {
        let _ = self.try_remove_native_tab_reservation(window_id, tab_id, active_tab_id);
    }

    fn try_remove_native_tab_reservation(
        &self,
        window_id: &str,
        tab_id: &str,
        active_tab_id: Option<&str>,
    ) -> RuntimeResult<()> {
        #[cfg(target_os = "macos")]
        let target = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
        });
        #[cfg(target_os = "macos")]
        let result = target
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The AppKit tab controller was not found.",
                )
            })?
            .remove(tab_id, active_tab_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let target = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
        });
        #[cfg(windows)]
        let result = {
            let tab_strip = target.ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The WebView2 tab strip was not found.",
                )
            })?;
            let tab_id = serde_json::to_string(tab_id).unwrap_or_else(|_| "null".to_owned());
            let active_tab_id =
                serde_json::to_string(&active_tab_id).unwrap_or_else(|_| "null".to_owned());
            tab_strip
                .eval(format!(
                    "window.__rionRemoveRuntimeTab?.({tab_id}, {active_tab_id});"
                ))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn relocate_native_tab_reservation(
        &self,
        source_window_id: &str,
        target_window_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
        source_active_tab_id: Option<&str>,
        target_rollback_active_tab_id: Option<&str>,
        revision: u64,
    ) -> RuntimeResult<()> {
        self.try_ensure_native_tab(target_window_id, tab_id, name, tab_type, workspace_template)?;
        if let Err(error) =
            self.try_remove_native_tab_reservation(source_window_id, tab_id, source_active_tab_id)
        {
            let rollback = self.try_remove_native_tab_reservation(
                target_window_id,
                tab_id,
                target_rollback_active_tab_id,
            );
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(RuntimeError::new(
                    "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED",
                    format!(
                        "Moving native tab {tab_id} failed: {} Compensation also failed: {}. Restart Rion Studio to recover safely.",
                        error.message, rollback_error.message
                    ),
                )),
            };
        }
        self.record_presentation_event(
            LogLevel::Debug,
            "tab.chrome-relocated",
            "Native tab chrome moved to the authoritative runtime window.",
            target_window_id,
            Some(tab_id),
            revision,
            "topology-reconciled",
            0,
        );
        Ok(())
    }

    fn reorder_native_tabs(&self, window_id: &str, tab_ids: &[String]) -> RuntimeResult<()> {
        #[cfg(target_os = "macos")]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| host.tabs_controller.clone())
            })
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The AppKit tab controller was not found.",
                )
            })?
            .reorder(tab_ids)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let result = {
            let tab_strip = self
                .state
                .lock()
                .ok()
                .and_then(|state| {
                    state
                        .display_hosts
                        .get(window_id)
                        .map(|host| host.tab_strip.clone())
                })
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The WebView2 tab strip was not found.",
                    )
                })?;
            let tab_ids = serde_json::to_string(tab_ids)
                .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            tab_strip
                .eval(format!("window.__rionReorderRuntimeTabs?.({tab_ids});"))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn replace_native_tab_reservation(
        &self,
        window_id: &str,
        provisional_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
        active_tab_id: Option<&str>,
        revision: u64,
    ) -> RuntimeResult<()> {
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = workspace_template;
        #[cfg(target_os = "macos")]
        let result = self
            .state()?
            .display_hosts
            .get(window_id)
            .map(|host| host.tabs_controller.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The AppKit tab controller was not found.",
                )
            })?
            .replace_reservation(
                provisional_id,
                tab_id,
                name,
                tab_type,
                workspace_template,
                active_tab_id,
            )
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let result = {
            let tab_strip = self
                .state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The WebView2 tab strip was not found.",
                    )
                })?;
            let provisional_id = serde_json::to_string(provisional_id)
                .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            let active_tab_id = serde_json::to_string(&active_tab_id)
                .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            let payload = serde_json::to_string(&json!({
                "id": tab_id,
                "name": name,
                "type": tab_type,
                "workspaceTemplate": workspace_template,
            }))
            .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            tab_strip
                .eval(format!(
                    "window.__rionRemoveRuntimeTab?.({provisional_id}, null); window.__rionReserveRuntimeTab?.({payload}); window.__rionSetActiveRuntimeTab?.({active_tab_id});"
                ))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        self.record_presentation_event(
            if result.is_ok() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            "tab.surface-reservation-reconciled",
            if result.is_ok() {
                "The provisional native tab was reconciled in one native transaction."
            } else {
                "The provisional native tab could not be reconciled."
            },
            window_id,
            Some(tab_id),
            revision,
            "launch",
            0,
        );
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_native_presentation(
        &self,
        window_id: String,
        tab_id: Option<String>,
        revision: u64,
        trigger: &'static str,
        requested_at: Instant,
        window: Window,
        previous_tab_id: Option<String>,
        previous_surfaces: Vec<Webview>,
        next_surfaces: Vec<Webview>,
        active_webview: Option<Webview>,
        window_visibility: Option<bool>,
        focus: bool,
    ) {
        let Ok(presentation) = self.presentation.coordinator(&window_id) else {
            self.record_presentation_event(
                LogLevel::Warn,
                "native.presentation-completed",
                "Native tab presentation could not resolve its window coordinator.",
                &window_id,
                tab_id.as_deref(),
                revision,
                trigger,
                0,
            );
            return;
        };
        let next_surface_identities = presentation
            .lock()
            .ok()
            .map(|state| state.surface_identities(tab_id.as_deref()))
            .unwrap_or_default();
        let surface_labels = previous_surfaces
            .iter()
            .chain(next_surfaces.iter())
            .map(|surface| surface.label().to_owned())
            .collect::<HashSet<_>>();
        let surface_owner_revisions = self.presentation.surface_owner_revisions(&surface_labels);
        let actor = match self.presentation.actor(&window_id) {
            Ok(actor) => actor,
            Err(message) => {
                self.record_presentation_event(
                    LogLevel::Warn,
                    "native.presentation-completed",
                    "Native tab presentation could not start its window actor.",
                    &window_id,
                    tab_id.as_deref(),
                    revision,
                    trigger,
                    requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                );
                eprintln!("Native window actor unavailable: {message}");
                return;
            }
        };
        let dispatch_result = actor.dispatch(NativePresentationRequest {
            active_webview,
            coordinator: presentation,
            core: Arc::clone(&self.core),
            focus,
            next_surface_identities,
            next_surfaces,
            observed_previous_tab_id: previous_tab_id,
            observed_previous_surfaces: previous_surfaces,
            requested_at,
            revision,
            surface_owner_revisions,
            surface_owners: Arc::clone(&self.presentation.surface_owners),
            tab_id,
            trigger,
            window,
            window_id,
            window_visibility,
        });
        if let Err(message) = dispatch_result {
            eprintln!("Native window actor enqueue failed: {message}");
        }
    }

    fn wait_for_presentation_paint_barrier(&self, window_id: &str, revision: u64) {
        let started = Instant::now();
        let applied = self
            .presentation
            .actor(window_id)
            .ok()
            .is_some_and(|actor| {
                actor.wait_until_applied(revision, PRESENTATION_PAINT_BARRIER_TIMEOUT)
            });
        // Queue one additional no-op after the P0 AppKit/UI-dispatcher mutation.
        // Controller creation may proceed after this turn even if platform paint
        // instrumentation is unavailable; launch can never wait indefinitely.
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let scheduled = self
            .app
            .run_on_main_thread(move || {
                let _ = sender.send(());
            })
            .is_ok();
        let yielded = scheduled
            && receiver
                .recv_timeout(PRESENTATION_PAINT_BARRIER_TIMEOUT)
                .is_ok();
        self.record_presentation_event(
            LogLevel::Debug,
            "native.presentation-paint-barrier",
            "Native presentation yielded a UI turn before controller creation.",
            window_id,
            None,
            revision,
            "launch",
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        if !applied || !yielded {
            eprintln!(
                "Native presentation paint barrier used bounded fail-open (window={window_id}, revision={revision}, applied={applied}, yielded={yielded})."
            );
        }
    }

    fn record_tab_close_presentation(
        &self,
        tab_id: &str,
        next_tab_id: Option<&str>,
        revision: u64,
        elapsed: Duration,
    ) {
        let core = Arc::clone(&self.core);
        let context = json!({
            "nextTabId": next_tab_id,
            "nextTabVisibleMs": elapsed.as_millis(),
            "presentationRevision": revision,
            "tabId": tab_id,
            "uiHiddenMs": elapsed.as_millis(),
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Debug,
                        source: LogSource::Browser,
                        event: "surface.presentation-closed".to_owned(),
                        message: "Runtime tab presentation closed immediately.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn record_surface_stage_by_label(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        webview_label: &str,
    ) {
        let surface = self.state.lock().ok().and_then(|state| {
            state
                .surface_registry
                .values()
                .find(|surface| surface.webview.label() == webview_label)
                .cloned()
        });
        if let Some(surface) = surface {
            self.record_surface_event(level, event, message, &surface);
        }
    }

}
