impl SystemRuntimeExecutor {
    pub(crate) fn preview_tab_close(&self, tab_id: &str) -> Result<RuntimeTabCloseIntent, String> {
        self.preview_tab_close_with_presentation(tab_id, true, None)
    }

    fn preview_tab_close_with_presentation(
        &self,
        tab_id: &str,
        present_successor: bool,
        parent_operation_id: Option<&str>,
    ) -> Result<RuntimeTabCloseIntent, String> {
        let started = Instant::now();
        let existing_tombstone = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?;
            if let Some(parent_operation_id) = parent_operation_id {
                if let Some(tombstone) = state.close_previews.get_mut(tab_id) {
                    tombstone.parent_operation_id = Some(parent_operation_id.to_owned());
                }
                for surface in state
                    .native_resources.surface_registry
                    .values_mut()
                    .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                {
                    surface.close_operation_id = Some(parent_operation_id.to_owned());
                }
            }
            state.close_previews.get(tab_id).cloned()
        };
        if let Some(tombstone) = existing_tombstone {
            return Ok(RuntimeTabCloseIntent {
                source_id: tombstone.source_id,
                tab_type: tombstone.tab_type,
            });
        }
        let window_id = self
            .presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer in the live topology.".to_owned())?;
        let kernel_operation_id = uuid::Uuid::new_v4().to_string();
        let (close_attempt_id, close_surface_generation) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?;
            let attempt_id = state
                .launch_attempt_generations
                .get(tab_id)
                .cloned()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let surface_generation = state
                .native_resources.surface_registry
                .values()
                .chain(state.native_resources.retired_surface_registry.values())
                .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                .map(|surface| surface.generation)
                .max()
                .unwrap_or_default();
            (attempt_id, surface_generation)
        };
        let (
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            next_tab_id,
            revision,
            source_id,
            tab_type,
        ) = {
            let presentation = self
                .presentation
                .existing(&window_id)
                .ok_or_else(|| "The live runtime window is no longer available.".to_owned())?;
            let mut next = presentation.record.clone();
            let presentation_tab = next
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| "Runtime tab is no longer in the live topology.".to_owned())?;
            let original_active_tab_id = next.selected_tab_id.clone();
            let previous_surfaces = self
                .presentation
                .surfaces(&window_id, original_active_tab_id.as_deref());
            let next_tab_id = if original_active_tab_id.as_deref() == Some(tab_id) {
                successor_tab_after_close(&next.tab_ids(), tab_id, |candidate| {
                    !next.hidden_tab_ids.contains(candidate)
                })
            } else {
                original_active_tab_id.clone()
            };
            next.remove_tab(tab_id, 0);
            next.select(next_tab_id.clone(), 0);
            let receipt = self.presentation.commit_live_tab_close(
                &close_attempt_id,
                &kernel_operation_id,
                close_surface_generation,
                tab_id,
                &window_id,
                next_tab_id.as_deref(),
            )?;
            if receipt.status == LiveTopologyCommitStatus::Superseded {
                return Err("The tab close was superseded by newer live topology.".to_owned());
            }
            let revision = receipt.revision;
            let next_surfaces = self
                .presentation
                .surfaces(&window_id, next_tab_id.as_deref());
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
        self.schedule_live_projection_membership_follow();
        let isolation_surfaces = {
            let mut state = self.state().map_err(|error| error.message)?;
            let retirement_revision = if next_tab_id.is_none() {
                state.native_resources.display_hosts.get_mut(&window_id).map(|host| {
                    let revision = WINDOW_RETIREMENT_SEQUENCE
                        .fetch_add(1, Ordering::AcqRel)
                        .saturating_add(1);
                    host.retirement_revision = revision;
                    revision
                })
            } else {
                None
            };
            let mut isolation_surfaces = Vec::new();
            for surface in state.native_resources.surface_registry.values_mut().filter(|surface| {
                    surface.tab_id.as_deref() == Some(tab_id)
                        && surface.kind != ManagedSurfaceKind::Divider
                        && surface.phase.blocks_role_relaunch()
                }) {
                if let Some(parent_operation_id) = parent_operation_id {
                    surface.close_operation_id = Some(parent_operation_id.to_owned());
                }
                isolation_surfaces.push(surface.clone());
            }
            let slot_owners = state
                .native_resources.tabs
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
                    kernel_operation_id: kernel_operation_id.clone(),
                    parent_operation_id: parent_operation_id.map(str::to_owned),
                    revision,
                    retirement_revision,
                    slot_owners,
                    source_id: source_id.clone(),
                    tab_type: tab_type.clone(),
                    window_id: window_id.clone(),
                },
            );
            isolation_surfaces
        };
        let elapsed = started.elapsed();
        self.publish_launcher_presence();
        if present_successor {
            self.record_tab_close_presentation(tab_id, next_tab_id.as_deref(), revision, elapsed);

            // The Kernel close commit above is the sole membership authority. Project its
            // removal to native tab chrome before presenting the successor; otherwise AppKit
            // and the Windows HTML strip can retain a selectable ghost for a tab whose logical
            // owner and surfaces are already terminally closing. A native projection failure
            // cannot compensate or roll back the committed close, so record it and continue
            // forward with surface isolation.
            let native_close_started = Instant::now();
            let native_close = self.try_remove_native_tab_reservation(
                &window_id,
                tab_id,
                next_tab_id.as_deref(),
            );
            self.record_presentation_event(
                if native_close.is_ok() {
                    LogLevel::Debug
                } else {
                    LogLevel::Warn
                },
                if native_close.is_ok() {
                    "tab.chrome-removal-submitted"
                } else {
                    "tab.chrome-removal-submit-failed"
                },
                if native_close.is_ok() {
                    "Native tab chrome accepted the committed logical tab removal projection."
                } else {
                    "Native tab chrome rejected the committed logical tab removal projection."
                },
                &window_id,
                Some(tab_id),
                revision,
                "close",
                native_close_started
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            );
        }
        if present_successor
            && let Some(window) = self.window_for_id(&window_id)
        {
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
        }
        self.request_preview_surface_isolation(isolation_surfaces);
        // A window close flushes the complete pre-close LiveWindowRecord before
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
            if let Ok(request) = quiesce_platform_surface(&surface.webview, &surface.lifecycle) {
                self.record_surface_isolation_request(surface.webview.label(), request);
            }
        }

        #[cfg(windows)]
        let runtime = self.self_weak.get().and_then(std::sync::Weak::upgrade);
        #[cfg(windows)]
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::scope(|scope| {
                for surface in &surfaces {
                    let runtime = runtime.clone();
                    scope.spawn(move || {
                        if let Ok(request) =
                            quiesce_platform_surface(&surface.webview, &surface.lifecycle)
                            && let Some(runtime) = runtime
                        {
                            runtime.record_surface_isolation_request(
                                surface.webview.label(),
                                request,
                            );
                        }
                    });
                }
            });
        });

        #[cfg(not(any(windows, target_os = "macos")))]
        for surface in surfaces {
            if let Ok(request) = quiesce_platform_surface(&surface.webview, &surface.lifecycle) {
                self.record_surface_isolation_request(surface.webview.label(), request);
            }
        }
    }

    pub(crate) fn resolve_tab_close_preview(&self, tab_id: &str, succeeded: bool) {
        let tombstone = if let Ok(mut state) = self.state.lock() {
            let tombstone = state.close_previews.remove(tab_id);
            if !succeeded && state.native_resources.tabs.contains_key(tab_id) {
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
                            .native_resources.tabs
                            .get(tab_id)
                            .map(|tab| tab.roles.keys().cloned().collect::<Vec<_>>())
                            .unwrap_or_default()
                    });
                state.close_coordinator.quarantined_roles.extend(role_ids);
                for surface in state
                    .native_resources.surface_registry
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
        self.tab_close_changed.notify_all();
        if let Some(tombstone) = tombstone {
            if succeeded {
                let _ = self.apply_runtime_native_event_for_operation(
                    &tombstone.kernel_operation_id,
                    "closed",
                );
            } else {
                let _ = self.terminalize_runtime_operation(
                    &tombstone.kernel_operation_id,
                    RuntimeOperationPhase::Indeterminate,
                    Some("NATIVE_TAB_TEARDOWN_INDETERMINATE".to_owned()),
                );
            }
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
            if tombstone.parent_operation_id.is_some() {
                "parent-operation-fenced-slots"
            } else if owner_generations == 0 {
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
            .and_then(|window| {
                (window.selected_tab_id.as_deref() == Some(tab_id)).then_some(window.revision)
            })
    }

    /// Builds the renderer compatibility DTO from the live topology and the
    /// role-owner runtime. Core tab/window membership is deliberately ignored.
    fn compose_live_runtime_snapshot(
        &self,
        roles: Vec<BrowserRuntimeRoleRecord>,
    ) -> Option<BrowserRuntimeSnapshot> {
        let mut live_windows = self.presentation.snapshot_states().ok()?.into_iter().collect::<Vec<_>>();
        live_windows.sort_by(|left, right| left.0.cmp(&right.0));
        let owner_by_role = roles
            .iter()
            .map(|role| (role.role_id.as_str(), role))
            .collect::<HashMap<_, _>>();
        let mut tabs = Vec::new();
        let mut windows = Vec::new();
        let mut workspaces = Vec::new();
        for (window_id, live) in &live_windows {
            let tab_ids = live.all_tab_ids();
            windows.push(BrowserRuntimeWindowRecord {
                window_id: window_id.clone(),
                active_tab_id: live.selected_tab_id.clone().filter(|tab_id| {
                    tab_ids.contains(tab_id) && !live.tab_is_hidden(tab_id)
                }),
                tab_ids,
            });
            for tab in &live.tabs {
                let slots = tab
                    .role_slots
                    .iter()
                    .map(|slot| {
                        let owner = owner_by_role.get(slot.role_id.as_str());
                        let owned_here = owner.is_some_and(|role| {
                            role.owner.tab_id == tab.id && role.owner.slot_id == slot.slot_id
                        });
                        RuntimeRoleSlotRecord {
                            slot_id: slot.slot_id.clone(),
                            role_id: slot.role_id.clone(),
                            rect: slot.rect.clone(),
                            browser_zoom_percent: slot.browser_zoom_percent,
                            state: owner
                                .map_or("available", |role| {
                                    if owned_here {
                                        role.state.as_str()
                                    } else {
                                        "blocked"
                                    }
                                })
                                .to_owned(),
                            owner: owner.map(|role| role.owner.clone()),
                        }
                    })
                    .collect::<Vec<_>>();
                let projected = BrowserRuntimeTabRecord {
                    id: tab.id.clone(),
                    source_id: tab.source_id.clone(),
                    name: tab.title.clone(),
                    window_id: window_id.clone(),
                    tab_type: tab.tab_type.clone(),
                    workspace_id: (tab.tab_type == "workspace").then(|| tab.source_id.clone()),
                    slots: slots.clone(),
                    hidden: live.tab_is_hidden(&tab.id),
                };
                if tab.tab_type == "workspace" {
                    workspaces.push(BrowserRuntimeWorkspaceRecord {
                        workspace_id: tab.source_id.clone(),
                        name: tab.title.clone(),
                        runtime: "embedded".to_owned(),
                        window_id: window_id.clone(),
                        tab_id: tab.id.clone(),
                        role_ids: tab.role_ids.clone(),
                        state: projected_workspace_state(&slots).to_owned(),
                    });
                }
                tabs.push(projected);
            }
        }
        Some(BrowserRuntimeSnapshot {
            windows,
            roles,
            tabs,
            workspaces,
        })
    }

    pub fn restore_tab_audio_muted(&self, source_id: &str, muted: bool) -> Result<(), String> {
        let tab_id = self
            .presentation
            .tab_for_source(source_id, "role")
            .or_else(|| self.presentation.tab_for_source(source_id, "workspace"))
            .ok_or_else(|| "The restored runtime tab was not found in live topology.".to_owned())?;
        self.set_tab_audio_muted(&tab_id, muted).map(|_| ())
    }

}

fn projected_workspace_state(slots: &[RuntimeRoleSlotRecord]) -> &'static str {
    if slots.iter().any(|slot| slot.state == "stopping") {
        "stopping"
    } else if slots.iter().all(|slot| slot.state == "running") {
        "running"
    } else if slots.iter().any(|slot| slot.state == "launching")
        && slots
            .iter()
            .all(|slot| matches!(slot.state.as_str(), "launching" | "running"))
    {
        "launching"
    } else {
        "partial"
    }
}

fn retire_completed_tab_close_fence(
    state: &mut RuntimeState,
    tab_id: &str,
) -> Option<TabCloseTombstone> {
    state.close_previews.remove(tab_id)
}

fn wait_for_tab_close_fence(
    state: &Mutex<RuntimeState>,
    changed: &Condvar,
    tab_id: &str,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    let Ok(mut state) = state.lock() else {
        return false;
    };
    while tab_close_fence_pending(&state, tab_id) {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let Ok((next, wait)) = changed.wait_timeout(
            state,
            deadline.saturating_duration_since(now),
        ) else {
            return false;
        };
        state = next;
        if wait.timed_out() && tab_close_fence_pending(&state, tab_id) {
            return false;
        }
    }
    true
}

fn tab_close_fence_pending(state: &RuntimeState, tab_id: &str) -> bool {
    state.close_previews.contains_key(tab_id)
        || state.close_coordinator.closing_tabs.contains(tab_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoleRelaunchFenceState {
    Ready,
    Pending,
    Quarantined,
}

fn role_relaunch_fence_state(
    state: &RuntimeState,
    live_tab_ids: &HashSet<String>,
    role_ids: &HashSet<String>,
) -> RoleRelaunchFenceState {
    if role_ids
        .iter()
        .any(|role_id| state.close_coordinator.quarantined_roles.contains(role_id))
    {
        return RoleRelaunchFenceState::Quarantined;
    }
    let close_pending = role_ids.iter().any(|role_id| {
        state.close_coordinator.closing_roles.contains(role_id)
            || state
                .native_tab_id_for_role_surface(role_id)
                .is_some_and(|tab_id| !live_tab_ids.contains(tab_id))
            || state.native_resources.surface_registry.values().any(|surface| {
                surface.role_id.as_deref() == Some(role_id.as_str())
                    && surface
                        .tab_id
                        .as_ref()
                        .is_some_and(|tab_id| !live_tab_ids.contains(tab_id))
            })
    });
    if close_pending {
        RoleRelaunchFenceState::Pending
    } else {
        RoleRelaunchFenceState::Ready
    }
}

impl SystemRuntimeExecutor {
    fn wait_for_role_relaunch_fences(
        &self,
        role_ids: &HashSet<String>,
        timeout: Duration,
    ) -> RuntimeResult<bool> {
        if role_ids.is_empty() {
            return Ok(false);
        }
        let deadline = Instant::now() + timeout;
        let mut waited = false;
        loop {
            let live_tab_ids = self
                .presentation
                .snapshot_states()
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?
                .into_values()
                .flat_map(|window| window.all_tab_ids())
                .collect::<HashSet<_>>();
            let state = self.state()?;
            match role_relaunch_fence_state(&state, &live_tab_ids, role_ids) {
                RoleRelaunchFenceState::Ready => return Ok(waited),
                RoleRelaunchFenceState::Quarantined => {
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "A previous native role surface could not be released safely. Restart Rion Studio before reopening this role.",
                    ));
                }
                RoleRelaunchFenceState::Pending => {}
            }
            waited = true;
            let now = Instant::now();
            if now >= deadline {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_PREVIOUS_CLOSE_PENDING",
                    "The previous native role surfaces did not finish closing before relaunch.",
                ));
            }
            let (state, _) = self
                .tab_close_changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_STATE_UNAVAILABLE",
                        "The native role close coordinator is unavailable.",
                    )
                })?;
            drop(state);
        }
    }
}

impl SystemRuntimeExecutor {
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
                    .native_resources.display_hosts
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
        let live_target = self.state.lock().ok().and_then(|mut state| {
            let host = state.native_resources.display_hosts.get_mut(&window_id)?;
            host.target.bounds.x = logical_x;
            host.target.bounds.y = logical_y;
            if let Some((display_id, work_area, scale_factor)) = monitor_target {
                host.target.display_id = display_id;
                host.target.work_area = work_area;
                host.target.scale_factor = scale_factor;
            }
            Some(host.target.clone())
        });
        if let Some(target) = live_target
            && let Err(error) = self.update_live_window_target(&target, true)
        {
            eprintln!("Live Game Window move commit failed: window={window_id} error={error}");
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
            state.native_resources.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| (window_id.clone(), host.generation))
            })
        }) else {
            return;
        };
        let selected_tab_id = self
            .presentation
            .existing(&window_id)
            .and_then(|presentation| presentation.selected_tab_id.clone());
        let focus_observed = self.focus_broker.observe_native_focus(
            &window_id,
            generation,
            0,
            selected_tab_id.clone(),
        );
        if focus_observed.is_some() {
            self.record_presentation_event(
                LogLevel::Debug,
                "native.window-focus-observed",
                "The runtime window received the authoritative native focus event.",
                &window_id,
                selected_tab_id.as_deref(),
                0,
                "native-focus-event",
                0,
            );
        }
        let is_saved = self
            .presentation
            .existing(&window_id)
            .is_some_and(|window| window.persisted_name.is_some());
        if !is_saved {
            return;
        }
        let core = Arc::clone(&self.core);
        let focused_window_id = window_id.clone();
        let _ = thread::Builder::new()
            .name("rion-runtime-focus-journal".to_owned())
            .spawn(move || {
                if let Ok(mut session) = core.runtime_restore_session() {
                    session.last_focused_window_id = Some(focused_window_id);
                    session.updated_at = chrono::Utc::now().to_rfc3339();
                    let _ = core.replace_runtime_restore_session(session);
                }
            });
        self.schedule_window_placement_persistence(label.to_owned());
    }

    pub fn observe_window_blur(&self, label: &str) {
        if let Some((window_id, generation)) = self.state.lock().ok().and_then(|state| {
            state.native_resources.display_hosts.iter().find_map(|(window_id, host)| {
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
                    .native_resources.display_hosts
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
        let Some(window_id) = self.state.lock().ok().and_then(|state| {
            state.native_resources.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| window_id.clone())
            })
        }) else {
            return Ok(());
        };
        let is_saved = self
            .presentation
            .existing(&window_id)
            .map(|window| window.persisted_name.is_some())
            .unwrap_or(false);
        if !is_saved {
            return Ok(());
        }
        self.flush_live_window_state(&window_id)?;
        Ok(())
    }

}
