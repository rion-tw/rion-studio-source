impl SystemRuntimeExecutor {
    pub fn handle_divider_pointer(
        &self,
        webview_label: &str,
        payload: DividerPointerPayload,
    ) -> Result<(), String> {
        if !matches!(payload.phase.as_str(), "start" | "move" | "end" | "reset") {
            return Err("divider pointer phase is invalid".to_owned());
        }
        let context = {
            let mut state = self.state().map_err(|error| error.message)?;
            let Some((tab_id, tab)) = state.native_resources.tabs.iter_mut().find(|(_, tab)| {
                tab.dividers
                    .iter()
                    .any(|divider| divider.webview.label() == webview_label)
            }) else {
                return Err("divider bridge is not authorized for this WebView".to_owned());
            };
            let divider = tab
                .dividers
                .iter()
                .find(|divider| divider.webview.label() == webview_label)
                .ok_or_else(|| "runtime divider was not found".to_owned())?;
            let window_id = self
                .presentation
                .tab_window(tab_id)?
                .ok_or_else(|| "Runtime divider tab is no longer live.".to_owned())?;
            if payload.phase == "end" {
                let active = tab.active_divider_resize.take();
                let role_ids = active.map(|value| value.role_ids).unwrap_or_default();
                let tab_id = tab_id.clone();
                drop(state);
                self.send_divider_indicators(&role_ids, "hide");
                self.persist_runtime_tab_role_views(&tab_id)?;
                return Ok(());
            }
            let previous = tab
                .active_divider_resize
                .as_ref()
                .filter(|active| active.divider_index == divider.index)
                .map(|active| active.snapped_position);
            let tab_context = (
                tab_id.clone(),
                divider.index,
                divider.descriptor.clone(),
                tab.dividers
                    .iter()
                    .map(|divider| divider.descriptor.clone())
                    .collect::<Vec<_>>(),
                tab.slots
                    .values()
                    .map(runtime_role_slot_input)
                    .collect::<Vec<_>>(),
                window_id,
                previous,
                tab.active_divider_resize.clone(),
            );
            let host = state.native_resources.display_hosts.get(&tab_context.5).ok_or_else(|| {
                "runtime display host was not found for divider WebView".to_owned()
            })?;
            #[cfg(windows)]
            let toolbar_revealed = host.toolbar_revealed;
            #[cfg(not(windows))]
            let toolbar_revealed = false;
            (
                tab_context.0,
                tab_context.1,
                tab_context.2,
                tab_context.3,
                tab_context.4,
                tab_context.5,
                host.window.clone(),
                tab_context.6,
                tab_context.7,
                toolbar_revealed,
            )
        };
        let (
            tab_id,
            divider_index,
            divider,
            dividers,
            roles,
            window_id,
            window,
            previous,
            previous_active_resize,
            _toolbar_revealed,
        ) = context;
        let requested_position = if payload.phase == "reset" {
            divider.default_position
        } else {
            let event_screen_position =
                payload
                    .screen_position
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| "divider screen position is invalid".to_owned())?;
            let scale = window.scale_factor().map_err(|error| error.to_string())?;
            let position = window.inner_position().map_err(|error| error.to_string())?;
            #[cfg(windows)]
            let metrics = runtime_window_content_metrics_with_tab_strip(
                &window,
                self.windows_tab_strip_height(&window, _toolbar_revealed),
            )
            .map_err(|error| error.message)?;
            #[cfg(not(windows))]
            let metrics = runtime_window_content_metrics(&window).map_err(|error| error.message)?;
            let screen_position = if cfg!(windows) {
                let cursor = self
                    .app
                    .cursor_position()
                    .map_err(|error| error.to_string())?;
                if divider.axis == "vertical" {
                    cursor.x / scale
                } else {
                    cursor.y / scale
                }
            } else {
                event_screen_position
            };
            if divider.axis == "vertical" {
                (screen_position - position.x as f64 / scale) / metrics.width.max(1.0)
            } else {
                (screen_position - position.y as f64 / scale - metrics.top_inset)
                    / metrics.height.max(1.0)
            }
        };
        let result = rion_core::resize_workspace_divider(&WorkspaceDividerResizeInput {
            roles: roles.clone(),
            dividers,
            divider_index,
            requested_position,
            previous_position: (payload.phase == "move").then_some(previous).flatten(),
        })
        .ok_or_else(|| "Runtime divider layout could not be resolved.".to_owned())?;
        let live = self
            .presentation
            .existing(&window_id)
            .ok_or_else(|| "Runtime divider topology is unavailable.".to_owned())?;
        let previous_role_slots = live
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.role_slots.clone())
            .ok_or_else(|| "Runtime divider tab topology is unavailable.".to_owned())?;
        let mut desired_role_slots = previous_role_slots.clone();
        for role in &result.roles {
            let Some(slot) = desired_role_slots
                .iter_mut()
                .find(|slot| slot.role_id == role.role_id)
            else {
                return Err(format!(
                    "Runtime divider role {} has no authoritative slot.",
                    role.role_id
                ));
            };
            slot.rect = StateNormalizedRectRecord {
                x: role.rect.x,
                y: role.rect.y,
                width: role.rect.width,
                height: role.rect.height,
            };
        }
        let desired = self.presentation.live.commit_tab_role_slots(
            live.revision,
            &tab_id,
            &window_id,
            desired_role_slots,
        )?;
        if desired.status == LiveTopologyCommitStatus::Superseded {
            return Err("Runtime divider update was superseded before native projection."
                .to_owned());
        }
        let projection_state_commit = (|| -> Result<(), String> {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state
                .native_resources.tabs
                .get_mut(&tab_id)
                .ok_or_else(|| "runtime tab was closed during divider resize".to_owned())?;
            for role in &result.roles {
                if let Some(slot) = tab
                    .slots
                    .values_mut()
                    .find(|slot| slot.role.id == role.role_id)
                {
                    slot.rect = StateNormalizedRectRecord {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    };
                }
                if let Some(surface) = tab.roles.get_mut(&role.role_id) {
                    surface.rect = StateNormalizedRectRecord {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    };
                }
            }
            if payload.phase == "start" {
                tab.active_divider_resize = Some(ActiveDividerResize {
                    divider_index,
                    role_ids: result.role_ids.clone(),
                    snapped_position: result.position,
                });
            } else if payload.phase == "move"
                && let Some(active) = tab.active_divider_resize.as_mut()
            {
                active.role_ids = result.role_ids.clone();
                active.snapped_position = result.position;
            } else if payload.phase == "reset" {
                tab.active_divider_resize = None;
            }
            Ok(())
        })();
        if let Err(error) = projection_state_commit {
            let compensation = self.presentation.live.commit_tab_role_slots(
                desired.revision,
                &tab_id,
                &window_id,
                previous_role_slots,
            );
            if compensation.is_err()
                || compensation
                    .is_ok_and(|receipt| receipt.status == LiveTopologyCommitStatus::Superseded)
            {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{error} Kernel divider compensation was superseded; restart Rion Studio to recover safely."
                ));
            }
            return Err(error);
        }
        if result.changed
            && let Err(error) = self.layout_runtime_tab(&tab_id)
        {
                let state_rolled_back = self.state.lock().is_ok_and(|mut state| {
                    let Some(tab) = state.native_resources.tabs.get_mut(&tab_id) else {
                        return false;
                    };
                    let mut restored_roles = 0;
                    for role in &roles {
                        if let Some(slot) = tab
                            .slots
                            .values_mut()
                            .find(|slot| slot.role.id == role.role_id)
                        {
                            slot.rect = StateNormalizedRectRecord {
                                x: role.rect.x,
                                y: role.rect.y,
                                width: role.rect.width,
                                height: role.rect.height,
                            };
                            restored_roles += 1;
                        }
                        if let Some(surface) = tab.roles.get_mut(&role.role_id) {
                            surface.rect = StateNormalizedRectRecord {
                                x: role.rect.x,
                                y: role.rect.y,
                                width: role.rect.width,
                                height: role.rect.height,
                            };
                        }
                    }
                    tab.active_divider_resize = previous_active_resize;
                    restored_roles == roles.len()
                });
                if !state_rolled_back {
                    self.health.mark_unhealthy();
                    return Err(format!(
                        "{} Runtime layout state compensation failed; restart Rion Studio to recover safely.",
                        error.message
                    ));
                }
                let compensation = self.presentation.live.commit_tab_role_slots(
                    desired.revision,
                    &tab_id,
                    &window_id,
                    previous_role_slots,
                );
                if compensation.is_err()
                    || compensation.is_ok_and(|receipt| {
                        receipt.status == LiveTopologyCommitStatus::Superseded
                    })
                {
                    self.health.mark_unhealthy();
                    return Err(format!(
                        "{} Native divider layout rolled back but Kernel compensation was superseded; restart Rion Studio to recover safely.",
                        error.message
                    ));
                }
                return Err(error.message);
        }
        let indicator_type = if payload.phase == "start" {
            "show"
        } else {
            "update"
        };
        self.send_divider_indicators(&result.role_ids, indicator_type);
        if payload.phase == "reset" {
            self.send_divider_indicators(&result.role_ids, "hide");
            self.persist_runtime_tab_role_views(&tab_id)?;
        }
        Ok(())
    }

    fn persist_runtime_tab_role_views(&self, tab_id: &str) -> Result<(), String> {
        let window_id = self
            .presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer live while saving its layout.".to_owned())?;
        if self.presentation.tab(&window_id, tab_id).is_none() {
            return Err("Runtime tab layout is no longer authoritative.".to_owned());
        }
        self.schedule_live_window_state_persistence(&window_id);
        Ok(())
    }

    fn send_divider_indicators(&self, role_ids: &[String], indicator_type: &str) {
        let surfaces = self.state.lock().ok().map(|state| {
            role_ids
                .iter()
                .filter_map(|role_id| {
                    let tab_id = state.native_tab_id_for_role_surface(role_id)?;
                    let role = state.native_resources.tabs.get(tab_id)?.roles.get(role_id)?;
                    Some((role.webview.clone(), role.rect.clone()))
                })
                .collect::<Vec<_>>()
        });
        for (webview, rect) in surfaces.unwrap_or_default() {
            let payload = if indicator_type == "hide" {
                json!({ "type": "hide" })
            } else {
                json!({
                    "type": indicator_type,
                    "label": format!("{} × {}", format_ratio(rect.width), format_ratio(rect.height))
                })
            };
            let _ = webview.eval(format!(
                "globalThis.__rionStudioWorkspaceResizeIndicator?.({payload});"
            ));
        }
    }

    pub fn toggle_focused_runtime_fullscreen(
        &self,
    ) -> Result<Option<SystemRuntimeOperationSummaryRecord>, String> {
        let window_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .native_resources.display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.window_id.clone())
        };
        let Some(window_id) = window_id else {
            return Ok(None);
        };
        self.toggle_runtime_window_fullscreen(&window_id).map(Some)
    }

    pub fn toggle_runtime_window_fullscreen(
        &self,
        window_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.require_runtime_accepting()
            .map_err(|error| error.message)?;
        #[cfg(target_os = "macos")]
        {
            let window = self
                .window_for_id(window_id)
                .ok_or_else(|| "Runtime window was not found.".to_owned())?;
            let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
            self.prepare_runtime_window_fullscreen(window.label(), !fullscreen);
        }
        let (revision, operation_id) = self
            .request_window_contract_presentation(
                window_id,
                None,
                NativePresentationFocus::None,
                Some(NativeWindowMode::ToggleFullscreen),
                "toggle-fullscreen",
            )
            .map_err(|error| error.message)?;
        self.wait_for_presentation_paint_barrier(window_id, revision);
        self.wait_native_operation_summary(&operation_id)
    }

    fn collect_browser_performance_diagnostics(
        &self,
        sample_duration: Duration,
        operation_id: &str,
        cancellation: &PerformanceDiagnosticCancellation,
    ) -> Result<BrowserPerformanceDiagnosticsRecord, String> {
        let bounded_duration = bounded_performance_diagnostic_duration(sample_duration);
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Performance,
            "browserPerformanceDiagnostics",
            bounded_duration + Duration::from_secs(5),
        );
        let result = self.collect_browser_performance_diagnostics_inner(
            bounded_duration,
            operation_id,
            cancellation,
        );
        if let Ok(record) = result.as_ref()
            && let Some(window_id) = record.window_id.as_ref()
        {
            operation.window_id = Some(window_id.clone());
        }
        let receipt = match result.as_ref() {
            Ok(record) if record.surfaces.iter().any(|surface| surface.error.is_some()) => {
                NativeOperationReceipt::with_status(
                    operation,
                    "performanceProbePartial",
                    NativeOperationStatus::Degraded,
                    Some("PERFORMANCE_DIAGNOSTIC_PARTIAL"),
                )
            }
            Ok(_) => NativeOperationReceipt::applied(operation, "performanceProbeCompleted"),
            Err(error) if error.code == "PERFORMANCE_DIAGNOSTIC_CANCELLED" => {
                NativeOperationReceipt::with_status(
                    operation,
                    "performanceProbeCancelled",
                    NativeOperationStatus::Cancelled,
                    Some(error.code),
                )
            }
            Err(error) => NativeOperationReceipt::with_status(
                operation,
                "performanceProbeFailed",
                NativeOperationStatus::Failed,
                Some(error.code),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result.map_err(|error| error.message)
    }

    pub fn begin_browser_performance_diagnostics(
        &self,
    ) -> Result<BrowserPerformanceDiagnosticOperationRecord, String> {
        let sequence = self
            .performance_diagnostic_sequence
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        let operation_id = format!("performance-diagnostic-{sequence}");
        let (superseded, accepted) = {
            let mut owner = self
                .performance_diagnostic_operation
                .lock()
                .map_err(|_| "Performance diagnostic operation owner is unavailable.".to_owned())?;
            let superseded = owner.as_mut().and_then(|current| {
                transition_performance_diagnostic_phase(
                    current,
                    &[
                        BrowserPerformanceDiagnosticOperationPhase::WaitingForFocus,
                        BrowserPerformanceDiagnosticOperationPhase::Sampling,
                    ],
                    BrowserPerformanceDiagnosticOperationPhase::Cancelled,
                )
                .then(|| {
                    current.cancellation.cancel();
                    (
                        current.operation_id.clone(),
                        performance_diagnostic_operation_record(current, None, None),
                    )
                })
            });
            let state = PerformanceDiagnosticOperationState {
                cancellation: Arc::new(PerformanceDiagnosticCancellation::default()),
                operation_id,
                phase: BrowserPerformanceDiagnosticOperationPhase::WaitingForFocus,
                revision: sequence,
            };
            let accepted = performance_diagnostic_operation_record(&state, None, None);
            *owner = Some(state);
            (superseded, accepted)
        };
        if let Some((operation_id, record)) = superseded {
            self.publish_performance_diagnostic_operation(&record);
            self.clear_performance_diagnostic_probe(&operation_id);
        }
        self.publish_performance_diagnostic_operation(&accepted);
        Ok(accepted)
    }

    pub fn cancel_browser_performance_diagnostics(
        &self,
        operation_id: &str,
    ) -> Result<(), String> {
        let record = {
            let mut owner = self
                .performance_diagnostic_operation
                .lock()
                .map_err(|_| "Performance diagnostic operation owner is unavailable.".to_owned())?;
            let current = owner
                .as_mut()
                .filter(|current| current.operation_id == operation_id)
                .ok_or_else(|| "Performance diagnostic operation was not found.".to_owned())?;
            if !transition_performance_diagnostic_phase(
                current,
                &[
                    BrowserPerformanceDiagnosticOperationPhase::WaitingForFocus,
                    BrowserPerformanceDiagnosticOperationPhase::Sampling,
                ],
                BrowserPerformanceDiagnosticOperationPhase::Cancelled,
            ) {
                return Ok(());
            }
            current.cancellation.cancel();
            performance_diagnostic_operation_record(current, None, None)
        };
        self.publish_performance_diagnostic_operation(&record);
        self.clear_performance_diagnostic_probe(operation_id);
        Ok(())
    }

    pub fn begin_performance_diagnostic_for_focused_window(&self) {
        let (operation_id, cancellation, sampling) = {
            let Ok(mut owner) = self.performance_diagnostic_operation.lock() else {
                return;
            };
            let Some(current) = owner.as_mut() else {
                return;
            };
            if !transition_performance_diagnostic_phase(
                current,
                &[BrowserPerformanceDiagnosticOperationPhase::WaitingForFocus],
                BrowserPerformanceDiagnosticOperationPhase::Sampling,
            ) {
                return;
            }
            (
                current.operation_id.clone(),
                Arc::clone(&current.cancellation),
                performance_diagnostic_operation_record(current, None, None),
            )
        };
        self.publish_performance_diagnostic_operation(&sampling);
        let Some(runtime) = self.self_weak.get().cloned() else {
            self.finish_performance_diagnostic_operation(
                &operation_id,
                Err("Performance diagnostic runtime ownership is unavailable.".to_owned()),
            );
            return;
        };
        let worker_operation_id = operation_id.clone();
        if thread::Builder::new()
            .name("rion-performance-diagnostic".to_owned())
            .spawn(move || {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let result = runtime.collect_browser_performance_diagnostics(
                    performance_diagnostic_sample_duration(),
                    &worker_operation_id,
                    &cancellation,
                );
                runtime.finish_performance_diagnostic_operation(&worker_operation_id, result);
            })
            .is_err()
        {
            self.finish_performance_diagnostic_operation(
                &operation_id,
                Err("Performance diagnostic worker could not be started.".to_owned()),
            );
        }
    }

    fn finish_performance_diagnostic_operation(
        &self,
        operation_id: &str,
        result: Result<BrowserPerformanceDiagnosticsRecord, String>,
    ) {
        let terminal = {
            let Ok(mut owner) = self.performance_diagnostic_operation.lock() else {
                return;
            };
            let Some(current) = owner
                .as_mut()
                .filter(|current| current.operation_id == operation_id)
            else {
                return;
            };
            let terminal_phase = if result.is_ok() {
                BrowserPerformanceDiagnosticOperationPhase::Completed
            } else {
                BrowserPerformanceDiagnosticOperationPhase::Failed
            };
            if !transition_performance_diagnostic_phase(
                current,
                &[BrowserPerformanceDiagnosticOperationPhase::Sampling],
                terminal_phase,
            ) {
                return;
            }
            match result {
                Ok(diagnostics) => {
                    performance_diagnostic_operation_record(current, Some(diagnostics), None)
                }
                Err(error) => {
                    performance_diagnostic_operation_record(current, None, Some(error))
                }
            }
        };
        self.publish_performance_diagnostic_operation(&terminal);
    }

    fn publish_performance_diagnostic_operation(
        &self,
        record: &BrowserPerformanceDiagnosticOperationRecord,
    ) {
        let _ = self
            .app
            .emit("rion://browser-performance-diagnostic", record);
    }

    fn clear_performance_diagnostic_probe(&self, operation_id: &str) {
        let webviews = self
            .state()
            .map(|state| {
                state
                    .native_resources
                    .tabs
                    .values()
                    .flat_map(|tab| tab.roles.values().map(|surface| surface.webview.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let source = performance_diagnostic_source("cancel", operation_id, false);
        for webview in webviews {
            let _ = webview.eval(&source);
        }
    }

    fn collect_browser_performance_diagnostics_inner(
        &self,
        sample_duration: Duration,
        operation_id: &str,
        cancellation: &PerformanceDiagnosticCancellation,
    ) -> RuntimeResult<BrowserPerformanceDiagnosticsRecord> {
        let captured_at = chrono::Utc::now().to_rfc3339();
        let environment = platform_performance_environment();
        let platform = if cfg!(target_os = "macos") {
            "macos"
        } else {
            "windows"
        }
        .to_owned();
        let sample_duration = bounded_performance_diagnostic_duration(sample_duration);
        let selected_tabs = self.presentation.selected_tabs();
        let candidates = {
            let state = self.state()?;
            selected_tabs
                .iter()
                .filter_map(|(window_id, tab_id)| {
                    let host = state.native_resources.display_hosts.get(window_id)?;
                    let tab = state.native_resources.tabs.get(tab_id)?;
                    let surfaces = tab
                        .roles
                        .iter()
                        .map(|(role_id, surface)| PerformanceDiagnosticSurface {
                            high_refresh_rate_status: surface.high_refresh_rate_status,
                            web_gl_configuration: surface.web_gl_configuration,
                            origin: surface.current_url.as_ref().and_then(|url| {
                                let origin = url.origin().ascii_serialization();
                                (origin != "null").then_some(origin)
                            }),
                            role_id: role_id.clone(),
                            webview: surface.webview.clone(),
                        })
                        .collect::<Vec<_>>();
                    (!surfaces.is_empty()).then(|| PerformanceDiagnosticWindow {
                        focused: false,
                        surfaces,
                        window: host.window.clone(),
                        window_id: window_id.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };
        if candidates.is_empty() {
            return Ok(
                self.store_performance_diagnostics(empty_performance_diagnostics(
                    captured_at,
                    platform,
                    BrowserPerformanceDiagnosticStatus::NoRunningRole,
                    &self.configuration,
                    sample_duration,
                    environment.system_low_power_mode_enabled,
                    environment.system_thermal_state,
                )),
            );
        }
        let mut visible = candidates
            .into_iter()
            .filter_map(|mut candidate| {
                let is_visible = candidate.window.is_visible().unwrap_or(false)
                    && !candidate.window.is_minimized().unwrap_or(false);
                if !is_visible {
                    return None;
                }
                candidate.focused = candidate.window.is_focused().unwrap_or(false);
                Some(candidate)
            })
            .collect::<Vec<_>>();
        if visible.is_empty() {
            return Ok(
                self.store_performance_diagnostics(empty_performance_diagnostics(
                    captured_at,
                    platform,
                    BrowserPerformanceDiagnosticStatus::NoVisibleGameWindow,
                    &self.configuration,
                    sample_duration,
                    environment.system_low_power_mode_enabled,
                    environment.system_thermal_state,
                )),
            );
        }
        visible.sort_by_key(|candidate| !candidate.focused);
        let selected = visible.remove(0);
        let display_refresh_rate_hz = platform_display_refresh_rate(&selected.window);
        let start_source = performance_diagnostic_source(
            "start",
            operation_id,
            performance_diagnostic_game_loop_enabled(),
        );
        let mut samples = selected
            .surfaces
            .into_iter()
            .map(|surface| {
                let error = surface
                    .webview
                    .eval(&start_source)
                    .err()
                    .map(|error| error.to_string());
                (surface, error)
            })
            .collect::<Vec<_>>();
        if !cancellation.wait(sample_duration) {
            self.clear_performance_diagnostic_probe(operation_id);
            return Err(RuntimeError::new(
                "PERFORMANCE_DIAGNOSTIC_CANCELLED",
                "System WebView performance diagnostic was cancelled.",
            ));
        }
        let read_source = performance_diagnostic_source("read", operation_id, false);
        let pending_reads = samples
            .drain(..)
            .map(|(surface, start_error)| {
                if let Some(error) = start_error {
                    return (surface, Err(error));
                }
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                match surface.webview.eval_with_callback(
                    &read_source,
                    move |value| {
                        let _ = sender.send(value);
                    },
                ) {
                    Ok(()) => (surface, Ok(receiver)),
                    Err(error) => (surface, Err(error.to_string())),
                }
            })
            .collect::<Vec<_>>();
        let read_deadline = Instant::now() + Duration::from_secs(5);
        let mut diagnostic_timed_out = false;
        let surfaces = pending_reads
            .into_iter()
            .map(|(surface, pending)| {
                let readback = pending
                    .map_err(|error| RuntimeError::new("PERFORMANCE_DIAGNOSTIC_FAILED", error))
                    .and_then(|receiver| {
                        receiver
                            .recv_timeout(read_deadline.saturating_duration_since(Instant::now()))
                            .map_err(|_| {
                                RuntimeError::new(
                                    "PERFORMANCE_DIAGNOSTIC_TIMEOUT",
                                    "System WebView performance diagnostic timed out.",
                                )
                            })
                    })
                    .and_then(|raw| decode_performance_diagnostic_readback(&raw));
                match readback {
                    Ok(readback) => {
                        completed_performance_surface(surface, readback, display_refresh_rate_hz)
                    }
                    Err(error) => {
                        diagnostic_timed_out |= error.code == "PERFORMANCE_DIAGNOSTIC_TIMEOUT";
                        failed_performance_surface(surface, error.message)
                    }
                }
            })
            .collect::<Vec<_>>();
        if diagnostic_timed_out {
            self.clear_performance_diagnostic_probe(operation_id);
            return Err(RuntimeError::new(
                "PERFORMANCE_DIAGNOSTIC_TIMEOUT",
                "System WebView performance diagnostic timed out; the result is indeterminate.",
            ));
        }
        Ok(
            self.store_performance_diagnostics(BrowserPerformanceDiagnosticsRecord {
                captured_at,
                platform,
                status: BrowserPerformanceDiagnosticStatus::Available,
                window_id: Some(selected.window_id),
                window_focused: selected.focused,
                display_refresh_rate_hz,
                system_low_power_mode_enabled: environment.system_low_power_mode_enabled,
                system_thermal_state: environment.system_thermal_state,
                high_refresh_rate_requested: macos_high_refresh_rate_enabled(
                    self.configuration.macos_high_refresh_mode,
                    display_refresh_rate_hz,
                ),
                sample_duration_ms: sample_duration.as_millis().min(u32::MAX as u128) as u32,
                surfaces,
            }),
        )
    }

    pub fn last_browser_performance_diagnostics(
        &self,
    ) -> Option<BrowserPerformanceDiagnosticsRecord> {
        self.last_performance_diagnostics
            .lock()
            .ok()
            .and_then(|record| record.clone())
    }

    fn store_performance_diagnostics(
        &self,
        record: BrowserPerformanceDiagnosticsRecord,
    ) -> BrowserPerformanceDiagnosticsRecord {
        if let Ok(mut last) = self.last_performance_diagnostics.lock() {
            *last = Some(record.clone());
        }
        record
    }

    pub fn zoom_focused_runtime(&self, action: &str) -> Result<bool, String> {
        let window_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .native_resources.display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.window_id.clone())
        };
        let Some(window_id) = window_id else {
            return Ok(false);
        };
        self.zoom_runtime_window(&window_id, action)
    }

    pub fn zoom_runtime_window(&self, window_id: &str, action: &str) -> Result<bool, String> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Zoom,
            "zoomRuntimeWindow",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_window(window_id);
        let result = self.apply_runtime_window_zoom(window_id, action);
        let receipt = match result.as_ref() {
            Ok(_) => NativeOperationReceipt::applied(operation, "windowZoomApplied"),
            Err(message)
                if message
                    .to_ascii_lowercase()
                    .contains("compensation also failed") =>
            {
                NativeOperationReceipt::with_status(
                    operation,
                    "windowZoomRollbackFailed",
                    NativeOperationStatus::Indeterminate,
                    Some("SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED"),
                )
            }
            Err(_) => NativeOperationReceipt::with_status(
                operation,
                "windowZoomFailed",
                NativeOperationStatus::Failed,
                Some("TAURI_RUNTIME_ZOOM_FAILED"),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn apply_runtime_window_zoom(&self, window_id: &str, action: &str) -> Result<bool, String> {
        if !matches!(action, "in" | "out" | "reset") {
            return Err("Runtime window zoom action is invalid.".to_owned());
        }
        if !self
            .state()
            .map_err(|error| error.message)?
            .native_resources.display_hosts
            .contains_key(window_id)
        {
            return Ok(false);
        }
        let live = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Runtime window topology is unavailable while zooming.".to_owned())?;
        let current_zoom = live.window_zoom_factor.unwrap_or(1.0);
        let next_zoom = next_zoom_factor(current_zoom, action, 0.25, 5.0);
        let Some(tab_id) = self.presentation.selected_tabs().remove(window_id)
        else {
            return Ok(false);
        };
        let live_tab_ids = self
            .live_tab_ids_for_window(window_id)
            .into_iter()
            .collect::<HashSet<_>>();
        let (surface_projections, visible_role_ids) = {
            let state = self.state().map_err(|error| error.message)?;
            let Some(active_tab) = state.native_resources.tabs.get(&tab_id) else {
                return Ok(false);
            };
            let visible_role_ids = active_tab.roles.keys().cloned().collect::<HashSet<_>>();
            let surfaces = state
                .native_resources.tabs
                .iter()
                .filter(|(tab_id, _)| live_tab_ids.contains(*tab_id))
                .flat_map(|(_, tab)| {
                    tab.roles.iter().map(|(role_id, surface)| {
                        (
                            tab_id.clone(),
                            role_id.clone(),
                            surface.webview.clone(),
                            surface.zoom_factor,
                        )
                    })
                })
                .collect::<Vec<_>>();
            (surfaces, visible_role_ids)
        };
        let surfaces = surface_projections
            .into_iter()
            .map(|(tab_id, role_id, webview, projected_zoom)| {
                let (base, _) = self.runtime_role_zoom_contract(
                    window_id,
                    &tab_id,
                    &role_id,
                    projected_zoom,
                );
                (
                    role_id,
                    webview,
                    effective_zoom_factor(base, current_zoom),
                    effective_zoom_factor(base, next_zoom),
                )
            })
            .collect::<Vec<_>>();
        let popup_projections = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, role_id)| {
                    let tab_id = state.native_tab_id_for_role_surface(role_id)?;
                    let tab = state.native_resources.tabs.get(tab_id)?;
                    if !live_tab_ids.contains(tab_id) {
                        return None;
                    }
                    let base = tab.roles.get(role_id)?.zoom_factor;
                    Some((
                        label.clone(),
                        tab_id.clone(),
                        role_id.clone(),
                        base,
                    ))
                })
                .collect::<Vec<_>>()
        };
        let popup_surfaces = popup_projections
            .into_iter()
            .map(|(label, tab_id, role_id, projected_zoom)| {
                let (base, _) = self.runtime_role_zoom_contract(
                    window_id,
                    &tab_id,
                    &role_id,
                    projected_zoom,
                );
                (
                    label,
                    effective_zoom_factor(base, current_zoom),
                    effective_zoom_factor(base, next_zoom),
                )
            })
            .collect::<Vec<_>>();
        let mut zoom_mutations = surfaces
            .iter()
            .map(|(_, webview, previous_zoom, zoom)| (webview.clone(), *previous_zoom, *zoom))
            .collect::<Vec<_>>();
        for (label, previous_zoom, zoom) in popup_surfaces {
            let webview = self
                .app
                .get_webview(&label)
                .ok_or_else(|| format!("Runtime popup {label} has no live native handle."))?;
            zoom_mutations.push((webview, previous_zoom, zoom));
        }
        let desired = self.presentation.live.commit_window_zoom_factor(
            live.revision,
            window_id,
            next_zoom,
        )?;
        if desired.status == LiveTopologyCommitStatus::Superseded {
            return Err("Runtime window zoom was superseded before native submission.".to_owned());
        }
        if let Err(failure) = apply_reversible_fanout(
            &zoom_mutations,
            |index, (webview, _, zoom)| {
                webview
                    .set_zoom(*zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
            |index, (webview, previous_zoom, _)| {
                webview
                    .set_zoom(*previous_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            let compensation = self.presentation.live.commit_window_zoom_factor(
                desired.revision,
                window_id,
                current_zoom,
            );
            if match compensation.as_ref() {
                Ok(receipt) => receipt.status == LiveTopologyCommitStatus::Superseded,
                Err(_) => true,
            } {
                self.health.mark_unhealthy();
                return Err(format!(
                    "Native zoom failed and the authoritative Kernel compensation was superseded: {}",
                    failure.apply_error
                ));
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_RUNTIME_ZOOM_FAILED",
                "Updating runtime window zoom",
                &failure,
            )
            .message);
        }
        let label = self.window_zoom_indicator_label(next_zoom);
        for (role_id, webview, _, _) in surfaces {
            if visible_role_ids.contains(&role_id) {
                show_zoom_indicator(&webview, &label);
            }
        }
        Ok(true)
    }

}
