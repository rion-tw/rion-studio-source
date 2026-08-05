impl SystemRuntimeExecutor {
    fn apply_runtime_inner(
        &self,
        snapshot: BrowserRuntimeSnapshot,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: &[String],
        focus_window_ids: &[String],
        focus_tab_id: Option<&str>,
        correlation: &RuntimeEffectCorrelation,
    ) -> RuntimeResult<()> {
        // Core owns role lifecycle metadata, not the topology the user is
        // currently manipulating. Any delayed ApplyRuntime effect is rebased on
        // the one live topology before it can touch native chrome or surfaces.
        let snapshot = self
            .compose_live_runtime_snapshot(snapshot)
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The live tab topology could not be read; the Core projection was ignored.",
                )
            })?;
        let parent_operation_id = correlation.parent_operation_id.as_deref();
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
        let (live_windows, optimistic_closed_tabs, pending_window_tab_restores) = {
            let state = self.state()?;
            (
                state
                    .surface_registry
                    .values()
                    .filter_map(|surface| {
                        surface
                            .tab_id
                            .as_ref()
                            .map(|tab_id| (tab_id.clone(), surface.window_id.clone()))
                    })
                    .collect::<HashMap<_, _>>(),
                state.optimistic_closed_tabs.clone(),
                state.pending_window_tab_restores.clone(),
            )
        };
        let host_plan =
            resolve_runtime_tab_host_plan(&snapshot, &live_windows, focus_window_ids, focus_tab_id);
        let tab_updates = {
            let state = self.state()?;
            host_plan
                .iter()
                .filter(|plan| !optimistic_closed_tabs.contains(&plan.tab_id))
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
                    surfaces.extend(runtime_tab.slots.values().filter_map(|slot| {
                        slot.placeholder
                            .as_ref()
                            .map(|placeholder| placeholder.webview.clone())
                    }));
                    Some(RuntimeTabProjectionUpdate {
                        window_id: plan.window_id.clone(),
                        moved: plan.moved,
                        #[cfg(windows)]
                        source_window_id: live_windows.get(&plan.tab_id)?.clone(),
                        surfaces,
                        tab_id: plan.tab_id.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };

        let mut projected_tab_ids = HashSet::new();
        for update in &tab_updates {
            if self.runtime_tab_close_projection_fenced(&update.tab_id)? {
                continue;
            }
            if !update.moved {
                projected_tab_ids.insert(update.tab_id.clone());
                continue;
            }
            let projection = (|| -> RuntimeResult<()> {
                let window = self.window_for_id(&update.window_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "The target runtime display host was not found.",
                    )
                })?;
                for surface in &update.surfaces {
                    #[cfg(windows)]
                    surface.hide().map_err(RuntimeError::tauri)?;
                    surface.reparent(&window).map_err(RuntimeError::tauri)?;
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
                        return Err(RuntimeError::new(
                            "SYSTEM_WEBVIEW_REPARENT_SYNC_FAILED",
                            failure.message,
                        ));
                    }
                }
                Ok(())
            })();
            match projection {
                Ok(()) => {
                    projected_tab_ids.insert(update.tab_id.clone());
                }
                Err(error) => {
                    eprintln!(
                        "Live tab surface projection remains pending: tab={} target={} error={}",
                        update.tab_id, update.window_id, error.message
                    );
                    self.schedule_tab_surface_move_retry(
                        update.tab_id.clone(),
                        update.window_id.clone(),
                    );
                }
            }
        }

        let moved_registry_surfaces = {
            let mut state = self.state()?;
            if let Some(target) = target.as_ref()
                && let Some(host) = state.display_hosts.get_mut(&target.window_id)
            {
                host.target = target.clone();
            }
            for update in &tab_updates {
                if update.moved && !projected_tab_ids.contains(&update.tab_id) {
                    continue;
                }
                for surface in state.surface_registry.values_mut() {
                    if surface.tab_id.as_deref() == Some(update.tab_id.as_str()) {
                        surface.window_id = update.window_id.clone();
                    }
                }
            }
            state
                .surface_registry
                .values()
                .filter(|surface| {
                    tab_updates.iter().any(|update| {
                        update.moved
                            && projected_tab_ids.contains(&update.tab_id)
                            && surface.tab_id.as_deref() == Some(update.tab_id.as_str())
                    })
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for surface in &moved_registry_surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.moved",
                "Native surface ownership moved to another window.",
                surface,
            );
        }

        let presentation_after = self.presentation.snapshot_states().map_err(|message| {
            RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
        })?;
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
            .filter(|tab| {
                live_windows.contains_key(&tab.id)
                    && !optimistic_closed_tabs.contains(&tab.id)
            })
            .map(|tab| tab.window_id.as_str())
            .collect::<HashSet<_>>();
        for runtime_window in snapshot
            .windows
            .iter()
            .filter(|window| projected_native_tab_window_ids.contains(window.window_id.as_str()))
        {
            // Restore already seeded native chrome. Replaying partial owner snapshots causes
            // visible AppKit/WebView2 width animations without changing the topology.
            if pending_window_tab_restores.contains_key(&runtime_window.window_id) {
                continue;
            }
            let visible_tab_ids = presentation_after
                .get(&runtime_window.window_id)
                .map(LiveWindowTabState::tab_ids)
                .unwrap_or_default()
                .into_iter()
                .filter(|tab_id| {
                    live_windows.contains_key(tab_id.as_str())
                        && !optimistic_closed_tabs.contains(tab_id.as_str())
                        && snapshot
                            .tabs
                            .iter()
                            .any(|tab| tab.id == *tab_id && !tab.hidden)
                })
                .collect::<Vec<_>>();
            self.reorder_native_tabs_for_projection(
                &runtime_window.window_id,
                &visible_tab_ids,
                parent_operation_id,
            )?;
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
        {
            let fullscreen = self
                .window_for_id(&target.window_id)
                .is_some_and(|window| window.is_fullscreen().unwrap_or(false));
            if runtime_target_requires_placement_reapply(&target.presentation, fullscreen) {
                self.apply_window_geometry_target(
                    target,
                    GeometryMutationScope::WindowAndLayout,
                    "applyRuntimePlacement",
                )?;
            }
        }

        for update in &tab_updates {
            if (update.moved && projected_tab_ids.contains(&update.tab_id))
                || target
                    .as_ref()
                    .is_some_and(|target| target.window_id == update.window_id)
            {
                self.layout_runtime_tab(&update.tab_id)?;
            }
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
                            state.tabs.contains_key(*tab_id)
                                && !state.optimistic_closed_tabs.contains(*tab_id)
                        });
                    let title = Some(native_runtime_window_title(
                        game_window_names.get(window_id).map(String::as_str),
                    ));
                    RuntimeHostProjectionUpdate {
                        active_tab_id: active_tab.map(str::to_owned),
                        focus_window: runtime_host_should_receive_window_focus(
                            focus_window_ids.contains(window_id),
                            active_tab.is_some(),
                        ),
                        presentation: host.target.presentation.clone(),
                        reveal: reveal_window_ids.contains(window_id),
                        retain_visibility: presentation_window
                            .is_some_and(|presentation| presentation.projection.host_visibility),
                        title,
                        window: host.window.clone(),
                        window_id: window_id.clone(),
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
            self.request_window_contract_presentation(
                &update.window_id,
                update.active_tab_id.as_deref(),
                Some(visible),
                if update.focus_window {
                    NativePresentationFocus::WindowAndContent
                } else {
                    NativePresentationFocus::None
                },
                NativeWindowMode::from_presentation(&update.presentation),
                "apply-runtime-host",
            )?;
        }
        Ok(())
    }

}
