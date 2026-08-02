impl SystemRuntimeExecutor {
    pub(crate) fn preview_tab_close(&self, tab_id: &str) -> Result<RuntimeTabCloseIntent, String> {
        let started = Instant::now();
        let (
            window,
            window_id,
            isolation_surfaces,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            next_tab_id,
            revision,
            source_id,
            tab_type,
        ) = {
            let (window_id, window, isolation_surfaces) = {
                let state = self.state().map_err(|error| error.message)?;
                let tab = state
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
                let window_id = tab.window_id.clone();
                let window = state
                    .display_hosts
                    .get(&window_id)
                    .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                    .window
                    .clone();
                let isolation_surfaces = state
                    .surface_registry
                    .values()
                    .filter(|surface| {
                        surface.tab_id.as_deref() == Some(tab_id)
                            && surface.kind != ManagedSurfaceKind::Divider
                            && surface.phase.blocks_role_relaunch()
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                (window_id, window, isolation_surfaces)
            };
            let (
                original_active_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                next_tab_id,
                revision,
                source_id,
                tab_type,
            ) = {
                let presentation = self.presentation.coordinator(&window_id)?;
                let revision = self.presentation.next_revision();
                let mut window_state = presentation.lock().map_err(|_| {
                    "The runtime tab presentation coordinator is unavailable.".to_owned()
                })?;
                if !window_state.contains_tab(tab_id) {
                    return Err("Runtime tab was not found in the presentation state.".to_owned());
                }
                let presentation_tab = window_state
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .cloned()
                    .ok_or_else(|| "Runtime tab presentation metadata was not found.".to_owned())?;
                let original_active_tab_id = window_state.selected_tab_id.clone();
                let previous_surfaces = window_state.surfaces(original_active_tab_id.as_deref());
                let next_tab_id = if original_active_tab_id.as_deref() == Some(tab_id) {
                    successor_tab_after_close(&window_state.tab_ids(), tab_id, |_| true)
                } else {
                    original_active_tab_id.clone()
                };
                window_state.remove_tab(tab_id, revision);
                window_state.select(next_tab_id.clone(), revision);
                let next_surfaces = window_state.surfaces(next_tab_id.as_deref());
                let active_webview = next_surfaces.first().cloned();
                (
                    original_active_tab_id,
                    previous_surfaces,
                    next_surfaces,
                    active_webview,
                    next_tab_id,
                    revision,
                    presentation_tab.source_id,
                    presentation_tab.tab_type,
                )
            };
            let mut state = self.state().map_err(|error| error.message)?;
            state.optimistic_closed_tabs.insert(tab_id.to_owned());
            state.close_previews.insert(
                tab_id.to_owned(),
                CloseTransaction,
            );
            (
                window,
                window_id,
                isolation_surfaces,
                original_active_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                next_tab_id,
                revision,
                source_id,
                tab_type,
            )
        };
        let elapsed = started.elapsed();
        self.publish_launcher_presence();
        self.apply_native_active_style(&window_id, next_tab_id.as_deref(), revision, "close");
        self.record_tab_close_presentation(tab_id, next_tab_id.as_deref(), revision, elapsed);
        self.dispatch_native_presentation(
            window_id,
            next_tab_id.clone(),
            revision,
            "close",
            started,
            window,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            next_tab_id.is_none().then_some(false),
            NativePresentationFocus::ContentOnly,
            None,
        );
        self.request_preview_surface_isolation(isolation_surfaces);
        Ok(RuntimeTabCloseIntent {
            source_id,
            tab_type,
        })
    }

    fn request_preview_surface_isolation(&self, surfaces: Vec<ManagedSurface>) {
        if surfaces.is_empty() {
            return;
        }
        for surface in &surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.isolation-requested-early",
                "Native isolation was requested directly from the presentation close transaction.",
                surface,
            );
        }

        #[cfg(target_os = "macos")]
        for surface in surfaces {
            // The native adapter dispatches to AppKit without waiting. This must
            // precede Core persistence so a rapid close burst takes every game
            // page offline even while metadata commits are queued.
            let _ = quiesce_platform_surface(&surface.webview, &surface.lifecycle);
        }

        #[cfg(windows)]
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::scope(|scope| {
                for surface in &surfaces {
                    scope.spawn(move || {
                        let _ = quiesce_platform_surface(&surface.webview, &surface.lifecycle);
                    });
                }
            });
        });

        #[cfg(not(any(windows, target_os = "macos")))]
        for surface in surfaces {
            let _ = quiesce_platform_surface(&surface.webview, &surface.lifecycle);
        }
    }

    pub(crate) fn resolve_tab_close_preview(&self, tab_id: &str, succeeded: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.close_previews.remove(tab_id);
            if succeeded || !state.tabs.contains_key(tab_id) {
                state.optimistic_closed_tabs.remove(tab_id);
            } else {
                let role_ids = state
                    .tabs
                    .get(tab_id)
                    .map(|tab| tab.roles.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                state.close_coordinator.quarantined_roles.extend(role_ids);
                for surface in state
                    .surface_registry
                    .values_mut()
                    .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                {
                    surface.phase = ManagedSurfacePhase::Quarantined;
                }
            }
        }
        self.publish_projection();
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn cancel_tab_close_preview(&self, tab_id: &str) {
        self.resolve_tab_close_preview(tab_id, false);
    }

    pub(crate) fn reconcile_tab_activation(&self, window_id: &str) {
        let (tab_id, revision) = self
            .presentation
            .existing(window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .map(|window| (window.selected_tab_id.clone(), window.revision))
            })
            .unwrap_or((None, 0));
        self.record_presentation_event(
            LogLevel::Warn,
            "tab.selection-persist-failed",
            "The visual tab selection was retained after metadata persistence failed.",
            window_id,
            tab_id.as_deref(),
            revision,
            "persistence",
            0,
        );
    }

    pub(crate) fn tab_selection_revision(&self, window_id: &str, tab_id: &str) -> Option<u64> {
        self.presentation
            .existing(window_id)
            .and_then(|presentation| {
                presentation.lock().ok().and_then(|window| {
                    (window.selected_tab_id.as_deref() == Some(tab_id)).then_some(window.revision)
                })
            })
    }

    pub(crate) fn tab_selection_is_desired(
        &self,
        window_id: &str,
        tab_id: &str,
        selection_revision: u64,
    ) -> bool {
        self.tab_selection_revision(window_id, tab_id) == Some(selection_revision)
    }

    fn snapshot_with_native_tab_locations(
        &self,
        mut snapshot: BrowserRuntimeSnapshot,
    ) -> BrowserRuntimeSnapshot {
        let selected_tabs = self.presentation.selected_tabs();
        let Ok(state) = self.state.lock() else {
            return snapshot;
        };
        let native_locations = state
            .tabs
            .iter()
            .map(|(tab_id, tab)| (tab_id.as_str(), tab.window_id.as_str()))
            .collect::<HashMap<_, _>>();
        for tab in &mut snapshot.tabs {
            if let Some(window_id) = native_locations.get(tab.id.as_str()) {
                tab.window_id = (*window_id).to_owned();
            }
        }
        for window in &mut snapshot.windows {
            window.tab_ids.clear();
            window.active_tab_id = None;
        }
        for tab in &snapshot.tabs {
            if !snapshot
                .windows
                .iter()
                .any(|window| window.window_id == tab.window_id)
            {
                snapshot.windows.push(BrowserRuntimeWindowRecord {
                    window_id: tab.window_id.clone(),
                    active_tab_id: None,
                    tab_ids: Vec::new(),
                });
            }
            let window = snapshot
                .windows
                .iter_mut()
                .find(|window| window.window_id == tab.window_id)
                .expect("native tab window was inserted");
            window.tab_ids.push(tab.id.clone());
            if selected_tabs
                .get(&tab.window_id)
                .is_some_and(|selected| selected == &tab.id)
                && !state.optimistic_closed_tabs.contains(&tab.id)
            {
                window.active_tab_id = Some(tab.id.clone());
            }
        }
        for window in &mut snapshot.windows {
            if window.active_tab_id.is_none() {
                window.active_tab_id = window
                    .tab_ids
                    .iter()
                    .find(|tab_id| !state.optimistic_closed_tabs.contains(tab_id.as_str()))
                    .cloned();
            }
        }
        snapshot
    }

    pub fn restore_tab_audio_muted(&self, source_id: &str, muted: bool) -> Result<(), String> {
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let role_id = snapshot
            .tabs
            .iter()
            .find(|tab| tab.source_id == source_id)
            .and_then(|tab| tab.role_ids.first())
            .ok_or_else(|| "The restored runtime tab has no role surface.".to_owned())?;
        self.set_role_audio_muted(role_id, muted)
            .map_err(|error| error.message)
    }

    pub(crate) fn begin_window_close_requested(
        &self,
        label: &str,
    ) -> RuntimeResult<RuntimeWindowCloseRequest> {
        let mut state = self.state()?;
        if state.allow_window_close_labels.remove(label) {
            return Ok(RuntimeWindowCloseRequest::PassThrough);
        }
        let Some((window_id, window)) = state.display_hosts.iter().find_map(|(window_id, host)| {
            (host.window.label() == label).then(|| (window_id.clone(), host.window.clone()))
        }) else {
            return Ok(RuntimeWindowCloseRequest::PassThrough);
        };
        if !state.pending_window_close_labels.insert(label.to_owned()) {
            return Ok(RuntimeWindowCloseRequest::Pending);
        }
        Ok(RuntimeWindowCloseRequest::Start {
            window_id,
            window: Box::new(window),
        })
    }

    pub(crate) fn finish_window_close_requested(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_window_close_labels.remove(label);
        }
    }

    pub fn resize_window(&self, label: &str, physical_width: u32, physical_height: u32) -> bool {
        let Some((window_id, window)) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .iter()
                .find(|(_, host)| host.window.label() == label)
                .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
        }) else {
            return false;
        };
        if !runtime_window_resize_is_actionable(
            physical_width,
            physical_height,
            window.is_minimized().unwrap_or(false),
        ) {
            return false;
        }
        let scale_factor = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
        let width = (physical_width as f64 / scale_factor).max(1.0);
        let height = (physical_height as f64 / scale_factor).max(1.0);
        let normal_state = !window.is_maximized().unwrap_or(false)
            && !window.is_fullscreen().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false);
        if normal_state
            && let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&window_id)
        {
            host.target.bounds.width = width.round() as i32;
            host.target.bounds.height = height.round() as i32;
        }
        let tab_ids = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .tabs
                    .iter()
                    .filter_map(|(tab_id, tab)| {
                        (tab.window_id == window_id).then_some(tab_id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut layout_errors = Vec::new();
        for tab_id in tab_ids {
            if let Err(error) = self.layout_runtime_tab(&tab_id) {
                layout_errors.push(format!("{tab_id}: {}: {}", error.code, error.message));
            }
        }
        if !layout_errors.is_empty() {
            self.emit_runtime_shell_error(
                "TAURI_RUNTIME_WINDOW_LAYOUT_FAILED",
                layout_errors.join("; "),
                label,
            );
        }
        self.publish_projection();
        true
    }

    pub fn move_window(self: &Arc<Self>, label: &str, physical_x: i32, physical_y: i32) {
        // Tauri window queries can synchronously marshal to AppKit's main thread.
        // Snapshot the native window while holding the runtime lock, then release
        // the lock before making any of those calls to avoid lock inversion with
        // window callbacks handled by the main event loop.
        let Some((window_id, logical_x, logical_y, monitor_target)) = query_unlocked_snapshot(
            &self.state,
            |state| {
                state
                    .display_hosts
                    .iter()
                    .find(|(_, host)| host.window.label() == label)
                    .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
            },
            |(window_id, window)| {
                if window.is_maximized().unwrap_or(false)
                    || window.is_fullscreen().unwrap_or(false)
                    || window.is_minimized().unwrap_or(false)
                {
                    return None;
                }
                let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
                let (logical_x, logical_y) = logical_window_position(physical_x, physical_y, scale);
                let monitor_target = window.current_monitor().ok().flatten().map(|monitor| {
                    let scale = monitor.scale_factor().max(f64::EPSILON);
                    let work_area = monitor.work_area();
                    (
                        super::monitor_id(&monitor),
                        StatePixelBoundsRecord {
                            x: (work_area.position.x as f64 / scale).round() as i32,
                            y: (work_area.position.y as f64 / scale).round() as i32,
                            width: (work_area.size.width as f64 / scale).round() as i32,
                            height: (work_area.size.height as f64 / scale).round() as i32,
                        },
                        scale,
                    )
                });
                Some((window_id, logical_x, logical_y, monitor_target))
            },
        )
        .flatten() else {
            return;
        };
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&window_id)
        {
            host.target.bounds.x = logical_x;
            host.target.bounds.y = logical_y;
            if let Some((display_id, work_area, scale_factor)) = monitor_target {
                host.target.display_id = display_id;
                host.target.work_area = work_area;
                host.target.scale_factor = scale_factor;
            }
        }
        self.schedule_window_placement_persistence(label.to_owned());
    }

    pub fn relocate_game_window(&self, target: EmbeddedLaunchTargetRecord) -> Result<(), String> {
        self.relocate_game_window_if_live(target).map(|_| ())
    }

    pub fn relocate_game_window_if_live(
        &self,
        target: EmbeddedLaunchTargetRecord,
    ) -> Result<bool, String> {
        let Some(window) = self.window_for_id(&target.window_id) else {
            return Ok(false);
        };
        if window.is_fullscreen().unwrap_or(false) {
            window
                .set_fullscreen(false)
                .map_err(|error| error.to_string())?;
        }
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|error| error.to_string())?;
        }
        let (physical_x, physical_y) =
            physical_window_position(target.bounds.x, target.bounds.y, target.scale_factor);
        window
            .set_position(PhysicalPosition::new(physical_x, physical_y))
            .map_err(|error| error.to_string())?;
        window
            .set_size(LogicalSize::new(
                target.bounds.width.max(1) as f64,
                target.bounds.height.max(1) as f64,
            ))
            .map_err(|error| error.to_string())?;
        let tab_ids = {
            let mut state = self.state().map_err(|error| error.message)?;
            if let Some(host) = state.display_hosts.get_mut(&target.window_id) {
                host.target = target.clone();
            }
            state
                .tabs
                .iter()
                .filter_map(|(tab_id, tab)| {
                    (tab.window_id == target.window_id).then_some(tab_id.clone())
                })
                .collect::<Vec<_>>()
        };
        for tab_id in tab_ids {
            self.layout_runtime_tab(&tab_id)
                .map_err(|error| error.message)?;
        }
        match target.presentation.as_str() {
            "fullscreen" => window
                .set_fullscreen(true)
                .map_err(|error| error.to_string())?,
            "maximized" => window.maximize().map_err(|error| error.to_string())?,
            _ => {}
        }
        self.publish_projection();
        Ok(true)
    }

    pub fn focus_window(self: &Arc<Self>, label: &str) {
        let Some(window_id) = self.window_id_for_label(label) else {
            return;
        };
        if !self.is_saved_game_window(&window_id).unwrap_or(false) {
            return;
        }
        if let Ok(mut session) = self
            .core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .and_then(|value| {
                serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            })
        {
            session.last_focused_window_id = Some(window_id);
            session.updated_at = chrono::Utc::now().to_rfc3339();
            let _ = self
                .core
                .invoke(CoreCommand::RuntimeRestoreSessionReplace { session });
        }
        self.schedule_window_placement_persistence(label.to_owned());
    }

    pub fn persist_all_game_window_placements(&self) -> Result<(), String> {
        let labels = self
            .state
            .lock()
            .map(|state| {
                state
                    .display_hosts
                    .values()
                    .map(|host| host.window.label().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for label in labels {
            self.persist_game_window_placement(&label)?;
        }
        Ok(())
    }

    pub(crate) fn persist_game_window_placement(&self, label: &str) -> Result<(), String> {
        let Some(window_id) = self.window_id_for_label(label) else {
            return Ok(());
        };
        if !self.is_saved_game_window(&window_id)? {
            return Ok(());
        }
        let primary_id = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .as_ref()
            .map(super::monitor_id);
        // Do not call into Tauri/AppKit while holding RuntimeState. These queries
        // may synchronously wait for the main thread, which also handles moved
        // events and needs the same mutex.
        let snapshot = query_unlocked_snapshot(
            &self.state,
            |state| {
                state
                    .display_hosts
                    .values()
                    .find(|host| host.window.label() == label)
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
                let display_target = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .map(|monitor| super::display_target_and_work_area(&monitor, primary_id).0)
                    .unwrap_or(DisplayTargetRecord {
                        id: target.display_id,
                        fingerprint: None,
                    });
                (target, display_target, presentation.to_owned())
            },
        );
        let Some((target, display_target, presentation)) = snapshot else {
            return Ok(());
        };
        self.core
            .invoke(CoreCommand::GameWindowUpdate {
                id: target.window_id,
                input: GameWindowUpdateInputRecord {
                    target_display: Some(display_target),
                    placement: Some(GameWindowPlacementRecord {
                        normal_bounds: target.bounds,
                        saved_work_area: target.work_area,
                        presentation,
                    }),
                    ..GameWindowUpdateInputRecord::default()
                },
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn schedule_resize_window(
        self: &Arc<Self>,
        label: String,
        physical_width: u32,
        physical_height: u32,
    ) {
        let should_spawn = self.state.lock().ok().is_some_and(|mut state| {
            state
                .pending_window_resizes
                .insert(label.clone(), (physical_width, physical_height));
            state.active_window_resize_workers.insert(label.clone())
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::clone(self);
        let worker_label = label.clone();
        if std::thread::Builder::new()
            .name("rion-runtime-window-resize".to_owned())
            .spawn(move || {
                loop {
                    let next = runtime.state.lock().ok().and_then(|mut state| {
                        let next = state.pending_window_resizes.remove(&worker_label);
                        if next.is_none() {
                            state.active_window_resize_workers.remove(&worker_label);
                        }
                        next
                    });
                    let Some((width, height)) = next else {
                        break;
                    };
                    if runtime.resize_window(&worker_label, width, height) {
                        runtime.schedule_window_placement_persistence(worker_label.clone());
                    }
                }
            })
            .is_err()
            && let Ok(mut state) = self.state.lock()
        {
            state.active_window_resize_workers.remove(&label);
            state.pending_window_resizes.remove(&label);
        }
    }

}
