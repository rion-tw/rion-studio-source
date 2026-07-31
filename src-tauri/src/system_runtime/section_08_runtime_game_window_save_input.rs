impl SystemRuntimeExecutor {
    pub(crate) fn runtime_game_window_save_input(
        &self,
        window_id: &str,
        name: String,
    ) -> Result<GameWindowSaveRuntimeInputRecord, String> {
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let runtime_window = snapshot
            .windows
            .iter()
            .find(|window| window.window_id == window_id)
            .ok_or_else(|| "Runtime window was not found while saving.".to_owned())?;
        let primary_id = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .as_ref()
            .map(super::monitor_id);
        let placement = query_unlocked_snapshot(
            &self.state,
            |state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| (host.window.clone(), host.target.clone()))
            },
            |(window, target)| {
                let presentation = if window.is_fullscreen().unwrap_or(false) {
                    "fullscreen"
                } else if window.is_maximized().unwrap_or(false) {
                    "maximized"
                } else {
                    "normal"
                };
                let target_display = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .map(|monitor| super::display_target_and_work_area(&monitor, primary_id).0)
                    .unwrap_or(DisplayTargetRecord {
                        id: target.display_id,
                        fingerprint: None,
                    });
                (
                    target_display,
                    GameWindowPlacementRecord {
                        normal_bounds: target.bounds,
                        saved_work_area: target.work_area,
                        presentation: presentation.to_owned(),
                    },
                )
            },
        )
        .ok_or_else(|| "Native runtime window was not found while saving.".to_owned())?;
        let native_tabs = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            runtime_window
                .tab_ids
                .iter()
                .map(|tab_id| {
                    let runtime_tab = state.tabs.get(tab_id).ok_or_else(|| {
                        "Native runtime tab was not found while saving.".to_owned()
                    })?;
                    let mut role_views = runtime_tab
                        .roles
                        .iter()
                        .map(|(role_id, surface)| GameWindowRoleViewRecord {
                            role_id: role_id.clone(),
                            rect: surface.rect.clone(),
                            browser_zoom_percent: (surface.zoom_factor * 100.0).clamp(25.0, 500.0),
                        })
                        .collect::<Vec<_>>();
                    role_views.sort_by(|left, right| left.role_id.cmp(&right.role_id));
                    Ok::<_, String>((tab_id.clone(), (runtime_tab.audio_muted, role_views)))
                })
                .collect::<Result<HashMap<_, _>, _>>()?
        };
        let tabs = runtime_window
            .tab_ids
            .iter()
            .map(|tab_id| {
                let tab = snapshot
                    .tabs
                    .iter()
                    .find(|tab| &tab.id == tab_id)
                    .ok_or_else(|| "Runtime tab metadata changed while saving.".to_owned())?;
                let (audio_muted, role_views) = native_tabs.get(tab_id).ok_or_else(|| {
                    "Native runtime tab metadata changed while saving.".to_owned()
                })?;
                Ok(GameWindowTabRecord {
                    id: tab.id.clone(),
                    tab_type: tab.tab_type.clone(),
                    source_id: tab.source_id.clone(),
                    name: tab.name.clone(),
                    role_ids: tab.role_ids.clone(),
                    hidden: tab.hidden,
                    audio_muted: *audio_muted,
                    role_views: role_views.clone(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(GameWindowSaveRuntimeInputRecord {
            window_id: window_id.to_owned(),
            name,
            target_display: placement.0,
            placement: placement.1,
            tabs,
            active_tab_id: runtime_window.active_tab_id.clone(),
        })
    }

    pub(crate) fn refresh_saved_game_windows(
        &self,
        game_windows: &[StateGameWindowRecord],
    ) -> Result<(), String> {
        let names = game_windows
            .iter()
            .map(|window| (window.id.clone(), window.name.clone()))
            .collect::<HashMap<_, _>>();
        let updates = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            state.saved_window_names = names.clone();
            state
                .display_hosts
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
        Ok(())
    }

    pub(crate) fn launcher_context_for_window_id(
        &self,
        window_id: &str,
    ) -> Result<(Window, EmbeddedLaunchTargetRecord), String> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| "The live game-window launch context is temporarily busy.".to_owned())?;
        let host = state
            .display_hosts
            .get(window_id)
            .ok_or_else(|| "The runtime window has no live native host.".to_owned())?;
        Ok((host.window.clone(), host.target.clone()))
    }

    pub(crate) fn role_zoom_factor_for_tab(
        &self,
        tab_id: &str,
        role_id: &str,
    ) -> Result<f64, String> {
        self.state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .tabs
            .get(tab_id)
            .and_then(|tab| tab.roles.get(role_id))
            .map(|surface| surface.zoom_factor)
            .ok_or_else(|| "The conflicting role has no live native surface.".to_owned())
    }

    pub(crate) fn runtime_tab_role_views(
        &self,
        tab_id: &str,
    ) -> Result<Vec<GameWindowRoleViewRecord>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        let tab = state
            .tabs
            .get(tab_id)
            .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
        let mut views = tab
            .roles
            .iter()
            .map(|(role_id, surface)| GameWindowRoleViewRecord {
                role_id: role_id.clone(),
                rect: surface.rect.clone(),
                browser_zoom_percent: (surface.zoom_factor * 100.0).clamp(25.0, 500.0),
            })
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.role_id.cmp(&right.role_id));
        Ok(views)
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

    fn install_surface_lifecycle_tracker(
        &self,
        webview: &Webview,
    ) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
        platform_surface_lifecycle_tracker(webview)
    }

    fn setup_role_surface(
        &self,
        webview: &Webview,
        role_id: &str,
        generation: u64,
    ) -> Result<Arc<SurfaceLifecycleTracker>, RoleSurfaceSetupFailure> {
        platform_role_surface_setup(
            webview,
            self.app.clone(),
            SurfaceFailureTarget::Role {
                role_id: role_id.to_owned(),
                generation,
            },
        )
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
        let instance_id = next_surface_instance_id(webview.label());
        let surface = ManagedSurface {
            close_started_at: None,
            generation,
            instance_id: instance_id.clone(),
            kind,
            lifecycle: Arc::clone(lifecycle),
            native_lifecycle_lane: Arc::new(Mutex::new(())),
            phase,
            role_id: role_id.map(str::to_owned),
            tab_id: tab_id.map(str::to_owned),
            webview: webview.clone(),
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
                    .surface_registry
                    .insert(instance_id.clone(), surface.clone());
            }
            fenced
        };
        if role_fenced {
            if let Some(role_id) = role_id {
                let _ = self.close_surface_and_wait(webview, lifecycle, role_id);
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
    }

    fn managed_surface(&self, instance_id: &str) -> RuntimeResult<ManagedSurface> {
        let state = self.state()?;
        state
            .surface_registry
            .get(instance_id)
            .or_else(|| state.retired_surface_registry.get(instance_id))
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
            .surface_registry
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
            let surface = if state.surface_registry.contains_key(instance_id) {
                state.surface_registry.get_mut(instance_id)
            } else {
                state.retired_surface_registry.get_mut(instance_id)
            }
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })?;
            surface.phase = phase;
            if phase == ManagedSurfacePhase::CloseRequested {
                surface.close_started_at = Some(Instant::now());
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
            if let Some(surface) = state.surface_registry.get_mut(instance_id) {
                surface.phase = ManagedSurfacePhase::Released;
            }
            if let Some(surface) = state.retired_surface_registry.get_mut(instance_id) {
                surface.phase = ManagedSurfacePhase::Released;
            }
            state
                .surface_registry
                .remove(instance_id)
                .or_else(|| state.retired_surface_registry.remove(instance_id))
        };
        if let Some(surface) = removed {
            self.presentation
                .unbind_surface(instance_id, surface.webview.label());
            self.record_surface_event(
                LogLevel::Debug,
                "surface.released",
                "Native surface release confirmed.",
                &surface,
            );
        }
        Ok(())
    }

    fn retire_managed_surface(&self, instance_id: &str) -> RuntimeResult<ManagedSurface> {
        let surface = {
            let mut state = self.state()?;
            if let Some(surface) = state.retired_surface_registry.get(instance_id) {
                return Ok(surface.clone());
            }
            let mut surface = state.surface_registry.remove(instance_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })?;
            surface.phase = ManagedSurfacePhase::Releasing;
            state
                .retired_surface_registry
                .insert(instance_id.to_owned(), surface.clone());
            surface
        };
        self.presentation
            .unbind_surface(instance_id, surface.webview.label());
        self.record_surface_event(
            LogLevel::Debug,
            "surface.lease-retired",
            "The isolated native surface lease moved to background cleanup.",
            &surface,
        );
        Ok(surface)
    }

    fn record_surface_event(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        surface: &ManagedSurface,
    ) {
        let core = Arc::clone(&self.core);
        let context = json!({
            "isolationMs": (event == "surface.isolated")
                .then(|| surface.close_started_at.map(|started| started.elapsed().as_millis()))
                .flatten(),
            "releaseMs": (event == "surface.released")
                .then(|| surface.close_started_at.map(|started| started.elapsed().as_millis()))
                .flatten(),
            "generation": surface.generation,
            "instanceId": surface.instance_id,
            "kind": surface.kind.as_str(),
            "phase": surface.phase.as_str(),
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "roleId": surface.role_id,
            "tabId": surface.tab_id,
            "webviewLabel": surface.webview.label(),
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
            error.map(|error| log_error_details(&error.code, &error.message)),
            diagnostic,
        );
    }

}
