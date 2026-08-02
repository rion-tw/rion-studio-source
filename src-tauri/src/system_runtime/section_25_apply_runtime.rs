impl SystemRuntimeExecutor {
    fn apply_runtime(
        &self,
        snapshot: BrowserRuntimeSnapshot,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: &[String],
        focus_window_ids: &[String],
        focus_tab_id: Option<&str>,
        presentation_revision: u64,
    ) -> RuntimeResult<()> {
        struct TabUpdate {
            window_id: String,
            moved: bool,
            source_window_id: String,
            surfaces: Vec<Webview>,
            tab_id: String,
        }
        struct PresentationRelocation {
            source_window_id: String,
            surface_labels: HashSet<String>,
            tab_id: String,
            target_window_id: String,
        }
        struct HostUpdate {
            focus_window: bool,
            presentation: String,
            reveal: bool,
            retain_visibility: bool,
            title: Option<String>,
            window: Window,
        }

        let ensured_target_host = if let Some(target) = target.as_ref() {
            let title = snapshot
                .windows
                .iter()
                .find(|window| window.window_id == target.window_id)
                .and_then(|window| window.active_tab_id.as_deref())
                .and_then(|tab_id| snapshot.tabs.iter().find(|tab| tab.id == tab_id))
                .map(|tab| tab.name.as_str())
                .unwrap_or(RION_STUDIO_APP_NAME);
            let (_, created) = self.ensure_display_host(target, title)?;
            Some((target.window_id.clone(), created))
        } else {
            None
        };

        // apply_runtime is a native topology projection and must not synchronously call back
        // into AppCore while a core effect is awaiting it. Restore callers already omit focus
        // requests. Saved names come from the local runtime cache so this effect never calls Core.
        let game_window_names = self.state()?.saved_window_names.clone();
        let desired_windows = snapshot
            .windows
            .iter()
            .map(|window| window.window_id.as_str())
            .collect::<HashSet<_>>();
        let (live_windows, optimistic_closed_tabs) = {
            let state = self.state()?;
            (
                state
                    .tabs
                    .iter()
                    .map(|(tab_id, tab)| (tab_id.clone(), tab.window_id.clone()))
                    .collect::<HashMap<_, _>>(),
                state.optimistic_closed_tabs.clone(),
            )
        };
        let presentation_before = self.presentation.snapshot_states().map_err(|message| {
            RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
        })?;
        let visible_surface_labels = presentation_before
            .values()
            .flat_map(|state| state.surfaces(state.selected_tab_id.as_deref()))
            .map(|surface| surface.label().to_owned())
            .collect::<HashSet<_>>();
        let host_plan =
            resolve_runtime_tab_host_plan(&snapshot, &live_windows, focus_window_ids, focus_tab_id);
        let tab_updates = {
            let state = self.state()?;
            host_plan
                .iter()
                .filter_map(|plan| {
                    let runtime_tab = state.tabs.get(&plan.tab_id)?;
                    let mut surfaces = runtime_tab
                        .roles
                        .values()
                        .map(|role| role.webview.clone())
                        .collect::<Vec<_>>();
                    surfaces.extend(
                        runtime_tab
                            .dividers
                            .iter()
                            .map(|divider| divider.webview.clone()),
                    );
                    Some(TabUpdate {
                        window_id: plan.window_id.clone(),
                        moved: plan.moved,
                        source_window_id: runtime_tab.window_id.clone(),
                        surfaces,
                        tab_id: plan.tab_id.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };

        let mut reparented_surfaces = Vec::<RuntimeReparentedSurface>::new();
        for update in &tab_updates {
            if update.moved {
                let window = self.window_for_id(&update.window_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "The target runtime display host was not found.",
                    )
                })?;
                let source_window =
                    self.window_for_id(&update.source_window_id)
                        .ok_or_else(|| {
                            RuntimeError::new(
                                "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                                "The source runtime display host was not found.",
                            )
                        })?;
                for surface in &update.surfaces {
                    if let Err(error) = surface.hide() {
                        let rollback_errors =
                            self.rollback_runtime_reparented_surfaces(&reparented_surfaces);
                        if let Some((window_id, created)) = &ensured_target_host {
                            self.remove_empty_display_host(window_id, *created);
                        }
                        return Err(self.runtime_reparent_failure(
                            RuntimeError::tauri(error),
                            rollback_errors,
                        ));
                    }
                    reparented_surfaces.push(RuntimeReparentedSurface {
                        source_window: source_window.clone(),
                        #[cfg(windows)]
                        source_window_id: update.source_window_id.clone(),
                        surface: surface.clone(),
                        tab_id: update.tab_id.clone(),
                        #[cfg(windows)]
                        target_window_id: update.window_id.clone(),
                        was_visible: visible_surface_labels.contains(surface.label()),
                    });
                    if let Err(error) = surface.reparent(&window) {
                        let rollback_errors =
                            self.rollback_runtime_reparented_surfaces(&reparented_surfaces);
                        if let Some((window_id, created)) = &ensured_target_host {
                            self.remove_empty_display_host(window_id, *created);
                        }
                        return Err(self.runtime_reparent_failure(
                            RuntimeError::tauri(error),
                            rollback_errors,
                        ));
                    }
                }
                #[cfg(windows)]
                match synchronize_windows_reparented_surfaces(&update.surfaces, &window) {
                    Ok(outcome) => self.record_windows_reparent_sync_event(
                        "tab.reparent-synchronized",
                        "WebView2 surfaces synchronized with the target Game Window after reparenting.",
                        &update.tab_id,
                        &update.source_window_id,
                        &update.window_id,
                        "topology-reconciled",
                        Ok(&outcome),
                        None,
                    ),
                    Err(failure) => {
                        self.record_windows_reparent_sync_event(
                            "tab.reparent-sync-failed",
                            "WebView2 surfaces could not synchronize with the target Game Window.",
                            &update.tab_id,
                            &update.source_window_id,
                            &update.window_id,
                            "topology-reconciled",
                            Err(&failure),
                            None,
                        );
                        let rollback_errors =
                            self.rollback_runtime_reparented_surfaces(&reparented_surfaces);
                        if let Some((window_id, created)) = &ensured_target_host {
                            self.remove_empty_display_host(window_id, *created);
                        }
                        return Err(self.runtime_reparent_failure(
                            RuntimeError::new(
                                "SYSTEM_WEBVIEW_REPARENT_SYNC_FAILED",
                                failure.message,
                            ),
                            rollback_errors,
                        ));
                    }
                }
            }
        }

        let (obsolete_window_ids, moved_registry_surfaces) = {
            let mut state = self.state()?;
            if let Some(target) = target.as_ref()
                && let Some(host) = state.display_hosts.get_mut(&target.window_id)
            {
                host.target = target.clone();
            }
            for update in &tab_updates {
                if let Some(runtime_tab) = state.tabs.get_mut(&update.tab_id) {
                    runtime_tab.window_id = update.window_id.clone();
                }
                for surface in state.surface_registry.values_mut() {
                    if surface.tab_id.as_deref() == Some(update.tab_id.as_str()) {
                        surface.window_id = update.window_id.clone();
                    }
                }
            }
            let moved_registry_surfaces = state
                .surface_registry
                .values()
                .filter(|surface| {
                    tab_updates.iter().any(|update| {
                        update.moved && surface.tab_id.as_deref() == Some(update.tab_id.as_str())
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            let obsolete_window_ids = state
                .display_hosts
                .keys()
                .filter(|window_id| !desired_windows.contains(window_id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            (obsolete_window_ids, moved_registry_surfaces)
        };
        for surface in &moved_registry_surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.moved",
                "Native surface ownership moved to another window.",
                surface,
            );
        }

        let topology_revision = self.presentation.next_revision();
        let mut presentation_relocations = Vec::<PresentationRelocation>::new();
        for snapshot_tab in &snapshot.tabs {
            if !live_windows.contains_key(&snapshot_tab.id) {
                continue;
            }
            let owner = self
                .presentation
                .tab_window(&snapshot_tab.id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            let Some(source_window_id) = owner else {
                if optimistic_closed_tabs.contains(&snapshot_tab.id) {
                    continue;
                }
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    format!(
                        "Runtime tab {} is missing from the presentation registry.",
                        snapshot_tab.id
                    ),
                ));
            };
            if source_window_id == snapshot_tab.window_id {
                continue;
            }
            // The source transition must never hide a surface after it has been
            // reparented and shown by the target. Capture the exact pre-move
            // presentation bindings instead of inferring them from runtime roles,
            // which can be incomplete during launch/compensation interleavings.
            let moved_surface_labels = presentation_before
                .get(&source_window_id)
                .map(|state| {
                    presentation_surface_labels(&state.surfaces(Some(snapshot_tab.id.as_str())))
                })
                .unwrap_or_default();
            self.presentation
                .move_tab_with_activation(
                    &snapshot_tab.id,
                    &source_window_id,
                    &snapshot_tab.window_id,
                    topology_revision,
                    false,
                )
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            presentation_relocations.push(PresentationRelocation {
                source_window_id,
                surface_labels: moved_surface_labels,
                tab_id: snapshot_tab.id.clone(),
                target_window_id: snapshot_tab.window_id.clone(),
            });
        }
        for relocation in &presentation_relocations {
            self.record_topology_reconciled(
                &relocation.tab_id,
                &relocation.source_window_id,
                &relocation.target_window_id,
                topology_revision,
            );
        }
        let relocated_active_tabs = presentation_relocations
            .iter()
            .filter_map(|relocation| {
                snapshot
                    .windows
                    .iter()
                    .find(|window| window.window_id == relocation.target_window_id)
                    .and_then(|window| {
                        (window.active_tab_id.as_deref() == Some(relocation.tab_id.as_str()))
                            .then_some((
                                relocation.target_window_id.as_str(),
                                relocation.tab_id.as_str(),
                            ))
                    })
            })
            .collect::<HashMap<_, _>>();

        for runtime_window in &snapshot.windows {
            let presentation = self
                .presentation
                .coordinator(&runtime_window.window_id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            let mut window = presentation.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            for snapshot_tab in snapshot
                .tabs
                .iter()
                .filter(|tab| tab.window_id == runtime_window.window_id)
            {
                window.update_metadata(
                    &snapshot_tab.id,
                    &snapshot_tab.source_id,
                    &snapshot_tab.tab_type,
                    &snapshot_tab.role_ids,
                    &snapshot_tab.name,
                );
            }
            // Core owns durable ordering, but provisional/closing entries remain local until
            // their own transaction resolves.
            window.reorder_known_tabs(&runtime_window.tab_ids);
            let local_ids = window.tab_ids();
            window
                .aliases
                .retain(|_, target| local_ids.contains(target));
            let previous = presentation_before
                .get(&runtime_window.window_id)
                .cloned()
                .unwrap_or_default();
            // A compensation effect has no explicit focus request, but it still needs to
            // restore the active tab that moved back with the durable topology. Treat that
            // tab as a selection request while keeping native focus behavior unchanged.
            let selection_tab_id = focus_tab_id
                .filter(|tab_id| {
                    snapshot
                        .tabs
                        .iter()
                        .any(|tab| tab.id == *tab_id && tab.window_id == runtime_window.window_id)
                })
                .or_else(|| {
                    relocated_active_tabs
                        .get(runtime_window.window_id.as_str())
                        .copied()
                });
            let selection = resolved_runtime_window_selection(
                &snapshot,
                &runtime_window.window_id,
                &previous,
                selection_tab_id,
                presentation_revision,
            );
            if window.selected_tab_id != selection {
                window.select(selection, topology_revision);
            }
        }

        let presentation_after = self.presentation.snapshot_states().map_err(|message| {
            RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
        })?;
        for relocation in &presentation_relocations {
            let snapshot_tab = snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == relocation.tab_id)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_TOPOLOGY_INVALID",
                        format!(
                            "Runtime tab {} disappeared while moving native tab chrome.",
                            relocation.tab_id
                        ),
                    )
                })?;
            let source_active_tab_id = presentation_after
                .get(&relocation.source_window_id)
                .and_then(|window| window.selected_tab_id.as_deref());
            let target_active_tab_id = presentation_after
                .get(&relocation.target_window_id)
                .and_then(|window| window.selected_tab_id.as_deref());
            let target_rollback_active_tab_id = presentation_before
                .get(&relocation.target_window_id)
                .and_then(|window| window.selected_tab_id.as_deref());
            if snapshot_tab.hidden {
                self.try_remove_native_tab_reservation(
                    &relocation.source_window_id,
                    &relocation.tab_id,
                    source_active_tab_id,
                )?;
                self.try_remove_native_tab_reservation(
                    &relocation.target_window_id,
                    &relocation.tab_id,
                    target_active_tab_id,
                )?;
                continue;
            }
            #[cfg(any(windows, target_os = "macos"))]
            let workspace_template = self
                .state()?
                .tabs
                .get(&relocation.tab_id)
                .and_then(|tab| tab.workspace_template.clone());
            #[cfg(not(any(windows, target_os = "macos")))]
            let workspace_template: Option<String> = None;
            self.relocate_native_tab_reservation(
                &relocation.source_window_id,
                &relocation.target_window_id,
                &relocation.tab_id,
                &snapshot_tab.name,
                &snapshot_tab.tab_type,
                workspace_template.as_deref(),
                source_active_tab_id,
                target_rollback_active_tab_id,
                topology_revision,
            )?;
            self.apply_native_active_style(
                &relocation.target_window_id,
                target_active_tab_id,
                topology_revision,
                "topology-reconciled",
            );
        }
        for snapshot_tab in snapshot.tabs.iter().filter(|tab| {
            live_windows.contains_key(&tab.id) && !optimistic_closed_tabs.contains(&tab.id)
        }) {
            let active_tab_id = presentation_after
                .get(&snapshot_tab.window_id)
                .and_then(|window| window.selected_tab_id.as_deref());
            if snapshot_tab.hidden {
                self.try_remove_native_tab_reservation(
                    &snapshot_tab.window_id,
                    &snapshot_tab.id,
                    active_tab_id,
                )?;
                continue;
            }
            #[cfg(any(windows, target_os = "macos"))]
            let workspace_template = self
                .state()?
                .tabs
                .get(&snapshot_tab.id)
                .and_then(|tab| tab.workspace_template.clone());
            #[cfg(not(any(windows, target_os = "macos")))]
            let workspace_template: Option<String> = None;
            self.try_ensure_native_tab(
                &snapshot_tab.window_id,
                &snapshot_tab.id,
                &snapshot_tab.name,
                &snapshot_tab.tab_type,
                workspace_template.as_deref(),
            )?;
        }
        let projected_native_tab_window_ids = snapshot
            .tabs
            .iter()
            .filter(|tab| live_windows.contains_key(&tab.id))
            .map(|tab| tab.window_id.as_str())
            .collect::<HashSet<_>>();
        for runtime_window in snapshot
            .windows
            .iter()
            .filter(|window| projected_native_tab_window_ids.contains(window.window_id.as_str()))
        {
            let visible_tab_ids = runtime_window
                .tab_ids
                .iter()
                .filter(|tab_id| {
                    live_windows.contains_key(tab_id.as_str())
                        && snapshot
                            .tabs
                            .iter()
                            .any(|tab| tab.id == tab_id.as_str() && !tab.hidden)
                })
                .cloned()
                .collect::<Vec<_>>();
            self.reorder_native_tabs(&runtime_window.window_id, &visible_tab_ids)?;
        }
        for snapshot_tab in &snapshot.tabs {
            if !live_windows.contains_key(&snapshot_tab.id)
                || optimistic_closed_tabs.contains(&snapshot_tab.id)
            {
                continue;
            }
            let owner = self
                .presentation
                .tab_window(&snapshot_tab.id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            if owner.as_deref() != Some(snapshot_tab.window_id.as_str()) {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_TOPOLOGY_INVALID",
                    format!(
                        "Runtime tab {} did not commit to presentation window {}.",
                        snapshot_tab.id, snapshot_tab.window_id
                    ),
                ));
            }
        }
        for (window_id, state) in &presentation_after {
            let Some(selected_tab_id) = state.selected_tab_id.as_deref() else {
                continue;
            };
            if let Some(snapshot_tab) = snapshot.tabs.iter().find(|tab| tab.id == selected_tab_id)
                && (snapshot_tab.window_id != *window_id || snapshot_tab.hidden)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_SELECTION_INVALID",
                    format!(
                        "Presentation window {window_id} selected unavailable runtime tab {selected_tab_id}."
                    ),
                ));
            }
        }
        {
            let state = self.state()?;
            for surface in state.surface_registry.values() {
                let Some(tab_id) = surface.tab_id.as_deref() else {
                    continue;
                };
                let Some(snapshot_tab) = snapshot.tabs.iter().find(|tab| tab.id == tab_id) else {
                    continue;
                };
                if surface.window_id != snapshot_tab.window_id {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_TOPOLOGY_INVALID",
                        format!(
                            "Native surface {} did not move with runtime tab {tab_id}.",
                            surface.instance_id
                        ),
                    ));
                }
            }
        }
        let presentation_windows = snapshot
            .windows
            .iter()
            .filter_map(|window| {
                presentation_after
                    .get(&window.window_id)
                    .cloned()
                    .map(|state| (window.window_id.clone(), state))
            })
            .collect::<HashMap<_, _>>();

        if let Some(target) = target.as_ref()
            && let Some(window) = self.window_for_id(&target.window_id)
        {
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            if runtime_target_requires_placement_reapply(&target.presentation, fullscreen) {
                if fullscreen {
                    window.set_fullscreen(false).map_err(RuntimeError::tauri)?;
                }
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize().map_err(RuntimeError::tauri)?;
                }
                window
                    .set_position(LogicalPosition::new(
                        target.bounds.x as f64,
                        target.bounds.y as f64,
                    ))
                    .map_err(RuntimeError::tauri)?;
                window
                    .set_size(LogicalSize::new(
                        target.bounds.width.max(1) as f64,
                        target.bounds.height.max(1) as f64,
                    ))
                    .map_err(RuntimeError::tauri)?;
            }
        }

        for update in &tab_updates {
            if update.moved
                || target
                    .as_ref()
                    .is_some_and(|target| target.window_id == update.window_id)
            {
                self.layout_runtime_tab(&update.tab_id)?;
            }
        }

        let moved_away_labels = presentation_relocations.iter().fold(
            HashMap::<String, HashSet<String>>::new(),
            |mut labels, relocation| {
                labels
                    .entry(relocation.source_window_id.clone())
                    .or_default()
                    .extend(relocation.surface_labels.iter().cloned());
                labels
            },
        );
        let transition_window_ids = presentation_before
            .keys()
            .chain(presentation_after.keys())
            .cloned()
            .collect::<HashSet<_>>();
        for window_id in transition_window_ids {
            let previous = presentation_before
                .get(&window_id)
                .cloned()
                .unwrap_or_default();
            let next = presentation_after
                .get(&window_id)
                .cloned()
                .unwrap_or_default();
            let mut previous_surfaces = previous.surfaces(previous.selected_tab_id.as_deref());
            if let Some(moved_labels) = moved_away_labels.get(&window_id) {
                previous_surfaces.retain(|surface| !moved_labels.contains(surface.label()));
            }
            let next_surfaces = next.surfaces(next.selected_tab_id.as_deref());
            if !native_presentation_changed(
                &previous.selected_tab_id,
                &next.selected_tab_id,
                &presentation_surface_labels(&previous_surfaces),
                &presentation_surface_labels(&next_surfaces),
            ) {
                continue;
            }
            let Some(window) = self.window_for_id(&window_id) else {
                continue;
            };
            let focus = if focus_tab_id == next.selected_tab_id.as_deref()
                && previous.revision <= presentation_revision
            {
                NativePresentationFocus::WindowAndContent
            } else {
                NativePresentationFocus::None
            };
            self.apply_native_active_style(
                &window_id,
                next.selected_tab_id.as_deref(),
                next.revision,
                "topology-reconciled",
            );
            self.dispatch_native_presentation(
                window_id,
                next.selected_tab_id.clone(),
                next.revision,
                "topology-reconciled",
                Instant::now(),
                window,
                previous.selected_tab_id,
                previous_surfaces,
                next_surfaces.clone(),
                next_surfaces.first().cloned(),
                None,
                focus,
            );
        }

        if let Some((window_id, created)) = &ensured_target_host
            && *created
            && let Some(window) = self.window_for_id(window_id)
        {
            self.finish_surface_host_initialization(
                &window,
                surface_host_initialization_should_restore_hidden(
                    true,
                    Some(reveal_window_ids.contains(window_id)),
                ),
                window_id,
            )?;
        }

        let host_updates = {
            let state = self.state()?;
            state
                .display_hosts
                .values()
                .map(|host| {
                    let window_id = &host.target.window_id;
                    let presentation_window = presentation_windows.get(window_id);
                    let active_tab = presentation_window
                        .and_then(|selection| selection.selected_tab_id.as_deref())
                        .filter(|tab_id| {
                            state.tabs.get(*tab_id).is_some_and(|tab| {
                                tab.window_id == *window_id
                                    && !state.optimistic_closed_tabs.contains(*tab_id)
                            })
                        });
                    let title = Some(native_runtime_window_title(
                        game_window_names.get(window_id).map(String::as_str),
                    ));
                    HostUpdate {
                        focus_window: runtime_host_should_receive_window_focus(
                            focus_window_ids.contains(window_id),
                            active_tab.is_some(),
                        ),
                        presentation: host.target.presentation.clone(),
                        reveal: reveal_window_ids.contains(window_id),
                        retain_visibility: presentation_window
                            .is_some_and(|presentation| presentation.host_visibility),
                        title,
                        window: host.window.clone(),
                    }
                })
                .collect::<Vec<_>>()
        };
        for update in host_updates {
            if let Some(title) = update.title {
                let _ = update.window.set_title(&title);
            }
            let currently_visible = update.window.is_visible().unwrap_or(false);
            let visible = runtime_host_should_be_visible(
                update.reveal,
                update.retain_visibility,
                currently_visible,
            );
            if visible && !currently_visible {
                update.window.show().map_err(RuntimeError::tauri)?;
            } else if !visible && currently_visible {
                update.window.hide().map_err(RuntimeError::tauri)?;
            }
            if update.focus_window && update.window.is_minimized().unwrap_or(false) {
                update.window.unminimize().map_err(RuntimeError::tauri)?;
            }
            match update.presentation.as_str() {
                "fullscreen" if !update.window.is_fullscreen().unwrap_or(false) => {
                    update
                        .window
                        .set_fullscreen(true)
                        .map_err(RuntimeError::tauri)?;
                }
                "maximized" if !update.window.is_maximized().unwrap_or(false) => {
                    update.window.maximize().map_err(RuntimeError::tauri)?;
                }
                _ => {}
            }
            if update.focus_window {
                update.window.set_focus().map_err(RuntimeError::tauri)?;
            }
        }
        let obsolete_hosts = {
            let mut state = self.state()?;
            obsolete_window_ids
                .into_iter()
                .filter_map(|window_id| {
                    let host = state.display_hosts.remove(&window_id)?;
                    state
                        .allow_window_close_labels
                        .insert(host.window.label().to_owned());
                    Some((window_id, host))
                })
                .collect::<Vec<_>>()
        };
        for (window_id, host) in obsolete_hosts {
            self.presentation.remove(&window_id);
            self.unregister_runtime_launcher_window(&window_id);
            let _ = host.window.close();
        }
        Ok(())
    }

}
