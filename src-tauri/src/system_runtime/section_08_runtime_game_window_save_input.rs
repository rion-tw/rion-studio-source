impl SystemRuntimeExecutor {
    pub(crate) fn refresh_saved_game_windows(
        &self,
        game_windows: &[StateGameWindowRecord],
    ) -> Result<(), String> {
        let names = game_windows
            .iter()
            .map(|window| (window.id.clone(), window.name.clone()))
            .collect::<HashMap<_, _>>();
        let updates = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            state
                .native_resources.display_hosts
                .iter()
                .map(|(window_id, host)| {
                    (
                        window_id.clone(),
                        host.window.clone(),
                        #[cfg(target_os = "macos")]
                        host.tabs_controller.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for window_id in self
            .presentation
            .snapshot_states()?
            .into_keys()
            .collect::<Vec<_>>()
        {
            self.set_live_window_persisted_name(&window_id, names.get(&window_id).cloned())?;
        }
        for update in updates {
            #[cfg(target_os = "macos")]
            let (window_id, window, controller) = update;
            #[cfg(not(target_os = "macos"))]
            let (window_id, window) = update;
            let saved_name = names.get(&window_id).map(String::as_str);
            window
                .set_title(&native_runtime_window_title(saved_name))
                .map_err(|error| error.to_string())?;
            #[cfg(target_os = "macos")]
            controller.set_window_name(saved_name)?;
        }
        self.publish_projection();
        Ok(())
    }

    pub(crate) fn launcher_context_for_window_id(
        &self,
        window_id: &str,
    ) -> Result<(Window, EmbeddedLaunchTargetRecord), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "The live game-window launch context is unavailable.".to_owned())?;
        let host = state
            .native_resources.display_hosts
            .get(window_id)
            .ok_or_else(|| "The runtime window has no live native host.".to_owned())?;
        Ok((host.window.clone(), host.target.clone()))
    }

    fn record_runtime_stage(&self, stage: impl Into<String>, status: &str, started: Instant) {
        self.record_runtime_stage_with_error(stage, status, started, None, None);
    }

    fn record_runtime_stage_failure(
        &self,
        stage: impl Into<String>,
        started: Instant,
        error: &RuntimeError,
    ) {
        self.record_runtime_stage_with_error(
            stage,
            "failed",
            started,
            Some(log_error_details(error.code, &error.message)),
            error.diagnostic.clone(),
        );
    }

    fn record_runtime_stage_with_error(
        &self,
        stage: impl Into<String>,
        status: &str,
        started: Instant,
        error: Option<LogErrorDetails>,
        diagnostic: Option<RuntimeErrorDiagnostic>,
    ) {
        let stage = stage.into();
        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        eprintln!(
            "System WebView lifecycle: stage={stage} status={status} elapsedMs={}",
            elapsed_ms
        );
        let core = Arc::clone(&self.core);
        let mut context = json!({
            "elapsedMs": elapsed_ms,
            "phase": stage,
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "status": status,
        });
        if let Some(diagnostic) = diagnostic
            && let Some(context) = context.as_object_mut()
        {
            context.insert(
                "setupStage".to_owned(),
                Value::String(diagnostic.setup_stage.to_owned()),
            );
            if let Some(native_code) = diagnostic.native_code {
                context.insert("nativeCode".to_owned(), Value::String(native_code));
            }
        }
        let level = if status == "failed" {
            LogLevel::Warn
        } else {
            LogLevel::Debug
        };
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Browser,
                        event: "tab.launch-phase".to_owned(),
                        message: "Runtime tab launch phase changed.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error,
                    }],
                })
                .await;
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn record_runtime_launch_latency(
        &self,
        trace: &RuntimeLaunchLatencyTrace,
        phase: &'static str,
        status: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
        operation_id: Option<&str>,
        attempt_id: Option<&str>,
        window_generation: u64,
        surface_generation: Option<u64>,
        topology_revision: u64,
    ) {
        let elapsed_ms = trace
            .started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let context = json!({
            "attemptId": attempt_id,
            "elapsedMs": elapsed_ms,
            "hydrationOperationId": trace.hydration_operation_id,
            "intentId": trace.intent_id,
            "operationId": operation_id,
            "phase": phase,
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "status": status,
            "surfaceGeneration": surface_generation,
            "tabId": tab_id,
            "topologyRevision": topology_revision,
            "windowGeneration": window_generation,
            "windowId": window_id,
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if status == "failed" {
                            LogLevel::Warn
                        } else {
                            LogLevel::Debug
                        },
                        source: LogSource::Browser,
                        event: "runtime.launch-latency".to_owned(),
                        message: "Runtime launch advanced to an identity-fenced latency stage."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn install_surface_lifecycle_tracker(
        &self,
        webview: &Webview,
    ) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
        platform_surface_lifecycle_tracker(webview, SurfaceProcessExitTracking::Enabled)
    }

    fn install_shared_process_surface_lifecycle_tracker(
        &self,
        webview: &Webview,
    ) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
        platform_surface_lifecycle_tracker(webview, SurfaceProcessExitTracking::Disabled)
    }

    fn setup_role_surface(
        &self,
        webview: &Webview,
        role_id: &str,
        generation: u64,
        navigation: Arc<NavigationTracker>,
    ) -> Result<Arc<SurfaceLifecycleTracker>, RoleSurfaceSetupFailure> {
        let ownership = self.state().ok().and_then(|state| {
            let tab_id = state.native_tab_id_for_role_surface(role_id)?.clone();
            state.native_resources.tabs.get(&tab_id)?;
            Some(tab_id)
        }).and_then(|tab_id| {
            self.presentation
                .tab_window(&tab_id)
                .ok()
                .flatten()
                .map(|window_id| (tab_id, window_id))
        });
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Security,
            "roleSurfaceSetup",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_role(role_id)
        .with_surface_generation(generation);
        if let Some((tab_id, window_id)) = ownership {
            operation = operation.with_tab(tab_id).with_window(window_id);
        }
        let result = platform_role_surface_setup(
            webview,
            self.app.clone(),
            SurfaceFailureTarget::Role {
                role_id: role_id.to_owned(),
                generation,
            },
            navigation,
        )
        .and_then(|lifecycle| {
            self.restore_role_cookie_checkpoint(webview, role_id)
                .map_err(|error| RoleSurfaceSetupFailure {
                    error,
                    lifecycle: Some(Arc::clone(&lifecycle)),
                })?;
            Ok(lifecycle)
        });
        let receipt = match result.as_ref() {
            Ok(_) => NativeOperationReceipt::applied(operation, "securityPolicyInstalled"),
            Err(failure) => NativeOperationReceipt::with_status(
                operation,
                "securityPolicyInstallFailed",
                NativeOperationStatus::Failed,
                Some(failure.error.code),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn register_managed_surface(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        kind: ManagedSurfaceKind,
        phase: ManagedSurfacePhase,
        role_id: Option<&str>,
        tab_id: Option<&str>,
        window_id: &str,
        generation: u64,
    ) -> RuntimeResult<String> {
        let window_generation = self
            .state()?
            .native_resources.display_hosts
            .get(window_id)
            .map(|host| host.generation)
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_WINDOW_NOT_FOUND",
                    "The native window generation was unavailable while registering its surface.",
                )
            })?;
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::SurfaceLifecycle,
            "registerManagedSurface",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)
        .with_window(window_id)
        .with_window_generation(window_generation)
        .with_surface_generation(generation);
        if let Some(role_id) = role_id {
            operation = operation.with_role(role_id);
        }
        if let Some(tab_id) = tab_id {
            operation = operation.with_tab(tab_id);
        }
        let result = (|| {
            let instance_id = next_surface_instance_id(webview.label());
            let surface = ManagedSurface {
                close_operation_id: None,
                generation,
                instance_id: instance_id.clone(),
                kind,
                lifecycle: Arc::clone(lifecycle),
                native_lifecycle_lane: Arc::new(Mutex::new(())),
                phase,
                release_boundary: kind.release_boundary(),
                role_id: role_id.map(str::to_owned),
                tab_id: tab_id.map(str::to_owned),
                webview: webview.clone(),
                window_generation,
                window_id: window_id.to_owned(),
            };
            let role_fenced = {
                let mut state = self.state()?;
                let fenced = role_id.is_some_and(|role_id| {
                    state.close_coordinator.closing_roles.contains(role_id)
                        || state.close_coordinator.quarantined_roles.contains(role_id)
                });
                if !fenced {
                    state
                        .native_resources.surface_registry
                        .insert(instance_id.clone(), surface.clone());
                }
                fenced
            };
            if role_fenced {
                if let Some(role_id) = role_id {
                    let _ = self.close_surface_with_boundary_and_wait(
                        webview,
                        lifecycle,
                        role_id,
                        kind.release_boundary(),
                    );
                }
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The role is closing or quarantined and cannot register another native surface until Rion Studio restarts.",
                ));
            }
            self.record_surface_event(
                LogLevel::Debug,
                "surface.registered",
                "Native surface registered.",
                &surface,
            );
            if surface.tab_id.is_some() {
                self.record_surface_event(
                    LogLevel::Debug,
                    "tab.surface-attached",
                    "Native surface attached to a runtime tab.",
                    &surface,
                );
            }
            Ok(instance_id)
        })();
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            match kind {
                ManagedSurfaceKind::Divider => "dividerSurfaceRegistered",
                ManagedSurfaceKind::Popup => "popupSurfaceRegistered",
                ManagedSurfaceKind::Recovery => "recoverySurfaceRegistered",
                ManagedSurfaceKind::Role => "roleSurfaceRegistered",
            },
            &result,
        ));
        result
    }

    fn managed_surface(&self, instance_id: &str) -> RuntimeResult<ManagedSurface> {
        let state = self.state()?;
        state
            .native_resources.surface_registry
            .get(instance_id)
            .or_else(|| state.native_resources.retired_surface_registry.get(instance_id))
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })
    }

    fn managed_surface_ids_for_role(&self, role_id: &str) -> RuntimeResult<Vec<String>> {
        let mut surfaces = self
            .state()?
            .native_resources.surface_registry
            .values()
            .filter(|surface| {
                surface.role_id.as_deref() == Some(role_id) && surface.phase.blocks_role_relaunch()
            })
            .map(|surface| {
                let order = managed_surface_close_priority(surface.kind);
                (order, surface.instance_id.clone())
            })
            .collect::<Vec<_>>();
        surfaces.sort();
        Ok(surfaces
            .into_iter()
            .map(|(_, instance_id)| instance_id)
            .collect())
    }

    fn set_managed_surface_phase(
        &self,
        instance_id: &str,
        phase: ManagedSurfacePhase,
    ) -> RuntimeResult<()> {
        let surface = {
            let mut state = self.state()?;
            let surface = if state.native_resources.surface_registry.contains_key(instance_id) {
                state.native_resources.surface_registry.get_mut(instance_id)
            } else {
                state.native_resources.retired_surface_registry.get_mut(instance_id)
            }
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })?;
            surface.phase = phase;
            if phase == ManagedSurfacePhase::Retired {
                surface.release_boundary = SurfaceReleaseBoundary::SharedBrowserProcess;
            }
            surface.clone()
        };
        self.record_surface_event(
            LogLevel::Debug,
            "surface.phase",
            "Native surface phase changed.",
            &surface,
        );
        Ok(())
    }

    fn remove_managed_surface(&self, instance_id: &str) -> RuntimeResult<()> {
        let removed = {
            let mut state = self.state()?;
            if let Some(surface) = state.native_resources.surface_registry.get_mut(instance_id) {
                surface.phase = ManagedSurfacePhase::Released;
            }
            if let Some(surface) = state.native_resources.retired_surface_registry.get_mut(instance_id) {
                surface.phase = ManagedSurfacePhase::Released;
            }
            state
                .native_resources.surface_registry
                .remove(instance_id)
                .or_else(|| state.native_resources.retired_surface_registry.remove(instance_id))
        };
        if let Some(surface) = removed {
            #[cfg(windows)]
            windows_live_resize_unregister_surface(&surface.webview);
            self.unbind_surface_and_reconcile(
                instance_id,
                surface.webview.label(),
                "surface-released",
            );
            self.record_surface_event(
                LogLevel::Debug,
                "surface.released",
                "Native surface release confirmed.",
                &surface,
            );
        }
        Ok(())
    }

    fn record_surface_event(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        surface: &ManagedSurface,
    ) {
        let core = Arc::clone(&self.core);
        #[cfg(windows)]
        let native_navigation_id = match surface.lifecycle.navigation_id.load(Ordering::Acquire) {
            0 => None,
            navigation_id => Some(navigation_id),
        };
        #[cfg(not(windows))]
        let native_navigation_id: Option<u64> = None;
        let context = json!({
            "closeOperationId": surface.close_operation_id,
            "generation": surface.generation,
            "instanceId": surface.instance_id,
            "kind": surface.kind.as_str(),
            "nativeIsolationEvent": surface.lifecycle.native_isolation_event(),
            "nativeNavigationId": native_navigation_id,
            "navigationMatched": event == "surface.blank-finished",
            "phase": surface.phase.as_str(),
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "releaseBoundary": surface.release_boundary.as_str(),
            "roleId": surface.role_id,
            "tabId": surface.tab_id,
            "staleNativeEventCount": surface.lifecycle.stale_native_event_count(),
            "webviewLabel": surface.webview.label(),
            "windowGeneration": surface.window_generation,
            "windowId": surface.window_id,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
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

    fn record_surface_process_failure_event(
        &self,
        target: &SurfaceFailureTarget,
        reason: &str,
        scope: SurfaceFailureScope,
    ) {
        let surface = self.state.lock().ok().and_then(|state| {
            state
                .native_resources
                .surface_registry
                .values()
                .find(|surface| match target {
                    SurfaceFailureTarget::Role {
                        role_id,
                        generation,
                    } => {
                        surface.role_id.as_deref() == Some(role_id)
                            && surface.generation == *generation
                    }
                    SurfaceFailureTarget::Popup {
                        label,
                        role_id,
                        generation,
                    } => {
                        surface.webview.label() == label
                            && surface.role_id.as_deref() == Some(role_id)
                            && surface.generation == *generation
                    }
                })
                .cloned()
        });
        let Some(surface) = surface else {
            return;
        };
        let core = Arc::clone(&self.core);
        let context = json!({
            "failureScope": match scope {
                SurfaceFailureScope::Renderer => "renderer",
                #[cfg(any(windows, test))]
                SurfaceFailureScope::Browser => "browser",
            },
            "generation": surface.generation,
            "instanceId": surface.instance_id,
            "kind": surface.kind.as_str(),
            "platform": current_runtime_platform(),
            "roleId": surface.role_id,
            "tabId": surface.tab_id,
            "terminationReason": reason,
            "webviewLabel": surface.webview.label(),
            "windowId": surface.window_id,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Warn,
                        source: LogSource::Browser,
                        event: "surface.process-failed".to_owned(),
                        message: "The platform reported that a native web content process stopped."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn record_shortcut_modifier_handoff(
        &self,
        handoff: &RuntimeShortcutModifierHandoff,
        phase: &'static str,
        level: LogLevel,
        error: Option<LogErrorDetails>,
    ) {
        let core = Arc::clone(&self.core);
        let event = format!("input.modifier-handoff-{phase}");
        let message = match phase {
            "started" => "Runtime tab shortcut modifier handoff started.",
            "completed" => "Runtime tab shortcut modifiers were released from the source WebView.",
            "abandoned" => {
                "Runtime tab shortcut modifier handoff ended after the source became unavailable."
            }
            _ => "Runtime tab shortcut modifier handoff did not complete cleanly.",
        };
        let context = json!({
            "elapsedMs": handoff.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            "modifierCount": handoff.modifier_codes.len(),
            "phase": phase,
            "platform": current_runtime_platform(),
            "sourceTabId": handoff.source_tab_id,
            "windowId": handoff.window_id,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Browser,
                        event,
                        message: message.to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error,
                    }],
                })
                .await;
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn record_presentation_event(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
        elapsed_ms: u64,
    ) {
        capture_presentation_event(
            Arc::clone(&self.core),
            level,
            event,
            message,
            window_id.to_owned(),
            tab_id.map(str::to_owned),
            revision,
            trigger,
            elapsed_ms,
            None,
            None,
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn record_presentation_event_with_error(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
        elapsed_ms: u64,
        error: Option<&rion_core::CoreErrorPayload>,
    ) {
        capture_presentation_event(
            Arc::clone(&self.core),
            level,
            event,
            message,
            window_id.to_owned(),
            tab_id.map(str::to_owned),
            revision,
            trigger,
            elapsed_ms,
            None,
            error.map(|error| log_error_details(&error.code, &error.message)),
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn record_presentation_event_with_error_diagnostic(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
        elapsed_ms: u64,
        error: Option<&rion_core::CoreErrorPayload>,
        diagnostic: Option<RuntimeErrorDiagnostic>,
    ) {
        capture_presentation_event(
            Arc::clone(&self.core),
            level,
            event,
            message,
            window_id.to_owned(),
            tab_id.map(str::to_owned),
            revision,
            trigger,
            elapsed_ms,
            None,
            error.map(|error| log_error_details(&error.code, &error.message)),
            diagnostic,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn record_launch_presentation_event_with_error_diagnostic(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
        elapsed_ms: u64,
        launch_preview_id: Option<&str>,
        error: Option<&rion_core::CoreErrorPayload>,
        diagnostic: Option<RuntimeErrorDiagnostic>,
    ) {
        capture_presentation_event(
            Arc::clone(&self.core),
            level,
            event,
            message,
            window_id.to_owned(),
            tab_id.map(str::to_owned),
            revision,
            trigger,
            elapsed_ms,
            launch_preview_id.map(str::to_owned),
            error.map(|error| log_error_details(&error.code, &error.message)),
            diagnostic,
        );
    }

}
