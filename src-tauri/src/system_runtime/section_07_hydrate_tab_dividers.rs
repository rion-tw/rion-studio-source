impl SystemRuntimeExecutor {
    fn hydrate_tab_dividers(&self, tab_id: &str) -> RuntimeResult<()> {
        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let (window_id, window, gap, role_inputs) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "The runtime tab closed before optional dividers were attached.",
                )
            })?;
            if !tab.dividers.is_empty() || tab.slots.len() < 2 {
                return Ok(());
            }
            if state.close_coordinator.closing_tabs.contains(tab_id) {
                return Ok(());
            }
            let host = state.display_hosts.get(&window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "The runtime display host closed before optional dividers were attached.",
                )
            })?;
            (
                window_id.clone(),
                host.window.clone(),
                tab.workspace_appearance.gap,
                tab.slots
                    .values()
                    .map(runtime_role_slot_input)
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
                    .is_some_and(|tab| tab.dividers.is_empty())
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
                let expected_lifecycle_epoch =
                    transaction.context.lifecycle_epoch.unwrap_or_default();
                let lifecycle_current = self
                    .application_lifecycle_epoch_matches(expected_lifecycle_epoch);
                if self.health.is_healthy()
                    && lifecycle_current
                    && RuntimeShutdownState::from_raw(
                        self.shutdown_state.load(Ordering::Acquire),
                    ) == RuntimeShutdownState::Accepting
                {
                    self.recover_system_surface(*transaction, reason, allowed);
                } else {
                    let lifecycle_accepting =
                        self.application_lifecycle.accepts_native_work();
                    let lifecycle_unavailable = !lifecycle_current;
                    let (stage, failure_code, message, restart_required) =
                        if lifecycle_unavailable {
                            (
                                "surfaceRecoveryLifecycleCancelled",
                                if lifecycle_accepting {
                                    "SYSTEM_LIFECYCLE_STALE"
                                } else {
                                    "SYSTEM_LIFECYCLE_SUSPENDED"
                                },
                                "Surface recovery was cancelled because its application lifecycle epoch ended.",
                                false,
                            )
                        } else {
                        (
                            "surfaceRecoveryRuntimeUnavailable",
                            "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY",
                            "The System WebView runtime rejected recovery after a stalled native lifecycle. Restart Rion Studio to recover safely.",
                            true,
                        )
                    };
                    let role_id = transaction.role_id.clone();
                    let generation = transaction.surface_generation;
                    let parent_operation_id =
                        transaction.context.parent_operation_id.clone();
                    if let Ok(mut state) = self.state.lock() {
                        state.recovering_roles.remove(&role_id);
                    }
                    self.complete_surface_recovery(
                        *transaction,
                        stage,
                        NativeOperationStatus::Failed,
                        Some(failure_code),
                        restart_required,
                    );
                    let _ = self.app.emit(
                        "rion://shell-error",
                        json!({
                            "code": failure_code,
                            "message": message,
                            "roleId": role_id,
                            "reason": reason
                        }),
                    );
                    if lifecycle_unavailable {
                        self.schedule_surface_recovery_internal(
                            role_id,
                            format!("{reason}:lifecycle-retry"),
                            generation,
                            parent_operation_id,
                            true,
                        );
                    }
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
        let created_tab_id = match &effect.action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        };
        // Core cancellation removes an unstarted effect from its pending set.
        // The native queue may still contain that envelope, so admit create work
        // only while the exact effect/operation pair remains pending.
        if created_tab_id.is_some() && !self.create_effect_is_still_pending(&effect) {
            return;
        }
        let shutdown_accepting = RuntimeShutdownState::from_raw(
            self.shutdown_state.load(Ordering::Acquire),
        ) == RuntimeShutdownState::Accepting;
        let lifecycle_accepting = self.application_lifecycle.accepts_native_work();
        if (!shutdown_accepting || !lifecycle_accepting)
            && !is_surface_close_effect(&effect.action)
        {
            let (code, message) = if shutdown_accepting {
                (
                    "SYSTEM_RUNTIME_SUSPENDED",
                    "The System WebView runtime is suspended and cancelled queued native work.",
                )
            } else {
                (
                    "SYSTEM_RUNTIME_SHUTTING_DOWN",
                    "The System WebView runtime is shutting down and cancelled queued native work.",
                )
            };
            let _ = self.core.dispatch_core_effect_results(vec![CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: false,
                value_json: None,
                error: Some(rion_core::CoreErrorPayload {
                    code: code.to_owned(),
                    message: message.to_owned(),
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
        let stale_create_cleanup = (succeeded && acknowledgement_status != "accepted")
            .then(|| {
                created_tab_id
                    .as_deref()
                    .map(|tab_id| self.retire_unacknowledged_created_tab(tab_id))
            })
            .flatten();
        let retired_stale_create = stale_create_cleanup.as_ref().is_some_and(Result::is_ok);
        let stale_create_cleanup_error = stale_create_cleanup
            .as_ref()
            .and_then(|cleanup| cleanup.as_ref().err())
            .map(|error| rion_core::CoreErrorPayload {
                code: error.code.to_owned(),
                message: error.message.clone(),
            });
        if stale_create_cleanup_error.is_some() {
            // The duplicate login surface could not be proven offline. Fail
            // closed only at this genuine isolation boundary.
            self.health.mark_unhealthy();
        }
        if !retired_stale_create {
            self.record_effect_outcome_failures(
                action_name,
                &effect_id,
                &operation_id,
                stale_create_cleanup_error
                    .as_ref()
                    .or(error_payload.as_ref()),
                acknowledgement_status,
                started.elapsed(),
                persist_runtime,
                &scope,
            );
        }
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
