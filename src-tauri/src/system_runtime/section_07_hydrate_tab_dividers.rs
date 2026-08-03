impl SystemRuntimeExecutor {
    fn hydrate_tab_dividers(&self, tab_id: &str) -> RuntimeResult<()> {
        let (window_id, window, gap, role_inputs) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "The runtime tab closed before optional dividers were attached.",
                )
            })?;
            if !tab.dividers.is_empty() || tab.roles.len() < 2 {
                return Ok(());
            }
            if state.close_coordinator.closing_tabs.contains(tab_id) {
                return Ok(());
            }
            let host = state.display_hosts.get(&tab.window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "The runtime display host closed before optional dividers were attached.",
                )
            })?;
            (
                tab.window_id.clone(),
                host.window.clone(),
                tab.workspace_appearance.gap,
                tab.roles
                    .iter()
                    .map(|(role_id, surface)| LayoutRoleInput {
                        role_id: role_id.clone(),
                        rect: LayoutRect {
                            x: surface.rect.x,
                            y: surface.rect.y,
                            width: surface.rect.width,
                            height: surface.rect.height,
                        },
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let content_metrics = runtime_window_content_metrics(&window)?;
        let (_, descriptors) = self.resolve_runtime_layout(content_metrics, role_inputs, gap)?;
        let mut created = Vec::with_capacity(descriptors.len());
        for (index, descriptor, bounds) in descriptors {
            self.wait_for_optional_idle();
            let still_current = self.state.lock().ok().is_some_and(|state| {
                state
                    .tabs
                    .get(tab_id)
                    .is_some_and(|tab| tab.window_id == window_id && tab.dividers.is_empty())
                    && !state.close_coordinator.closing_tabs.contains(tab_id)
            });
            if !still_current {
                break;
            }
            let bounds = divider_hit_bounds(&descriptor.axis, bounds);
            let lifecycle_id = format!("{tab_id}:divider:{index}");
            let webview = self.with_native_creation_lane(&window_id, || {
                self.add_child_bounded(
                    &window,
                    WebviewBuilder::new(
                        runtime_label("game-divider", &format!("{tab_id}:{index}")),
                        WebviewUrl::App(
                            format!("runtime-divider.html?axis={}", descriptor.axis).into(),
                        ),
                    )
                    .transparent(true),
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                    &lifecycle_id,
                )
            })?;
            let lifecycle = self.install_surface_lifecycle_tracker(&webview)?;
            let surface_instance_id = self.register_managed_surface(
                &webview,
                &lifecycle,
                ManagedSurfaceKind::Divider,
                ManagedSurfacePhase::Live,
                None,
                Some(tab_id),
                &window_id,
                0,
            )?;
            let selected = self
                .presentation
                .existing(&window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|mut presentation| {
                        let bound = presentation.bind_surface(
                            tab_id,
                            SurfacePresentationBinding {
                                generation: 0,
                                instance_id: surface_instance_id.clone(),
                                webview: webview.clone(),
                            },
                        );
                        (
                            bound,
                            presentation.selected_tab_id.as_deref() == Some(tab_id),
                        )
                    })
                })
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The runtime tab presentation disappeared before its divider could bind.",
                    )
                })?;
            if !selected.0 {
                let _ = self.close_managed_surface_and_wait(
                    &surface_instance_id,
                    &format!("{tab_id}:divider:{index}"),
                );
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "The runtime tab was removed before its divider could bind.",
                ));
            }
            self.presentation
                .assign_surface_owner(webview.label(), &surface_instance_id, &window_id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            if !selected.1 {
                let _ = webview.hide();
            }
            created.push(RuntimeDivider {
                descriptor,
                index,
                surface_instance_id,
                webview,
            });
        }
        let inserted = if let Ok(mut state) = self.state.lock()
            && let Some(tab) = state.tabs.get_mut(tab_id)
            && tab.window_id == window_id
            && tab.dividers.is_empty()
        {
            tab.dividers = std::mem::take(&mut created);
            true
        } else {
            false
        };
        if !inserted {
            for divider in created {
                let _ = self.close_managed_surface_and_wait(
                    &divider.surface_instance_id,
                    &format!("{tab_id}:divider:{}", divider.index),
                );
            }
        } else if self
            .presentation
            .existing(&window_id)
            .is_some_and(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .is_some_and(|selection| selection.selected_tab_id.as_deref() == Some(tab_id))
            })
        {
            let _ = self.request_tab_presentation(
                tab_id,
                NativePresentationFocus::None,
                "optional-dividers-attached",
            );
        }
        Ok(())
    }

    fn execute_serial_work(self: &Arc<Self>, work: SystemRuntimeWork) {
        match work {
            SystemRuntimeWork::Effect {
                action_name,
                effect,
                presentation_revision,
                persist_runtime,
            } => self.execute_effect_work(
                action_name,
                *effect,
                presentation_revision,
                persist_runtime,
            ),
            SystemRuntimeWork::RecoverSurface {
                allowed,
                reason,
                transaction,
            } => {
                if self.health.is_healthy()
                    && RuntimeShutdownState::from_raw(
                        self.shutdown_state.load(Ordering::Acquire),
                    ) == RuntimeShutdownState::Accepting
                {
                    self.recover_system_surface(*transaction, reason, allowed);
                } else {
                    let role_id = transaction.role_id.clone();
                    if let Ok(mut state) = self.state.lock() {
                        state.recovering_roles.remove(&role_id);
                    }
                    self.complete_surface_recovery(
                        *transaction,
                        "surfaceRecoveryRuntimeUnavailable",
                        NativeOperationStatus::Failed,
                        Some("SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY"),
                        true,
                    );
                    let _ = self.app.emit(
                        "rion://shell-error",
                        json!({
                            "code": "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY",
                            "message": "The System WebView runtime rejected recovery after a stalled native lifecycle. Restart Rion Studio to recover safely.",
                            "roleId": role_id,
                            "reason": reason
                        }),
                    );
                }
            }
            SystemRuntimeWork::FinalizeSurfaceRelease {
                instance_id,
                isolated,
                released,
            } => self.finalize_surface_release(&instance_id, isolated, released),
        }
    }

    fn execute_effect_work(
        self: &Arc<Self>,
        action_name: &'static str,
        effect: CoreEffectRequest,
        presentation_revision: u64,
        persist_runtime: bool,
    ) {
        if RuntimeShutdownState::from_raw(self.shutdown_state.load(Ordering::Acquire))
            != RuntimeShutdownState::Accepting
            && !is_surface_close_effect(&effect.action)
        {
            let _ = self.core.dispatch_core_effect_results(vec![CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: false,
                value_json: None,
                error: Some(rion_core::CoreErrorPayload {
                    code: "SYSTEM_RUNTIME_SHUTTING_DOWN".to_owned(),
                    message: "The System WebView runtime is shutting down and cancelled queued native work."
                        .to_owned(),
                }),
            }]);
            return;
        }
        if matches!(effect.action, CoreEffectAction::EmbeddedLoadRoles { .. }) {
            self.execute_role_load_effect_async(
                action_name,
                effect,
                presentation_revision,
                persist_runtime,
            );
            return;
        }
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        let close_effect = is_surface_close_effect(&effect.action);
        let started = Instant::now();
        let scope = native_effect_scope(&effect);
        eprintln!("System WebView effect: {action_name} started (effect={effect_id}, {scope}).");
        let result = if self.health.is_healthy() || is_surface_close_effect(&effect.action) {
            // Close remains available for quarantined surfaces even if another native
            // lifecycle operation marked the general runtime unhealthy.
            self.execute(effect, presentation_revision)
        } else {
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: false,
                value_json: None,
                error: Some(rion_core::CoreErrorPayload {
                    code: "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY".to_owned(),
                    message: "The System WebView runtime stopped accepting native lifecycle operations after a stalled callback. Restart Rion Studio to recover safely.".to_owned(),
                }),
            }
        };
        if close_effect {
            let succeeded = result.ok;
            let error_payload = result.error.clone();
            eprintln!(
                "System WebView effect: {action_name} completed (effect={effect_id}, {scope}, ok={succeeded}, elapsedMs={}).",
                started.elapsed().as_millis()
            );
            // Acknowledge native isolation before any Core/SQLite callback. The
            // close worker is immediately reusable for the next tab in a burst;
            // restore-session durability is coalesced on one background worker.
            match self.core.dispatch_core_effect_results(vec![result]) {
                Ok(report) => {
                    let acknowledgement_status =
                        effect_acknowledgement_status(&report, &effect_id);
                    let accepted = acknowledgement_status == "accepted";
                    self.record_effect_outcome_failures(
                        action_name,
                        &effect_id,
                        &operation_id,
                        error_payload.as_ref(),
                        acknowledgement_status,
                        started.elapsed(),
                        persist_runtime,
                        &scope,
                    );
                    self.record_close_effect_completion(
                        action_name,
                        &effect_id,
                        succeeded,
                        accepted,
                        error_payload.as_ref(),
                        started.elapsed(),
                    );
                    if succeeded && accepted {
                        if persist_runtime {
                            self.schedule_restore_session_persist();
                        } else {
                            self.publish_projection();
                        }
                    }
                }
                Err(error) => {
                    let dispatch_error_payload = error.payload();
                    self.record_effect_outcome_failures(
                        action_name,
                        &effect_id,
                        &operation_id,
                        error_payload.as_ref(),
                        "dispatchFailed",
                        started.elapsed(),
                        persist_runtime,
                        &scope,
                    );
                    self.record_close_effect_completion(
                        action_name,
                        &effect_id,
                        succeeded,
                        false,
                        Some(&dispatch_error_payload),
                        started.elapsed(),
                    );
                }
            }
            return;
        }
        let persistence_error = (result.ok && persist_runtime)
            .then(|| self.persist_restore_session(false).err())
            .flatten();
        let result = finalize_persisted_effect_result(result, persist_runtime, persistence_error);
        let succeeded = result.ok;
        let error_payload = result.error.clone();
        eprintln!(
            "System WebView effect: {action_name} completed (effect={effect_id}, {scope}, ok={succeeded}, elapsedMs={}).",
            started.elapsed().as_millis()
        );
        let dispatch = self.core.dispatch_core_effect_results(vec![result]);
        let acknowledgement_status = dispatch
            .as_ref()
            .map(|report| effect_acknowledgement_status(report, &effect_id))
            .unwrap_or("dispatchFailed");
        self.record_effect_outcome_failures(
            action_name,
            &effect_id,
            &operation_id,
            error_payload.as_ref(),
            acknowledgement_status,
            started.elapsed(),
            persist_runtime,
            &scope,
        );
        if dispatch.is_ok() && succeeded && persist_runtime {
            self.publish_projection();
        }
    }

    fn schedule_restore_session_persist(self: &Arc<Self>) {
        self.restore_persist_requested
            .fetch_add(1, Ordering::AcqRel);
        if self
            .restore_persist_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            let mut failure_count = 0usize;
            loop {
                // Collapse a rapid close burst into one durable snapshot.
                let delay = match failure_count {
                    0 => Duration::from_millis(50),
                    1 => Duration::from_secs(1),
                    2 => Duration::from_secs(5),
                    _ => Duration::from_secs(30),
                };
                std::thread::sleep(delay);
                let target = runtime.restore_persist_requested.load(Ordering::Acquire);
                match runtime.persist_restore_session(false) {
                    Ok(()) => {
                        failure_count = 0;
                        runtime.publish_projection();
                    }
                    Err(error) => {
                        failure_count = failure_count.saturating_add(1);
                        eprintln!("Runtime close durability retry failed: {error}");
                        if failure_count < 4 {
                            continue;
                        }
                        let _ = runtime.app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "SYSTEM_RUNTIME_PERSIST_FAILED",
                                "failureKind": "close-durability-retry-exhausted",
                                "message": "The game pages stopped, but Rion Studio could not persist the closed tab state. Restart Rion Studio before relying on window restoration."
                            }),
                        );
                    }
                }
                if runtime.restore_persist_requested.load(Ordering::Acquire) != target {
                    continue;
                }
                runtime
                    .restore_persist_running
                    .store(false, Ordering::Release);
                if runtime.restore_persist_requested.load(Ordering::Acquire) == target
                    || runtime
                        .restore_persist_running
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_err()
                {
                    break;
                }
            }
        });
    }

    fn record_close_effect_completion(
        &self,
        action_name: &'static str,
        effect_id: &str,
        native_succeeded: bool,
        acknowledgement_accepted: bool,
        error: Option<&rion_core::CoreErrorPayload>,
        elapsed: Duration,
    ) {
        let core = Arc::clone(&self.core);
        let error_code = error.map(|error| error.code.clone());
        let error = error.map(|error| log_error_details(&error.code, &error.message));
        let context = json!({
            "acknowledgementAccepted": acknowledgement_accepted,
            "action": action_name,
            "effectId": effect_id,
            "elapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
            "errorCode": error_code,
            "nativeSucceeded": native_succeeded,
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if native_succeeded && acknowledgement_accepted {
                            LogLevel::Debug
                        } else {
                            LogLevel::Error
                        },
                        source: LogSource::Browser,
                        event: "surface.close-effect-completed".to_owned(),
                        message: "Native close completion was dispatched to the Core coordinator."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error,
                    }],
                })
                .await;
        });
    }

    fn execute_role_load_effect_async(
        self: &Arc<Self>,
        action_name: &'static str,
        effect: CoreEffectRequest,
        _presentation_revision: u64,
        persist_runtime: bool,
    ) {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        let scope = native_effect_scope(&effect);
        let started = Instant::now();
        let roles = match effect.action {
            CoreEffectAction::EmbeddedLoadRoles { roles } => roles,
            _ => unreachable!("role-load async dispatch only accepts EmbeddedLoadRoles"),
        };
        let pending = match self.start_role_loads(roles) {
            Ok(pending) => pending,
            Err(error) => {
                let error_payload = rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                };
                let result = CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: false,
                    value_json: None,
                    error: Some(error_payload.clone()),
                };
                let dispatch = self.core.dispatch_core_effect_results(vec![result]);
                let acknowledgement_status = dispatch
                    .as_ref()
                    .map(|report| effect_acknowledgement_status(report, &effect_id))
                    .unwrap_or("dispatchFailed");
                self.record_effect_outcome_failures(
                    action_name,
                    &effect_id,
                    &operation_id,
                    Some(&error_payload),
                    acknowledgement_status,
                    started.elapsed(),
                    persist_runtime,
                    &scope,
                );
                return;
            }
        };
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let role_ids = pending
                .iter()
                .map(|pending| pending.role_id.clone())
                .collect::<Vec<_>>();
            let mut navigation_error: Option<(&'static str, String)> = None;
            for pending_navigation in &pending {
                if navigation_error.is_some() {
                    if let Some(operation) = pending_navigation.operation.clone() {
                        pending_navigation.navigation.reset();
                        runtime.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "navigationBatchAborted",
                                NativeOperationStatus::Superseded,
                                Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                            ),
                        );
                    }
                    continue;
                }
                if let Some(operation) = pending_navigation.operation.clone() {
                    let receipt = pending_navigation
                        .navigation
                        .wait_operation_async(operation)
                        .await;
                    let status = receipt.status;
                    let failure_code = receipt.failure_code.clone();
                    runtime.record_native_operation_receipt(receipt);
                    if status != NativeOperationStatus::Applied {
                        navigation_error = Some((
                            if status == NativeOperationStatus::Superseded {
                                "SYSTEM_NAVIGATION_SUPERSEDED"
                            } else {
                                "TAURI_NAVIGATION_FAILED"
                            },
                            failure_code.unwrap_or_else(|| {
                                "System WebView navigation did not complete.".to_owned()
                            }),
                        ));
                        continue;
                    }
                }
                runtime.record_runtime_stage(
                    format!("page-finished:{}", pending_navigation.role_id),
                    "completed",
                    started,
                );
            }
            let runtime_for_completion = Arc::clone(&runtime);
            let completion = tauri::async_runtime::spawn_blocking(move || {
                let controlled_labels = pending
                    .iter()
                    .map(|pending| pending.surface.label().to_owned())
                    .collect::<Vec<_>>();
                let result = if let Some((code, message)) = navigation_error {
                    Err(RuntimeError::new(code, message))
                } else {
                    pending.iter().try_for_each(|pending| {
                        runtime_for_completion
                            .reassert_role_keys(&pending.role_id, &pending.surface)
                    })
                };
                runtime_for_completion.finish_controlled_navigations(&controlled_labels);
                result
            })
            .await
            .unwrap_or_else(|error| {
                Err(RuntimeError::new(
                    "TAURI_NAVIGATION_FAILED",
                    format!("Navigation completion task failed: {error}"),
                ))
            });
            let mut result = match completion {
                Ok(()) => CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: true,
                    value_json: None,
                    error: None,
                },
                Err(error) => CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: false,
                    value_json: None,
                    error: Some(rion_core::CoreErrorPayload {
                        code: error.code.to_owned(),
                        message: error.message,
                    }),
                },
            };
            if result.ok {
                let tab_ids = runtime
                    .state
                    .lock()
                    .ok()
                    .map(|state| {
                        role_ids
                            .iter()
                            .filter_map(|role_id| state.role_tabs.get(role_id).cloned())
                            .collect::<HashSet<_>>()
                    })
                    .unwrap_or_default();
                for tab_id in tab_ids {
                    runtime.set_launch_phase(&tab_id, LaunchPhase::EssentialReady);
                    runtime.schedule_optional_hydration(&tab_id);
                }
            }
            let persistence_error = (result.ok && persist_runtime)
                .then(|| runtime.persist_restore_session(false).err())
                .flatten();
            result = finalize_persisted_effect_result(result, persist_runtime, persistence_error);
            let succeeded = result.ok;
            let error_payload = result.error.clone();
            eprintln!(
                "System WebView effect: {action_name} completed asynchronously (ok={succeeded}, elapsedMs={}).",
                started.elapsed().as_millis()
            );
            let dispatch = runtime.core.dispatch_core_effect_results(vec![result]);
            let acknowledgement_status = dispatch
                .as_ref()
                .map(|report| effect_acknowledgement_status(report, &effect_id))
                .unwrap_or("dispatchFailed");
            runtime.record_effect_outcome_failures(
                action_name,
                &effect_id,
                &operation_id,
                error_payload.as_ref(),
                acknowledgement_status,
                started.elapsed(),
                persist_runtime,
                &scope,
            );
            if dispatch.is_ok() && succeeded && persist_runtime {
                runtime.publish_projection();
            }
        });
    }

    pub fn registration(&self) -> SystemWebViewRuntimeRegistrationRecord {
        let platform = if cfg!(target_os = "macos") {
            rion_platform::Platform::Macos
        } else {
            rion_platform::Platform::Windows
        };
        let probe = rion_platform::probe_system_webview(platform);
        let runtime_available = probe.available;
        let audio_mute_available = runtime_available && probe.audio_mute_available;
        let available = runtime_available && audio_mute_available;
        let macro_input_available = runtime_available && probe.macro_input_available;
        let registration = SystemWebViewRuntimeRegistrationRecord {
            platform: if cfg!(target_os = "macos") {
                "macos".to_owned()
            } else {
                "windows".to_owned()
            },
            engine: if cfg!(target_os = "macos") {
                ResolvedBrowserEngine::Wkwebview
            } else {
                ResolvedBrowserEngine::Webview2
            },
            adapter_version: format!("tauri-wry-{}", env!("CARGO_PKG_VERSION")),
            available,
            capability_snapshot: EngineCapabilitySnapshotRecord {
                navigation: supported_if(runtime_available),
                persistent_session: supported_if(runtime_available),
                trusted_input: supported_if(macro_input_available),
                background_input: supported_if(macro_input_available),
                frame_evaluation: if runtime_available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                popup: degraded_if(runtime_available),
                audio_mute: supported_if(audio_mute_available),
                custom_fonts: degraded_if(runtime_available),
                downloads: EngineCapabilityStatus::Disabled,
                file_upload: supported_if(runtime_available),
                permissions: if runtime_available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                dialogs: supported_if(runtime_available),
                certificate_handling: supported_if(runtime_available),
            },
            failure_reason: (!available).then_some(if cfg!(target_os = "macos") {
                rion_core::SystemWebViewIssueReason::WebkitSpiUnavailable
            } else {
                rion_core::SystemWebViewIssueReason::RuntimeCreationFailed
            }),
        };
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Capability,
            "systemWebViewProbe",
            PLATFORM_CALLBACK_TIMEOUT,
        );
        let receipt = if available && macro_input_available {
            NativeOperationReceipt::applied(operation, "capabilityProbe")
        } else if available {
            NativeOperationReceipt::with_status(
                operation,
                "capabilityProbe",
                NativeOperationStatus::Degraded,
                Some("SYSTEM_WEBVIEW_MACRO_INPUT_UNAVAILABLE"),
            )
        } else {
            NativeOperationReceipt::with_status(
                operation,
                "capabilityProbe",
                NativeOperationStatus::Failed,
                Some("SYSTEM_WEBVIEW_RUNTIME_UNAVAILABLE"),
            )
        };
        self.record_native_operation_receipt(receipt);
        registration
    }

    pub(crate) fn mark_unhealthy_after_failed_compensation(&self) {
        self.health.mark_unhealthy();
    }

    pub(crate) fn launch_target_for_window_id(
        &self,
        window_id: &str,
    ) -> Result<EmbeddedLaunchTargetRecord, String> {
        self.state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .display_hosts
            .get(window_id)
            .map(|host| host.target.clone())
            .ok_or_else(|| "The conflicting runtime window has no live native host.".to_owned())
    }

}
