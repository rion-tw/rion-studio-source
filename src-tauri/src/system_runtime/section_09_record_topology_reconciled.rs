impl SystemRuntimeExecutor {
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
                    .native_resources.display_hosts
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
                    .native_resources.display_hosts
                    .get(window_id)
                    .map(|host| host.tab_strip.clone())
            })
            .ok_or_else(|| "The WebView2 tab strip was not found.".to_owned())
            .and_then(|tab_strip| {
                let tab_id = serde_json::to_string(&tab_id).map_err(|error| error.to_string())?;
                self.dispatch_windows_tab_chrome_mutation(
                    &tab_strip,
                    format!("window.__rionSetActiveRuntimeTab?.({tab_id});"),
                    "set-active",
                )
                .map(|_| ())
                .map_err(|error| error.message)
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
                .native_resources.display_hosts
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
                .native_resources.display_hosts
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
                .native_resources.display_hosts
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
            self.dispatch_windows_tab_chrome_mutation(
                &tab_strip,
                format!("window.__rionReserveRuntimeTab?.({payload});"),
                "reserve",
            )
            .map(|_| ())
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
            .native_resources.display_hosts
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
                .native_resources.display_hosts
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
            self.dispatch_windows_tab_chrome_mutation(
                &tab_strip,
                format!("window.__rionEnsureRuntimeTab?.({payload});"),
                "ensure",
            )
            .map(|_| ())
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
                .native_resources.display_hosts
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
                .native_resources.display_hosts
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
            self.dispatch_windows_tab_chrome_mutation(
                &tab_strip,
                format!("window.__rionRemoveRuntimeTab?.({tab_id}, {active_tab_id});"),
                "remove",
            )
            .map(|_| ())
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
        target_ordered_tab_ids: &[String],
        revision: u64,
    ) -> RuntimeResult<()> {
        self.try_ensure_native_tab(target_window_id, tab_id, name, tab_type, workspace_template)?;
        // Native keyboard cycling follows the chrome controller's own tab array. A
        // cross-window drag can promote the preview at a different index than the
        // committed live topology, so make the authoritative order part of the same
        // retryable projection as the reservation transfer.
        self.reorder_native_tabs(target_window_id, target_ordered_tab_ids)?;
        // The target chrome represents the committed live topology. If source
        // removal fails, retain the target and retry removal forward; never
        // compensate by recreating the obsolete source topology.
        self.try_remove_native_tab_reservation(source_window_id, tab_id, source_active_tab_id)?;
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
                    .native_resources.display_hosts
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
                        .native_resources.display_hosts
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
            self.dispatch_windows_tab_chrome_mutation(
                &tab_strip,
                format!("window.__rionReorderRuntimeTabs?.({tab_ids});"),
                "reorder",
            )
            .map(|_| ())
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        result
    }

    fn reorder_native_tabs_for_projection(
        &self,
        window_id: &str,
        tab_ids: &[String],
        parent_operation_id: Option<&str>,
    ) -> RuntimeResult<()> {
        if self
            .tab_drag_intents
            .projection_is_superseded(parent_operation_id, window_id)
        {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .native_resources.display_hosts
                    .get(window_id)
                    .map(|host| host.tabs_controller.clone())
            })
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The AppKit tab controller was not found.",
                )
            })?
            .reorder_fenced(
                tab_ids,
                window_id,
                parent_operation_id,
                Arc::clone(&self.tab_drag_intents),
            )
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(not(target_os = "macos"))]
        let result = self.reorder_native_tabs(window_id, tab_ids);
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
        focus: NativePresentationFocus,
        window_mode: Option<NativeWindowMode>,
        launch_latency_trace: Option<RuntimeLaunchLatencyTrace>,
    ) -> String {
        let window_generation = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.native_resources.display_hosts.get(&window_id).map(|host| host.generation))
            .unwrap_or_default();
        let focus_origin = native_focus_intent_origin(trigger);
        let focus = self.focus_broker.admitted_focus(
            focus,
            &window_id,
            window_generation,
            focus_origin,
        );
        let expected_lifecycle_epoch = self.lifecycle_epoch();
        let mut operation = NativeOperationContext::new_at_for_platform(
            NativeOperationSubsystem::Presentation,
            trigger,
            PLATFORM_CALLBACK_TIMEOUT,
            current_runtime_platform(),
            requested_at,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
        .with_revision(revision)
        .with_window(window_id.clone())
        .with_window_generation(window_generation)
        .with_lifecycle_epoch(expected_lifecycle_epoch);
        if let Some(tab_id) = tab_id.as_ref() {
            operation = operation.with_tab(tab_id.clone());
        }
        let operation_id = operation.operation_id.clone();
        if let Err(code) = self.operations.register(operation.clone()) {
            self.operations.record_untracked(NativeOperationReceipt::with_status(
                operation,
                "nativeOperationRegistration",
                NativeOperationStatus::Failed,
                Some(code),
            ));
            return operation_id;
        }
        if let Err(message) = self
            .presentation
            .refresh_desired_native_projections(std::slice::from_ref(&window_id))
        {
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "desiredNativeProjection",
                NativeOperationStatus::Failed,
                Some("NATIVE_DESIRED_PROJECTION_UNAVAILABLE"),
            ));
            eprintln!("Desired native projection unavailable: {message}");
            return operation_id;
        }
        let Ok(presentation) = self.presentation.projection_coordinator(&window_id) else {
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
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "nativePresentationCoordinator",
                NativeOperationStatus::Failed,
                Some("NATIVE_PRESENTATION_COORDINATOR_UNAVAILABLE"),
            ));
            return operation_id;
        };
        let Ok(desired_projection) = self
            .presentation
            .desired_projection_coordinator(&window_id)
        else {
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "desiredNativeProjectionCoordinator",
                NativeOperationStatus::Failed,
                Some("NATIVE_DESIRED_PROJECTION_UNAVAILABLE"),
            ));
            return operation_id;
        };
        let focus_lease = (focus != NativePresentationFocus::None).then(|| {
            self.focus_broker.accept_with_origin(
                &window_id,
                window_generation,
                expected_lifecycle_epoch,
                tab_id.clone(),
                focus,
                focus_origin,
            )
        });
        #[cfg(windows)]
        let defer_window_focus_until_reveal = window_visibility == Some(true)
            && window_generation != 0
            && self.prepare_windows_tab_chrome_presentation(
                &window_id,
                window_generation,
                focus_lease.as_ref(),
            );
        #[cfg(not(windows))]
        let defer_window_focus_until_reveal = false;
        let next_surface_identities = presentation
            .lock()
            .ok()
            .map(|mut state| {
                state.host_visibility = native_presentation_host_visibility(
                    tab_id.as_deref(),
                    window_visibility,
                );
                state.surface_identities(tab_id.as_deref())
            })
            .unwrap_or_default();
        let surface_labels = previous_surfaces
            .iter()
            .chain(next_surfaces.iter())
            .map(|surface| surface.label().to_owned())
            .collect::<HashSet<_>>();
        let surface_owner_tokens = self.presentation.surface_owner_tokens(&surface_labels);
        let actor = match self.presentation.actor(&window_id, window_generation) {
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
                self.operations.complete(NativeOperationReceipt::with_status(
                    operation,
                    "nativePresentationActorStart",
                    NativeOperationStatus::Failed,
                    Some("NATIVE_PRESENTATION_ACTOR_UNAVAILABLE"),
                ));
                return operation_id;
            }
        };
        let dispatch_result = actor.dispatch(NativePresentationRequest {
            active_webview,
            actor_liveness: actor.liveness(),
            coordinator: presentation,
            core: Arc::clone(&self.core),
            desired_projection,
            defer_window_focus_until_reveal,
            focus,
            focus_broker: Arc::clone(&self.focus_broker),
            focus_lease,
            next_surface_identities,
            next_surfaces,
            native_window_mutations: Arc::clone(&self.native_window_mutations),
            observed_previous_tab_id: previous_tab_id,
            observed_previous_surfaces: previous_surfaces,
            operation,
            launch_latency_trace,
            operations: Arc::clone(&self.operations),
            requested_at,
            revision,
            expected_lifecycle_epoch,
            surface_owner_tokens,
            surface_owners: Arc::clone(&self.presentation.surface_owners),
            shutdown_state: Arc::clone(&self.shutdown_state),
            application_lifecycle: Arc::clone(&self.application_lifecycle),
            tab_id,
            trigger,
            window,
            window_generation,
            window_id,
            window_mode,
            window_visibility,
        });
        if let Err(message) = dispatch_result {
            eprintln!("Native window actor enqueue failed: {message}");
        }
        operation_id
    }

    fn wait_for_presentation_paint_barrier(&self, window_id: &str, revision: u64) {
        let started = Instant::now();
        let window_generation = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.native_resources.display_hosts.get(window_id).map(|host| host.generation))
            .unwrap_or_default();
        let applied = self
            .presentation
            .actor(window_id, window_generation)
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
                .native_resources.surface_registry
                .values()
                .find(|surface| surface.webview.label() == webview_label)
                .cloned()
        });
        if let Some(surface) = surface {
            self.record_surface_event(level, event, message, &surface);
        }
    }

    fn record_surface_isolation_request(
        &self,
        webview_label: &str,
        request: SurfaceIsolationRequest,
    ) {
        let surface = self.state.lock().ok().and_then(|state| {
            state
                .native_resources.surface_registry
                .values()
                .find(|surface| surface.webview.label() == webview_label)
                .cloned()
        });
        let Some(surface) = surface else {
            return;
        };
        let (event, message) = match request {
            SurfaceIsolationRequest::Started => (
                "surface.isolation-submitted",
                "The exact native surface isolation sequence was submitted once.",
            ),
            SurfaceIsolationRequest::Joined => (
                "surface.isolation-singleflight-joined",
                "The close path joined the existing native surface isolation sequence.",
            ),
            SurfaceIsolationRequest::AlreadyIsolated => (
                "surface.isolation-already-complete",
                "The close path observed an already isolated native surface.",
            ),
        };
        let core = Arc::clone(&self.core);
        let context = json!({
            "generation": surface.generation,
            "instanceId": surface.instance_id,
            "roleId": surface.role_id,
            "tabId": surface.tab_id,
            "webviewLabel": surface.webview.label(),
            "windowId": surface.window_id,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Debug,
                        source: LogSource::Browser,
                        event: event.to_owned(),
                        message: message.to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

}
