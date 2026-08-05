impl SystemRuntimeExecutor {
    pub(crate) fn preview_tab_close(&self, tab_id: &str) -> Result<RuntimeTabCloseIntent, String> {
        let started = Instant::now();
        if let Some(tombstone) = self
            .state
            .lock()
            .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?
            .close_previews
            .get(tab_id)
            .cloned()
        {
            return Ok(RuntimeTabCloseIntent {
                source_id: tombstone.source_id,
                tab_type: tombstone.tab_type,
            });
        }
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
            let (runtime_window_id, isolation_surfaces) = {
                let state = self.state().map_err(|error| error.message)?;
                let tab = state
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
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
                (tab.window_id.clone(), isolation_surfaces)
            };
            let window_id = self
                .presentation
                .tab_window(tab_id)?
                .unwrap_or(runtime_window_id);
            let window = self
                .window_for_id(&window_id)
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
            let (
                original_active_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                next_tab_id,
                revision,
                source_id,
                tab_type,
                role_ids,
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
                    presentation_tab.role_ids,
                )
            };
            let mut state = self.state().map_err(|error| error.message)?;
            state.optimistic_closed_tabs.insert(tab_id.to_owned());
            let slot_owners = state
                .tabs
                .get(tab_id)
                .map(|tab| {
                    tab.slots
                        .values()
                        .map(|slot| {
                            (
                                slot.slot_id.clone(),
                                slot.role.id.clone(),
                                slot.owner_generation,
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            state.close_previews.insert(
                tab_id.to_owned(),
                TabCloseTombstone {
                    revision,
                    role_ids,
                    slot_owners,
                    source_id: source_id.clone(),
                    tab_type: tab_type.clone(),
                    window_id: window_id.clone(),
                },
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
            window_id.clone(),
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
        // A window close flushes the complete pre-close LiveWindowTabState before
        // BrowserWindowStop starts isolating its tabs. Those teardown tombstones
        // are not user tab mutations and must never overwrite that final snapshot
        // with one tab, then zero tabs, on the debounced persistence lane.
        if !self.current_window_close_in_progress(&window_id) {
            self.schedule_live_window_state_persistence(&window_id);
        }
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
        let tombstone = if let Ok(mut state) = self.state.lock() {
            let tombstone = state.close_previews.remove(tab_id);
            if succeeded || !state.tabs.contains_key(tab_id) {
                state.optimistic_closed_tabs.remove(tab_id);
            } else {
                let role_ids = tombstone
                    .as_ref()
                    .map(|tombstone| {
                        tombstone
                            .slot_owners
                            .iter()
                            .map(|(_, role_id, _)| role_id.clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| {
                        state
                            .tabs
                            .get(tab_id)
                            .map(|tab| tab.roles.keys().cloned().collect::<Vec<_>>())
                            .unwrap_or_default()
                    });
                state.close_coordinator.quarantined_roles.extend(role_ids);
                for surface in state
                    .surface_registry
                    .values_mut()
                    .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                {
                    surface.phase = ManagedSurfacePhase::Quarantined;
                }
            }
            tombstone
        } else {
            None
        };
        if let Some(tombstone) = tombstone {
            self.record_tab_close_tombstone_resolution(tab_id, &tombstone, succeeded);
        }
        self.publish_projection();
    }

    fn record_tab_close_tombstone_resolution(
        &self,
        tab_id: &str,
        tombstone: &TabCloseTombstone,
        succeeded: bool,
    ) {
        let owner_generations = tombstone
            .slot_owners
            .iter()
            .filter(|(_, _, generation)| generation.is_some())
            .count();
        self.record_presentation_event(
            if succeeded {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            "tab.close-tombstone-resolved",
            if succeeded {
                "The live tab tombstone completed after role isolation."
            } else {
                "The live tab tombstone retained fenced role ownership after isolation could not be confirmed."
            },
            &tombstone.window_id,
            Some(tab_id),
            tombstone.revision,
            if owner_generations == 0 {
                "no-owned-slots"
            } else {
                "generation-fenced-slots"
            },
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

    /// Overlays Core metadata with the already-committed live topology. Core
    /// snapshots are allowed to lag, but they can never move, reorder, reveal,
    /// hide, or select an open-window tab on their way back through a native
    /// effect or renderer projection.
    fn snapshot_with_live_tab_topology(
        &self,
        mut snapshot: BrowserRuntimeSnapshot,
    ) -> Option<BrowserRuntimeSnapshot> {
        // Fail closed when the live authority cannot be read. Returning the raw
        // Core snapshot here would let a delayed projection become a second UI
        // authority precisely when the presentation registry is unhealthy.
        let live_windows = self.presentation.snapshot_states().ok()?;
        let optimistic_closed_tabs = self
            .state
            .lock()
            .map(|state| state.optimistic_closed_tabs.clone())
            .unwrap_or_default();
        let live_owners = live_windows
            .iter()
            .flat_map(|(window_id, live)| {
                live.all_tab_ids()
                    .into_iter()
                    .map(|tab_id| (tab_id, window_id.clone()))
            })
            .collect::<HashMap<_, _>>();
        for tab in &mut snapshot.tabs {
            if let Some(window_id) = live_owners.get(&tab.id) {
                tab.window_id = window_id.clone();
                tab.hidden = live_windows
                    .get(window_id)
                    .is_some_and(|live| live.tab_is_hidden(&tab.id));
            } else if optimistic_closed_tabs.contains(&tab.id) {
                tab.hidden = true;
            }
        }
        let snapshot_tab_ids = snapshot
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect::<HashSet<_>>();
        for window_id in live_windows.keys().chain(snapshot.tabs.iter().map(|tab| &tab.window_id)) {
            if !snapshot
                .windows
                .iter()
                .any(|window| window.window_id == *window_id)
            {
                snapshot.windows.push(BrowserRuntimeWindowRecord {
                    window_id: window_id.clone(),
                    active_tab_id: None,
                    tab_ids: Vec::new(),
                });
            }
        }
        for window in &mut snapshot.windows {
            let core_order = window.tab_ids.clone();
            if let Some(live) = live_windows.get(&window.window_id) {
                let mut ordered = live
                    .all_tab_ids()
                    .into_iter()
                    .filter(|tab_id| {
                        snapshot_tab_ids.contains(tab_id)
                            && !optimistic_closed_tabs.contains(tab_id)
                    })
                    .collect::<Vec<_>>();
                let mut seen = ordered.iter().cloned().collect::<HashSet<_>>();
                ordered.extend(core_order.into_iter().filter(|tab_id| {
                    seen.insert(tab_id.clone())
                        && !live_owners.contains_key(tab_id)
                        && !optimistic_closed_tabs.contains(tab_id)
                }));
                window.tab_ids = ordered;
                window.active_tab_id = live.selected_tab_id.clone().filter(|tab_id| {
                    !live.tab_is_hidden(tab_id)
                        && window.tab_ids.contains(tab_id)
                        && !optimistic_closed_tabs.contains(tab_id)
                });
            } else {
                window.tab_ids.retain(|tab_id| {
                    !live_owners.contains_key(tab_id)
                        && !optimistic_closed_tabs.contains(tab_id)
                });
                window.active_tab_id = window
                    .active_tab_id
                    .take()
                    .filter(|tab_id| window.tab_ids.contains(tab_id));
            }
        }
        Some(snapshot)
    }

    pub fn restore_tab_audio_muted(&self, source_id: &str, muted: bool) -> Result<(), String> {
        let tab_id = self
            .presentation
            .tab_for_source(source_id, "role")
            .or_else(|| self.presentation.tab_for_source(source_id, "workspace"))
            .ok_or_else(|| "The restored runtime tab was not found in live topology.".to_owned())?;
        let role_id = self
            .state()
            .map_err(|error| error.message)?
            .tabs
            .get(&tab_id)
            .and_then(|tab| tab.roles.keys().next())
            .cloned()
            .ok_or_else(|| "The restored runtime tab has no owned role surface.".to_owned())?;
        self.set_role_audio_muted(&role_id, muted)
            .map_err(|error| error.message)
    }

}

fn retire_completed_tab_close_fence(
    state: &mut RuntimeState,
    tab_id: &str,
) -> Option<TabCloseTombstone> {
    state.optimistic_closed_tabs.remove(tab_id);
    state.close_previews.remove(tab_id)
}

impl SystemRuntimeExecutor {
    pub fn resize_window(&self, label: &str, physical_width: u32, physical_height: u32) -> bool {
        if self.require_runtime_accepting().is_err() {
            return false;
        }
        let Some((window_id, window)) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .iter()
                .find(|(_, host)| host.window.label() == label)
                .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
        }) else {
            return false;
        };
        if self.state.lock().ok().is_some_and(|state| {
            state.active_geometry_windows.contains(&window_id)
        }) {
            return false;
        }
        if self.native_window_mutations.is_busy(&window_id) {
            return false;
        }
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
        let maximized = window.is_maximized().unwrap_or(false);
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        let presentation = if fullscreen {
            "fullscreen"
        } else if maximized {
            "maximized"
        } else {
            "normal"
        };
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&window_id)
        {
            host.target.presentation = presentation.to_owned();
            if !maximized && !fullscreen && !minimized {
                host.target.bounds.width = width.round() as i32;
                host.target.bounds.height = height.round() as i32;
            }
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
        if self.require_runtime_accepting().is_err() {
            return;
        }
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
        if self.state.lock().ok().is_some_and(|state| {
            state.active_geometry_windows.contains(&window_id)
        }) {
            return;
        }
        if self.native_window_mutations.is_busy(&window_id) {
            return;
        }
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
        self.apply_window_geometry_target(
            &target,
            GeometryMutationScope::WindowAndLayout,
            "relocateGameWindow",
        )
        .map_err(|error| error.message)
    }

    pub fn observe_window_focus(self: &Arc<Self>, label: &str) {
        let Some((window_id, generation)) = self.state.lock().ok().and_then(|state| {
            state.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| (window_id.clone(), host.generation))
            })
        }) else {
            return;
        };
        let selected_tab_id = self
            .presentation
            .existing(&window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .and_then(|state| state.selected_tab_id.clone())
            });
        self.focus_broker.observe_native_focus(
            &window_id,
            generation,
            0,
            selected_tab_id,
        );
        let is_saved = self.state.lock().ok().is_some_and(|state| {
            state.saved_window_names.contains_key(&window_id)
        });
        if !is_saved {
            return;
        }
        let core = Arc::clone(&self.core);
        let focused_window_id = window_id.clone();
        let _ = thread::Builder::new()
            .name("rion-runtime-focus-journal".to_owned())
            .spawn(move || {
                if let Ok(mut session) = core
                    .invoke(CoreCommand::RuntimeRestoreSessionGet)
                    .and_then(|value| {
                        serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                            .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
                    })
                {
                    session.last_focused_window_id = Some(focused_window_id);
                    session.updated_at = chrono::Utc::now().to_rfc3339();
                    let _ = core.invoke(CoreCommand::RuntimeRestoreSessionReplace { session });
                }
            });
        self.schedule_window_placement_persistence(label.to_owned());
    }

    pub fn observe_window_blur(&self, label: &str) {
        if let Some((window_id, generation)) = self.state.lock().ok().and_then(|state| {
            state.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| (window_id.clone(), host.generation))
            })
        }) {
            self.focus_broker
                .observe_native_blur(&window_id, generation);
        }
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
        let Some((window_id, is_saved)) = self.state.lock().ok().and_then(|state| {
            state.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| {
                    (
                        window_id.clone(),
                        state.saved_window_names.contains_key(window_id),
                    )
                })
            })
        }) else {
            return Ok(());
        };
        if !is_saved {
            return Ok(());
        }
        self.touch_live_window_state(&window_id)?;
        self.schedule_live_window_state_persistence(&window_id);
        Ok(())
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
                let mut native_blocked_since = None;
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
                    let native_busy = runtime
                        .window_id_for_label(&worker_label)
                        .is_some_and(|window_id| {
                            runtime.native_window_mutations.is_busy(&window_id)
                        });
                    let shutdown_state = RuntimeShutdownState::from_raw(
                        runtime.shutdown_state.load(Ordering::Acquire),
                    );
                    if native_resize_should_retry(
                        native_busy,
                        shutdown_state,
                        native_blocked_since
                            .map(|started: Instant| started.elapsed())
                            .unwrap_or_default(),
                    ) {
                        native_blocked_since.get_or_insert_with(Instant::now);
                        if let Ok(mut state) = runtime.state.lock() {
                            state
                                .pending_window_resizes
                                .entry(worker_label.clone())
                                .or_insert((width, height));
                        }
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    } else {
                        native_blocked_since = None;
                    }
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

fn native_resize_should_retry(
    native_busy: bool,
    shutdown_state: RuntimeShutdownState,
    blocked_for: Duration,
) -> bool {
    native_busy
        && shutdown_state == RuntimeShutdownState::Accepting
        && blocked_for < PLATFORM_CALLBACK_TIMEOUT
}
